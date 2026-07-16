import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_FILE = join(homedir(), '.agentdeck', 'archived-sessions.json');
const MAX_ENTRIES = 500;

/**
 * Native session ids the user archived, persisted so live discovery stops
 * resurfacing them across bridge restarts. A dismissed session reappears if its
 * transcript gains activity after the dismissal (e.g. resumed in a terminal).
 */
export class DismissedSessions {
  /** nativeSessionId -> dismissedAt (ms epoch) */
  private map = new Map<string, number>();

  constructor(private file = DEFAULT_FILE) {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (data && typeof data === 'object') {
        for (const [id, at] of Object.entries(data)) {
          if (typeof at === 'number') this.map.set(id, at);
        }
      }
    } catch {
      // First run or unreadable file — start empty.
    }
  }

  /**
   * `graceMs` extends the dismissal window past now — needed when archiving a
   * bridge-spawned session, whose process still flushes its transcript while
   * shutting down (that flush must not count as "new activity").
   */
  dismiss(nativeSessionId: string, graceMs = 0) {
    this.map.set(nativeSessionId, Date.now() + graceMs);
    if (this.map.size > MAX_ENTRIES) {
      this.map = new Map([...this.map.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES));
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)) + '\n');
    } catch {
      // Best effort — worst case the dismissal only lasts until restart.
    }
  }

  /** Dismissed, and with no transcript activity since the dismissal. */
  isDismissed(nativeSessionId: string, updatedAt: number): boolean {
    const at = this.map.get(nativeSessionId);
    return at !== undefined && updatedAt <= at;
  }
}
