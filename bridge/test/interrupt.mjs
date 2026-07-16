import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const token = readFileSync(join(homedir(), '.agentdeck', 'token'), 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${encodeURIComponent(token)}`);
let sessionId, interrupted = false, t0;
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello' })));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'welcome') ws.send(JSON.stringify({ type: 'session.create', platform: 'claude', cwd: '/tmp/agentdeck-e2e', model: 'haiku', prompt: 'Count from 1 to 200 slowly, writing a short sentence about each number. Do not stop early.' }));
  else if (msg.type === 'session.created') {
    sessionId = msg.session.id;
    t0 = Date.now();
    setTimeout(() => { console.log('SENDING INTERRUPT at', Date.now() - t0, 'ms'); interrupted = true; ws.send(JSON.stringify({ type: 'interrupt', sessionId })); }, 6000);
  } else if (msg.type === 'event' && msg.sessionId === sessionId) {
    if (msg.event.kind === 'turn.end') {
      console.log('TURN END after', Date.now() - t0, 'ms, interrupted =', interrupted, 'isError =', msg.event.isError);
      ws.send(JSON.stringify({ type: 'session.archive', sessionId }));
    }
  } else if (msg.type === 'session.removed') { console.log('INTERRUPT TEST DONE'); process.exit(0); }
  else if (msg.type === 'error') { console.error('ERR', msg.message); process.exit(1); }
});
