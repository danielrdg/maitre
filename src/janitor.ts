import { execFile } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isIdle, isQuiet, roomActivity, type RoomActivity } from './activity.js';
import { closerAlive, noteClosing, ownsClosing, readClosing, releaseClosing, takeClosing, type ClosingMarker } from './closing.js';
import { settings } from './config.js';
import { cleanEnv } from './env.js';
import { ensureServer, herdrSession, listWorkspaces } from './herdr.js';
import { writeMinutes } from './minutes.js';
import { maitreHome, roomSlug } from './paths.js';
import { checkPending } from './pending.js';
import { roomPr, type PrState } from './pr-state.js';
import { isOpening, removeQueued } from './queue.js';
import { readIndex } from './projects.js';
import { checkInput, CloseStopped, closeRoomTab, isRecord, markRunning, probeRoom, unsentInput, type RoomLiveness } from './room-open.js';
import { listRooms, patchRoom, readRoom, sameRoom, writeRoom, type RoomRecord } from './rooms.js';
import { park, whyPark, type ParkDeps } from './seats.js';
import { expectedDir, moveScratch, ownedDir } from './vault.js';

export type JanitorDecision = { room: string; decision: 'close' | 'couch' | 'park' | 'skip' | 'error'; reasons: string[] };

export interface ClosedRoom {
  minutes: string;
  worktreeRemoved: boolean;
  notes: string[];
}

export interface CloseDeps {
  // What the decision was made on: a janitor close aborts when the room has anything newer.
  activity?: RoomActivity;
  looseEnds?: string[];
  ignoredGone?: string[];
  // Why the janitor closes the room, for its minutes (a merged or closed PR).
  why?: string;
  exitTimeoutMs?: number;
  writeMinutes?: typeof writeMinutes;
  heartbeatMs?: number;
  afterTabClosed?: () => void | Promise<void>;
}

// The marker went stale under this closer (e.g. a long suspend) and another closer took it over.
export class ClosingTakenOver extends Error {
  constructor(room: string) {
    super(`room ${room}: another closer took over its close`);
    this.name = 'ClosingTakenOver';
  }
}

export class RoomBecameActive extends Error {
  constructor(room: string) {
    super(`room ${room} became active`);
    this.name = 'RoomBecameActive';
  }
}

const GIT_TIMEOUT_MS = 60_000;
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];

const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
const message = (err: unknown): string => firstLine(err instanceof Error ? err.message : String(err)) || 'unknown error';

function exists(path: unknown): boolean {
  return typeof path === 'string' && path !== '' && existsSync(path);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const withoutCouch = ({ couch: _c, ...r }: RoomRecord): RoomRecord => r;
const withoutPending = ({ pending: _p, ...r }: RoomRecord): RoomRecord => r;
const withoutSeat = ({ seat: _s, ...r }: RoomRecord): RoomRecord => r;

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...cleanEnv(env), GIT_TERMINAL_PROMPT: '0' };
  for (const k of REPO_VARS) delete out[k];
  return out;
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    const child = execFile('git', args, { cwd, env: gitEnv(env), timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      done(err === null ? { ok: true, out: stdout.trim() } : { ok: false, out: firstLine(stderr) || message(err) }),
    );
    child.stdin?.end();
  });
}

// `git worktree remove` runs from the project's main clone: never with --force, so git refuses a dirty,
// locked or submodule worktree instead of deleting it, and the branch always stays.
async function removeWorktree(rec: RoomRecord, dir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  let main: string | undefined;
  try {
    const path = readIndex(env).find((p) => p.name === rec.project)?.path;
    if (typeof path === 'string' && isDir(path)) main = path;
  } catch {
    main = undefined;
  }
  if (main === undefined) {
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir, env);
    if (!common.ok) return `could not find the project's clone: ${common.out}`;
    main = common.out;
  }
  const r = await git(['worktree', 'remove', dir], main, env);
  return r.ok ? undefined : r.out;
}

function appendNote(minutes: string, lines: string[]): void {
  appendFileSync(minutes, ['', '## Not done when closing', '', ...lines.map((l) => `- ${l}`), ''].join('\n'));
}

