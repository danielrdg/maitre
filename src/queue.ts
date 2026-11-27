import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { processStart } from './closing.js';
import { readJson, writeJsonAtomic } from './config.js';
import { maitreHome, roomSlug } from './paths.js';
import { isRequestId } from './requests.js';
import type { Route } from './router.js';

// The sidewalk on disk. Every change happens under state/queue.lock, held only for a read-modify-write
// of these files: never across a herdr call or while a room opens.
export interface QueueEntry {
  room: string;
  requestIds: string[];
  route: Route;
  queuedAt: number;
  attempts: number;
  lastError?: string;
  // When its last open failed: the doorman tries a queued room at most once a minute.
  lastAttemptAt?: number;
}

export type FailedEntry = QueueEntry & { failedAt: number };

// A seat taken by a room that is being opened right now; it counts as active until dropped.
export interface Reservation {
  room: string;
  pid: number;
  since: number;
  // The opener's start time (/proc/<pid>/stat field 22): a reused pid has another one.
  start?: string;
}

export const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 35_000;
const SYNC_WAIT_MS = 5_000;
const RETRY_MS = 10;

const stateDir = (env: NodeJS.ProcessEnv) => join(maitreHome(env), 'state');
export const queueFile = (env: NodeJS.ProcessEnv = process.env) => join(stateDir(env), 'queue.json');
export const failedFile = (env: NodeJS.ProcessEnv = process.env) => join(stateDir(env), 'queue-failed.json');
export const openingFile = (env: NodeJS.ProcessEnv = process.env) => join(stateDir(env), 'opening.json');
export const queueLock = (env: NodeJS.ProcessEnv = process.env) => join(stateDir(env), 'queue.lock');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isEntry(v: unknown): v is QueueEntry {
  if (!isObject(v) || typeof v.room !== 'string' || !isObject(v.route) || !isObject(v.route.room)) return false;
  try {
    if (roomSlug(v.room) !== v.room) return false;
  } catch {
    return false;
  }
  return (
    Array.isArray(v.requestIds) &&
    v.requestIds.length > 0 &&
    v.requestIds.every((x) => typeof x === 'string' && isRequestId(x)) &&
    typeof v.queuedAt === 'number' &&
    Number.isInteger(v.attempts) &&
    (v.lastError === undefined || typeof v.lastError === 'string') &&
    (v.lastAttemptAt === undefined || typeof v.lastAttemptAt === 'number')
  );
}

// A file that is not a list of entries is an error, never read as empty: a write would drop what it held.
function readList<T>(path: string, ok: (v: unknown) => v is T): T[] {
  const raw = readJson(path);
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every(ok)) throw new Error(`cannot read ${path}: not a list of queued rooms`);
  return raw;
}

export function readQueue(env: NodeJS.ProcessEnv = process.env): QueueEntry[] {
  return readList(queueFile(env), isEntry);
}

export function readFailed(env: NodeJS.ProcessEnv = process.env): FailedEntry[] {
  return readList(failedFile(env), (v): v is FailedEntry => isEntry(v) && typeof (v as FailedEntry).failedAt === 'number');
}

export function writeQueue(queue: QueueEntry[], env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(queueFile(env), queue);
}

export function writeFailed(failed: FailedEntry[], env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(failedFile(env), failed);
}

export function queuedRooms(env: NodeJS.ProcessEnv = process.env): { room: string; position: number; project?: string }[] {
  return readQueue(env).map((e, i) => ({ room: e.room, position: i + 1, ...(typeof e.route.project === 'string' ? { project: e.route.project } : {}) }));
}

// --- the lock

function tryLock(path: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let at: number;
    try {
      at = statSync(path).mtimeMs;
    } catch {
      return false;
    }
    if (Date.now() - at <= LOCK_STALE_MS) return false;
    try {
      unlinkSync(path);
    } catch {
      return false;
    }
    return false;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, token }));
  } finally {
    closeSync(fd);
  }
  return true;
}

function unlock(path: string, token: string): void {
  try {
    if ((JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown }).token !== token) return;
    unlinkSync(path);
  } catch {
    // gone, or broken as stale by someone else
  }
}

const busy = (env: NodeJS.ProcessEnv) => new Error(`the queue is locked (${queueLock(env)}); try again`);
const pause = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ensureStateDir(env: NodeJS.ProcessEnv): void {
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
}

// `fn` should be synchronous: the lock is only for a read-modify-write of the queue files.
export async function withQueueLock<T>(env: NodeJS.ProcessEnv, fn: () => T | Promise<T>): Promise<T> {
  const path = queueLock(env);
  const token = randomBytes(8).toString('hex');
  ensureStateDir(env);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!tryLock(path, token)) {
    if (Date.now() >= deadline) throw busy(env);
    await sleep(RETRY_MS);
  }
  try {
    return await fn();
  } finally {
    unlock(path, token);
  }
}

// For the few callers that cannot wait asynchronously; other holders keep the lock for milliseconds.
export function withQueueLockSync<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const path = queueLock(env);
  const token = randomBytes(8).toString('hex');
  ensureStateDir(env);
  const deadline = Date.now() + SYNC_WAIT_MS;
  while (!tryLock(path, token)) {
    if (Date.now() >= deadline) throw busy(env);
    Atomics.wait(pause, 0, 0, RETRY_MS);
  }
  try {
    return fn();
  } finally {
    unlock(path, token);
  }
}

