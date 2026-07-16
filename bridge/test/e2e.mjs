// Minimal e2e smoke test: connects to a running bridge, creates a session on the
// given platform, sends a prompt, and prints every message until turn.end.
// Usage: node test/e2e.mjs <platform> <cwd> <prompt> [port]
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [platform = 'claude', cwd = process.cwd(), prompt = 'Reply with exactly PONG.', port = '8787'] = process.argv.slice(2);
const token = (process.env.AGENTDECK_TOKEN ?? readFileSync(join(homedir(), '.agentdeck', 'token'), 'utf8')).trim();

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
let sessionId;
const timeout = setTimeout(() => { console.error('E2E TIMEOUT'); process.exit(2); }, 120_000);

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', clientName: 'e2e-test' })));
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1); });
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'welcome') {
    console.log('WELCOME', JSON.stringify({ server: msg.serverName, platforms: msg.platforms }));
    ws.send(JSON.stringify({ type: 'session.create', platform, cwd, permissionMode: 'acceptEdits', model: 'haiku', prompt }));
  } else if (msg.type === 'session.created') {
    sessionId = msg.session.id;
    console.log('SESSION', JSON.stringify(msg.session));
  } else if (msg.type === 'event' && msg.sessionId === sessionId) {
    console.log(`EVENT[${msg.seq}]`, JSON.stringify(msg.event));
    if (msg.event.kind === 'turn.end') {
      ws.send(JSON.stringify({ type: 'session.history', sessionId }));
    }
  } else if (msg.type === 'history') {
    console.log('HISTORY_COUNT', msg.events.length);
    ws.send(JSON.stringify({ type: 'session.archive', sessionId }));
  } else if (msg.type === 'session.removed') {
    console.log('ARCHIVED OK');
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  } else if (msg.type === 'session.updated') {
    console.log('STATE', msg.session.state);
  } else if (msg.type === 'error') {
    console.error('SERVER ERROR', msg.message);
    process.exit(1);
  }
});
