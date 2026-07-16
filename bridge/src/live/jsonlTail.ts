import { statSync, createReadStream, watch, type FSWatcher, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent } from '../events.js';

/** Translates one parsed JSONL object into zero or more AgentEvents. */
export type LineParser = (obj: any) => AgentEvent[];

/**
 * Read a JSONL transcript file into events (used for history on first attach).
 * `endOffset` bounds the read to the first N bytes so lines appended while we read
 * are left for the tailer — otherwise they'd be emitted twice.
 */
export function readJsonlEvents(file: string, parse: LineParser, endOffset?: number): Promise<AgentEvent[]> {
  return new Promise((resolve) => {
    const events: AgentEvent[] = [];
    if (endOffset !== undefined && endOffset <= 0) return resolve(events);
    const stream = endOffset !== undefined
      ? createReadStream(file, { encoding: 'utf8', end: endOffset - 1 })
      : createReadStream(file, { encoding: 'utf8' });
    const rl = createInterface({ input: stream });
    rl.on('line', (line) => {
      try {
        events.push(...parse(JSON.parse(line)));
      } catch {
        // ignore
      }
    });
    rl.on('close', () => resolve(events));
    rl.on('error', () => resolve(events));
  });
}

/**
 * Tails a single JSONL file, emitting AgentEvents for lines appended after
 * `startOffset` bytes. Debounces fs change notifications and handles truncation.
 */
export class JsonlTailer {
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private offset: number;
  private carry = '';
  private reading = false;
  private pending = false;

  constructor(
    private file: string,
    startOffset: number,
    private parse: LineParser,
    private onEvents: (events: AgentEvent[]) => void,
  ) {
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
      // Watch the directory, not the file: some CLIs replace the transcript
      // via rename on resume, and a file watcher would keep following the dead
      // inode and go silent.
      const name = basename(this.file);
      this.watcher = watch(dirname(this.file), (_event, filename) => {
        if (!filename || filename === name) this.scheduleRead();
      });
    } catch {
      // Directory may vanish; the poll below still covers us.
    }
    // Belt-and-braces: some editors/filesystems drop watch events entirely.
    this.pollTimer = setInterval(() => {
      if (JsonlTailer.byteLength(this.file) !== this.offset) this.scheduleRead();
    }, 2000);
    this.pollTimer.unref?.();
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
            events.push(...this.parse(JSON.parse(trimmed)));
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
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
