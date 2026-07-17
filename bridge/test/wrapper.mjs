// Baton-pass wrapper test: runs the REAL `agentdeck claude` wrapper under a PTY
// against the real bridge, with a fake `claude` binary on PATH (both TUI and
// stream-json modes). Exercises the full loop:
//   local TUI → phone prompt → handoff (TUI killed, banner) → takeover session
//   → keypress → release → TUI respawned with --resume.
//   npx tsx test/wrapper.mjs           (parent: re-execs itself with temp HOME)
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

if (!process.env.AGENTDECK_WRAPPER_TEST_HOME) {
  const home = join(tmpdir(), `agentdeck-wrapper-${Date.now()}`);
  const fakeBin = join(home, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });

  // Fake `claude`: interactive mode prints a marker and waits (exits on SIGHUP,
  // like the real TUI when its terminal goes away); -p stream-json mode speaks
  // just enough of the protocol for the takeover adapter.
  writeFileSync(join(fakeBin, 'claude'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const resumeIdx = args.indexOf('--resume');
const sessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : 'fresh-' + Date.now();
if (args.includes('-p')) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'user') {
        console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fake reply' }] } }));
        console.log(JSON.stringify({ type: 'result', result: 'fake reply', is_error: false }));
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  console.log('FAKE_TUI_UP resume=' + (resumeIdx >= 0 ? sessionId : 'none'));
  process.stdin.resume();
  process.on('SIGHUP', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
`);
  chmodSync(join(fakeBin, 'claude'), 0o755);

  const r = spawnSync(process.execPath, process.execArgv.concat([process.argv[1]]), {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      AGENTDECK_WRAPPER_TEST_HOME: home,
    },
  });
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

const HOME = process.env.AGENTDECK_WRAPPER_TEST_HOME;
const PORT = 19960 + (process.pid % 30);
const TOKEN = 'wrapper-test-token';
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fixture transcript so the live watcher mirrors the session.
const uuid = randomUUID();
const proj = join(HOME, 'proj');
mkdirSync(proj, { recursive: true });
const tdir = join(HOME, '.claude', 'projects', 'fixture');
mkdirSync(tdir, { recursive: true });
const line = (o) => JSON.stringify(o) + '\n';
writeFileSync(join(tdir, `${uuid}.jsonl`),
  line({ type: 'user', sessionId: uuid, cwd: proj, message: { content: 'seed' } }) +
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'seed answer' }] } }));

// Token file for the wrapper.
mkdirSync(join(HOME, '.agentdeck'), { recursive: true });
writeFileSync(join(HOME, '.agentdeck', 'token'), TOKEN);
process.env.AGENTDECK_TOKEN = TOKEN;

const { startServer } = await import('../src/server.ts');
const server = await startServer(PORT, TOKEN, { watchLive: true });

const { default: WebSocket } = await import('ws');
function wsClient() {
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

// Run the real wrapper under a PTY (it needs a TTY for raw mode).
const pty = await import('node-pty');
const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const entry = join(process.cwd(), 'src', 'index.ts');
const wrapperPty = pty.spawn(tsxBin, [entry, 'claude', '--resume', uuid, '--port', String(PORT)], {
  name: 'xterm-256color', cols: 100, rows: 30, cwd: proj, env: process.env,
});
let ptyOut = '';
wrapperPty.onData((d) => { ptyOut += d; });
const ptySee = async (pattern, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(ptyOut)) return true;
    await sleep(50);
  }
  return false;
};

if (!(await ptySee(/FAKE_TUI_UP resume=/))) fail(`TUI never started: ${ptyOut.slice(-300)}`);
console.log('LOCAL: fake TUI running under the wrapper');

const phone = await wsClient();
phone.send({ type: 'hello', clientName: 'test-phone' });
await phone.wait((m) => m.type === 'welcome');

// The wrapper registers its PTY (it knows the id from --resume) → writable mirror.
// Registration may predate our connection, so poll the session list.
let liveId;
{
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !liveId) {
    phone.send({ type: 'session.list' });
    const msg = await phone.wait((m) => m.type === 'sessions');
    phone.messages.splice(phone.messages.indexOf(msg), 1);
    const s = (msg?.sessions ?? []).find((x) => x.nativeSessionId === uuid && x.readOnly === false);
    if (s) { liveId = s.id; break; }
    await sleep(300);
  }
}
if (!liveId) fail('mirror never became writable (pty.register missing)');
console.log(`REGISTERED: ${liveId} controllable from the phone`);

// Phone sends a message → handoff → banner → takeover session runs the prompt.
phone.send({ type: 'prompt', sessionId: liveId, text: 'hello from the phone' });
if (!(await ptySee(/continued from your phone/i))) fail(`banner not shown: ${ptyOut.slice(-400)}`);
console.log('HANDOFF: TUI stopped, banner up');

const takeover = await phone.wait((m) => m.type === 'session.takeover' && m.fromSessionId === liveId);
if (!takeover) fail('no session.takeover');
const newId = takeover.session.id;
const reply = await phone.wait((m) => m.type === 'event' && m.sessionId === newId && m.event?.kind === 'text' && m.event.text === 'fake reply');
if (!reply) fail('takeover session never answered the phone prompt');
console.log(`REMOTE: ${newId} answered the phone (${JSON.stringify(reply.event.text)})`);

// Press a key in the terminal → wrapper releases the session and respawns the TUI.
await sleep(300);
wrapperPty.write('k');
const deadline = Date.now() + 20_000;
let reclaimed = false;
while (Date.now() < deadline) {
  const occurrences = ptyOut.split('FAKE_TUI_UP').length - 1;
  if (occurrences >= 2 && ptyOut.lastIndexOf(`resume=${uuid}`) > ptyOut.indexOf('FAKE_TUI_UP')) { reclaimed = true; break; }
  await sleep(100);
}
if (!reclaimed) fail(`TUI not respawned after keypress: ${ptyOut.slice(-400)}`);
const removed = await phone.wait((m) => m.type === 'session.removed' && m.sessionId === newId);
if (!removed) fail('bridge session not removed after release');
console.log('RECLAIM: keypress released the session and respawned the TUI');

// Ctrl+C in local mode goes to the (fake) TUI, which exits → wrapper exits.
wrapperPty.write('\x03');
const exited = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 8000);
  wrapperPty.onExit(() => { clearTimeout(t); resolve(true); });
});
if (!exited) { try { wrapperPty.kill(); } catch {} }

phone.ws.close();
server.close();
console.log('WRAPPER TEST PASSED');
process.exit(0);
