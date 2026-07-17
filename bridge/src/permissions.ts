import { randomBytes } from 'node:crypto';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export interface PermissionRequest {
  id: string;
  /** Bridge session id when we can map it, otherwise undefined (global card). */
  sessionId?: string;
  /** The platform-native session id as reported by the hook. */
  nativeSessionId?: string;
  platform: string;
  toolName: string;
  /** Tool input, already truncated for transport. */
  input?: unknown;
  cwd?: string;
  createdAt: number;
  expiresAt: number;
}

export interface PermissionResolution {
  id: string;
  decision: PermissionDecision;
  reason?: string;
  /** 'phone' when a client answered, 'timeout' when nobody did. */
  resolvedBy: 'phone' | 'timeout';
}

interface Pending {
  request: PermissionRequest;
  resolve: (res: PermissionResolution) => void;
  timer: NodeJS.Timeout;
}

export interface PermissionBrokerCallbacks {
  onRequest: (request: PermissionRequest) => void;
  onResolved: (resolution: PermissionResolution, request: PermissionRequest) => void;
}

/**
 * Routes permission prompts (from Claude Code PreToolUse hooks or the Codex
 * app-server) to connected phones and returns the first answer. Unanswered
 * requests resolve as 'ask' so the caller falls back to its normal permission
 * flow — the phone can only ever make things more permissive than silence,
 * never block a session that would otherwise have proceeded.
 */
export class PermissionBroker {
  private pending = new Map<string, Pending>();

  constructor(private cb: PermissionBrokerCallbacks) {}

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  request(opts: {
    sessionId?: string;
    nativeSessionId?: string;
    platform: string;
    toolName: string;
    input?: unknown;
    cwd?: string;
    timeoutMs: number;
  }): Promise<PermissionResolution> {
    const id = `perm_${randomBytes(5).toString('hex')}`;
    const now = Date.now();
    const request: PermissionRequest = {
      id,
      sessionId: opts.sessionId,
      nativeSessionId: opts.nativeSessionId,
      platform: opts.platform,
      toolName: opts.toolName,
      input: opts.input,
      cwd: opts.cwd,
      createdAt: now,
      expiresAt: now + opts.timeoutMs,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, { id, decision: 'ask', resolvedBy: 'timeout' }), opts.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { request, resolve, timer });
      this.cb.onRequest(request);
    });
  }

  /** Answer from a client. Returns false when the request is unknown/expired. */
  respond(id: string, decision: PermissionDecision, reason?: string): boolean {
    if (!this.pending.has(id)) return false;
    this.finish(id, { id, decision, reason, resolvedBy: 'phone' });
    return true;
  }

  /** Resolve everything for shutdown so no hook is left hanging. */
  dispose() {
    for (const id of [...this.pending.keys()]) {
      this.finish(id, { id, decision: 'ask', resolvedBy: 'timeout' });
    }
  }

  private finish(id: string, resolution: PermissionResolution) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(resolution);
    this.cb.onResolved(resolution, p.request);
  }
}
