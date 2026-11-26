import { closeSync, fstatSync, openSync, readSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { HookLine } from './events.js';

const DEFAULT_POLL_MS = 500;
const READ_CHUNK = 64 * 1024;
// Hook lines are capped far below this; anything longer is not ours and is dropped whole.
const MAX_LINE = 1024 * 1024;
const FINGERPRINT = 32;
const NL = 0x0a;
const EMPTY = Buffer.alloc(0);

interface Cursor {
  ino: number;
  offset: number;
  // Last bytes before `offset`: a truncate-and-rewrite that keeps the inode and outgrows the
  // old offset changes them, which a size check alone would miss.
  tail: Buffer;
  partial: Buffer;
  skipping: boolean;
}

function isLine(v: unknown): v is HookLine {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.room === 'string' && o.room !== '' && typeof o.event === 'string' && typeof o.ts === 'number' && Number.isFinite(o.ts);
}

export class EventTail {
  private readonly roomsDir: string;
  private readonly pollMs: number;
  private readonly useWatch: boolean;
  private readonly cursors = new Map<string, Cursor>();
  private readonly watchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | undefined;
  private queued = false;
  private running = false;

  constructor(
    stateDir: string,
    private readonly onLine: (line: HookLine) => void,
    opts: { pollMs?: number; watch?: boolean } = {},
  ) {
    this.roomsDir = join(stateDir, 'rooms');
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.useWatch = opts.watch ?? true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scan();
    // fs.watch is unreliable on some filesystems, so polling always runs alongside it.
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private readonly schedule = (): void => {
    if (this.queued || !this.running) return;
    this.queued = true;
    setImmediate(() => {
      this.queued = false;
      if (this.running) this.scan();
    });
  };

  private watchDir(dir: string): void {
    if (!this.useWatch || this.watchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, this.schedule);
      w.on('error', () => {
        w.close();
        if (this.watchers.get(dir) === w) this.watchers.delete(dir);
      });
      this.watchers.set(dir, w);
    } catch {
      // Polling covers it.
    }
  }

  private scan(): void {
    if (!this.running) return;
    const files = new Set<string>();
    const dirs = new Set<string>();
    try {
      for (const d of readdirSync(this.roomsDir, { withFileTypes: true })) {
        if (d.isDirectory()) dirs.add(join(this.roomsDir, d.name));
      }
      dirs.add(this.roomsDir);
    } catch {
      // No rooms yet.
    }
    for (const [dir, w] of this.watchers) {
      if (!dirs.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    }
    for (const dir of dirs) {
      this.watchDir(dir);
      if (dir === this.roomsDir) continue;
      const file = join(dir, 'events.jsonl');
      files.add(file);
      this.read(file);
    }
    for (const file of this.cursors.keys()) if (!files.has(file)) this.cursors.delete(file);
  }

  private read(file: string): void {
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch {
      this.cursors.delete(file);
      return;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) {
        this.cursors.delete(file);
        return;
      }
      let c = this.cursors.get(file);
      if (c !== undefined && (c.ino !== st.ino || st.size < c.offset || (st.size > c.offset && !this.sameTail(fd, c)))) c = undefined;
      if (c === undefined) {
        c = { ino: st.ino, offset: 0, tail: EMPTY, partial: EMPTY, skipping: false };
        this.cursors.set(file, c);
      }
      const buf = Buffer.allocUnsafe(READ_CHUNK);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, c.offset);
        if (n === 0) break;
        const chunk = buf.subarray(0, n);
        c.offset += n;
        const joined = Buffer.concat([c.tail, chunk.subarray(Math.max(0, n - FINGERPRINT))]);
        c.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - FINGERPRINT)));
        this.consume(c, chunk);
      }
    } catch {
      // A file vanishing mid-read is retried on the next scan.
    } finally {
      closeSync(fd);
    }
  }

  private sameTail(fd: number, c: Cursor): boolean {
    if (c.tail.length === 0) return true;
    const now = Buffer.alloc(c.tail.length);
    const n = readSync(fd, now, 0, now.length, c.offset - c.tail.length);
    return n === now.length && now.equals(c.tail);
  }

  private consume(c: Cursor, chunk: Buffer): void {
    let start = 0;
    for (let i = chunk.indexOf(NL); i !== -1; i = chunk.indexOf(NL, start)) {
      const piece = chunk.subarray(start, i);
      start = i + 1;
      if (c.skipping) {
        c.skipping = false;
        continue;
      }
      const line = c.partial.length > 0 ? Buffer.concat([c.partial, piece]) : piece;
      c.partial = EMPTY;
      this.emit(line);
    }
    const rest = chunk.subarray(start);
    if (rest.length === 0 || c.skipping) return;
    if (c.partial.length + rest.length > MAX_LINE) {
      c.partial = EMPTY;
      c.skipping = true;
    } else {
      // Copy: `chunk` is a view into a reused read buffer.
      c.partial = Buffer.concat([c.partial, rest]);
    }
  }

  private emit(raw: Buffer): void {
    if (!this.running) return;
    let v: unknown;
    try {
      v = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!isLine(v)) return;
    try {
      this.onLine(v);
    } catch {
      // A consumer bug must not stop the tail for every other line.
    }
  }
}
