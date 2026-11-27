import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  // When the marker was last written (its mtime), read from disk, never stored in it.
  at?: number;
}

// Only where the closer's start time cannot be read (no /proc): a marker its heartbeat stopped touching
// for this long is a dead closer's. With a start time, a reused pid is already told apart.
export const MARKER_MAX_AGE_MS = 15 * 60_000;
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

function lockOnce(lock: string, mark: ClosingMarker): boolean {
  if (create(lock, mark)) return true;
  const at = mtime(lock);
  if (at === undefined || Date.now() - at <= TAKEOVER_STALE_MS) return false;
  try {
    unlinkSync(lock);
  } catch {
    return false;
  }
  return create(lock, mark);
}

function underLock<T>(path: string, token: string, fn: () => T, tries = LOCK_TRIES): T | 'busy' {
  const lock = `${path}.takeover`;
  const mark: ClosingMarker = { pid: process.pid, token };
  let got = false;
  for (let i = 0; i < tries && !got; i++) {
    got = lockOnce(lock, mark);
    if (!got) Atomics.wait(pause, 0, 0, LOCK_WAIT_MS);
  }
  if (!got) return 'busy';
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
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

function beat(path: string, token: string): void {
  const m = parseMarker(path);
  if (m === undefined || m.token !== token || m.pid !== process.pid) return stopBeat(token);
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // gone: the next beat stops
  }
}

function stopBeat(token: string): void {
  clearInterval(held.get(token));
  held.delete(token);
}

export function takeClosing(room: string, env: NodeJS.ProcessEnv = process.env, opts: { heartbeatMs?: number } = {}): Held | 'busy' {
  const path = closingFile(room, env);
  const token = randomBytes(8).toString('hex');
  const start = processStart(process.pid);
  const mine: ClosingMarker = { pid: process.pid, token, ...(start !== undefined ? { start } : {}) };
  // Held before the marker exists: from its first byte on disk it reads as a live closer.
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
