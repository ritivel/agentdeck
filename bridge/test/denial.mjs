import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const token = readFileSync(join(homedir(), '.agentdeck', 'token'), 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${encodeURIComponent(token)}`);
let sessionId;
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello' })));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'welcome') ws.send(JSON.stringify({ type: 'session.create', platform: 'claude', cwd: '/tmp/agentdeck-e2e', model: 'haiku', permissionMode: 'manual', prompt: 'Run this exact bash command: osascript -e "beep". If you cannot run it, reply BLOCKED.' }));
  else if (msg.type === 'session.created') sessionId = msg.session.id;
  else if (msg.type === 'event' && msg.sessionId === sessionId) {
    const e = msg.event;
    if (e.kind === 'permission.denied') console.log('PERMISSION.DENIED for', e.toolName);
    if (e.kind === 'text') console.log('TEXT:', e.text.slice(0, 100));
    if (e.kind === 'tool.end' && e.isError) console.log('TOOL DENIED OUTPUT:', (e.output ?? '').slice(0, 120));
    if (e.kind === 'turn.end') { ws.send(JSON.stringify({ type: 'session.archive', sessionId })); }
  } else if (msg.type === 'session.removed') { console.log('DENIAL TEST DONE'); process.exit(0); }
  else if (msg.type === 'error') { console.error('ERR', msg.message); process.exit(1); }
});