export async function closeWithMinutes(
  rec: RoomRecord,
  by: 'janitor' | 'user',
  env: NodeJS.ProcessEnv = process.env,
  deps: CloseDeps = {},
): Promise<ClosedRoom | 'busy'> {
  const room = rec.room;
  const held = takeClosing(room, env, { heartbeatMs: deps.heartbeatMs });
  if (held === 'busy') return 'busy';
  const stillMine = () => {
    if (!ownsClosing(room, held.token, env)) throw new ClosingTakenOver(room);
  };
  const janitor = by === 'janitor';
  let minutes: string | undefined;
  let reused = false;
  let tabClosed = false;
  try {
    // Checked after taking the marker, while an opener reserves before checking it: one of them backs off.
    if (isOpening(room, env)) return 'busy';
    // The caller's record may be minutes old: someone else may have closed or reopened the room since.
    const current = readRoom(room, env);
    if (current === undefined || current.closedBy !== undefined || !sameRoom(current, rec)) return 'busy';
    const dirThere = exists(rec.dir);
    if (janitor && dirThere) ownedDir(rec, env);
    else if (janitor) gone(rec, env);
    const snapshot = deps.activity ?? roomActivity(room, env);

    // A close that died after its tab was closed (folder gone, or marker left with pid 0) keeps its minutes,
    // unless the room was opened again since: those minutes are of the earlier opening.
    const prev = held.previous;
    if (prev?.minutes !== undefined && prev.createdAt === rec.createdAt && (!dirThere || prev.pid === 0) && existsSync(prev.minutes)) {
      minutes = prev.minutes;
      reused = true;
    } else {
      let looseEnds = deps.looseEnds;
      if (looseEnds === undefined && !janitor && dirThere) looseEnds = (await checkPending(rec, snapshot, env)).reasons;
      minutes = await (deps.writeMinutes ?? writeMinutes)(
        {
          rec,
          activity: snapshot,
          closedBy: by,
          looseEnds: looseEnds ?? [],
          ignoredGone: janitor ? (deps.ignoredGone ?? []) : [],
          ...(deps.why !== undefined ? { why: deps.why } : {}),
        },
        env,
      );
    }
    noteClosing(room, held.token, { minutes, createdAt: rec.createdAt }, env);

    if (janitor) {
      const now = roomActivity(room, env);
      if ((now.lastEventAt ?? -Infinity) > (snapshot.lastEventAt ?? -Infinity) || !sameRoom(readRoom(room, env), rec)) throw new RoomBecameActive(room);
    }
    stillMine();
    await closeRoomTab(rec, env, { exitTimeoutMs: deps.exitTimeoutMs, by });
    tabClosed = true;
    await deps.afterTabClosed?.();

    const notes: string[] = [];
    let worktreeRemoved = false;
    if (janitor && rec.kind === 'code') {
      if (dirThere) {
        // Plain `git worktree remove` deletes ignored files (a new .env too): the local checks run once more right before.
        const late = (await checkPending(rec, snapshot, env, { local: true })).reasons;
        stillMine();
        const failed = late.length > 0 ? late.join('; ') : await removeWorktree(rec, ownedDir(rec, env), env);
        if (failed === undefined) worktreeRemoved = true;
        else notes.push(`worktree kept at ${rec.dir}: ${failed}`);
      } else worktreeRemoved = true;
    } else if (janitor && rec.kind === 'scratch' && exists(rec.dir)) {
      stillMine();
      try {
        moveScratch(rec, env);
      } catch (err) {
        notes.push(`scratch files left in ${rec.dir}: ${message(err)}`);
      }
    }
    if (notes.length > 0) {
      const extra = janitor && deps.ignoredGone !== undefined && deps.ignoredGone.length > 0 && !worktreeRemoved ? ['the ignored files listed above are still in the kept worktree'] : [];
      appendNote(minutes, [...notes, ...extra]);
    }

    stillMine();
    const fresh = readRoom(room, env);
    if (sameRoom(fresh, rec)) writeRoom({ ...withoutSeat(withoutPending(withoutCouch(fresh))), closedAt: fresh.closedAt ?? Date.now(), closedBy: by }, env);
    return { minutes, worktreeRemoved, notes };
  } catch (err) {
    // Before the tab closed the room is not closed: its minutes go. After, the next close finishes this one.
    if (!tabClosed && minutes !== undefined && !reused) {
      try {
        unlinkSync(minutes);
      } catch {
        // already gone
      }
    }
    if (tabClosed) noteClosing(room, held.token, { pid: 0 }, env);
    throw err;
  } finally {
    releaseClosing(room, held.token, env);
  }
}

