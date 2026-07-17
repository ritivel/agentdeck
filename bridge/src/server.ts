import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager, adapters } from './sessions.js';
import { DismissedSessions } from './dismissed.js';
import { LiveWatcher } from './live/watcher.js';
import { claudeSource } from './live/claudeTranscripts.js';
import { codexSource } from './live/codexTranscripts.js';
import { cursorSource } from './live/cursorTranscripts.js';
import { PermissionBroker } from './permissions.js';
import { setCodexPermissionRelay } from './adapters/codexAppServer.js';
import type { Platform } from './events.js';

/** Tools auto-approved by a permission mode — no point asking the phone. */
function autoAllowedByMode(permissionMode: string, toolName: string): boolean {
  if (permissionMode === 'bypassPermissions') return true;
  if (permissionMode === 'acceptEdits') {
    return ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName);
  }
  return false;
}

/** Cap tool input for transport; big inputs become a truncated JSON string. */
function compactInput(input: unknown): unknown {
  try {
    const s = JSON.stringify(input);
    if (s === undefined) return undefined;
    return s.length <= 4000 ? input : s.slice(0, 4000) + '…';
  } catch {
    return String(input).slice(0, 4000);
  }
}

function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Version from package.json (dist/index.js and src/…ts both sit one level below it). */
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8')).version;
      if (typeof v === 'string') return v;
    } catch {
      // keep looking
    }
  }
  return '0.0.0';
}
export const VERSION = readVersion();

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

