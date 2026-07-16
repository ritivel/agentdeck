import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent } from '../events.js';
import type { LiveSessionMeta, LiveTail, TranscriptSource } from './source.js';

/**
 * Live discovery of Cursor agent sessions (cursor-agent CLI and the Cursor app's
 * background agents) from ~/.cursor/chats/<workspace-hash>/<chatId>/store.db.
 *
 * store.db is a content-addressed SQLite store:
 *   - meta(key='0')  → hex-encoded JSON { agentId, name, latestRootBlobId, createdAt, mode }
 *   - blobs(id,data) → the root blob is a protobuf whose repeated field 1 holds the
 *     32-byte ids of message blobs (field 9 is the workspace file:// URI); each message
 *     blob is plain JSON { role, content } in the Vercel-AI-SDK shape (text / reasoning /
 *     tool-call / tool-result blocks).
 *
 * There is no append-only file to tail, so mirroring polls the db mtime and emits
 * events for message blobs not seen before.
 */

const CHATS_DIR = join(homedir(), '.cursor', 'chats');
const POLL_MS = 2000;

interface CursorStore {
  name?: string;
  createdAt?: number;
  cwd: string;
  /** Message blob ids in conversation order. */
  childIds: string[];
  messages: any[];
}

/** Minimal protobuf scan of the root blob: field 1 (len 32) = child ids, field 9 = workspace URI. */
function parseRootBlob(data: Uint8Array): { childIds: string[]; workspaceUri?: string } {
  const childIds: string[] = [];
  let workspaceUri: string | undefined;
  let i = 0;
  const varint = (): number => {
    let r = 0;
    let s = 0;
    while (i < data.length) {
      const x = data[i++];
      r |= (x & 0x7f) << s;
      if (!(x & 0x80)) break;
      s += 7;
    }
    return r;
  };
  while (i < data.length) {
    const key = varint();
    const field = key >> 3;
    const wt = key & 7;
    if (wt === 2) {
      const len = varint();
      const val = data.subarray(i, i + len);
      i += len;
      if (field === 1 && len === 32) childIds.push(Buffer.from(val).toString('hex'));
      else if (field === 9) workspaceUri = Buffer.from(val).toString('utf8');
    } else if (wt === 0) {
      varint();
    } else if (wt === 5) {
      i += 4;
    } else if (wt === 1) {
      i += 8;
    } else {
      break; // unknown wire type — bail rather than misparse
    }
  }
  return { childIds, workspaceUri };
}

/** Open the chat store read-only and pull meta + ordered messages. */
function readStore(chatDir: string, opts: { withMessages?: boolean } = {}): CursorStore | null {
  const dbFile = join(chatDir, 'store.db');
  if (!existsSync(dbFile)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: string | Uint8Array } | undefined;
    if (!row?.value) return null;
    const raw = typeof row.value === 'string' ? Buffer.from(row.value, 'hex') : Buffer.from(row.value);
    const meta = JSON.parse(raw.toString('utf8'));
    const rootId = meta.latestRootBlobId;
    if (!rootId) return null;
    const rootRow = db.prepare('SELECT data FROM blobs WHERE id = ?').get(rootId) as { data?: Uint8Array } | undefined;
    if (!rootRow?.data) return null;
    const { childIds, workspaceUri } = parseRootBlob(rootRow.data);
    let cwd = homedir();
    if (workspaceUri?.startsWith('file://')) {
      try {
        cwd = fileURLToPath(workspaceUri);
      } catch {
        // keep fallback
      }
    }
    const messages: any[] = [];
    if (opts.withMessages) {
      const getBlob = db.prepare('SELECT data FROM blobs WHERE id = ?');
      for (const id of childIds) {
        const b = getBlob.get(id) as { data?: Uint8Array } | undefined;
        if (!b?.data) {
          messages.push(null);
          continue;
        }
        try {
          messages.push(JSON.parse(Buffer.from(b.data).toString('utf8')));
        } catch {
          messages.push(null);
        }
      }
    }
    return { name: meta.name, createdAt: meta.createdAt, cwd, childIds, messages };
  } catch {
    return null; // db mid-write, locked, or an unexpected schema
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/** Translate one stored chat message into zero or more AgentEvents. */
export function cursorMessageToEvents(m: any): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (!m || typeof m !== 'object') return out;
  const { role, content } = m;
  if (role === 'user') {
    if (typeof content === 'string') {
      // The workspace-context preamble is stored as a plain-string user message.
      if (!content.startsWith('<user_info>')) out.push({ kind: 'user', text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'text' || !b.text) continue;
        // Real prompts arrive wrapped in <user_query> alongside attached context.
        const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(b.text);
        if (q) out.push({ kind: 'user', text: q[1] });
        else if (!b.text.startsWith('<')) out.push({ kind: 'user', text: b.text });
      }
    }
  } else if (role === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text' && b.text) out.push({ kind: 'text', text: b.text });
      else if (b?.type === 'reasoning' && b.text) out.push({ kind: 'thinking', text: b.text });
      else if (b?.type === 'tool-call') out.push({ kind: 'tool.start', toolUseId: b.toolCallId, toolName: String(b.toolName ?? 'tool'), input: b.args });
    }
  } else if (role === 'tool' && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'tool-result') {
        const text = typeof b.result === 'string' ? b.result : JSON.stringify(b.result ?? '');
        out.push({ kind: 'tool.end', toolUseId: b.toolCallId, output: text.slice(0, 2000) });
      }
    }
  }
  return out;
}

