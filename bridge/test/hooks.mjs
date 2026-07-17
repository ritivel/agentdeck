// Phone-approval e2e test: real bridge server, real HTTP hook calls, real WS
// clients — no agent CLIs required. Also exercises the settings.json installer
// against the fixture HOME.
//   npx tsx test/hooks.mjs            (parent: re-execs itself with temp HOME)
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';

if (!process.env.AGENTDECK_HOOKS_TEST_HOME) {
  const home = join(tmpdir(), `agentdeck-hooks-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  const r = spawnSync(process.execPath, process.execArgv.concat([process.argv[1]]), {
    stdio: 'inherit',
    env: { ...process.env, HOME: home, AGENTDECK_HOOKS_TEST_HOME: home },
  });
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

const HOME = process.env.AGENTDECK_HOOKS_TEST_HOME;
const PORT = 19100 + (process.pid % 700);
const TOKEN = 'hooks-test-token';

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startServer } = await import('../src/server.ts');
const server = await startServer(PORT, TOKEN, { watchLive: false });

// ---------- tiny WS test client ----------

const { default: WebSocket } = await import('ws');

function wsClient() {
  const messages = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const client = {
    ws,
    messages,
    send: (m) => ws.send(JSON.stringify(m)),
    async wait(pred, timeoutMs = 5000) {
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

const hookPost = (path, body, extra = {}) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agentdeck-token': TOKEN, ...extra.headers },
    body: JSON.stringify(body),
  });

// ---------- auth ----------

{
  const res = await fetch(`http://127.0.0.1:${PORT}/hooks/pre-tool-use`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentdeck-token': 'wrong' }, body: '{}',
  });
  if (res.status !== 401) fail(`bad token: expected 401, got ${res.status}`);
  console.log('AUTH: bad token rejected');
}

// ---------- no phone connected → immediate ask ----------

