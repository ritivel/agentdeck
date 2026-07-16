// Live-mirror smoke test: builds fixture transcript stores for all three platforms
// under a temp HOME, runs the LiveWatcher against them, then appends a new turn to
// each store and asserts the tails pick it up. No agent CLIs required.
// Usage: HOME must be set BEFORE the sources load, so run via the child below:
//   npx tsx test/live.mjs            (parent: builds fixtures, re-execs itself)
//   AGENTDECK_LIVE_TEST_HOME=<dir>   (child: runs the actual test)
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// ---------- fixture builders ----------

const claudeLine = (o) => JSON.stringify(o) + '\n';

function buildClaudeFixture(home, uuid) {
  const dir = join(home, '.claude', 'projects', '-tmp-fixture');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${uuid}.jsonl`);
  writeFileSync(
    file,
    claudeLine({ type: 'user', sessionId: uuid, cwd: '/tmp/claude-proj', message: { content: 'hello claude' } }) +
    claudeLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi from claude' }] } }),
  );
  return file;
}

function buildCodexFixture(home, uuid) {
  const dir = join(home, '.codex', 'sessions', '2026', '07', '16');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-07-16T10-00-00-${uuid}.jsonl`);
  writeFileSync(
    file,
    claudeLine({ type: 'session_meta', payload: { session_id: uuid, cwd: '/tmp/codex-proj' } }) +
    claudeLine({ type: 'event_msg', payload: { type: 'user_message', message: 'hello codex' } }) +
    claudeLine({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi from codex' } }) +
    claudeLine({ type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' } }) +
    claudeLine({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'file.txt' }] } }),
  );
  writeFileSync(join(home, '.codex', 'session_index.jsonl'), claudeLine({ id: uuid, thread_name: 'Codex fixture chat' }));
  return file;
}

// Cursor store.db: meta(key,value) with hex-encoded JSON; blobs(id,data) where the
// root blob is a protobuf: repeated field 1 = 32-byte child ids, field 9 = file:// URI.
function cursorMsgBlob(msg) {
  const data = Buffer.from(JSON.stringify(msg), 'utf8');
  const id = randomUUID().replace(/-/g, '').padEnd(64, 'a'); // any 64-hex id works
  return { id, data };
}

function cursorRootBlob(childHexIds, workspaceUri) {
  const parts = [];
  for (const hex of childHexIds) {
    parts.push(Buffer.from([0x0a, 0x20]), Buffer.from(hex, 'hex'));
  }
  const uri = Buffer.from(workspaceUri, 'utf8');
  parts.push(Buffer.from([0x4a, uri.length]), uri); // field 9, wt 2
  const data = Buffer.concat(parts);
  const id = randomUUID().replace(/-/g, '').padEnd(64, 'b');
  return { id, data };
}

function writeCursorStore(chatDir, name, messages) {
  mkdirSync(chatDir, { recursive: true });
  const db = new DatabaseSync(join(chatDir, 'store.db'));
  db.exec('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);');
  const ins = db.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)');
  const kids = [];
  for (const m of messages) {
    const b = cursorMsgBlob(m);
    ins.run(b.id, b.data);
    kids.push(b.id);
  }
  const root = cursorRootBlob(kids, 'file:///tmp/cursor-proj');
  ins.run(root.id, root.data);
  const meta = { agentId: 'fixture-chat', name, latestRootBlobId: root.id, createdAt: Date.now() };
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta), 'utf8').toString('hex'));
  db.close();
  return kids;
}

// ---------- parent: build fixtures, re-exec with HOME set ----------

