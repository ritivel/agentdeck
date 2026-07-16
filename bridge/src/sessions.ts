import { randomBytes } from 'node:crypto';
import type { AgentEvent, Platform, SessionInfo, SessionState, StoredEvent } from './events.js';
import type { AdapterHandle, PlatformAdapter } from './adapters/types.js';
import { claudeAdapter } from './adapters/claude.js';
import { cursorAdapter } from './adapters/cursor.js';
import { codexAdapter } from './adapters/codex.js';

const MAX_TRANSCRIPT = 500;

export const adapters: Record<Platform, PlatformAdapter> = {
  claude: claudeAdapter,
  cursor: cursorAdapter,
  codex: codexAdapter,
};

export interface Session {
  info: SessionInfo;
  handle: AdapterHandle;
  transcript: StoredEvent[];
  seq: number;
}

export interface SessionManagerCallbacks {
  onSessionUpdated: (info: SessionInfo) => void;
  onSessionRemoved: (sessionId: string) => void;
  onEvent: (sessionId: string, stored: StoredEvent) => void;
}

export interface CreateSessionOptions {
  platform: Platform;
  cwd: string;
  permissionMode?: string;
  model?: string;
  title?: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private cb: SessionManagerCallbacks) {}

  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .map((s) => s.info)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  create(opts: CreateSessionOptions): SessionInfo {
    const adapter = adapters[opts.platform];
    if (!adapter) throw new Error(`unknown platform: ${opts.platform}`);

    const id = `s_${randomBytes(5).toString('hex')}`;
    const now = Date.now();
    const info: SessionInfo = {
      id,
      platform: opts.platform,
      title: opts.title ?? 'new session',
      cwd: opts.cwd,
      state: 'starting',
      permissionMode: opts.permissionMode ?? 'acceptEdits',
      createdAt: now,
      updatedAt: now,
    };

    const handle = adapter.start({
      cwd: opts.cwd,
      permissionMode: info.permissionMode,
      model: opts.model,
      onEvent: (e) => this.ingest(id, e),
      onNativeSessionId: (nativeId) => {
        const s = this.sessions.get(id);
        if (!s) return;
        s.info.nativeSessionId = nativeId;
        this.touch(s);
      },
    });

    const session: Session = { info, handle, transcript: [], seq: 0 };
    this.sessions.set(id, session);
    return info;
  }

  prompt(id: string, text: string) {
    const s = this.mustGet(id);
    s.handle.send(text);
    this.ingest(id, { kind: 'user', text });
    this.setState(s, 'working');
    if (s.info.title === 'new session') {
      s.info.title = text.length > 48 ? text.slice(0, 45) + '…' : text;
      this.touch(s);
    }
  }

  interrupt(id: string) {
    this.mustGet(id).handle.interrupt();
  }

  history(id: string, sinceSeq = 0): StoredEvent[] {
    return this.mustGet(id).transcript.filter((e) => e.seq > sinceSeq);
  }

  archive(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.handle.dispose();
    this.sessions.delete(id);
    this.cb.onSessionRemoved(id);
  }

  disposeAll() {
    for (const s of this.sessions.values()) s.handle.dispose();
    this.sessions.clear();
  }

  private mustGet(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no such session: ${id}`);
    return s;
  }

  private ingest(id: string, event: AgentEvent) {
    const s = this.sessions.get(id);
    if (!s) return;

    const stored: StoredEvent = { seq: ++s.seq, ts: Date.now(), event };
    s.transcript.push(stored);
    if (s.transcript.length > MAX_TRANSCRIPT) s.transcript.splice(0, s.transcript.length - MAX_TRANSCRIPT);
    this.cb.onEvent(id, stored);

    if (event.kind === 'text') {
      s.info.lastText = event.text.length > 120 ? event.text.slice(0, 117) + '…' : event.text;
      this.touch(s);
    } else if (event.kind === 'turn.end') {
      this.setState(s, event.isError ? 'error' : 'idle');
    } else if (event.kind === 'status') {
      this.setState(s, event.state);
    } else if (event.kind === 'error' && s.info.state !== 'exited') {
      this.setState(s, 'error');
    }
  }

  private setState(s: Session, state: SessionState) {
    if (s.info.state === state) return;
    s.info.state = state;
    this.touch(s);
  }

  private touch(s: Session) {
    s.info.updatedAt = Date.now();
    this.cb.onSessionUpdated(s.info);
  }
}
