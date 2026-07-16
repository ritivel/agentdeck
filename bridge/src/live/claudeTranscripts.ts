import { readdirSync, statSync, existsSync, createReadStream, watch, type FSWatcher, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent } from '../events.js';
import { contentToText } from '../adapters/util.js';

/**
 * Live discovery of already-running (or past) Claude Code sessions by reading the
 * transcript JSONL files Claude Code writes to ~/.claude/projects/<slug>/<id>.jsonl.
 *
 * These sessions are NOT spawned by the bridge — they're owned by a terminal/IDE —
 * so they are surfaced read-only: we parse the existing transcript and tail the file
 * for appended lines, translating each into the bridge's normalized AgentEvent schema.
 */

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export interface LiveSessionMeta {
  nativeSessionId: string;
  title: string;
  cwd: string;
  updatedAt: number;
  file: string;
}

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
          out.push({ kind: 'user', text: block.text });
        }
      }
    }
  }
  return out;
}

/** Read metadata (id, cwd, title, mtime) from a transcript file without loading it all. */
function readMeta(file: string): Promise<LiveSessionMeta | null> {
  return new Promise((resolve) => {
    let nativeSessionId = '';
    let cwd = '';
    let title = '';
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (!nativeSessionId) return resolve(null);
      const st = statSync(file);
      resolve({ nativeSessionId, title: title || 'terminal session', cwd: cwd || homedir(), updatedAt: st.mtimeMs, file });
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

/** Read a whole transcript file into events (used for history on first attach). */
export function readTranscriptEvents(file: string): Promise<AgentEvent[]> {
  return new Promise((resolve) => {
    const events: AgentEvent[] = [];
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
    rl.on('line', (line) => {
      try {
        events.push(...transcriptLineToEvents(JSON.parse(line)));
      } catch {
        // ignore
      }
    });
    rl.on('close', () => resolve(events));
    rl.on('error', () => resolve(events));
  });
}

/**
 * Tails a single transcript file, emitting AgentEvents for lines appended after
 * `startOffset` bytes. Debounces fs change notifications and handles truncation.
 */
export class TranscriptTailer {
  private watcher?: FSWatcher;
  private offset: number;
  private carry = '';
  private reading = false;
  private pending = false;

  constructor(private file: string, startOffset: number, private onEvents: (events: AgentEvent[]) => void) {
    this.offset = startOffset;
  }

  static byteLength(file: string): number {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  }

  start() {
    try {
      this.watcher = watch(this.file, () => this.scheduleRead());
    } catch {
      // File may vanish; nothing to tail.
    }
  }

  private scheduleRead() {
    if (this.reading) {
      this.pending = true;
      return;
    }
    this.readNew();
  }

  private readNew() {
    this.reading = true;
    this.pending = false;
    let fd: number | undefined;
    try {
      fd = openSync(this.file, 'r');
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // truncated/rotated — restart from the top
        this.offset = 0;
        this.carry = '';
      }
      if (size > this.offset) {
        const len = size - this.offset;
        const buf = Buffer.allocUnsafe(len);
        const read = readSync(fd, buf, 0, len, this.offset);
        this.offset += read;
        this.carry += buf.toString('utf8', 0, read);
        const lines = this.carry.split('\n');
        this.carry = lines.pop() ?? '';
        const events: AgentEvent[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            events.push(...transcriptLineToEvents(JSON.parse(trimmed)));
          } catch {
            // ignore partial/malformed
          }
        }
        if (events.length) this.onEvents(events);
      }
    } catch {
      // ignore transient read errors
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      this.reading = false;
      if (this.pending) this.readNew();
    }
  }

  stop() {
    this.watcher?.close();
    this.watcher = undefined;
  }
}
