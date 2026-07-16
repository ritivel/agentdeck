import type { AgentEvent, Platform } from '../events.js';

/** A session found on disk that some terminal/IDE-owned agent process writes to. */
export interface LiveSessionMeta {
  platform: Platform;
  nativeSessionId: string;
  title: string;
  cwd: string;
  updatedAt: number;
  /** Source-specific locator: transcript file (claude/codex) or chat directory (cursor). */
  ref: string;
}

/** A started mirror of one live session. */
export interface LiveTail {
  /** Transcript parsed up to the attach point; the tail continues from there. */
  initialEvents: AgentEvent[];
  start(): void;
  stop(): void;
}

/**
 * Per-platform discovery + mirroring of sessions the bridge did not spawn.
 * Each coding-agent CLI persists transcripts differently (Claude: JSONL per
 * session, Codex: dated rollout JSONL, Cursor: SQLite blob store), so the
 * watcher stays format-agnostic behind this interface.
 */
export interface TranscriptSource {
  platform: Platform;
  /** List recent sessions, newest first. */
  scan(opts?: { maxAgeMs?: number; limit?: number }): Promise<LiveSessionMeta[]>;
  /** Whether the backing store still exists (false → detach the mirror). */
  exists(ref: string): boolean;
  /** Read history and begin tailing; events stream via onEvents. */
  attach(meta: LiveSessionMeta, onEvents: (events: AgentEvent[]) => void): Promise<LiveTail>;
}