/** Latest write across the db and its WAL sidecar. */
function storeMtime(chatDir: string): number {
  let mtime = 0;
  for (const f of ['store.db', 'store.db-wal']) {
    try {
      mtime = Math.max(mtime, statSync(join(chatDir, f)).mtimeMs);
    } catch {
      // ignore
    }
  }
  return mtime;
}

/** First real user prompt, for a title when the chat is unnamed. */
function titleFrom(store: CursorStore): string {
  if (store.name) return store.name;
  for (const m of store.messages) {
    for (const e of cursorMessageToEvents(m)) {
      if (e.kind === 'user') {
        const t = e.text.replace(/\s+/g, ' ').trim();
        return t.length > 48 ? t.slice(0, 45) + '…' : t;
      }
    }
  }
  return 'cursor session';
}

/** List recent Cursor chats across all workspaces, newest first. */
async function scanCursorSessions(opts: { maxAgeMs?: number; limit?: number } = {}): Promise<LiveSessionMeta[]> {
  const maxAge = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const limit = opts.limit ?? 20;
  if (!existsSync(CHATS_DIR)) return [];
  const now = Date.now();
  const candidates: { dir: string; chatId: string; mtime: number }[] = [];
  for (const ws of readdirSync(CHATS_DIR)) {
    const wsDir = join(CHATS_DIR, ws);
    let chats: string[];
    try {
      if (!statSync(wsDir).isDirectory()) continue;
      chats = readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const chatId of chats) {
      const dir = join(wsDir, chatId);
      if (!existsSync(join(dir, 'store.db'))) continue;
      const mtime = storeMtime(dir);
      if (now - mtime <= maxAge) candidates.push({ dir, chatId, mtime });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const metas: LiveSessionMeta[] = [];
  for (const c of candidates.slice(0, limit)) {
    const store = readStore(c.dir, { withMessages: true });
    if (!store) continue;
    metas.push({
      platform: 'cursor',
      nativeSessionId: c.chatId,
      title: titleFrom(store),
      cwd: store.cwd,
      updatedAt: c.mtime,
      ref: c.dir,
    });
  }
  return metas;
}

export const cursorSource: TranscriptSource = {
  platform: 'cursor',
  scan: scanCursorSessions,
  exists: (ref) => existsSync(join(ref, 'store.db')),
  async attach(meta, onEvents): Promise<LiveTail> {
    const seen = new Set<string>();
    const initialEvents: AgentEvent[] = [];
    const initial = readStore(meta.ref, { withMessages: true });
    if (initial) {
      initial.childIds.forEach((id) => seen.add(id));
      for (const m of initial.messages) initialEvents.push(...cursorMessageToEvents(m));
    }
    let lastMtime = storeMtime(meta.ref);
    let timer: NodeJS.Timeout | undefined;
    const poll = () => {
      const mtime = storeMtime(meta.ref);
      if (mtime === lastMtime) return;
      lastMtime = mtime;
      const store = readStore(meta.ref, { withMessages: true });
      if (!store) return;
      const events: AgentEvent[] = [];
      store.childIds.forEach((id, idx) => {
        if (seen.has(id)) return;
        seen.add(id);
        events.push(...cursorMessageToEvents(store.messages[idx]));
      });
      if (events.length) onEvents(events);
    };
    return {
      initialEvents,
      start() {
        timer = setInterval(poll, POLL_MS);
        timer.unref?.();
      },
      stop() {
        if (timer) clearInterval(timer);
        timer = undefined;
      },
    };
  },
};
