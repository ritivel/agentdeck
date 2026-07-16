import type { AgentEvent, Platform } from '../events.js';

export interface AdapterStartOptions {
  cwd: string;
  permissionMode: string;
  model?: string;
  resumeNativeId?: string;
  onEvent: (event: AgentEvent) => void;
  /** Called once the platform reveals its own session/chat/thread id. */
  onNativeSessionId: (id: string) => void;
}

export interface AdapterHandle {
  /** Send a user prompt. The adapter emits events until turn.end. */
  send(text: string): void;
  /** Interrupt the current turn (best effort). */
  interrupt(): void;
  /** Kill processes and release resources. */
  dispose(): void;
}

export interface PlatformAdapter {
  platform: Platform;
  /** Whether the underlying CLI is installed. */
  available(): Promise<boolean>;
  start(opts: AdapterStartOptions): AdapterHandle;
}

/** Read a child process stdout as JSON lines, tolerating partial chunks and junk lines. */
export function jsonLines(onLine: (obj: any) => void, onJunk?: (line: string) => void) {
  let buf = '';
  return (chunk: Buffer | string) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        onJunk?.(line);
      }
    }
  };
}