// --- reservations

// Reservations this process holds right now: for our own pid, this says whether the opener still runs.
const held = new Set<string>();
const heldKey = (room: string, env: NodeJS.ProcessEnv) => `${maitreHome(env)}\0${room}`;

function isReservation(v: unknown): v is Reservation {
  return isObject(v) && typeof v.room === 'string' && Number.isInteger(v.pid) && typeof v.since === 'number' && (v.start === undefined || typeof v.start === 'string');
}

// An unreadable reservations file holds nothing that can be shown to be live.
function readOpening(env: NodeJS.ProcessEnv): Reservation[] {
  try {
    const raw = readJson(openingFile(env));
    return Array.isArray(raw) ? raw.filter(isReservation) : [];
  } catch {
    return [];
  }
}

function alive(r: Reservation, env: NodeJS.ProcessEnv): boolean {
  if (r.pid <= 0) return false;
  if (r.pid === process.pid) return held.has(heldKey(r.room, env));
  try {
    process.kill(r.pid, 0);
  } catch {
    return false;
  }
  const start = r.start !== undefined ? processStart(r.pid) : undefined;
  return start === undefined || start === r.start;
}

export function liveReservations(env: NodeJS.ProcessEnv = process.env): Reservation[] {
  return readOpening(env).filter((r) => alive(r, env));
}

export function isOpening(room: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return liveReservations(env).some((r) => r.room === room);
}

// Under the lock: drops the reservations of openers that are gone and returns the live ones.
export function pruneReservations(env: NodeJS.ProcessEnv): Reservation[] {
  const all = readOpening(env);
  const live = all.filter((r) => alive(r, env));
  if (live.length !== all.length) writeJsonAtomic(openingFile(env), live);
  return live;
}

// Under the lock. The returned release drops the reservation, best effort: once this process no longer
// holds it, it reads as stale anyway.
export function reserveUnderLock(room: string, env: NodeJS.ProcessEnv): () => void {
  const live = pruneReservations(env);
  if (live.some((r) => r.room === room)) throw new Error(`${room} is opening`);
  const start = processStart(process.pid);
  writeJsonAtomic(openingFile(env), [...live, { room, pid: process.pid, since: Date.now(), ...(start !== undefined ? { start } : {}) }]);
  held.add(heldKey(room, env));
  return () => {
    if (!held.has(heldKey(room, env))) return;
    try {
      withQueueLockSync(env, () => dropUnderLock(room, env));
    } catch {
      held.delete(heldKey(room, env));
    }
  };
}

export function dropUnderLock(room: string, env: NodeJS.ProcessEnv): void {
  held.delete(heldKey(room, env));
  const all = readOpening(env);
  const rest = all.filter((r) => !(r.room === room && r.pid === process.pid));
  if (rest.length !== all.length) writeJsonAtomic(openingFile(env), rest);
}

// A seat for a room opened outside the doorman (`maitre room open`): no capacity check, but the janitor
// and other openers see it is being opened.
export async function reserve(room: string, env: NodeJS.ProcessEnv = process.env): Promise<() => void> {
  return withQueueLock(env, () => reserveUnderLock(roomSlug(room), env));
}

// --- changes from outside the doorman

// A first look without the lock, so a room that is not queued never waits on it, nor on an unreadable file.
function listed(room: string, read: () => QueueEntry[]): boolean {
  try {
    return read().some((e) => e.room === room);
  } catch {
    return false;
  }
}

// A follow-up to a queued room joins its entry. A room that is being opened already read its brief.
export function appendToQueued(room: string, requestIds: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (!listed(room, () => readQueue(env))) return false;
  return withQueueLockSync(env, () => {
    const queue = readQueue(env);
    const entry = queue.find((e) => e.room === room);
    if (entry === undefined) return false;
    if (pruneReservations(env).some((r) => r.room === room)) throw new Error(`${room} is opening; send it again once it is open`);
    const added = requestIds.filter((id) => !entry.requestIds.includes(id));
    if (added.length > 0) {
      entry.requestIds.push(...added);
      writeQueue(queue, env);
    }
    return true;
  });
}

// `maitre room close` on a room that is not open yet: it leaves the queue (or the failed list).
export async function removeQueued(room: string, env: NodeJS.ProcessEnv = process.env): Promise<'queue' | 'failed' | undefined> {
  if (!listed(room, () => readQueue(env)) && !listed(room, () => readFailed(env))) return undefined;
  return withQueueLock(env, () => {
    const queue = readQueue(env);
    const i = queue.findIndex((e) => e.room === room);
    if (i >= 0) {
      if (pruneReservations(env).some((r) => r.room === room)) throw new Error(`${room} is opening; close it once it is open`);
      queue.splice(i, 1);
      writeQueue(queue, env);
      return 'queue';
    }
    const failed = readFailed(env);
    const j = failed.findIndex((e) => e.room === room);
    if (j < 0) return undefined;
    failed.splice(j, 1);
    writeFailed(failed, env);
    return 'failed';
  });
}
