import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { roomDir } from './paths.js';

// The per-room closing marker: one closer at a time, and a room being closed takes no new messages.
export interface ClosingMarker {
  pid: number;
  token: string;
  // The closer's start time (/proc/<pid>/stat field 22): a reused pid has another one.
  start?: string;
  minutes?: string;
  // The createdAt of the record being closed: minutes are reused only for that same opening of the room.
  createdAt?: number;
  // When this closer took the marker (wall clock, for people).
  since?: number;
  // How long this closer has been running since (its monotonic clock, which a suspend does not advance),
  // as its heartbeat last wrote it.
  awakeMs?: number;
  // When the marker was last written (its mtime), read from disk, never stored in it.
  at?: number;
}

// Only where the closer's start time cannot be read (no /proc): a marker its heartbeat stopped touching
// for this long is a dead closer's. With a start time, a reused pid is already told apart.
export const MARKER_MAX_AGE_MS = 15 * 60_000;
// However alive its closer: a close that hangs (a call that never returns, its heartbeat still beating) must
// not hold its room forever. A close takes minutes at most; one taken over past this finds out (ClosingTakenOver).
export const MARKER_HARD_MS = 2 * 3_600_000;
export const HEARTBEAT_MS = 60_000;
const TAKEOVER_STALE_MS = 30_000;

// Markers this process holds right now, with their heartbeat: for our own pid, the token says whether
// the closer is still running.
const held = new Map<string, NodeJS.Timeout>();

export function closingFile(room: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(roomDir(room, env), 'closing');
}

export function readClosing(room: string, env: NodeJS.ProcessEnv = process.env): ClosingMarker | undefined {
  return parseMarker(closingFile(room, env));
}

function parseMarker(path: string): ClosingMarker | undefined {
  let raw: unknown;
  let at: number | undefined;
  try {
    at = statSync(path).mtimeMs;
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // Unreadable or half-written: nobody can be shown to hold it.
    return { pid: 0, token: '' };
  }
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    pid: Number.isInteger(o.pid) ? (o.pid as number) : 0,
    token: typeof o.token === 'string' ? o.token : '',
    ...(typeof o.start === 'string' ? { start: o.start } : {}),
    ...(typeof o.minutes === 'string' ? { minutes: o.minutes } : {}),
    ...(typeof o.createdAt === 'number' ? { createdAt: o.createdAt } : {}),
    ...(typeof o.since === 'number' && Number.isFinite(o.since) ? { since: o.since } : {}),
    ...(typeof o.awakeMs === 'number' && Number.isFinite(o.awakeMs) ? { awakeMs: o.awakeMs } : {}),
    ...(at !== undefined ? { at } : {}),
  };
}

const stored = ({ at: _at, ...m }: ClosingMarker): ClosingMarker => m;

export function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) may hold spaces and parentheses: count from the last ')'.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

// pid 0 or below would signal a process group: never a live closer. EPERM: another user's process, not ours.
export function closerAlive(m: ClosingMarker, now = Date.now()): boolean {
  if (m.pid <= 0) return false;
  // Counted in the closer's own running time: a laptop suspended mid-close resumes with its closer still alive.
  if (m.awakeMs !== undefined && m.awakeMs > MARKER_HARD_MS) return false;
  if (m.pid === process.pid) return held.has(m.token);
  try {
    process.kill(m.pid, 0);
  } catch {
    return false;
  }
  const start = m.start !== undefined ? processStart(m.pid) : undefined;
  if (start !== undefined) return start === m.start;
  return m.at === undefined || now - m.at <= MARKER_MAX_AGE_MS;
}

// The minutes a close that died after closing the room's tab (its marker set to pid 0, or the folder already
// gone) left for the next close of that same opening of the room to finish with.
export function leftMinutes(m: ClosingMarker | undefined, createdAt: number, dirThere: boolean): string | undefined {
  return m?.minutes !== undefined && m.createdAt === createdAt && (!dirThere || m.pid === 0) && existsSync(m.minutes) ? m.minutes : undefined;
}

export function isClosing(room: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const m = readClosing(room, env);
  return m !== undefined && closerAlive(m);
}

export interface Held {
  token: string;
  // The marker a dead closer left behind, when this close took it over.
  previous?: ClosingMarker;
}