// A folder that is already gone gets the same guard, by name: the record must still name maître's folder.
function gone(rec: RoomRecord, env: NodeJS.ProcessEnv): void {
  const expected = expectedDir(rec, env);
  const sub = rec.kind === 'scratch' ? join('scratch', rec.room) : join('worktrees', rec.project ?? '', rec.room);
  const dir = resolve(rec.dir);
  if (dir !== expected && dir !== join(maitreHome(env), sub)) throw new Error(`room ${rec.room}: ${rec.dir} is outside maître's folders`);
}

export type Dequeued = { room: string; dequeued: 'queue' | 'failed' };

// `maitre room close`: minutes and the tab, the folder stays. A room still waiting for a seat (or one
// that failed to open from the queue) only leaves the queue: there is nothing else to close.
export async function closeRoom(
  room: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { exitTimeoutMs?: number } = {},
): Promise<(RoomRecord & { minutes?: string }) | Dequeued> {
  const slug = roomSlug(room);
  const dequeued = await removeQueued(slug, env);
  if (dequeued !== undefined) return { room: slug, dequeued };
  // A reopen in progress has a new tab under the same label.
  if (isOpening(slug, env)) throw new Error(`${slug} is opening; close it once it is open`);
  const rec = readRoom(slug, env);
  if (rec === undefined) throw new Error(`no room named ${slug} — open it with: maitre room open …`);
  if (rec.closedBy !== undefined) {
    await closeRoomTab(rec, env, opts);
    return rec;
  }
  // Before the minutes: text in the room's input would stop the close once they are written.
  await checkInput(rec, env);
  const r = await closeWithMinutes(rec, 'user', env, { exitTimeoutMs: opts.exitTimeoutMs });
  if (r === 'busy') {
    const now = readRoom(slug, env);
    if (now?.closedBy !== undefined) return now;
    throw new Error(`${slug} is closing`);
  }
  return { ...(readRoom(slug, env) ?? rec), minutes: r.minutes };
}

export function janitorLog(env: NodeJS.ProcessEnv = process.env): string {
  return join(maitreHome(env), 'state', 'janitor.log');
}

const LOG_MAX_BYTES = 1024 * 1024;
// The last logged decision of each room, per maître home: an unchanged skip is not logged again.
const lastLogged = new Map<string, string>();