{
  const res = await hookPost('/hooks/pre-tool-use', { session_id: 'nope', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const body = await res.json();
  if (body.decision !== 'ask') fail(`no-phone: expected ask, got ${JSON.stringify(body)}`);
  console.log('NO PHONE: defers to normal flow');
}

// ---------- phone allows ----------

const phone = await wsClient();
phone.send({ type: 'hello', clientName: 'test-phone' });
const welcome = await phone.wait((m) => m.type === 'welcome');
if (!welcome) fail('no welcome');
if (!Array.isArray(welcome.permissions)) fail('welcome missing permissions[]');

{
  const pending = hookPost('/hooks/pre-tool-use', { session_id: 'term-1', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, cwd: '/tmp/x' });
  const req = await phone.wait((m) => m.type === 'permission.request');
  if (!req) fail('phone never received permission.request');
  if (req.request.toolName !== 'Bash') fail(`toolName: ${req.request.toolName}`);
  if (req.request.input?.command !== 'rm -rf build') fail(`input lost: ${JSON.stringify(req.request.input)}`);
  phone.send({ type: 'permission.respond', id: req.request.id, decision: 'allow' });
  const res = await (await pending).json();
  if (res.decision !== 'allow') fail(`expected allow, got ${JSON.stringify(res)}`);
  const resolved = await phone.wait((m) => m.type === 'permission.resolved' && m.id === req.request.id);
  if (!resolved || resolved.decision !== 'allow') fail('permission.resolved not broadcast');
  console.log('ALLOW: phone approval reached the hook');
}

// ---------- phone denies ----------

{
  const pending = hookPost('/hooks/pre-tool-use', { session_id: 'term-1', tool_name: 'Write', tool_input: { file_path: '/etc/passwd' } });
  const req = await phone.wait((m) => m.type === 'permission.request' && m.request.toolName === 'Write');
  phone.send({ type: 'permission.respond', id: req.request.id, decision: 'deny', reason: 'nope' });
  const res = await (await pending).json();
  if (res.decision !== 'deny' || res.reason !== 'nope') fail(`expected deny/nope, got ${JSON.stringify(res)}`);
  console.log('DENY: phone denial reached the hook');
}

// ---------- second client sees pending card in welcome ----------

{
  const pending = hookPost('/hooks/pre-tool-use', { session_id: 'term-2', tool_name: 'Bash', tool_input: { command: 'make deploy' } });
  await phone.wait((m) => m.type === 'permission.request' && m.request.input?.command === 'make deploy');
  const phone2 = await wsClient();
  phone2.send({ type: 'hello', clientName: 'test-phone-2' });
  const w2 = await phone2.wait((m) => m.type === 'welcome');
  const card = (w2.permissions ?? []).find((r) => r.input?.command === 'make deploy');
  if (!card) fail('reconnecting client did not see the pending approval');
  phone2.send({ type: 'permission.respond', id: card.id, decision: 'allow' });
  const res = await (await pending).json();
  if (res.decision !== 'allow') fail('second client answer did not resolve the hook');
  phone2.ws.close();
  console.log('RESYNC: pending card visible to a fresh client');
}

// ---------- presence gating (terminal sessions need a watching phone) ----------

{
  phone.send({ type: 'presence', active: false });
  await sleep(100);
  const res = await (await hookPost('/hooks/pre-tool-use', { session_id: 'term-3', tool_name: 'Bash', tool_input: { command: 'ls' } })).json();
  if (res.decision !== 'ask') fail(`backgrounded phone should not hold the TUI: ${JSON.stringify(res)}`);
  phone.send({ type: 'presence', active: true });
  console.log('PRESENCE: backgrounded phone defers instantly');
}

// ---------- notification hook → alert broadcast ----------

{
  await hookPost('/hooks/notification', { session_id: 'term-9', message: 'Claude needs your permission' });
  const alert = await phone.wait((m) => m.type === 'alert' && m.kind === 'notification');
  if (!alert || !alert.body.includes('needs your permission')) fail(`alert not broadcast: ${JSON.stringify(alert)}`);
  console.log('ALERT: notification hook broadcast');
}

// ---------- the real hook binary end-to-end ----------

{
  const child = spawn('npx', ['tsx', 'src/index.ts', 'hook', 'pre-tool-use', '--port', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, AGENTDECK_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stdin.write(JSON.stringify({ session_id: 'term-bin', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } }));
  child.stdin.end();
  const req = await phone.wait((m) => m.type === 'permission.request' && m.request.input?.command === 'git push', 20000);
  if (!req) fail('hook binary request never arrived');
  phone.send({ type: 'permission.respond', id: req.request.id, decision: 'allow' });
  await new Promise((r) => child.on('exit', r));
  let parsed;
  try { parsed = JSON.parse(out); } catch { fail(`hook binary stdout not JSON: "${out}"`); }
  if (parsed.hookSpecificOutput?.permissionDecision !== 'allow') fail(`hook binary output: ${out}`);
  console.log('HOOK BINARY: stdin→bridge→phone→stdout decision OK');
}

// ---------- installer round-trip (fixture HOME) ----------

{
  const { runHooksCommand } = await import('../src/hooks.ts');
  runHooksCommand(['install'], PORT);
  const settings = JSON.parse(readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8'));
  for (const ev of ['PreToolUse', 'Notification', 'Stop']) {
    const ours = (settings.hooks?.[ev] ?? []).filter((g) => g.hooks?.some((h) => h.command.includes('# agentdeck-hook')));
    if (ours.length !== 1) fail(`installer: expected 1 ${ev} entry, got ${ours.length}`);
  }
  runHooksCommand(['install'], PORT); // idempotent
  const again = JSON.parse(readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8'));
  if ((again.hooks.PreToolUse ?? []).length !== 1) fail('installer not idempotent');
  runHooksCommand(['uninstall'], PORT);
  const cleaned = JSON.parse(readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8'));
  if (cleaned.hooks) fail('uninstall left hooks behind');
  console.log('INSTALLER: install/idempotent/uninstall OK');
}

// ---------- broker timeout (fast, direct) ----------

{
  const { PermissionBroker } = await import('../src/permissions.ts');
  let requested, resolved;
  const broker = new PermissionBroker({ onRequest: (r) => { requested = r; }, onResolved: (r) => { resolved = r; } });
  const res = await broker.request({ platform: 'claude', toolName: 'Bash', timeoutMs: 120 });
  if (res.decision !== 'ask' || res.resolvedBy !== 'timeout') fail(`broker timeout: ${JSON.stringify(res)}`);
  if (!requested || resolved?.id !== res.id) fail('broker callbacks missing');
  if (broker.respond(res.id, 'allow')) fail('respond after timeout should be rejected');
  console.log('BROKER: timeout resolves as ask');
}

phone.ws.close();
server.close();
console.log('HOOKS TEST PASSED');
process.exit(0);
