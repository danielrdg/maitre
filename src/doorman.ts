import { isActive, roomActivity } from './activity.js';
import { settings } from './config.js';
import { ensureServer, listWorkspaces } from './herdr.js';
import { logDecision } from './janitor.js';
import { roomSlug } from './paths.js';
import { roomPr } from './pr-state.js';
import {
  dropUnderLock,
  liveReservations,
  pruneReservations,
  readFailed,
  readQueue,
  reserveUnderLock,
  withQueueLock,
  writeFailed,
  writeQueue,
  type QueueEntry,
  type Reservation,
} from './queue.js';
import { readRequests } from './requests.js';
import { isRecord, openRoom, probeRoom } from './room-open.js';
import { listRooms, readRoom, type RoomRecord } from './rooms.js';
import { withMinutes } from './minutes.js';
import type { Route } from './router.js';

export { appendToQueued, queuedRooms, readFailed, readQueue, withQueueLock, type QueueEntry } from './queue.js';

// Failed opens in a row before a queued room leaves the queue for queue-failed.json.
export const MAX_ATTEMPTS = 3;
// A queued room whose open failed is tried again at most this often, however often the doorman is woken.
export const RETRY_MS = 60_000;

// An odd or future stamp (a clock set back) does not hold a room back.
function backingOff(e: QueueEntry, now: number): boolean {
  const at = e.lastAttemptAt;
  return typeof at === 'number' && Number.isFinite(at) && at <= now && now - at < RETRY_MS;
}

// 'running': the name's queue entry was already opened by the doorman; the caller delivers to that room.
export type Admitted = { kind: 'open'; release: () => void } | { kind: 'queued'; position: number } | { kind: 'running' };

interface Probe {
  names: Set<string>;
  at: number;
}

const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
const message = (err: unknown): string => firstLine(err instanceof Error ? err.message : String(err)) || 'unknown error';

// The active rooms as herdr sees them. Asked before taking the queue lock: herdr is never called under it.
async function probeActive(env: NodeJS.ProcessEnv): Promise<Probe> {
  const at = Date.now();
  const names = new Set<string>();
  const candidates = listRooms(env)
    .filter(isRecord)
    .map((rec) => ({ rec, activity: roomActivity(rec.room, env), pr: rec.kind === 'code' ? roomPr(rec, env) : undefined }))
    .filter(({ rec, activity, pr }) => isActive(rec, activity, true, pr));
  if (candidates.length > 0) {
    await ensureServer(env);
    const workspaces = await listWorkspaces();
    for (const { rec, activity, pr } of candidates) {
      if (isActive(rec, activity, (await probeRoom(rec, workspaces, env)) !== 'not running', pr)) names.add(rec.room);
    }
  }
  return { names, at };
}

// Disk only, so it runs under the lock: a room opened since the probe has its record but may have
// dropped its reservation already, so it counts too. A name counts once.
function seatsTaken(probe: Probe, live: Reservation[], env: NodeJS.ProcessEnv): number {
  const names = new Set(probe.names);
  for (const rec of listRooms(env)) {
    if (isRecord(rec) && rec.closedBy === undefined && typeof rec.createdAt === 'number' && rec.createdAt >= probe.at) names.add(rec.room);
  }
  for (const r of live) names.add(r.room);
  return names.size;
}

export async function activeCount(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return seatsTaken(await probeActive(env), liveReservations(env), env);
}

const opening = (room: string) => new Error(`${room} is opening`);

