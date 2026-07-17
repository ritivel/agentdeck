// Baton-pass e2e test: fixture claude transcript → live mirror → fake wrapper
// registers its PTY → phone prompt triggers pty.handoff → ack → session.takeover.
// Also covers the explicit mode:'type' path and the handoff timeout error.
//   npx tsx test/handoff.mjs           (parent: re-execs itself with temp HOME)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

if (!process.env.AGENTDECK_HANDOFF_TEST_HOME) {
  const home = join(tmpdir(), `agentdeck-handoff-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  const r = spawnSync(process.execPath, process.execArgv.concat([process.argv[1]]), {
    stdio: 'inherit',
    env: { ...process.env, HOME: home, AGENTDECK_HANDOFF_TEST_HOME: home },
  });
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

const HOME = process.env.AGENTDECK_HANDOFF_TEST_HOME;
const PORT = 19800 + (process.pid % 150);
const TOKEN = 'handoff-test-token';
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const line = (o) => JSON.stringify(o) + '\n';
function buildClaudeFixture(uuid, cwd) {
  const dir = join(HOME, '.claude', 'projects', `-fixture-${uuid.slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(dir, `${uuid}.jsonl`),
    line({ type: 'user', sessionId: uuid, cwd, message: { content: 'seed question' } }) +
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'seed answer' }] } }));
}

const sessionA = randomUUID(); // handoff flow
const sessionB = randomUUID(); // type flow + timeout flow
buildClaudeFixture(sessionA, join(HOME, 'proj-a'));
buildClaudeFixture(sessionB, join(HOME, 'proj-b'));

const { startServer } = await import('../src/server.ts');
const server = await startServer(PORT, TOKEN, { watchLive: true });
const { default: WebSocket } = await import('ws');

function wsClient(name) {
  const messages = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const client = {
    ws, messages,
    send: (m) => ws.send(JSON.stringify(m)),
    async wait(pred, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(pred);
        if (found) return found;
        await sleep(25);
      }
      return undefined;
    },
  };
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

const phone = await wsClient('phone');
phone.send({ type: 'hello', clientName: 'test-phone' });
const welcome = await phone.wait((m) => m.type === 'welcome');
const claudeAvailable = welcome.platforms?.claude?.available === true;

// Wait for both fixtures to be discovered as live mirrors.
async function liveSession(nativeId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    phone.send({ type: 'session.list' });
    const msg = await phone.wait((m) => m.type === 'sessions');
    const s = (msg.sessions ?? []).find((x) => x.nativeSessionId === nativeId);
    phone.messages.length = 0;
    if (s) return s;
    await sleep(300);
  }
  fail(`live session for ${nativeId} never discovered`);
}
const liveA = await liveSession(sessionA);
const liveB = await liveSession(sessionB);
console.log(`DISCOVERED: ${liveA.id} + ${liveB.id}`);

// Wrapper registers both PTYs (as two `agentdeck claude` terminals would).
const wrapper = await wsClient('wrapper');
wrapper.send({ type: 'pty.register', nativeSessionId: sessionA, cwd: liveA.cwd });
wrapper.send({ type: 'pty.register', nativeSessionId: sessionB, cwd: liveB.cwd });
if (!(await wrapper.wait((m) => m.type === 'pty.registered' && m.nativeSessionId === sessionA))) fail('register A');
if (!(await wrapper.wait((m) => m.type === 'pty.registered' && m.nativeSessionId === sessionB))) fail('register B');
const writable = await phone.wait((m) => m.type === 'session.updated' && m.session?.id === liveA.id && m.session.readOnly === false);
if (!writable) fail('live session did not become writable after pty.register');
console.log('REGISTERED: live sessions now controllable');

// ---- explicit typing path (mode:'type') ----
phone.send({ type: 'prompt', sessionId: liveB.id, text: 'typed into terminal', mode: 'type' });
const typed = await wrapper.wait((m) => m.type === 'pty.input' && m.text === 'typed into terminal');
if (!typed) fail('mode:type did not deliver pty.input');
console.log('TYPE PATH: pty.input delivered');

// ---- baton-pass handoff ----
if (!claudeAvailable) {
  console.log('SKIP: claude CLI not installed — handoff/takeover not exercised');
} else {
  phone.send({ type: 'prompt', sessionId: liveA.id, text: 'hello from phone' });
  const handoff = await wrapper.wait((m) => m.type === 'pty.handoff' && m.nativeSessionId === sessionA);
  if (!handoff) fail('wrapper never received pty.handoff');
  // Wrapper: TUI exited → ack.
  wrapper.send({ type: 'pty.handoff-ack', nativeSessionId: sessionA });

  const takeover = await phone.wait((m) => m.type === 'session.takeover' && m.fromSessionId === liveA.id);
  if (!takeover) fail('no session.takeover broadcast after ack');
  const newId = takeover.session.id;
  if (newId.startsWith('live_')) fail('takeover session should be bridge-owned');
  if (takeover.session.nativeSessionId !== sessionA) fail('takeover lost the native session id');

  phone.send({ type: 'session.history', sessionId: newId });
  const hist = await phone.wait((m) => m.type === 'history' && m.sessionId === newId);
  const kinds = (hist.events ?? []).map((e) => e.event.kind);
  const texts = (hist.events ?? []).map((e) => e.event.text).filter(Boolean);
  if (!texts.includes('seed answer')) fail(`seeded transcript missing: ${texts}`);
  if (!texts.includes('hello from phone')) fail(`phone prompt missing from transcript: ${texts}`);
  console.log(`HANDOFF: takeover ${liveA.id} → ${newId}, transcript carried (${kinds.length} events)`);
}

// ---- handoff timeout: wrapper that never acks → phone gets an error ----
{
  phone.messages.length = 0;
  phone.send({ type: 'prompt', sessionId: liveB.id, text: 'this will time out' });
  const handoff = await wrapper.wait((m) => m.type === 'pty.handoff' && m.nativeSessionId === sessionB);
  if (!handoff) fail('no pty.handoff for session B');
  // deliberately no ack
  const err = await phone.wait((m) => m.type === 'error' && /did not hand/i.test(m.message ?? ''), 8000);
  if (!err) fail('no timeout error for unacked handoff');
  console.log('TIMEOUT: unacked handoff errors out cleanly');
}

phone.ws.close();
wrapper.ws.close();
server.close();
console.log('HANDOFF TEST PASSED');
process.exit(0);
