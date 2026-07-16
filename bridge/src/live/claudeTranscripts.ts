import { readdirSync, statSync, existsSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent } from '../events.js';
import { contentToText } from '../adapters/util.js';
import { JsonlTailer, readJsonlEvents } from './jsonlTail.js';
import type { LiveSessionMeta, TranscriptSource } from './source.js';

/**
 * Live discovery of already-running (or past) Claude Code sessions by reading the
 * transcript JSONL files Claude Code writes to ~/.claude/projects/<slug>/<id>.jsonl.
 *
 * These sessions are NOT spawned by the bridge — they're owned by a terminal/IDE —
 * so they are surfaced read-only: we parse the existing transcript and tail the file
 * for appended lines, translating each into the bridge's normalized AgentEvent schema.
 */

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** Translate one parsed transcript JSONL object into zero or more AgentEvents. */
export function transcriptLineToEvents(d: any): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (!d || typeof d !== 'object') return out;
  const msg = d.message;
  if (d.type === 'assistant' && msg && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) out.push({ kind: 'text', text: block.text });
      else if (block.type === 'thinking' && block.thinking) out.push({ kind: 'thinking', text: block.thinking });
      else if (block.type === 'tool_use') out.push({ kind: 'tool.start', toolUseId: block.id, toolName: block.name, input: block.input });
    }
  } else if (d.type === 'user' && msg) {
    const c = msg.content;
    if (typeof c === 'string') {
      // Skip local-command noise and meta lines; surface real user prompts.
      if (!d.isMeta && !c.startsWith('<local-command') && !c.startsWith('<command-')) {
        out.push({ kind: 'user', text: c });
      }
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (block?.type === 'tool_result') {
          out.push({ kind: 'tool.end', toolUseId: block.tool_use_id, output: contentToText(block.content).slice(0, 2000), isError: block.is_error === true });
        } else if (block?.type === 'text' && block.text) {
          // Same meta/noise filtering as the string branch: system reminders, hook
          // output, and slash-command scaffolding are not real user prompts.
          const t: string = block.text;
          if (d.isMeta || t.startsWith('<local-command') || t.startsWith('<command-') || t.startsWith('<system-reminder')) continue;
          out.push({ kind: 'user', text: t });
        }
      }
    }
  }
  return out;
}

/** Read metadata (id, cwd, title, mtime) from a transcript file without loading it all. */
function readMeta(file: string): Promise<LiveSessionMeta | null> {
  return new Promise((resolve) => {
    // The filename IS the session id. Lines are only a fallback: a resumed
    // session's transcript carries the parent session's id in copied history.
    const nameId = basename(file, '.jsonl');
    let nativeSessionId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(nameId) ? nameId : '';
    let cwd = '';
    let title = '';
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (!nativeSessionId) return resolve(null);
      try {
        const st = statSync(file);
        resolve({ platform: 'claude', nativeSessionId, title: title || 'terminal session', cwd: cwd || homedir(), updatedAt: st.mtimeMs, ref: file });
      } catch {
        // File vanished between scan and read (cleanup, /clear).
        resolve(null);
      }
    };
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
    let count = 0;
    rl.on('line', (line) => {
      count++;
      try {
        const d = JSON.parse(line);
        if (d.sessionId && !nativeSessionId) nativeSessionId = d.sessionId;
        if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
        if (d.aiTitle && !title) title = d.aiTitle;
        if (d.cwd) cwd = d.cwd;
      } catch {
        // ignore malformed lines
      }
      // We have what we need once we've seen id + cwd; keep scanning a little for a title.
      if (nativeSessionId && cwd && title) rl.close();
      if (count > 400) rl.close();
    });
    rl.on('close', finish);
    rl.on('error', () => resolve(null));
  });
}

/** List recent Claude Code sessions across all projects, newest first. */
export async function scanClaudeSessions(opts: { maxAgeMs?: number; limit?: number } = {}): Promise<LiveSessionMeta[]> {
  const maxAge = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const limit = opts.limit ?? 20;
  if (!existsSync(PROJECTS_DIR)) return [];
  const now = Date.now();
  const candidates: { file: string; mtime: number }[] = [];
  for (const slug of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, slug);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      try {
        const st = statSync(file);
        if (now - st.mtimeMs <= maxAge) candidates.push({ file, mtime: st.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const metas: LiveSessionMeta[] = [];
  for (const c of candidates.slice(0, limit)) {
    const m = await readMeta(c.file);
    if (m) metas.push(m);
  }
  return metas;
}

export const claudeSource: TranscriptSource = {
  platform: 'claude',
  scan: scanClaudeSessions,
  exists: (ref) => existsSync(ref),
  async attach(meta, onEvents) {
    // Seed history from the file's current extent; the tailer picks up from
    // the same offset, so lines appended while we read are never emitted twice.
    const startOffset = JsonlTailer.byteLength(meta.ref);
    const initialEvents = await readJsonlEvents(meta.ref, transcriptLineToEvents, startOffset);
    const tailer = new JsonlTailer(meta.ref, startOffset, transcriptLineToEvents, onEvents);
    return { initialEvents, start: () => tailer.start(), stop: () => tailer.stop() };
  },
};
