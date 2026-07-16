import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const token = readFileSync(join(homedir(), '.agentdeck', 'token'), 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${encodeURIComponent(token)}`);
let sessionId, turns = 0;
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello' })));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'welcome') ws.send(JSON.stringify({ type: 'session.create', platform: 'claude', cwd: '/tmp/agentdeck-e2e', model: 'haiku', prompt: 'Remember the number 47. Reply OK.' }));
  else if (msg.type === 'session.created') { sessionId = msg.session.id; console.log('NATIVE_ID_AT_CREATE', msg.session.nativeSessionId ?? 'none'); }
  else if (msg.type === 'event' && msg.sessionId === sessionId) {
    if (msg.event.kind === 'text') console.log(`TURN${turns} TEXT:`, msg.event.text);
    if (msg.event.kind === 'turn.end') {
      turns++;
      if (turns === 1) ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'What number did I ask you to remember? Reply with just the number.' }));
      else { ws.send(JSON.stringify({ type: 'session.archive', sessionId })); }
    }
  } else if (msg.type === 'session.updated' && msg.session.nativeSessionId && !msg._n) { }
  else if (msg.type === 'session.removed') { console.log('MULTITURN OK'); process.exit(0); }
  else if (msg.type === 'error') { console.error('ERR', msg.message); process.exit(1); }
});
