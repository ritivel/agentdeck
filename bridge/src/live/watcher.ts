import { randomBytes } from 'node:crypto';
import type { AgentEvent, SessionInfo, StoredEvent } from '../events.js';
import { scanClaudeSessions, readTranscriptEvents, TranscriptTailer, type LiveSessionMeta } from './claudeTranscripts.js';

const MAX_TRANSCRIPT = 500;
/** A session whose file changed within this window is shown as actively working. */
const ACTIVE_WINDOW_MS = 20_000;

interface LiveSession {
  info: SessionInfo;
  tailer: TranscriptTailer;
  transcript: StoredEvent[];
  seq: number;
  activeTimer?: NodeJS.Timeout;
}

export interface LiveWatcherCallbacks {
  onSessionDiscovered: (info: SessionInfo) => void;
  onSessionUpdated: (info: SessionInfo) => void;
  onEvent: (sessionId: string, stored: StoredEvent) => void;
}

/**
 * Discovers and live-tails Claude Code terminal sessions, exposing them as
 * read-only bridge sessions (attached=true, readOnly=true). Rescans periodically
 * so sessions started after the bridge launched still appear.
 */
export class LiveWatcher {
  private byNativeId = new Map<string, LiveSession>();
  private rescanTimer?: NodeJS.Timeout;

  constructor(private cb: LiveWatcherCallbacks) {}

  list(): SessionInfo[] {
    return [...this.byNativeId.values()].map((s) => s.info);
  }

  get(sessionId: string): LiveSession | undefined {
    for (const s of this.byNativeId.values()) if (s.info.id === sessionId) return s;
    return undefined;
  }

  history(sessionId: string, sinceSeq = 0): StoredEvent[] | undefined {
    const s = this.get(sessionId);
    if (!s) return undefined;
    return s.transcript.filter((e) => e.seq > sinceSeq);
  }

  async start() {
    await this.rescan();
    this.rescanTimer = setInterval(() => void this.rescan(), 15_000);
    this.rescanTimer.unref?.();
  }

  stop() {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    for (const s of this.byNativeId.values()) {
      s.tailer.stop();
      if (s.activeTimer) clearTimeout(s.activeTimer);
    }
    this.byNativeId.clear();
  }

  private async rescan() {
    let metas: LiveSessionMeta[];
    try {
      metas = await scanClaudeSessions();
    } catch {
      return;
    }
    for (const meta of metas) {
      const existing = this.byNativeId.get(meta.nativeSessionId);
      if (existing) {
        if (meta.title !== existing.info.title || meta.updatedAt > existing.info.updatedAt) {
          existing.info.title = meta.title;
          existing.info.updatedAt = meta.updatedAt;
          this.cb.onSessionUpdated(existing.info);
        }
        continue;
      }
      await this.attach(meta);
    }
  }

  private async attach(meta: LiveSessionMeta) {
    const id = `live_${randomBytes(4).toString('hex')}`;
    const now = Date.now();
    const info: SessionInfo = {
      id,
      platform: 'claude',
      title: meta.title,
      cwd: meta.cwd,
      state: now - meta.updatedAt < ACTIVE_WINDOW_MS ? 'working' : 'idle',
      permissionMode: 'attached',
      nativeSessionId: meta.nativeSessionId,
      createdAt: meta.updatedAt,
      updatedAt: meta.updatedAt,
      attached: true,
      readOnly: true,
    };

    // Seed transcript from the existing file, then tail from end of file.
    const startOffset = TranscriptTailer.byteLength(meta.file);
    const initialEvents = await readTranscriptEvents(meta.file);

    const session: LiveSession = {
      info,
      transcript: [],
      seq: 0,
      tailer: new TranscriptTailer(meta.file, startOffset, (events) => this.ingest(id, events)),
    };
    for (const e of initialEvents) {
      const stored: StoredEvent = { seq: ++session.seq, ts: info.updatedAt, event: e };
      session.transcript.push(stored);
    }
    if (session.transcript.length > MAX_TRANSCRIPT) {
      session.transcript.splice(0, session.transcript.length - MAX_TRANSCRIPT);
    }
    const last = [...initialEvents].reverse().find((e) => e.kind === 'text') as { text: string } | undefined;
    if (last) info.lastText = last.text.length > 120 ? last.text.slice(0, 117) + '…' : last.text;

    this.byNativeId.set(meta.nativeSessionId, session);
    session.tailer.start();
    this.cb.onSessionDiscovered(info);
  }

  private ingest(sessionId: string, events: AgentEvent[]) {
    const s = this.get(sessionId);
    if (!s) return;
    for (const event of events) {
      const stored: StoredEvent = { seq: ++s.seq, ts: Date.now(), event };
      s.transcript.push(stored);
      if (s.transcript.length > MAX_TRANSCRIPT) s.transcript.shift();
      this.cb.onEvent(sessionId, stored);
      if (event.kind === 'text') {
        s.info.lastText = event.text.length > 120 ? event.text.slice(0, 117) + '…' : event.text;
      }
    }
    // Any new line means the terminal session is doing something right now.
    s.info.updatedAt = Date.now();
    if (s.info.state !== 'working') s.info.state = 'working';
    this.cb.onSessionUpdated(s.info);
    if (s.activeTimer) clearTimeout(s.activeTimer);
    s.activeTimer = setTimeout(() => {
      s.info.state = 'idle';
      this.cb.onSessionUpdated(s.info);
    }, ACTIVE_WINDOW_MS);
    s.activeTimer.unref?.();
  }
}
