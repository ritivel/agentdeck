import { realpathSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import WebSocket from 'ws';
import { scanClaudeSessions } from './live/claudeTranscripts.js';

/**
 * `agentdeck claude [args…]` — run the real interactive Claude Code TUI inside a
 * PTY the bridge can type into. This is what makes a terminal session two-way:
 * a prompt sent from the phone is injected here as keystrokes (so it shows up in
 * your terminal exactly as if you typed it), and the transcript watcher mirrors
 * everything back to the phone. One process, no forks — every device is a thin
 * client into this session.
 *
 * The wrapper is transparent: raw stdio passthrough, resize forwarding, same
 * exit code. If the bridge isn't running it silently degrades to plain `claude`.
 */

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

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

/** Maintain a registration with the bridge; inject phone input into the PTY. */
function connectToBridge(port: number, token: string, nativeSessionId: string, cwd: string, pty: IPty, stopped: () => boolean) {
  let ws: WebSocket | undefined;
  const connect = () => {
    if (stopped()) return;
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    ws.on('open', () => {
      ws!.send(JSON.stringify({ type: 'pty.register', nativeSessionId, cwd }));
    });
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'pty.input' && typeof msg.text === 'string' && msg.text.length) {
        // Bracketed paste keeps embedded newlines from submitting early; the
        // trailing CR submits the message like pressing Enter.
        pty.write(BRACKETED_PASTE_START + msg.text + BRACKETED_PASTE_END + '\r');
      } else if (msg.type === 'pty.interrupt') {
        pty.write('\x1b'); // Escape interrupts the current turn in the Claude TUI
      }
    });
    const retry = () => {
      ws = undefined;
      if (!stopped()) setTimeout(connect, 3000).unref?.();
    };
    ws.on('close', retry);
    ws.on('error', () => ws?.close());
  };
  connect();
  return () => ws?.close();
}

export async function runWrappedClaude(claudeArgs: string[], port: number, cwd = process.cwd()): Promise<void> {
  const startedAt = Date.now();
  const resumeIdx = claudeArgs.indexOf('--resume');
  const knownId = resumeIdx >= 0 ? claudeArgs[resumeIdx + 1] : undefined;

  // Strip nested-claude markers: when they leak in (e.g. the wrapper itself is
  // launched from inside a Claude session), claude treats the child as nested
  // and suppresses transcript persistence — which kills live mirroring.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')) env[k] = v;
  }

  const pty = ptySpawn('claude', claudeArgs, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd,
    env,
  });

  // Transparent passthrough.
  pty.onData((d) => process.stdout.write(d));
  const stdinWasRaw = process.stdin.isTTY ? process.stdin.isRaw : undefined;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const onStdin = (d: Buffer) => pty.write(d.toString());
  process.stdin.on('data', onStdin);
  const onResize = () => pty.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  process.stdout.on('resize', onResize);

  let exited = false;
  let closeBridge: (() => void) | undefined;
  pty.onExit(({ exitCode }) => {
    exited = true;
    closeBridge?.();
    process.stdin.off('data', onStdin);
    process.stdout.off('resize', onResize);
    if (process.stdin.isTTY && stdinWasRaw !== undefined) process.stdin.setRawMode(stdinWasRaw);
    process.stdin.pause();
    process.exit(exitCode);
  });

  // Register with the bridge in the background; the terminal never waits on this.
  const token = loadToken();
  if (token) {
    void detectSessionId(cwd, startedAt, () => exited, knownId).then((id) => {
      if (id && !exited) closeBridge = connectToBridge(port, token, id, cwd, pty, () => exited);
    });
  }
}
