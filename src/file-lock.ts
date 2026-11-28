import { randomBytes } from 'node:crypto';
import { linkSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { processStart } from './closing.js';

// A short lock for a synchronous read-modify-write of one file (a room's record, the janitor log's rotation).
// It is stale only once it is old and its holder is gone; waiting for it ends after `waitMs`, and then the
// caller goes on without it (as before the lock existed) rather than fail.
interface Holder {
  pid: number;
  token: string;
  start?: string;
}

const pause = new Int32Array(new SharedArrayBuffer(4));

function holder(path: string): Holder | undefined {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!Number.isInteger(o.pid) || typeof o.token !== 'string') return undefined;
    return { pid: o.pid as number, token: o.token, ...(typeof o.start === 'string' ? { start: o.start } : {}) };
  } catch {
    return undefined;
  }
}

// Held only by synchronous code: a lock of this process is a leftover.
function gone(h: Holder | undefined): boolean {
  if (h === undefined || h.pid <= 0 || h.pid === process.pid) return true;
  try {
    process.kill(h.pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'EPERM';
  }
  const start = h.start !== undefined ? processStart(h.pid) : undefined;
  return start !== undefined && start !== h.start;
}

// Written aside, then linked into place (which fails if the lock exists): no one ever sees it half-written.
function create(path: string, mine: Holder): boolean {
  const tmp = `${path}.${process.pid}.${mine.token}.new`;
  writeFileSync(tmp, JSON.stringify(mine), { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    unlinkQuiet(tmp);
  }
}

const ino = (path: string): number | undefined => {
  try {
    return statSync(path).ino;
  } catch {
    return undefined;
  }
};

function tryLock(path: string, mine: Holder, staleMs: number): boolean {
  if (create(path, mine)) return true;
  let at: number;
  let seenIno: number;
  try {
    const st = statSync(path);
    at = st.mtimeMs;
    seenIno = st.ino;
  } catch {
    return false;
  }
  if (Date.now() - at <= staleMs) return false;
  const seen = holder(path);
  if (!gone(seen)) return false;
  // Moved aside, never unlinked in place: of two breakers, the second moves the first one's fresh lock, sees
  // it is not the stale one (another file, whatever it holds, an empty one too) and puts it back.
  const aside = `${path}.${process.pid}.${mine.token}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  if (ino(aside) !== seenIno) {
    try {
      linkSync(aside, path);
    } catch {
      // taken meanwhile
    }
    unlinkQuiet(aside);
    return false;
  }
  unlinkQuiet(aside);
  return create(path, mine);
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

// What a holder or breaker that died mid-step left beside the lock (`<lock>.<pid>.<token>.new|stale`).
function sweepLeftovers(path: string): void {
  const prefix = `${basename(path)}.`;
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const m = /^(\d+)\.[0-9a-f]+\.(?:new|stale)$/.exec(name.slice(prefix.length));
    const pid = Number(m?.[1]);
    if (m === null || pid === process.pid || !gone({ pid, token: '' })) continue;
    unlinkQuiet(join(dirname(path), name));
  }
}

export function withFileLock<T>(path: string, fn: () => T, opts: { waitMs?: number; staleMs?: number } = {}): T {
  return locked(path, fn, opts, true) as T;
}

// The same, but `fn` is skipped (undefined) when the lock stays taken: for work another holder does anyway.
export function tryFileLock<T>(path: string, fn: () => T, opts: { waitMs?: number; staleMs?: number } = {}): T | undefined {
  return locked(path, fn, opts, false);
}

function locked<T>(path: string, fn: () => T, opts: { waitMs?: number; staleMs?: number }, failOpen: boolean): T | undefined {
  const start = processStart(process.pid);
  const mine: Holder = { pid: process.pid, token: randomBytes(8).toString('hex'), ...(start !== undefined ? { start } : {}) };
  const deadline = Date.now() + (opts.waitMs ?? 2_000);
  let got = false;
  for (;;) {
    try {
      got = tryLock(path, mine, opts.staleMs ?? 10_000);
    } catch {
      break;
    }
    if (got || Date.now() >= deadline) break;
    Atomics.wait(pause, 0, 0, 2);
  }
  if (got) sweepLeftovers(path);
  if (!got && !failOpen) return undefined;
  try {
    return fn();
  } finally {
    if (got && holder(path)?.token === mine.token) unlinkQuiet(path);
  }
}