/** The bundled mobile web app: dist/web when built/packaged, ../web in dev. */
function webRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, 'web'), join(here, '..', '..', 'web')]) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(root: string, urlPath: string, res: ServerResponse): boolean {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  // No traversal, no hidden files.
  if (rel.includes('..') || rel.startsWith('.')) return false;
  const file = normalize(join(root, rel));
  if (!file.startsWith(root) || !existsSync(file)) return false;
  const ext = file.slice(file.lastIndexOf('.'));
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
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
  // (nativeSessionId → the wrapper's socket). A prompt for one of these hands
  // the session off: the wrapper stops the local TUI, the bridge resumes the
  // same session and runs the phone's prompt (no fork, one owner at a time).
  const ptyRegistry = new Map<string, WebSocket>();

  // Handoffs awaiting the wrapper's ack that its TUI has exited. Prompts that
  // arrive mid-handoff queue up and run on the taken-over session.
  interface HandoffWaiter { text: string; reply: (msg: object) => void }
  const pendingHandoffs = new Map<string, { queue: HandoffWaiter[]; timer: NodeJS.Timeout }>();

  // Clients that completed the hello handshake (phones/web/CLI — not wrappers).
  const helloClients = new Set<WebSocket>();
  // Subset that is currently foregrounded (presence messages / hello default).
  // Approvals for TERMINAL sessions only relay when someone is actually looking,
  // so a phone in a pocket never stalls the TUI's own permission prompt.
  const activeClients = new Set<WebSocket>();

  const broker = new PermissionBroker({
    onRequest: (request) => broadcast({ type: 'permission.request', request }),
    onResolved: (resolution, request) =>
      broadcast({ type: 'permission.resolved', id: resolution.id, decision: resolution.decision, resolvedBy: resolution.resolvedBy, sessionId: request.sessionId }),
  });

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
    return session;
  };

  /** Session (bridge-owned or live mirror) for a platform-native session id. */
  const sessionByNativeId = (nativeSessionId: string) =>
    manager.list().find((s) => s.nativeSessionId === nativeSessionId) ??
    liveWatcher.list().find((s) => s.nativeSessionId === nativeSessionId);

  // Codex app-server approvals (experimental adapter) ride the same broker as
  // Claude hooks — approval cards look identical on the phone.
  setCodexPermissionRelay(async ({ toolName, input, cwd, nativeSessionId }) => {
    if (!anyPhoneConnected()) return 'deny';
    const session = nativeSessionId ? sessionByNativeId(nativeSessionId) : undefined;
    const resolution = await broker.request({
      sessionId: session?.id,
      nativeSessionId,
      platform: 'codex',
      toolName,
      input: compactInput(input),
      cwd,
      timeoutMs: 45_000,
    });
    return resolution.decision === 'allow' ? 'allow' : 'deny';
  });

  const anyPhoneConnected = () =>
    [...helloClients].some((ws) => ws.readyState === WebSocket.OPEN);
  const anyPhoneWatching = () =>
    [...activeClients].some((ws) => ws.readyState === WebSocket.OPEN);

  /**
   * PreToolUse hook relay: ask connected phones to approve a tool call, fall
   * back to 'ask' (Claude's normal permission flow) on timeout or when nobody
   * is listening — the hook can only ever add a decision, never remove one.
   *
   * Bridge-owned sessions have no other permission surface, so any connected
   * phone gets asked (45s). Terminal sessions have the TUI prompt as fallback,
   * so they only relay when a phone is actually foregrounded (30s).
   */
  const handlePreToolUseHook = async (body: any, res: ServerResponse) => {
    const toolName = String(body.tool_name ?? 'unknown');
    const nativeSessionId = body.session_id ? String(body.session_id) : undefined;
    const session = nativeSessionId ? sessionByNativeId(nativeSessionId) : undefined;

    const bridgeOwned = session && !session.attached;
    if (bridgeOwned && autoAllowedByMode(session.permissionMode, toolName)) {
      return respondJson(res, 200, { decision: 'ask' });
    }
    if (bridgeOwned ? !anyPhoneConnected() : !anyPhoneWatching()) {
      return respondJson(res, 200, { decision: 'ask' });
    }
    const resolution = await broker.request({
      sessionId: session?.id,
      nativeSessionId,
      platform: 'claude',
      toolName,
      input: compactInput(body.tool_input),
      cwd: body.cwd ? String(body.cwd) : undefined,
      timeoutMs: bridgeOwned ? 45_000 : 30_000,
    });
    respondJson(res, 200, { decision: resolution.decision, reason: resolution.reason });
  };

  /** Notification/Stop hook relay → alert broadcast (phones show notifications). */
  const handleAlertHook = (kind: 'notification' | 'stop', body: any, res: ServerResponse) => {
    const nativeSessionId = body.session_id ? String(body.session_id) : undefined;
    const session = nativeSessionId ? sessionByNativeId(nativeSessionId) : undefined;
    // Bridge-owned sessions already stream turn.end/permission events to phones.
    if (!session || session.attached) {
      broadcast({
        type: 'alert',
        kind,
        sessionId: session?.id,
        title: kind === 'stop' ? 'Claude finished' : 'Claude needs attention',
        body: typeof body.message === 'string' ? body.message.slice(0, 300) : (session?.title ?? ''),
        cwd: body.cwd ? String(body.cwd) : undefined,
      });
    }
    respondJson(res, 200, { ok: true });
  };

  const platformAvailability: Record<string, { available: boolean }> = {};
  for (const [name, adapter] of Object.entries(adapters)) {
    platformAvailability[name] = { available: await adapter.available() };
  }

  const web = webRoot();

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: hostname(), version: VERSION }));
      return;
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    // Claude Code hook callbacks (`agentdeck hook …`), authed with the pairing token.
    if (req.method === 'POST' && path.startsWith('/hooks/')) {
      if (req.headers['x-agentdeck-token'] !== token) {
        return respondJson(res, 401, { error: 'unauthorized' });
      }
      readBody(req)
        .then((body) => {
          if (path === '/hooks/pre-tool-use') return handlePreToolUseHook(body, res);
          if (path === '/hooks/notification') return handleAlertHook('notification', body, res);
          if (path === '/hooks/stop') return handleAlertHook('stop', body, res);
          respondJson(res, 404, { error: 'unknown hook' });
        })
        .catch((err) => respondJson(res, 400, { error: err.message }));
      return;
    }

    // The mobile web app (token still required to open the WebSocket).
    if (web && req.method === 'GET' && serveStatic(web, path, res)) return;
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
      helloClients.delete(ws);
      activeClients.delete(ws);
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
          helloClients.add(ws);
          activeClients.add(ws); // foregrounded until it says otherwise
          reply({
            type: 'welcome',
            serverName: hostname(),
            version: VERSION,
            platforms: platformAvailability,
            sessions: allSessions(),
            permissions: broker.list(),
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
            const nativeId = live.info.nativeSessionId;
            const pty = nativeId ? ptyRegistry.get(nativeId) : undefined;
            if (pty && pty.readyState === WebSocket.OPEN && nativeId) {
              if (msg.mode === 'type') {
                // Power path: literally type it into the terminal TUI.
                pty.send(JSON.stringify({ type: 'pty.input', text }));
                break;
              }
              // Baton pass: ask the wrapper to stop the local TUI, then resume
              // the same session here and run the phone's prompt. Prompts that
              // arrive while the handoff is in flight queue up behind it.
              const inflight = pendingHandoffs.get(nativeId);
              if (inflight) {
                inflight.queue.push({ text, reply });
                break;
              }
              const timer = setTimeout(() => {
                const entry = pendingHandoffs.get(nativeId);
                if (!entry) return;
                pendingHandoffs.delete(nativeId);
                for (const w of entry.queue) {
                  w.reply({ type: 'error', message: 'The terminal did not hand the session over. Is the agentdeck wrapper still running?', inReplyTo: 'prompt' });
                }
              }, 6000);
              timer.unref?.();
              pendingHandoffs.set(nativeId, { queue: [{ text, reply }], timer });
              pty.send(JSON.stringify({ type: 'pty.handoff', nativeSessionId: nativeId }));
              break;
            }
            takeoverLiveSession(live, text);
            break;
          }
          manager.prompt(msg.sessionId, String(msg.text ?? ''));
          break;
        }
        case 'pty.handoff-ack': {
          // The wrapper's TUI has exited; the session is free to resume.
          const nativeId = String(msg.nativeSessionId ?? '');
          const entry = pendingHandoffs.get(nativeId);
          if (!entry) break;
          pendingHandoffs.delete(nativeId);
          clearTimeout(entry.timer);
          if (ptyRegistry.get(nativeId) === ws) {
            ptyRegistry.delete(nativeId);
            ownedPtys.delete(nativeId);
          }
          const liveInfo = liveWatcher.list().find((s) => s.nativeSessionId === nativeId);
          const live = liveInfo ? liveWatcher.get(liveInfo.id) : undefined;
          const first = entry.queue.shift();
          if (!first) break;
          try {
            if (!live) throw new Error('The mirrored session disappeared during handoff.');
            const session = takeoverLiveSession(live, first.text);
            for (const w of entry.queue) manager.prompt(session.id, w.text);
          } catch (err: any) {
            for (const w of [first, ...entry.queue]) {
              w.reply({ type: 'error', message: err.message, inReplyTo: 'prompt' });
            }
          }
          break;
        }
        case 'permission.respond': {
          const decision = msg.decision === 'allow' || msg.decision === 'deny' ? msg.decision : undefined;
          if (!decision) throw new Error('permission.respond requires decision allow|deny');
          if (!broker.respond(String(msg.id ?? ''), decision, typeof msg.reason === 'string' ? msg.reason.slice(0, 300) : undefined)) {
            throw new Error('That permission request already expired.');
          }
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
        case 'presence':
          if (msg.active === false) activeClients.delete(ws);
          else if (helloClients.has(ws)) activeClients.add(ws);
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
      broker.dispose();
      for (const entry of pendingHandoffs.values()) clearTimeout(entry.timer);
      pendingHandoffs.clear();
      manager.disposeAll();
      liveWatcher.stop();
      wss.close();
      httpServer.close();
    },
  };
}
