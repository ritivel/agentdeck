import { createServer, type IncomingMessage } from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager, adapters } from './sessions.js';
import type { Platform } from './events.js';

const VERSION = '0.1.0';

/** Git repos up to two levels under common code roots — cwd suggestions for new sessions. */
function suggestDirs(): string[] {
  const home = homedir();
  const roots = ['Repos', 'Projects', 'Code', 'dev', 'src', 'workspace', 'Developer']
    .map((d) => join(home, d))
    .filter(existsSync);
  const found: string[] = [];
  const scan = (dir: string, depth: number) => {
    if (found.length >= 100) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes('.git')) {
      found.push(dir);
      return;
    }
    if (depth <= 0) return;
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      scan(join(dir, name), depth - 1);
    }
  };
  for (const root of roots) scan(root, 3);
  return found.sort();
}

export interface BridgeServer {
  port: number;
  close(): void;
}

export async function startServer(port: number, token: string): Promise<BridgeServer> {
  const clients = new Set<WebSocket>();

  const broadcast = (msg: object) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  const manager = new SessionManager({
    onSessionUpdated: (session) => broadcast({ type: 'session.updated', session }),
    onSessionRemoved: (sessionId) => broadcast({ type: 'session.removed', sessionId }),
    onEvent: (sessionId, stored) => broadcast({ type: 'event', sessionId, ...stored }),
  });

  const platformAvailability: Record<string, { available: boolean }> = {};
  for (const [name, adapter] of Object.entries(adapters)) {
    platformAvailability[name] = { available: await adapter.available() };
  }

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: hostname(), version: VERSION }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));

    const reply = (msg: object) => ws.send(JSON.stringify(msg));

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return reply({ type: 'error', message: 'invalid JSON' });
      }
      try {
        handleMessage(msg, reply);
      } catch (err: any) {
        reply({ type: 'error', message: err.message, inReplyTo: msg?.type });
      }
    });

    function handleMessage(msg: any, reply: (m: object) => void) {
      switch (msg.type) {
        case 'hello':
          reply({
            type: 'welcome',
            serverName: hostname(),
            version: VERSION,
            platforms: platformAvailability,
            sessions: manager.list(),
          });
          break;
        case 'session.create': {
          const platform = msg.platform as Platform;
          if (!platformAvailability[platform]?.available) {
            throw new Error(`${platform} CLI is not installed on this machine`);
          }
          const session = manager.create({
            platform,
            cwd: msg.cwd,
            permissionMode: msg.permissionMode,
            model: msg.model,
            title: msg.title,
          });
          broadcast({ type: 'session.created', session });
          if (typeof msg.prompt === 'string' && msg.prompt.trim()) {
            manager.prompt(session.id, msg.prompt);
          }
          break;
        }
        case 'session.list':
          reply({ type: 'sessions', sessions: manager.list() });
          break;
        case 'session.history':
          reply({ type: 'history', sessionId: msg.sessionId, events: manager.history(msg.sessionId, msg.sinceSeq ?? 0) });
          break;
        case 'prompt':
          manager.prompt(msg.sessionId, String(msg.text ?? ''));
          break;
        case 'interrupt':
          manager.interrupt(msg.sessionId);
          break;
        case 'session.archive':
          manager.archive(msg.sessionId);
          break;
        case 'dirs.suggest':
          reply({ type: 'dirs', dirs: suggestDirs() });
          break;
        case 'ping':
          reply({ type: 'pong' });
          break;
        default:
          reply({ type: 'error', message: `unknown message type: ${msg.type}` });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '0.0.0.0', resolve);
  });

  return {
    port,
    close() {
      manager.disposeAll();
      wss.close();
      httpServer.close();
    },
  };
}
