import { createServer, type IncomingMessage } from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager, adapters } from './sessions.js';
import { DismissedSessions } from './dismissed.js';
import { LiveWatcher } from './live/watcher.js';
import { claudeSource } from './live/claudeTranscripts.js';
import { codexSource } from './live/codexTranscripts.js';
import { cursorSource } from './live/cursorTranscripts.js';
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

export async function startServer(port: number, token: string, opts: { watchLive?: boolean } = {}): Promise<BridgeServer> {
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

  const dismissed = new DismissedSessions();

  // Sessions handed off to a terminal (nativeSessionId → the bridge session id a
  // client may still have open). When the transcript resurfaces as a live mirror,
  // we broadcast a takeover so open views re-point to it seamlessly.
  const recentlyReleased = new Map<string, string>();

  // Terminal sessions running under the `agentdeck claude` PTY wrapper
  // (nativeSessionId → the wrapper's socket). Prompts for these are injected
  // into the terminal as keystrokes instead of forking a takeover process.
  const ptyRegistry = new Map<string, WebSocket>();

  const liveWatcher = new LiveWatcher([claudeSource, cursorSource, codexSource], {
    onSessionDiscovered: (session) => {
      broadcast({ type: 'session.created', session });
      const oldId = session.nativeSessionId ? recentlyReleased.get(session.nativeSessionId) : undefined;
      if (oldId) {
        recentlyReleased.delete(session.nativeSessionId!);
        broadcast({ type: 'session.takeover', fromSessionId: oldId, session });
      }
    },
    onSessionUpdated: (session) => broadcast({ type: 'session.updated', session }),
    onSessionRemoved: (sessionId) => broadcast({ type: 'session.removed', sessionId }),
    onEvent: (sessionId, stored) => broadcast({ type: 'event', sessionId, ...stored }),
    isBridgeOwned: (nativeSessionId) => manager.ownsNativeSession(nativeSessionId),
    isDismissed: (nativeSessionId, updatedAt) => dismissed.isDismissed(nativeSessionId, updatedAt),
    isControllable: (nativeSessionId) => ptyRegistry.has(nativeSessionId),
  });

  /** Combined view: bridge-spawned sessions plus discovered live terminal sessions. */
  const allSessions = () => [...manager.list(), ...liveWatcher.list()].sort((a, b) => b.updatedAt - a.updatedAt);

  /**
   * Take over a mirrored terminal session: spawn a bridge-owned process resuming the
   * same platform session, carry the mirrored transcript over, retire the live copy,
   * and deliver the prompt. The terminal's own process is untouched — if it keeps
   * being used there, it continues as a separate fork and reappears in the deck.
   */
  const takeoverLiveSession = (live: NonNullable<ReturnType<LiveWatcher['get']>>, text: string) => {
    const { info } = live;
    if (!info.nativeSessionId) throw new Error('Cannot take over this session: its id is not known yet.');
    if (!text.trim()) throw new Error('empty prompt');
    if (!platformAvailability[info.platform]?.available) {
      throw new Error(`Cannot take over this session: the ${info.platform} CLI is not installed on this machine.`);
    }
    const session = manager.create({
      platform: info.platform,
      cwd: info.cwd,
      permissionMode: 'acceptEdits',
      title: info.title,
      resumeNativeId: info.nativeSessionId,
      seedTranscript: live.transcript,
    });
    broadcast({ type: 'session.created', session });
    // Tell clients where the conversation moved before the old id disappears.
    broadcast({ type: 'session.takeover', fromSessionId: info.id, session });
    liveWatcher.dismiss(info.id);
    dismissed.dismiss(info.nativeSessionId);
    manager.prompt(session.id, text);
  };

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
    const ownedPtys = new Set<string>();
    ws.on('close', () => {
      clients.delete(ws);
      for (const nativeId of ownedPtys) {
        if (ptyRegistry.get(nativeId) === ws) {
          ptyRegistry.delete(nativeId);
          liveWatcher.refreshControllable(nativeId);
        }
      }
    });

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
            sessions: allSessions(),
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
          reply({ type: 'sessions', sessions: allSessions() });
          break;
        case 'session.history': {
          const sinceSeq = msg.sinceSeq ?? 0;
          const liveHistory = liveWatcher.history(msg.sessionId, sinceSeq);
          const events = liveHistory ?? manager.history(msg.sessionId, sinceSeq);
          reply({ type: 'history', sessionId: msg.sessionId, events });
          break;
        }
        case 'pty.register': {
          // An `agentdeck claude` wrapper announces it controls a terminal session.
          const nativeId = String(msg.nativeSessionId ?? '');
          if (!nativeId) throw new Error('pty.register requires nativeSessionId');
          ptyRegistry.set(nativeId, ws);
          ownedPtys.add(nativeId);
          liveWatcher.refreshControllable(nativeId);
          reply({ type: 'pty.registered', nativeSessionId: nativeId });
          break;
        }
        case 'prompt': {
          const live = liveWatcher.get(msg.sessionId);
          if (live) {
            const text = String(msg.text ?? '');
            const pty = live.info.nativeSessionId ? ptyRegistry.get(live.info.nativeSessionId) : undefined;
            if (pty && pty.readyState === WebSocket.OPEN) {
              // Type it into the terminal; the transcript tailer mirrors the
              // turn back to every device. No fork, no ownership change.
              pty.send(JSON.stringify({ type: 'pty.input', text }));
              break;
            }
            takeoverLiveSession(live, text);
            break;
          }
          manager.prompt(msg.sessionId, String(msg.text ?? ''));
          break;
        }
        case 'interrupt': {
          const live = liveWatcher.get(msg.sessionId);
          if (live) {
            const pty = live.info.nativeSessionId ? ptyRegistry.get(live.info.nativeSessionId) : undefined;
            if (pty && pty.readyState === WebSocket.OPEN) {
              pty.send(JSON.stringify({ type: 'pty.interrupt' }));
              break;
            }
            throw new Error('Cannot interrupt a terminal session from here. Send a message to take it over first.');
          }
          manager.interrupt(msg.sessionId);
          break;
        }
        case 'session.archive': {
          if (liveWatcher.get(msg.sessionId)) {
            // Hide a mirrored terminal session; it returns if it gets new activity.
            const nativeId = liveWatcher.dismiss(msg.sessionId);
            if (nativeId) dismissed.dismiss(nativeId);
            break;
          }
          // Remember the native id so the transcript left on disk doesn't
          // resurface this session as a read-only live entry. The grace window
          // covers the disposed process's final transcript flush (dispose ends
          // stdin, then SIGTERMs after 3s).
          const nativeId = manager.get(msg.sessionId)?.info.nativeSessionId;
          manager.archive(msg.sessionId);
          if (nativeId) dismissed.dismiss(nativeId, 15_000);
          break;
        }
        case 'session.release': {
          // Hand a session off to a terminal: stop our process (if we own it) and
          // tell the caller what to resume. The transcript then resurfaces as a
          // live mirror, so phones keep watching and can take it back by typing.
          const live = liveWatcher.get(msg.sessionId);
          if (live) {
            // Already terminal-owned; the mirror stays as-is.
            reply({ type: 'released', sessionId: msg.sessionId, nativeSessionId: live.info.nativeSessionId, cwd: live.info.cwd, title: live.info.title });
            break;
          }
          const s = manager.get(msg.sessionId);
          if (!s) throw new Error(`no such session: ${msg.sessionId}`);
          const { nativeSessionId, cwd, title } = s.info;
          manager
            .release(msg.sessionId)
            .then(() => {
              if (nativeSessionId) recentlyReleased.set(nativeSessionId, msg.sessionId);
              reply({ type: 'released', sessionId: msg.sessionId, nativeSessionId, cwd, title });
            })
            .catch((err: any) => reply({ type: 'error', message: err.message, inReplyTo: 'session.release' }));
          break;
        }
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

  if (opts.watchLive !== false) {
    liveWatcher.start().catch((err) => console.error(`live watcher failed to start: ${err.message}`));
  }

  return {
    port,
    close() {
      manager.disposeAll();
      liveWatcher.stop();
      wss.close();
      httpServer.close();
    },
  };
}