// A free seat → the `opening` reservation is written and the caller opens the room outside the lock,
// then calls `release`, on success and on failure. No seat → the room joins the queue.
export async function admit(
  route: Route,
  requestIds: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: { afterProbe?: () => void | Promise<void> } = {},
): Promise<Admitted> {
  const room = roomSlug(route.room.name);
  if (requestIds.length === 0) throw new Error(`nothing to queue for ${room}: no request ids`);
  const { capacity } = settings(env);
  const probe = await probeActive(env);
  const waiting = queuedEntry(room, env);
  const opened = waiting !== undefined && (await runningHead(waiting, env)) === 'ours' ? waiting : undefined;
  await deps.afterProbe?.();
  return withQueueLock(env, (): Admitted => {
    const live = pruneReservations(env);
    if (live.some((r) => r.room === room)) throw opening(room);
    const queue = readQueue(env);
    const i = queue.findIndex((e) => e.room === room);
    if (i >= 0) {
      const e = queue[i];
      if ((e.route.project ?? null) !== (route.project ?? null)) throw new Error(`a room named ${room} already waits for a seat in ${e.route.project ?? 'scratch'}`);
      // Opened by the doorman from this entry, which a failed settle left behind: the entry is done.
      if (opened !== undefined && sameEntry(e, opened)) {
        queue.splice(i, 1);
        writeQueue(queue, env);
        return { kind: 'running' };
      }
      const added = requestIds.filter((id) => !e.requestIds.includes(id));
      if (added.length > 0) {
        e.requestIds.push(...added);
        writeQueue(queue, env);
      }
      return { kind: 'queued', position: i + 1 };
    }
    // FIFO: with anyone waiting, a newcomer waits behind them and the doorman opens the head first.
    if (queue.length === 0 && seatsTaken(probe, live, env) < capacity) return { kind: 'open', release: reserveUnderLock(room, env) };
    queue.push({ room, requestIds: [...requestIds], route, queuedAt: Date.now(), attempts: 0 });
    writeQueue(queue, env);
    return { kind: 'queued', position: queue.length };
  });
}

export async function openQueued(entry: QueueEntry, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const r = entry.route;
  return openRoom(
    {
      name: entry.room,
      ...(typeof r.project === 'string' ? { project: r.project } : {}),
      model: r.model,
      taskType: r.taskType,
      brief: withMinutes(readRequests(entry.requestIds, env), r.continues, r.project, env),
      fromQueue: entry.queuedAt,
    },
    env,
  );
}

const isObject = (v: unknown): v is RoomRecord => typeof v === 'object' && v !== null && !Array.isArray(v);

const sameEntry = (a: QueueEntry, b: QueueEntry) => a.room === b.room && a.queuedAt === b.queuedAt;

// The head's name is registered and running. Opened by the doorman from this very entry (an earlier
// tick that could not take it off the queue): its requests are in that room. Anything else opened that
// name: the requests reached no room, so the entry is kept in queue-failed.json.
function queuedEntry(room: string, env: NodeJS.ProcessEnv): QueueEntry | undefined {
  try {
    return readQueue(env).find((e) => e.room === room);
  } catch {
    return undefined;
  }
}

async function runningHead(entry: QueueEntry, env: NodeJS.ProcessEnv): Promise<'ours' | 'other' | undefined> {
  const rec = readRoom(entry.room, env);
  if (!isObject(rec) || !isRecord(rec) || rec.closedBy !== undefined) return undefined;
  await ensureServer(env);
  if ((await probeRoom(rec, undefined, env)) === 'not running') return undefined;
  return rec.fromQueue === entry.queuedAt ? 'ours' : 'other';
}

export const OPENED_OUTSIDE = 'opened outside the queue';

// Under the lock, once the open is over: the entry leaves the queue, or its failure is counted.
function settle(entry: QueueEntry, error: string | undefined, now: number, env: NodeJS.ProcessEnv): 'opened' | 'retry' | QueueEntry {
  dropUnderLock(entry.room, env);
  const queue = readQueue(env);
  const i = queue.findIndex((e) => sameEntry(e, entry));
  if (error === undefined) {
    if (i >= 0) {
      queue.splice(i, 1);
      writeQueue(queue, env);
    }
    return 'opened';
  }
  if (i < 0) return 'retry';
  const e = { ...queue[i], attempts: queue[i].attempts + 1, lastError: error, lastAttemptAt: now };
  if (e.attempts < MAX_ATTEMPTS) {
    queue[i] = e;
    writeQueue(queue, env);
    return 'retry';
  }
  writeFailed([...readFailed(env), { ...e, failedAt: Date.now() }], env);
  queue.splice(i, 1);
  writeQueue(queue, env);
  return e;
}

