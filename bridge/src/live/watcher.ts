import { randomBytes } from 'node:crypto';
import type { AgentEvent, SessionInfo, StoredEvent } from '../events.js';
import type { LiveSessionMeta, LiveTail, TranscriptSource } from './source.js';

const MAX_TRANSCRIPT = 500;
/** A session whose file changed within this window is shown as actively working. */
const ACTIVE_WINDOW_MS = 20_000;

interface LiveSession {
  info: SessionInfo;
  ref: string;
  source: TranscriptSource;
  tail?: LiveTail;
  transcript: StoredEvent[];
  seq: number;
  activeTimer?: NodeJS.Timeout;
}

export interface LiveWatcherCallbacks {
  onSessionDiscovered: (info: SessionInfo) => void;
  onSessionUpdated: (info: SessionInfo) => void;
  onSessionRemoved: (sessionId: string) => void;
  onEvent: (sessionId: string, stored: StoredEvent) => void;
  /**
   * Bridge-spawned sessions also persist transcripts to the platform stores;
   * without this check they would reappear here as read-only duplicates.
   */
  isBridgeOwned: (nativeSessionId: string) => boolean;
  /** User-archived sessions stay hidden until their transcript gains new activity. */
  isDismissed: (nativeSessionId: string, updatedAt: number) => boolean;
  /** True when a PTY wrapper controls this session — it can accept typed input. */
  isControllable: (nativeSessionId: string) => boolean;
}

/**
 * Discovers and live-tails terminal/IDE-owned agent sessions across all platform
 * transcript sources, exposing them as read-only bridge sessions (attached=true,
 * readOnly=true). Rescans periodically so sessions started after the bridge
 * launched still appear.
 */
export class LiveWatcher {
  /** Keyed by `${platform}:${nativeSessionId}` — native ids are only unique per platform. */
  private byKey = new Map<string, LiveSession>();
  private rescanTimer?: NodeJS.Timeout;

  constructor(private sources: TranscriptSource[], private cb: LiveWatcherCallbacks) {}

  list(): SessionInfo[] {
    return [...this.byKey.values()].map((s) => s.info);
  }

  get(sessionId: string): LiveSession | undefined {
    for (const s of this.byKey.values()) if (s.info.id === sessionId) return s;
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
    for (const s of this.byKey.values()) {
      s.tail?.stop();
      if (s.activeTimer) clearTimeout(s.activeTimer);
    }
    this.byKey.clear();
  }

  private key(platform: string, nativeSessionId: string): string {
    return `${platform}:${nativeSessionId}`;
  }

  private async rescan() {
    // Drop sessions whose transcript vanished or that the bridge now owns
    // (e.g. its nativeSessionId arrived after we attached).
    for (const [key, s] of this.byKey) {
      if (this.cb.isBridgeOwned(s.info.nativeSessionId!) || !s.source.exists(s.ref)) this.detach(key);
    }

    for (const source of this.sources) {
      let metas: LiveSessionMeta[];
      try {
        metas = await source.scan();
      } catch {
        continue;
      }
      for (const meta of metas) {
        if (this.cb.isBridgeOwned(meta.nativeSessionId)) continue;
        if (this.cb.isDismissed(meta.nativeSessionId, meta.updatedAt)) continue;
        const existing = this.byKey.get(this.key(meta.platform, meta.nativeSessionId));
        if (existing) {
          let changed = false;
          if (meta.title !== existing.info.title) {
            existing.info.title = meta.title;
            changed = true;
          }
          if (meta.updatedAt > existing.info.updatedAt) {
            existing.info.updatedAt = meta.updatedAt;
            changed = true;
          }
          if (changed) this.cb.onSessionUpdated(existing.info);
          continue;
        }
        await this.attach(source, meta);
      }
    }
  }

  /** Re-evaluate whether a session accepts input (PTY wrapper came or went). */
  refreshControllable(nativeSessionId: string) {
    const s = [...this.byKey.values()].find((x) => x.info.nativeSessionId === nativeSessionId);
    if (!s) {
      // Not discovered yet — pull it in now so the phone sees it promptly.
      void this.rescan();
      return;
    }
    const readOnly = !this.cb.isControllable(nativeSessionId);
    if (s.info.readOnly !== readOnly) {
      s.info.readOnly = readOnly;
      this.cb.onSessionUpdated(s.info);
    }
  }

  /** Remove a live session by its bridge id, returning the native id so the caller can persist the dismissal. */
  dismiss(sessionId: string): string | undefined {
    for (const [key, s] of this.byKey) {
      if (s.info.id === sessionId) {
        this.detach(key);
        return s.info.nativeSessionId;
      }
    }
    return undefined;
  }

  private detach(key: string) {
    const s = this.byKey.get(key);
    if (!s) return;
    s.tail?.stop();
    if (s.activeTimer) clearTimeout(s.activeTimer);
    this.byKey.delete(key);
    this.cb.onSessionRemoved(s.info.id);
  }

  private async attach(source: TranscriptSource, meta: LiveSessionMeta) {
    const id = `live_${randomBytes(4).toString('hex')}`;
    const now = Date.now();
    const info: SessionInfo = {
      id,
      platform: meta.platform,
      title: meta.title,
      cwd: meta.cwd,
      state: now - meta.updatedAt < ACTIVE_WINDOW_MS ? 'working' : 'idle',
      permissionMode: 'attached',
      nativeSessionId: meta.nativeSessionId,
      createdAt: meta.updatedAt,
      updatedAt: meta.updatedAt,
      attached: true,
      readOnly: !this.cb.isControllable(meta.nativeSessionId),
    };

    const session: LiveSession = {
      info,
      ref: meta.ref,
      source,
      transcript: [],
      seq: 0,
    };
    // Register before the (async) attach so a concurrent rescan can't double-attach.
    this.byKey.set(this.key(meta.platform, meta.nativeSessionId), session);

    let tail: LiveTail;
    try {
      tail = await source.attach(meta, (events) => this.ingest(id, events));
    } catch {
      this.byKey.delete(this.key(meta.platform, meta.nativeSessionId));
      return;
    }
    session.tail = tail;
    for (const e of tail.initialEvents) {
      const stored: StoredEvent = { seq: ++session.seq, ts: info.updatedAt, event: e };
      session.transcript.push(stored);
    }
    if (session.transcript.length > MAX_TRANSCRIPT) {
      session.transcript.splice(0, session.transcript.length - MAX_TRANSCRIPT);
    }
    const last = [...tail.initialEvents].reverse().find((e) => e.kind === 'text') as { text: string } | undefined;
    if (last) info.lastText = last.text.length > 120 ? last.text.slice(0, 117) + '…' : last.text;

    tail.start();
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
