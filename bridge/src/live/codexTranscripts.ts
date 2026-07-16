import { readdirSync, statSync, existsSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent } from '../events.js';
import { JsonlTailer, readJsonlEvents } from './jsonlTail.js';
import type { LiveSessionMeta, TranscriptSource } from './source.js';

/**
 * Live discovery of Codex sessions (CLI `codex exec`/TUI and the Codex desktop app)
 * from the rollout files written to ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
 *
 * Rollout lines are `{ timestamp, type, payload }`:
 *   - session_meta            → session id + cwd
 *   - event_msg/user_message  → user prompt
 *   - event_msg/agent_message → assistant text
 *   - event_msg/agent_reasoning → thinking
 *   - response_item/function_call | custom_tool_call (+ _output) → tool start/end
 * Assistant/user text also appears as response_item/message, but always alongside
 * the event_msg twin — so only event_msg is translated to avoid duplicates.
 *
 * Titles come from ~/.codex/session_index.jsonl ({ id, thread_name, updated_at }).
 */

const CODEX_DIR = join(homedir(), '.codex');
const SESSIONS_DIR = join(CODEX_DIR, 'sessions');
const INDEX_FILE = join(CODEX_DIR, 'session_index.jsonl');

/** Codex tool output is a string or an array of { type: input_text|output_text, text } blocks. */
function outputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((b: any) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Translate one rollout JSONL object into zero or more AgentEvents. */
export function rolloutLineToEvents(d: any): AgentEvent[] {
  const out: AgentEvent[] = [];
  const p = d?.payload;
  if (!p || typeof p !== 'object') return out;
  if (d.type === 'event_msg') {
    switch (p.type) {
      case 'user_message':
        if (typeof p.message === 'string' && p.message.trim()) out.push({ kind: 'user', text: p.message });
        break;
      case 'agent_message':
        if (typeof p.message === 'string' && p.message) out.push({ kind: 'text', text: p.message });
        break;
      case 'agent_reasoning':
        if (typeof p.text === 'string' && p.text) out.push({ kind: 'thinking', text: p.text });
        break;
    }
  } else if (d.type === 'response_item') {
    switch (p.type) {
      case 'function_call': {
        let input: unknown = p.arguments;
        try {
          if (typeof p.arguments === 'string') input = JSON.parse(p.arguments);
        } catch {
          // keep the raw string
        }
        out.push({ kind: 'tool.start', toolUseId: p.call_id, toolName: String(p.name ?? 'tool'), input });
        break;
      }
      case 'custom_tool_call':
        out.push({ kind: 'tool.start', toolUseId: p.call_id, toolName: String(p.name ?? 'tool'), input: p.input });
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
        out.push({ kind: 'tool.end', toolUseId: p.call_id, output: outputToText(p.output).slice(0, 2000) });
        break;
      case 'local_shell_call':
        // older codex CLI shape
        out.push({ kind: 'tool.start', toolUseId: p.call_id ?? p.id, toolName: 'shell', input: p.action?.command ?? p.action });
        break;
    }
  }
  return out;
}

/** id → thread_name from the session index (best-effort; the file may not exist). */
function readTitles(): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const titles = new Map<string, string>();
    if (!existsSync(INDEX_FILE)) return resolve(titles);
    const rl = createInterface({ input: createReadStream(INDEX_FILE, { encoding: 'utf8' }) });
    rl.on('line', (line) => {
      try {
        const d = JSON.parse(line);
        if (d.id && d.thread_name) titles.set(d.id, d.thread_name);
      } catch {
        // ignore
      }
    });
    rl.on('close', () => resolve(titles));
    rl.on('error', () => resolve(titles));
  });
}

/** Read id + cwd (+ first user prompt as a title fallback) from the head of a rollout. */
function readMeta(file: string, titles: Map<string, string>): Promise<LiveSessionMeta | null> {
  return new Promise((resolve) => {
    // Filename is rollout-<timestamp>-<uuid>.jsonl; the uuid is the session id.
    const name = basename(file, '.jsonl');
    const m = name.match(/([0-9a-f]{8}-[0-9a-f-]{27})$/i);
    let nativeSessionId = m ? m[1] : '';
    let cwd = '';
    let firstPrompt = '';
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (!nativeSessionId) return resolve(null);
      const title = titles.get(nativeSessionId)
        ?? (firstPrompt ? (firstPrompt.length > 48 ? firstPrompt.slice(0, 45) + '…' : firstPrompt) : 'codex session');
      try {
        const st = statSync(file);
        resolve({ platform: 'codex', nativeSessionId, title, cwd: cwd || homedir(), updatedAt: st.mtimeMs, ref: file });
      } catch {
        resolve(null);
      }
    };
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
    let count = 0;
    rl.on('line', (line) => {
      count++;
      try {
        const d = JSON.parse(line);
        const p = d?.payload ?? {};
        if (d.type === 'session_meta') {
          if (p.session_id ?? p.id) nativeSessionId = p.session_id ?? p.id;
          if (p.cwd) cwd = p.cwd;
        } else if (d.type === 'turn_context' && p.cwd && !cwd) {
          cwd = p.cwd;
        } else if (d.type === 'event_msg' && p.type === 'user_message' && !firstPrompt && typeof p.message === 'string') {
          firstPrompt = p.message.replace(/\s+/g, ' ').trim();
        }
      } catch {
        // ignore malformed lines
      }
      if (nativeSessionId && cwd && (titles.has(nativeSessionId) || firstPrompt)) rl.close();
      if (count > 200) rl.close();
    });
    rl.on('close', finish);
    rl.on('error', () => resolve(null));
  });
}

/** List recent Codex sessions across the dated rollout tree, newest first. */
async function scanCodexSessions(opts: { maxAgeMs?: number; limit?: number } = {}): Promise<LiveSessionMeta[]> {
  const maxAge = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const limit = opts.limit ?? 20;
  if (!existsSync(SESSIONS_DIR)) return [];
  const now = Date.now();
  const candidates: { file: string; mtime: number }[] = [];
  // sessions/YYYY/MM/DD/rollout-*.jsonl
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        if (now - st.mtimeMs <= maxAge) candidates.push({ file: p, mtime: st.mtimeMs });
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  candidates.sort((a, b) => b.mtime - a.mtime);
  const titles = await readTitles();
  const metas: LiveSessionMeta[] = [];
  for (const c of candidates.slice(0, limit)) {
    const m = await readMeta(c.file, titles);
    if (m) metas.push(m);
  }
  return metas;
}

export const codexSource: TranscriptSource = {
  platform: 'codex',
  scan: scanCodexSessions,
  exists: (ref) => existsSync(ref),
  async attach(meta, onEvents) {
    const startOffset = JsonlTailer.byteLength(meta.ref);
    const initialEvents = await readJsonlEvents(meta.ref, rolloutLineToEvents, startOffset);
    const tailer = new JsonlTailer(meta.ref, startOffset, rolloutLineToEvents, onEvents);
    return { initialEvents, start: () => tailer.start(), stop: () => tailer.stop() };
  },
};