// A queued room that left the queue for queue-failed.json: its requests reached no room.
export interface GaveUp {
  room: string;
  requestIds: string[];
  reason: string;
}

export interface DoormanResult {
  opened: string[];
  gaveUp: GaveUp[];
}

// Opens the oldest queued rooms while seats are free, one at a time. A failed head stays at the head
// (retried a minute later at the earliest) until its third failure in a row moves it to queue-failed.json.
export async function doormanTick(
  env: NodeJS.ProcessEnv = process.env,
  deps: { open?: (entry: QueueEntry, env: NodeJS.ProcessEnv) => Promise<unknown>; now?: () => number } = {},
): Promise<DoormanResult> {
  const out: DoormanResult = { opened: [], gaveUp: [] };
  try {
    await tick(out, env, deps.open ?? openQueued, deps.now ?? Date.now);
    return out;
  } catch (err) {
    // What already happened is reported; the error comes back on the next tick.
    if (out.opened.length > 0 || out.gaveUp.length > 0) return out;
    throw err;
  }
}

async function tick(
  out: DoormanResult,
  env: NodeJS.ProcessEnv,
  open: (entry: QueueEntry, env: NodeJS.ProcessEnv) => Promise<unknown>,
  now: () => number,
): Promise<void> {
  const gaveUp = (e: QueueEntry, reason: string) => {
    logDecision({ room: e.room, decision: 'error', reasons: [reason] }, env);
    out.gaveUp.push({ room: e.room, requestIds: [...e.requestIds], reason });
  };
  for (;;) {
    const first = readQueue(env)[0];
    if (first === undefined) return;
    const running = await runningHead(first, env);
    if (running !== undefined) {
      const done = await withQueueLock(env, (): QueueEntry | boolean => {
        const queue = readQueue(env);
        const i = queue.findIndex((e) => sameEntry(e, first));
        if (i < 0) return true;
        // Another process is still opening it: wait for the next tick.
        if (pruneReservations(env).some((r) => r.room === first.room)) return false;
        const [e] = queue.splice(i, 1);
        if (running === 'other') writeFailed([...readFailed(env), { ...e, lastError: OPENED_OUTSIDE, failedAt: Date.now() }], env);
        writeQueue(queue, env);
        return running === 'other' ? e : true;
      });
      if (done === false) return;
      if (done !== true) gaveUp(done, `left the queue: ${OPENED_OUTSIDE}`);
      continue;
    }
    // FIFO: a head waiting out its retry holds the queue.
    if (backingOff(first, now())) return;
    const { capacity } = settings(env);
    const probe = await probeActive(env);
    const pick = await withQueueLock(env, () => {
      const head = readQueue(env)[0];
      if (head === undefined || backingOff(head, now())) return undefined;
      const live = pruneReservations(env);
      if (live.some((r) => r.room === head.room) || seatsTaken(probe, live, env) >= capacity) return undefined;
      return { entry: head, release: reserveUnderLock(head.room, env) };
    });
    if (pick === undefined) return;
    let error: string | undefined;
    try {
      await open(pick.entry, env);
    } catch (err) {
      error = message(err);
    }
    let outcome: ReturnType<typeof settle>;
    try {
      outcome = await withQueueLock(env, () => settle(pick.entry, error, now(), env));
    } finally {
      pick.release();
    }
    if (outcome === 'opened') out.opened.push(pick.entry.room);
    else if (outcome === 'retry') return;
    else gaveUp(outcome, `left the queue after ${MAX_ATTEMPTS} failed opens: ${error}`);
  }
}
