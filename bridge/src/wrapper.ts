import { realpathSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import WebSocket from 'ws';
import { scanClaudeSessions } from './live/claudeTranscripts.js';

/**
 * `agentdeck claude [args…]` — run the real interactive Claude Code TUI under a
 * wrapper that makes the session two-way with the phone, WhatsApp-style:
 *
 * - LOCAL mode: the genuine TUI runs in this terminal; the bridge mirrors the
 *   transcript to every device (read-only + interrupt).
 * - A message sent from the phone triggers a HANDOFF: the wrapper stops the
 *   local TUI (same session id, transcript already on disk), acks the bridge,
 *   and the bridge resumes the session itself (`claude -p --resume`) to run the
 *   phone's prompt. The terminal shows a live activity banner.
 * - REMOTE mode: press any key to take the session back — the wrapper asks the
 *   bridge to release it, then respawns the TUI with `--resume`. Ctrl+C instead
 *   leaves the session to the phone and exits the wrapper.
 *
 * One session, one owner at a time, instant lossless switching in both
 * directions. If the bridge isn't running this degrades to plain `claude`.
 */

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

type Mode = 'local' | 'handoff' | 'remote' | 'reclaiming' | 'done';

function loadToken(): string | undefined {
  if (process.env.AGENTDECK_TOKEN) return process.env.AGENTDECK_TOKEN.trim();
  try {
    return readFileSync(join(homedir(), '.agentdeck', 'token'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Find the session this claude process is writing, by cwd + freshness. A fresh
 * interactive session only creates its transcript on the first message, so keep
 * polling (cheaply) until the process exits.
 */
async function detectSessionId(cwd: string, startedAt: number, stopped: () => boolean, knownId?: string): Promise<string | undefined> {
  if (knownId) return knownId;
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // keep as-is
  }
  while (!stopped()) {
    try {
      const metas = await scanClaudeSessions({ maxAgeMs: Date.now() - startedAt + 2000, limit: 10 });
      const mine = metas.find((m) => m.cwd === real && m.updatedAt >= startedAt - 2000);
      if (mine) return mine.nativeSessionId;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return undefined;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export async function runWrappedClaude(claudeArgs: string[], port: number, cwd = process.cwd()): Promise<void> {
  const startedAt = Date.now();
  const resumeIdx = claudeArgs.indexOf('--resume');
  let nativeSessionId: string | undefined = resumeIdx >= 0 ? claudeArgs[resumeIdx + 1] : undefined;

  let mode: Mode = 'local';
  let pty: IPty | undefined;
  let ws: WebSocket | undefined;
  let registered = false;
  /** Bridge session id once the bridge has taken the session over (remote mode). */
  let remoteSessionId: string | undefined;
  let activityLine = '';

  // Strip nested-claude markers: when they leak in (e.g. the wrapper itself is
  // launched from inside a Claude session), claude treats the child as nested
  // and suppresses transcript persistence — which kills live mirroring.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')) env[k] = v;
  }

  const cols = () => process.stdout.columns || 80;
  const rows = () => process.stdout.rows || 24;

  const spawnInner = (args: string[]) => {
    const child = ptySpawn('claude', args, {
      name: process.env.TERM || 'xterm-256color',
      cols: cols(),
      rows: rows(),
      cwd,
      env,
    });
    pty = child;
    child.onData((d) => {
      if (mode === 'local') process.stdout.write(d);
    });
    child.onExit(({ exitCode }) => {
      if (pty !== child) return;
      pty = undefined;
      if (mode === 'local' || mode === 'done') {
        finish(exitCode);
      } else if (mode === 'handoff') {
        // The TUI is down and the transcript is flushed — the bridge may resume.
        sendWs({ type: 'pty.handoff-ack', nativeSessionId });
        enterRemote();
      }
    });
  };

  const sendWs = (msg: object) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const registerIfReady = () => {
    if (mode === 'local' && nativeSessionId && ws?.readyState === WebSocket.OPEN && !registered) {
      registered = true;
      sendWs({ type: 'pty.register', nativeSessionId, cwd });
    }
  };

  // ---------- remote-mode banner ----------

  const renderBanner = () => {
    const line = '─'.repeat(Math.min(cols(), 60));
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen, home
    process.stdout.write(`\n  📱  ${bold('Session continued from your phone')}\n`);
    process.stdout.write(`  ${dim(cwd)}\n  ${dim(line)}\n`);
    process.stdout.write(`  ${bold('Press any key')} to take the session back here.\n`);
    process.stdout.write(`  ${dim('Ctrl+C leaves it on the phone and closes this window.')}\n  ${dim(line)}\n\n`);
    if (activityLine) process.stdout.write(`  ${dim(activityLine)}\n`);
  };

  const showActivity = (text: string) => {
    activityLine = text.replace(/\s+/g, ' ').slice(0, Math.max(20, cols() - 6));
    if (mode === 'remote') {
      process.stdout.write(`\r\x1b[2K  ${dim(activityLine)}`);
    }
  };

  const enterRemote = () => {
    mode = 'remote';
    registered = false;
    renderBanner();
  };

  // ---------- handoff / reclaim ----------

  const startHandoff = () => {
    if (mode !== 'local' || !pty) return;
    mode = 'handoff';
    const child = pty;
    child.kill(); // SIGHUP; the TUI exits and flushes
    setTimeout(() => {
      // Safety: if it ignored SIGHUP, force it — the phone is waiting.
      if (mode === 'handoff' && pty === child) child.kill('SIGKILL');
    }, 3000).unref?.();
  };

  const reclaim = () => {
    if (mode !== 'remote') return;
    mode = 'reclaiming';
    process.stdout.write(`\n\n  ${bold('Taking the session back…')}\n`);
    const fallback = setTimeout(() => {
      // Bridge unreachable or slow — resume anyway; worst case the bridge's
      // process is still flushing and claude tells us the session is busy.
      if (mode === 'reclaiming') respawnLocal();
    }, 15_000);
    fallback.unref?.();
    const onReleased = (msg: any) => {
      if (mode !== 'reclaiming') return;
      if (msg.type === 'released' && (msg.nativeSessionId === nativeSessionId || msg.sessionId === remoteSessionId)) {
        clearTimeout(fallback);
        if (msg.nativeSessionId) nativeSessionId = msg.nativeSessionId;
        respawnLocal();
      } else if (msg.type === 'error' && msg.inReplyTo === 'session.release') {
        clearTimeout(fallback);
        respawnLocal();
      }
    };
    releaseListeners.push(onReleased);
    if (remoteSessionId && ws?.readyState === WebSocket.OPEN) {
      sendWs({ type: 'session.release', sessionId: remoteSessionId });
    } else {
      // We never saw the takeover session (or the socket is down): just resume.
      clearTimeout(fallback);
      respawnLocal();
    }
  };

  const respawnLocal = () => {
    if (mode === 'done') return;
    mode = 'local';
    remoteSessionId = undefined;
    activityLine = '';
    process.stdout.write('\x1b[2J\x1b[H');
    if (!nativeSessionId) {
      finish(1, 'Cannot resume: the session id was never detected.');
      return;
    }
    spawnInner(['--resume', nativeSessionId]);
    registerIfReady();
  };

  const releaseListeners: Array<(msg: any) => void> = [];

  // ---------- bridge connection ----------

  const token = loadToken();
  const connect = () => {
    if (mode === 'done' || !token) return;
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    ws.on('open', () => {
      registered = false;
      registerIfReady();
    });
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      for (const l of [...releaseListeners]) l(msg);

      switch (msg.type) {
        case 'pty.input':
          // Explicit "type into the terminal" (legacy / power path).
          if (mode === 'local' && pty && typeof msg.text === 'string' && msg.text.length) {
            pty.write(BRACKETED_PASTE_START + msg.text + BRACKETED_PASTE_END + '\r');
          }
          break;
        case 'pty.interrupt':
          if (mode === 'local' && pty) pty.write('\x1b'); // ESC stops the current turn
          break;
        case 'pty.handoff':
          if (msg.nativeSessionId === nativeSessionId) startHandoff();
          break;
        case 'session.created':
        case 'session.takeover': {
          // The bridge session that resumed our native session — that's the
          // remote owner; track it so keypress-reclaim knows what to release.
          const s = msg.session ?? msg;
          if ((mode === 'handoff' || mode === 'remote') && s?.nativeSessionId === nativeSessionId && !String(s.id).startsWith('live_')) {
            remoteSessionId = s.id;
          }
          break;
        }
        case 'event': {
          if (mode !== 'remote' || !remoteSessionId || msg.sessionId !== remoteSessionId) break;
          const e = msg.event ?? {};
          if (e.kind === 'user') showActivity(`📱 you: ${e.text}`);
          else if (e.kind === 'text') showActivity(`claude: ${e.text}`);
          else if (e.kind === 'tool.start') showActivity(`🔧 ${e.toolName}`);
          else if (e.kind === 'turn.end') showActivity('turn finished — press any key to take over');
          break;
        }
      }
    });
    const retry = () => {
      ws = undefined;
      registered = false;
      if (mode !== 'done') setTimeout(connect, 3000).unref?.();
    };
    ws.on('close', retry);
    ws.on('error', () => ws?.close());
  };

  // ---------- terminal plumbing ----------

  const stdinWasRaw = process.stdin.isTTY ? process.stdin.isRaw : undefined;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const onStdin = (d: Buffer) => {
    if (mode === 'local' && pty) {
      pty.write(d.toString());
    } else if (mode === 'remote') {
      if (d.includes(0x03)) {
        // Ctrl+C: leave the session running on the phone.
        process.stdout.write(`\n  ${dim('Session stays on your phone. Run `agentdeck resume` to bring it back.')}\n`);
        finish(0);
      } else {
        reclaim();
      }
    } else if (mode === 'reclaiming' && d.includes(0x03)) {
      finish(0);
    }
  };
  process.stdin.on('data', onStdin);
  const onResize = () => {
    if (mode === 'local') pty?.resize(cols(), rows());
    else if (mode === 'remote') renderBanner();
  };
  process.stdout.on('resize', onResize);

  const finish = (exitCode: number, message?: string) => {
    if (mode === 'done') return;
    mode = 'done';
    if (message) console.error(message);
    try {
      ws?.close();
    } catch {
      // ignore
    }
    process.stdin.off('data', onStdin);
    process.stdout.off('resize', onResize);
    if (process.stdin.isTTY && stdinWasRaw !== undefined) process.stdin.setRawMode(stdinWasRaw);
    process.stdin.pause();
    process.exit(exitCode);
  };

  // ---------- boot ----------

  spawnInner(claudeArgs);
  if (token) {
    connect();
    void detectSessionId(cwd, startedAt, () => mode === 'done', nativeSessionId).then((id) => {
      if (id && mode !== 'done') {
        nativeSessionId = id;
        registerIfReady();
      }
    });
  }
}
