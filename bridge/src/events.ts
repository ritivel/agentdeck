export type Platform = 'claude' | 'cursor' | 'codex';

export type SessionState = 'starting' | 'idle' | 'working' | 'error' | 'exited';

export interface SessionInfo {
  id: string;
  platform: Platform;
  title: string;
  cwd: string;
  state: SessionState;
  permissionMode: string;
  nativeSessionId?: string;
  createdAt: number;
  updatedAt: number;
  lastText?: string;
  /** True for sessions discovered on disk (started in a terminal), not spawned by the bridge. */
  attached?: boolean;
  /** True when the bridge only mirrors the session and cannot send prompts to it. */
  readOnly?: boolean;
}

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool.start'; toolUseId?: string; toolName: string; input?: unknown }
  | { kind: 'tool.end'; toolUseId?: string; output?: string; isError?: boolean }
  | { kind: 'user'; text: string }
  | { kind: 'turn.end'; result?: string; isError?: boolean; costUsd?: number; durationMs?: number }
  | { kind: 'status'; state: SessionState }
  | { kind: 'permission.denied'; toolName: string; detail?: string }
  | { kind: 'error'; message: string };

export interface StoredEvent {
  seq: number;
  ts: number;
  event: AgentEvent;
}