function log(d: JanitorDecision, now: number, env: NodeJS.ProcessEnv, maxBytes: number): void {
  const key = `${maitreHome(env)}\0${d.room}`;
  const said = JSON.stringify([d.decision, d.reasons]);
  if (d.decision === 'skip' && lastLogged.get(key) === said) return;
  const file = janitorLog(env);
  mkdirSync(join(maitreHome(env), 'state'), { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
  appendFileSync(file, JSON.stringify({ ts: now, ...d }) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  lastLogged.set(key, said);
}

// For the doorman: a queued room that gave up is logged with the janitor's decisions. Never throws.
export function logDecision(d: JanitorDecision, env: NodeJS.ProcessEnv = process.env): void {
  try {
    log(d, Date.now(), env, LOG_MAX_BYTES);
  } catch {
    // a full disk must not stop the tick
  }
}

interface Tick {
  env: NodeJS.ProcessEnv;
  now: number;
  idleMs: number;
  releaseMs: number;
  dryRun: boolean;
  workspaces: { id: string; label: string }[];
  close: CloseDeps;
  park: ParkDeps;
}

// A room's live state between turns: nothing it does can be cut by closing it or stopping its Claude.
const RESTING = new Set(['ready', 'coffee', 'whisky', 'couch']);

// A dead room waits the idle time too, so a room whose Claude stopped (a reboot) can still be walked back into.
// A parked room's own SessionEnd, written as its Claude stopped, does not restart that wait.
function deadLongEnough(rec: RoomRecord, a: RoomActivity, t: Tick): boolean {
  let last = a.lastEventAt ?? rec.createdAt;
  if (rec.seat !== undefined && typeof rec.seat.releasedAt === 'number') last = Math.min(last, rec.seat.releasedAt);
  if (typeof last !== 'number' || !Number.isFinite(last)) return true;
  return t.now - last > t.idleMs;
}

// A dead room's pending reasons are kept on its record for `maitre room list`, and dropped once they go.
function notePending(rec: RoomRecord, reasons: string[], t: Tick): RoomRecord {
  if (reasons.length === 0) return rec.pending === undefined ? rec : patchRoom(rec, withoutPending, t.env);
  const since = rec.pending?.since ?? t.now;
  return patchRoom(rec, (r) => ({ ...r, pending: { since, reasons } }), t.env);
}

// A running room with something pending stays open, parked on the couch; `since` is kept across ticks.
function couch(rec: RoomRecord, t: Tick, notes: string[], reasons: string[]): JanitorDecision {
  const since = rec.couch?.since ?? t.now;
  if (!t.dryRun) patchRoom(rec, (r) => ({ ...r, couch: { since, reasons } }), t.env);
  return { room: rec.room, decision: 'couch', reasons: [...notes, ...reasons] };
}

interface Seen {
  rec: RoomRecord;
  live: RoomLiveness;
  running: boolean;
  activity: RoomActivity;
  marker: ClosingMarker | undefined;
  notes: string[];
  // Why this running room may give up its seat now (quiet, and on the couch or with an open PR).
  parkWhy?: string;
}

// The pending check, then the close. `why` is the decision's reason and, with `minutes`, the minutes' too.
// undefined: something is pending and the room gives up its seat instead of going to the couch.
async function closeIfClean(s: Seen, t: Tick, why: string, opts: { waitDead: boolean; minutes?: string }): Promise<JanitorDecision | undefined> {
  const { env, dryRun } = t;
  const { running, activity, marker, notes } = s;
  let rec = s.rec;
  const room = rec.room;
  const out = (decision: JanitorDecision['decision'], reasons: string[]): JanitorDecision => ({ room, decision, reasons });
  let ignoredGone: string[] = [];
  if (exists(rec.dir)) {
    ownedDir(rec, env);
    const pending = await checkPending(rec, activity, env);
    // `/exit` would be typed after a draft the user left in the room's input.
    const unsent = running ? await unsentInput(rec.herdr!.paneId) : undefined;
    const reasons = unsent !== undefined ? [...pending.reasons, unsent] : pending.reasons;
    if (!running && !dryRun) rec = notePending(rec, reasons, t);
    if (reasons.length > 0) {
      if (!running) return out('skip', [...notes, ...reasons]);
      if (s.parkWhy !== undefined) return undefined;
      return couch(rec, t, [...notes], reasons);
    }
    ignoredGone = pending.ignoredGone;
    if (!running && opts.waitDead && !deadLongEnough(rec, activity, t)) return out('skip', [...notes, 'not idle yet']);
  } else {
    gone(rec, env);
    if (running) throw new Error(`room ${room}: ${rec.dir} does not exist`);
    // A close that died half-way is past the point of no return; anything else waits like a live room.
    if (marker === undefined && opts.waitDead && !deadLongEnough(rec, activity, t)) return out('skip', [...notes, 'not idle yet']);
    if (opts.minutes === undefined) why = 'not running, its folder is already gone';
  }
  if (dryRun) return out('close', [...notes, why]);

  let r: ClosedRoom | 'busy';
  try {
    r = await closeWithMinutes(rec, 'janitor', env, { ...t.close, activity, ignoredGone, ...(opts.minutes !== undefined ? { why: opts.minutes } : {}) });
  } catch (err) {
    if (err instanceof RoomBecameActive || (err instanceof CloseStopped && err.kind === 'active')) return out('skip', [...notes, 'room became active']);
    if (err instanceof CloseStopped) return couch(rec, t, notes, [err.reason]);
    if (err instanceof ClosingTakenOver) return out('skip', [...notes, 'another closer took over']);
    throw err;
  }
  if (r === 'busy') return out('skip', [...notes, 'being closed']);
  return out('close', [...notes, why, ...r.notes]);
}

// A merged PR closes its room once the dance is over, a PR closed without merge at once: if nothing is
// pending, else the room goes to the couch. A parked room does not wait like a dead one.
async function prEnded(s: Seen, pr: PrState, t: Tick): Promise<JanitorDecision | undefined> {
  const { rec, live, running, activity, notes } = s;
  const out = (decision: JanitorDecision['decision'], reasons: string[]): JanitorDecision => ({ room: rec.room, decision, reasons });
  if (pr.state === 'MERGED' && pr.dance !== undefined && t.now < pr.dance.until) return out('skip', [...notes, 'dancing']);
  if (running && (live !== 'idle' || !RESTING.has(activity.state))) return out('skip', [...notes, 'not idle']);
  const label = pr.state === 'MERGED' ? 'PR merged' : 'PR closed without merge';
  return closeIfClean(s, t, `${label}: ${pr.url}`, { waitDead: rec.seat === undefined, minutes: `${label}: ${pr.url}` });
}

async function decide(rec: RoomRecord, t: Tick): Promise<JanitorDecision> {
  const { env, now, dryRun } = t;
  const room = rec.room;
  const out = (decision: JanitorDecision['decision'], reasons: string[]): JanitorDecision => ({ room, decision, reasons });

  // The tick's list may be minutes old by now: decide on the record as it is on disk.
  const current = readRoom(room, env);
  if (current === undefined || current.closedBy !== undefined) return out('skip', ['already closed']);
  rec = current;
  const marker = readClosing(room, env);
  if (marker !== undefined && closerAlive(marker)) return out('skip', ['being closed']);
  if (isOpening(room, env)) return out('skip', ['being opened']);

  // Another session's tabs are invisible from here: that is not the same as the room being dead.
  if (rec.herdr !== undefined && rec.herdr.session !== herdrSession(env)) return out('skip', ['could not check: the room belongs to another herdr session']);
  let live: RoomLiveness;
  try {
    live = await probeRoom(rec, t.workspaces, env);
  } catch (err) {
    return out('skip', [`could not check: herdr: ${message(err)}`]);
  }
  // Closing needs herdr to say idle: an agent in an unknown state may be in the middle of a turn.
  if (live === 'unknown') return out('skip', ['could not check: herdr cannot tell whether the room is idle']);
  const activity = roomActivity(room, env);
  const running = live !== 'not running';
  const idle = running ? live !== 'working' && live !== 'blocked' && isIdle(activity, now, t.idleMs) : true;
  const notes: string[] = [];

  // A seat on a room whose Claude runs (outside a wake, skipped above as being opened) was left by a park
  // that died before Claude stopped: the room holds its seat. Only the seat read here goes: one a park wrote
  // since (it took the marker after this tick checked it) stays.
  if (running && rec.seat !== undefined) {
    const read = rec.seat;
    rec = dryRun ? withoutSeat(rec) : patchRoom(rec, (r) => (r.seat?.releasedAt === read.releasedAt && r.seat.session === read.session ? withoutSeat(r) : r), env);
    if (rec.seat === undefined) notes.push('seat taken back: its Claude is running');
  }

  // The couch holds only while the room stays at rest with nothing after `since`. A parked room has no
  // Claude: only a wake (which clears the seat) can make it active.
  const parked = !running && rec.seat !== undefined;
  const busy = running && (live !== 'idle' || !RESTING.has(activity.state));
  if (rec.couch !== undefined && !parked && ((activity.lastEventAt ?? -Infinity) > rec.couch.since || busy)) {
    if (!dryRun) rec = patchRoom(rec, withoutCouch, env);
    else rec = withoutCouch(rec);
    notes.push('couch cleared: the room is active again');
  }
  if (!running && !dryRun) rec = patchRoom(rec, (r) => (r.closedAt !== undefined ? r : { ...r, closedAt: Date.now() }), env);
  if (running && !dryRun) rec = markRunning(rec, env);
  const pr = rec.kind === 'code' ? roomPr(rec, env) : undefined;
  const why = running ? whyPark(rec, activity, pr) : undefined;
  const parkWhy = why !== undefined && isQuiet(activity, live, now, t.releaseMs) ? why : undefined;
  const seen: Seen = { rec, live, running, activity, marker, notes, ...(parkWhy !== undefined ? { parkWhy } : {}) };

  // A room that can be closed is closed; one with something pending gives up its seat when it may.
  let d: JanitorDecision | undefined;
  if (pr !== undefined && pr.state !== 'OPEN') d = await prEnded(seen, pr, t);
  else if (idle) d = await closeIfClean(seen, t, running ? 'idle, nothing pending' : 'not running, nothing pending', { waitDead: true });
  if (d !== undefined) return d;

  if (parkWhy !== undefined) {
    if (dryRun) return out('park', [...notes, `quiet, ${parkWhy}`]);
    const p = await park(rec, env, t.park);
    return out(p.result === 'parked' ? 'park' : 'skip', [...notes, p.result === 'parked' ? `quiet, ${parkWhy}` : p.reason]);
  }
  return out('skip', ['not idle', ...notes]);
}

// One pass over every registered room that is not closed (`closedBy` unset). Never throws.
export async function janitorTick(
  env: NodeJS.ProcessEnv = process.env,
  deps: { now?: () => number; dryRun?: boolean; close?: CloseDeps; park?: ParkDeps; logMaxBytes?: number } = {},
): Promise<JanitorDecision[]> {
  const dryRun = deps.dryRun === true;
  const clock = deps.now ?? Date.now;
  const recs = listRooms(env).filter((r) => isRecord(r) && r.closedBy === undefined);
  if (recs.length === 0) return [];
  let herdrError: string | undefined;
  let workspaces: { id: string; label: string }[] = [];
  try {
    await ensureServer(env);
    workspaces = await listWorkspaces();
  } catch (err) {
    herdrError = `could not check: herdr: ${message(err)}`;
  }
  let idleMs = 0;
  let releaseMs = 0;
  let tickError = herdrError;
  try {
    ({ idleMs, releaseMs } = settings(env));
  } catch (err) {
    tickError = `could not read the settings: ${message(err)}`;
  }
  const t: Tick = { env, now: clock(), idleMs, releaseMs, dryRun, workspaces, close: deps.close ?? {}, park: { releaseMs, now: clock, ...deps.park } };
  const decisions: JanitorDecision[] = [];
  for (const rec of recs) {
    let d: JanitorDecision;
    if (tickError !== undefined) d = { room: rec.room, decision: tickError === herdrError ? 'skip' : 'error', reasons: [tickError] };
    else {
      try {
        d = await decide(rec, t);
      } catch (err) {
        d = { room: rec.room, decision: 'error', reasons: [message(err)] };
      }
    }
    if (!dryRun) {
      try {
        log(d, clock(), env, deps.logMaxBytes ?? LOG_MAX_BYTES);
      } catch {
        // a full disk must not stop the other rooms
      }
    }
    decisions.push(d);
  }
  return decisions;
}

export function formatDecisions(ds: JanitorDecision[]): string[] {
  if (ds.length === 0) return ['no rooms'];
  const w0 = Math.max(...ds.map((d) => d.room.length));
  const w1 = Math.max(...ds.map((d) => d.decision.length));
  return ds.map((d) => `${d.room.padEnd(w0)}  ${d.decision.padEnd(w1)}  ${d.reasons.join('; ')}`.trimEnd());
}