// Written aside, then linked into place: no reader ever sees a marker without its pid.
function create(path: string, m: ClosingMarker): boolean {
  const tmp = `${path}.${process.pid}.${m.token}.new`;
  writeFileSync(tmp, JSON.stringify(stored(m)), { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}

function mtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

// Every change to an existing marker (a takeover, a note) happens under this second, short-lived lock,
// so a closer never rewrites a marker another closer has just taken over.
// The lock is held for a few file operations: waiting a moment for it beats giving up a release or a note.
const LOCK_TRIES = 200;
const LOCK_WAIT_MS = 5;
const pause = new Int32Array(new SharedArrayBuffer(4));

// The short lock is held only by synchronous code: a lock of this process is never held across a call, and
// a lock is stale only when it is old and its holder is gone.
function holderGone(m: ClosingMarker): boolean {
  if (m.pid <= 0 || m.pid === process.pid) return true;
  try {
    process.kill(m.pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'EPERM';
  }
  const start = m.start !== undefined ? processStart(m.pid) : undefined;
  return start !== undefined && start !== m.start;
}

function lockOnce(lock: string, mark: ClosingMarker): boolean {
  if (create(lock, mark)) return true;
  const at = mtime(lock);
  if (at === undefined || Date.now() - at <= TAKEOVER_STALE_MS) return false;
  const seen = parseMarker(lock);
  if (seen === undefined || !holderGone(seen)) return false;
  // Moved aside, never unlinked in place: of two closers breaking it, the second moves the first one's fresh
  // lock, sees it is not the stale one and puts it back.
  const aside = `${lock}.${process.pid}.${mark.token}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return false;
  }
  const moved = parseMarker(aside);
  if (moved?.token !== seen.token || moved.pid !== seen.pid) {
    try {
      linkSync(aside, lock);
    } catch {
      // someone else took it meanwhile
    }
    unlinkQuiet(aside);
    return false;
  }
  unlinkQuiet(aside);
  return create(lock, mark);
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function underLock<T>(path: string, token: string, fn: () => T, tries = LOCK_TRIES): T | 'busy' {
  const lock = `${path}.takeover`;
  const start = processStart(process.pid);
  const mark: ClosingMarker = { pid: process.pid, token, ...(start !== undefined ? { start } : {}) };
  let got = false;
  for (let i = 0; i < tries && !got; i++) {
    got = lockOnce(lock, mark);
    if (!got) Atomics.wait(pause, 0, 0, LOCK_WAIT_MS);
  }
  if (!got) return 'busy';
  try {
    return fn();
  } finally {
    // Only our own lock: one broken and taken by another closer is theirs.
    const now = parseMarker(lock);
    if (now?.token === token && now.pid === process.pid) unlinkQuiet(lock);
  }
}

// What a closer that died mid-write left beside the marker (`closing.<pid>.<token>.new|tmp`, and the same
// for the takeover lock): removed once its process is gone.
const LEFT = /^closing(?:\.takeover)?\.(\d+)\.[0-9a-z]+\.(?:new|tmp|stale)$/;

function sweepLeftovers(path: string): void {
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(LEFT.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch {
      unlinkQuiet(join(dirname(path), name));
    }
  }
}

// Only after checking again, under the lock, that the marker is the same dead one: a live closer's
// marker is never moved.
function takeOver(path: string, seen: ClosingMarker, mine: ClosingMarker): ClosingMarker | 'busy' {
  return underLock(path, mine.token, () => {
    const again = parseMarker(path);
    if (again !== undefined && (again.token !== seen.token || closerAlive(again))) return 'busy';
    if (again !== undefined) unlinkSync(path);
    if (!create(path, mine)) return 'busy';
    return again ?? seen;
  });
}

// When each held marker was taken, on this process's monotonic clock.
const taken = new Map<string, number>();

// Touches the marker and writes how long the closer has been running; a busy takeover lock only skips the
// write (the next beat makes it), never the touch.
function beat(path: string, token: string): void {
  const m = parseMarker(path);
  if (m === undefined || m.token !== token || m.pid !== process.pid) return stopBeat(token);
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // gone: the next beat stops
  }
  const t0 = taken.get(token);
  if (t0 === undefined) return;
  const awakeMs = Math.round(performance.now() - t0);
  try {
    underLock(
      path,
      token,
      () => {
        const again = parseMarker(path);
        if (again === undefined || again.token !== token || again.pid !== process.pid) return;
        const tmp = `${path}.${process.pid}.${token}.tmp`;
        writeFileSync(tmp, JSON.stringify(stored({ ...again, awakeMs })), { mode: 0o600 });
        renameSync(tmp, path);
      },
      1,
    );
  } catch {
    // the next beat tries again
  }
}

function stopBeat(token: string): void {
  taken.delete(token);
  clearInterval(held.get(token));
  held.delete(token);
}

export function takeClosing(room: string, env: NodeJS.ProcessEnv = process.env, opts: { heartbeatMs?: number } = {}): Held | 'busy' {
  const path = closingFile(room, env);
  const token = randomBytes(8).toString('hex');
  const start = processStart(process.pid);
  const mine: ClosingMarker = { pid: process.pid, token, ...(start !== undefined ? { start } : {}), since: Date.now() };
  // Held before the marker exists: from its first byte on disk it reads as a live closer.
  taken.set(token, performance.now());
  const timer = setInterval(() => beat(path, token), opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();
  held.set(token, timer);
  let previous: ClosingMarker | 'busy' | undefined;
  if (!create(path, mine)) {
    const seen = parseMarker(path);
    if (seen === undefined) previous = create(path, mine) ? undefined : 'busy';
    else previous = closerAlive(seen) ? 'busy' : takeOver(path, seen, mine);
  }
  if (previous === 'busy') {
    stopBeat(token);
    return 'busy';
  }
  sweepLeftovers(path);
  return previous !== undefined ? { token, previous: stored(previous) } : { token };
}

export function ownsClosing(room: string, token: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const m = readClosing(room, env);
  return held.has(token) && m !== undefined && m.token === token && m.pid === process.pid;
}

type Note = { minutes?: string; createdAt?: number; pid?: number };
type Op = { kind: 'note'; patch: Note } | { kind: 'release' };

// Notes and releases that found the takeover lock busy, in order, per token. The token stays held (and
// its heartbeat runs) until its release is done: in a long-lived process (the lounge) a dropped release
// would leave a marker that reads as a live closer for as long as that process runs.
const deferred = new Map<string, { room: string; env: NodeJS.ProcessEnv; ops: Op[] }>();

// Under the lock and only while still ours: a closer that was taken over never rewrites the new marker.
function apply(room: string, token: string, op: Op, env: NodeJS.ProcessEnv, tries?: number): boolean {
  const path = closingFile(room, env);
  const done = underLock(
    path,
    token,
    () => {
      if (!ownsClosing(room, token, env)) return;
      if (op.kind === 'release') {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
        return;
      }
      const next = stored({ ...readClosing(room, env)!, ...op.patch });
      const tmp = `${path}.${process.pid}.${token}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      renameSync(tmp, path);
    },
    tries,
  );
  if (done === 'busy') return false;
  if (op.kind === 'release' || (op.patch.pid !== undefined && op.patch.pid !== process.pid)) stopBeat(token);
  return true;
}

function submit(room: string, token: string, op: Op, env: NodeJS.ProcessEnv): void {
  const waiting = deferred.get(token);
  if (waiting !== undefined) waiting.ops.push(op);
  else if (!apply(room, token, op, env)) deferred.set(token, { room, env, ops: [op] });
}

export function noteClosing(room: string, token: string, patch: Note, env: NodeJS.ProcessEnv = process.env): void {
  submit(room, token, { kind: 'note', patch }, env);
}

export function releaseClosing(room: string, token: string, env: NodeJS.ProcessEnv = process.env): void {
  submit(room, token, { kind: 'release' }, env);
}

// For the lounge's tick: one try each, so a still-busy lock never stalls the event loop. Returns how many
// tokens still wait.
export function retryClosings(): number {
  for (const [token, d] of [...deferred]) {
    for (;;) {
      const op = d.ops[0];
      if (op === undefined) break;
      try {
        if (!apply(d.room, token, op, d.env, 1)) break;
      } catch {
        // The marker cannot be written at all (its folder is gone): retrying would fail every tick.
        if (op.kind === 'release') stopBeat(token);
      }
      d.ops.shift();
    }
    if (d.ops.length === 0) deferred.delete(token);
  }
  return deferred.size;
}

export function pendingClosings(): number {
  return deferred.size;
}