if (!process.env.AGENTDECK_LIVE_TEST_HOME) {
  const home = join(tmpdir(), `agentdeck-live-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  const r = spawnSync(process.execPath, process.execArgv.concat([process.argv[1]]), {
    stdio: 'inherit',
    env: { ...process.env, HOME: home, AGENTDECK_LIVE_TEST_HOME: home },
  });
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

// ---------- child: the actual test ----------

const home = process.env.AGENTDECK_LIVE_TEST_HOME;
const claudeUuid = randomUUID();
const codexUuid = randomUUID();
const claudeFile = buildClaudeFixture(home, claudeUuid);
const codexFile = buildCodexFixture(home, codexUuid);
const cursorChatDir = join(home, '.cursor', 'chats', 'wshash', 'fixture-chat');
const cursorKids = writeCursorStore(cursorChatDir, 'Cursor fixture chat', [
  { role: 'user', content: [{ type: 'text', text: '<user_query>hello cursor</user_query>' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'hi from cursor' }] },
]);

const { LiveWatcher } = await import('../src/live/watcher.ts');
const { claudeSource } = await import('../src/live/claudeTranscripts.ts');
const { codexSource } = await import('../src/live/codexTranscripts.ts');
const { cursorSource } = await import('../src/live/cursorTranscripts.ts');

const discovered = new Map(); // platform → info
const tailEvents = new Map(); // platform → events[]
const sessionsById = new Map();

const watcher = new LiveWatcher([claudeSource, codexSource, cursorSource], {
  onSessionDiscovered: (info) => {
    discovered.set(info.platform, info);
    sessionsById.set(info.id, info);
  },
  onSessionUpdated: () => {},
  onSessionRemoved: () => {},
  onEvent: (sessionId, stored) => {
    const info = sessionsById.get(sessionId);
    if (!info) return;
    if (!tailEvents.has(info.platform)) tailEvents.set(info.platform, []);
    tailEvents.get(info.platform).push(stored.event);
  },
  isBridgeOwned: () => false,
  isDismissed: () => false,
  isControllable: () => false,
});

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await watcher.start();

// -- discovery --
for (const [platform, wantTitle, wantCwd] of [
  ['claude', 'terminal session', '/tmp/claude-proj'],
  ['codex', 'Codex fixture chat', '/tmp/codex-proj'],
  ['cursor', 'Cursor fixture chat', '/tmp/cursor-proj'],
]) {
  const info = discovered.get(platform);
  if (!info) fail(`${platform}: session not discovered`);
  if (info.title !== wantTitle) fail(`${platform}: title "${info.title}" != "${wantTitle}"`);
  if (info.cwd !== wantCwd) fail(`${platform}: cwd "${info.cwd}" != "${wantCwd}"`);
  if (!info.attached || !info.readOnly) fail(`${platform}: expected attached+readOnly`);
  console.log(`DISCOVERED ${platform}: "${info.title}" (${info.cwd})`);
}

// -- history --
for (const [platform, wantKinds] of [
  ['claude', ['user', 'text']],
  ['codex', ['user', 'text', 'tool.start', 'tool.end']],
  ['cursor', ['user', 'text']],
]) {
  const info = discovered.get(platform);
  const history = watcher.history(info.id) ?? [];
  const kinds = history.map((e) => e.event.kind);
  for (const k of wantKinds) if (!kinds.includes(k)) fail(`${platform}: history missing kind "${k}" (got ${kinds})`);
  console.log(`HISTORY ${platform}: ${history.length} events [${kinds.join(', ')}]`);
}

// -- live tailing: append a new turn to each store --
appendFileSync(claudeFile, claudeLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude tail works' }] } }));
appendFileSync(codexFile, claudeLine({ type: 'event_msg', payload: { type: 'agent_message', message: 'codex tail works' } }));
{
  // cursor: append a message blob and swap the root, like a real new turn
  const db = new DatabaseSync(join(cursorChatDir, 'store.db'));
  const ins = db.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)');
  const b = cursorMsgBlob({ role: 'assistant', content: [{ type: 'text', text: 'cursor tail works' }] });
  ins.run(b.id, b.data);
  const root = cursorRootBlob([...cursorKids, b.id], 'file:///tmp/cursor-proj');
  ins.run(root.id, root.data);
  const meta = { agentId: 'fixture-chat', name: 'Cursor fixture chat', latestRootBlobId: root.id, createdAt: Date.now() };
  db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(Buffer.from(JSON.stringify(meta), 'utf8').toString('hex'));
  db.close();
}

const deadline = Date.now() + 15_000;
const gotTail = (platform, text) => (tailEvents.get(platform) ?? []).some((e) => e.kind === 'text' && e.text === text);
while (Date.now() < deadline) {
  if (gotTail('claude', 'claude tail works') && gotTail('codex', 'codex tail works') && gotTail('cursor', 'cursor tail works')) break;
  await sleep(300);
}
for (const p of ['claude', 'codex', 'cursor']) {
  if (!gotTail(p, `${p} tail works`)) fail(`${p}: tail event not received within 15s`);
  console.log(`TAIL ${p}: OK`);
}

watcher.stop();
console.log('LIVE MIRROR TEST PASSED');
process.exit(0);
