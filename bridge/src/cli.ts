import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { SessionInfo } from './events.js';
import { scanClaudeSessions } from './live/claudeTranscripts.js';
import { runWrappedClaude } from './wrapper.js';

/**
 * `agentdeck resume [query]` — continue a phone (or any) Claude Code session in
 * this terminal, WhatsApp-style: no ids, no copy-paste. Asks the running bridge
 * to release the session (so the transcript is flushed and the deck stays clean),
 * then execs `claude --resume` in the session's own working directory. Falls back
 * to scanning transcript files directly when no bridge is running.
 */

interface Candidate {
  title: string;
  cwd: string;
  nativeSessionId?: string;
  updatedAt: number;
  state?: string;
  /** Bridge session id, when a bridge is running (needed to release it). */
  bridgeId?: string;
  attached?: boolean;
}

function loadToken(): string {
  const env = process.env.AGENTDECK_TOKEN;
  if (env) return env.trim();
  return readFileSync(join(homedir(), '.agentdeck', 'token'), 'utf8').trim();
}

/** One request/response over a short-lived socket; rejects on timeout. */
function wsCall<T>(
  port: number,
  token: string,
  run: (ws: WebSocket, done: (v: T) => void, fail: (err: Error) => void) => void,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('bridge did not respond'));
    }, timeoutMs);
    const done = (v: T) => {
      clearTimeout(timer);
      ws.close();
      resolve(v);
    };
    const fail = (err: Error) => {
      clearTimeout(timer);
      ws.close();
      reject(err);
    };
    ws.on('open', () => run(ws, done, fail));
    ws.on('error', fail);
  });
}

function bridgeSessions(port: number, token: string): Promise<SessionInfo[]> {
  return wsCall(port, token, (ws, done) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'welcome') done(msg.sessions ?? []);
    });
    ws.send(JSON.stringify({ type: 'hello', clientName: 'agentdeck-cli' }));
  }, 3000);
}

function releaseSession(port: number, token: string, sessionId: string): Promise<{ nativeSessionId?: string; cwd?: string }> {
  return wsCall(port, token, (ws, done, fail) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'released' && msg.sessionId === sessionId) done(msg);
      if (msg.type === 'error') fail(new Error(msg.message));
    });
    ws.send(JSON.stringify({ type: 'session.release', sessionId }));
  }, 15_000);
}

async function collectCandidates(port: number): Promise<Candidate[]> {
  try {
    const token = loadToken();
    const sessions = await bridgeSessions(port, token);
    return sessions
      .filter((s) => s.platform === 'claude')
      .map((s) => ({
        title: s.title,
        cwd: s.cwd,
        nativeSessionId: s.nativeSessionId,
        updatedAt: s.updatedAt,
        state: s.state,
        bridgeId: s.id,
        attached: s.attached,
      }));
  } catch {
    // No bridge running — scan transcript files directly.
    const metas = await scanClaudeSessions({ limit: 30 });
    return metas.map((m) => ({
      title: m.title,
      cwd: m.cwd,
      nativeSessionId: m.nativeSessionId,
      updatedAt: m.updatedAt,
      attached: true,
    }));
  }
}

function matches(c: Candidate, query: string): boolean {
  const q = query.toLowerCase();
  return (
    c.title.toLowerCase().includes(q) ||
    c.cwd.toLowerCase().includes(q) ||
    (c.nativeSessionId ?? '').toLowerCase().startsWith(q) ||
    (c.bridgeId ?? '').toLowerCase() === q
  );
}

function age(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function printList(candidates: Candidate[]) {
  if (!candidates.length) {
    console.log('No recent Claude Code sessions found.');
    return;
  }
  console.log('Recent Claude Code sessions (newest first):\n');
  candidates.forEach((c, i) => {
    const kind = c.attached ? 'terminal' : 'phone';
    console.log(`  ${i + 1}. ${c.title}  [${kind}${c.state ? `, ${c.state}` : ''}, ${age(c.updatedAt)}]`);
    console.log(`     ${c.cwd}`);
  });
  console.log('\nResume one with: agentdeck resume [number | title/path fragment]');
}

export async function runResume(args: string[], port: number): Promise<void> {
  const listOnly = args.includes('--list') || args.includes('-l');
  const printOnly = args.includes('--print');
  const query = args.find((a) => !a.startsWith('-'));

  const candidates = (await collectCandidates(port)).sort((a, b) => b.updatedAt - a.updatedAt);

  if (listOnly) {
    printList(candidates);
    return;
  }

  let picked: Candidate | undefined;
  if (query && /^\d+$/.test(query)) picked = candidates[Number(query) - 1];
  else if (query) picked = candidates.find((c) => matches(c, query));
  else picked = candidates[0];

  if (!picked) {
    console.error(query ? `No session matches "${query}".` : 'No recent sessions to resume.');
    printList(candidates);
    process.exitCode = 1;
    return;
  }

  let nativeId = picked.nativeSessionId;
  let cwd = picked.cwd;
  if (picked.bridgeId) {
    if (picked.state === 'working') {
      console.log('Note: this session is mid-turn; releasing it now interrupts the in-flight turn.');
    }
    console.log(`Releasing "${picked.title}" from the bridge…`);
    const released = await releaseSession(port, loadToken(), picked.bridgeId);
    nativeId = released.nativeSessionId ?? nativeId;
    cwd = released.cwd ?? cwd;
  }
  if (!nativeId) {
    console.error('Cannot resume: this session has no known session id yet.');
    process.exitCode = 1;
    return;
  }

  if (printOnly) {
    console.log(`cd ${JSON.stringify(cwd)} && claude --resume ${nativeId}`);
    return;
  }

  console.log(`Resuming "${picked.title}" in ${cwd}\n`);
  // Run under the PTY wrapper so this terminal session stays drivable from the
  // phone: messages sent there are typed in here, no forking.
  await runWrappedClaude(['--resume', nativeId], port, cwd);
}
