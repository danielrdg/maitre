import { execFile } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isIdle, isQuiet, roomActivity, type RoomActivity } from './activity.js';
import { closerAlive, leftMinutes, noteClosing, ownsClosing, readClosing, releaseClosing, takeClosing, type ClosingMarker } from './closing.js';
import { settings } from './config.js';
import { cleanEnv } from './env.js';
import { tryFileLock } from './file-lock.js';
import { ensureServer, herdrSession, listWorkspaces } from './herdr.js';
import { writeMinutes } from './minutes.js';
import { maitreHome, roomSlug } from './paths.js';
import { checkPending } from './pending.js';
import { roomPr, type PrState } from './pr-state.js';
import { isOpening, removeQueued } from './queue.js';
import { readIndex } from './projects.js';
import { checkInput, CloseStopped, closeRoomTab, isRecord, lostClaude, markRunning, probeRoom, unsentInput, type RoomLiveness } from './room-open.js';
import { listRooms, patchRoom, readRoom, sameRoom, type RoomRecord } from './rooms.js';
import { park, parkBlocker, whyPark, type ParkDeps } from './seats.js';
import { stillStarting } from './wake.js';
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
}

// For tests only (forTests): a step between closing the tab and the rest of the close.
interface Hooks {
  afterTabClosed?: () => void | Promise<void>;
}

// Why a close did not start: another closer holds the marker, the room is being opened, its record was
// closed meanwhile, or it names another opening of the room now.
export type CloseSkipped = 'busy' | 'opening' | 'closed' | 'changed';

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

export function closeWithMinutes(rec: RoomRecord, by: 'janitor' | 'user', env: NodeJS.ProcessEnv = process.env, deps: CloseDeps = {}): Promise<ClosedRoom | CloseSkipped> {
  return closeWith(rec, by, env, deps, {});
}

async function closeWith(rec: RoomRecord, by: 'janitor' | 'user', env: NodeJS.ProcessEnv, deps: CloseDeps, hooks: Hooks): Promise<ClosedRoom | CloseSkipped> {
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
    if (isOpening(room, env)) return 'opening';
    // The caller's record may be minutes old: someone else may have closed or reopened the room since.
    const current = readRoom(room, env);
    if (current === undefined || current.closedBy !== undefined) return 'closed';
    if (!sameRoom(current, rec)) return 'changed';
    const dirThere = exists(rec.dir);
    if (janitor && dirThere) ownedDir(rec, env);
    else if (janitor) gone(rec, env);
    const snapshot = deps.activity ?? roomActivity(room, env);

    // A close that died after its tab was closed (folder gone, or marker left with pid 0) keeps its minutes,
    // unless the room was opened again since: those minutes are of the earlier opening.
    const left = leftMinutes(held.previous, rec.createdAt, dirThere);
    if (left !== undefined) {
      minutes = left;
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
    await hooks.afterTabClosed?.();

    const notes: string[] = [];
    let worktreeRemoved = false;
    if (janitor && rec.kind === 'code') {
      if (dirThere) {
        // Plain `git worktree remove` deletes ignored files (a new .env too): the local checks run once more right before,
        // on a room whose tab is closed by now.
        const late = await checkPending(rec, snapshot, env, { local: true, running: false });
        stillMine();
        const failed = late.reasons.length > 0 ? late.reasons.join('; ') : await removeWorktree(rec, ownedDir(rec, env), env);
        if (failed === undefined) worktreeRemoved = true;
        else notes.push(`worktree kept at ${rec.dir}: ${failed}`);
        // Ignored files that showed up after the decision went too: the minutes list them as well.
        const lateGone = late.ignoredGone.filter((p) => !(deps.ignoredGone ?? []).includes(p));
        if (worktreeRemoved && lateGone.length > 0) {
          appendFileSync(minutes, ['', 'Ignored files found right before the removal, gone with the worktree too:', '', ...lateGone.map((p) => `- \`${p}\``), ''].join('\n'));
        }
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
    patchRoom(rec, (fresh) => ({ ...withoutSeat(withoutPending(withoutCouch(fresh))), closedAt: fresh.closedAt ?? Date.now(), closedBy: by }), env);
    return { minutes, worktreeRemoved, notes };
  } catch (err) {
    // Before the tab closed the room is not closed: its minutes go, unless another closer took the marker
    // over (it may reuse them). After, the next close finishes this one.
    if (!tabClosed && minutes !== undefined && !reused && ownsClosing(room, held.token, env)) {
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

// open: a room of that name is open and stays so (only a queue entry was removed).
export type Dequeued = { room: string; dequeued: 'queue' | 'failed'; open?: true };

// `maitre room close`: minutes and the tab, the folder stays. `writing` runs once the input check passed,
// right before the minutes are written. A room still waiting for a seat (or one that failed to open from the
// queue) leaves the queue. A queued name that is also open (an unclosed record) is closed as well; a name in
// queue-failed.json is not: its entry is all that was asked for, and a close by hand would not spare a turn.
export async function closeRoom(
  room: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { exitTimeoutMs?: number; writing?: () => void } = {},
): Promise<(RoomRecord & { minutes?: string; dequeued?: Dequeued['dequeued'] }) | Dequeued> {
  const slug = roomSlug(room);
  const dequeued = await removeQueued(slug, env);
  if (dequeued !== undefined) {
    const open = readRoom(slug, env);
    if (open === undefined || open.closedBy !== undefined || isOpening(slug, env)) return { room: slug, dequeued };
    if (dequeued === 'failed') return { room: slug, dequeued, open: true };
    try {
      return { ...(await closeOpen(slug, open, env, opts)), dequeued };
    } catch (err) {
      throw new Error(`removed ${slug} from the queue; ${(err as Error).message}`);
    }
  }
  // A reopen in progress has a new tab under the same label.
  if (isOpening(slug, env)) throw new Error(`${slug} is opening; close it once it is open`);
  const rec = readRoom(slug, env);
  if (rec === undefined) throw new Error(`no room named ${slug} — open it with: maitre room open …`);
  return closeOpen(slug, rec, env, opts);
}

async function closeOpen(
  slug: string,
  rec: RoomRecord,
  env: NodeJS.ProcessEnv,
  opts: { exitTimeoutMs?: number; writing?: () => void },
): Promise<RoomRecord & { minutes?: string }> {
  if (rec.closedBy !== undefined) {
    await closeRoomTab(rec, env, opts);
    return rec;
  }
  // Before the minutes: text in the room's input would stop the close once they are written.
  await checkInput(rec, env);
  opts.writing?.();
  let r: ClosedRoom | CloseSkipped;
  try {
    r = await closeWithMinutes(rec, 'user', env, { exitTimeoutMs: opts.exitTimeoutMs });
  } catch (err) {
    if (err instanceof ClosingTakenOver) logDecision({ room: slug, decision: 'error', reasons: ['closed by hand: another closer took over its close'] }, env);
    throw err;
  }
  if (typeof r === 'string') {
    const now = readRoom(slug, env);
    if (now?.closedBy !== undefined) return now;
    if (r === 'opening') throw new Error(`${slug} is opening; close it once it is open`);
    if (r === 'changed') throw new Error(`${slug} was opened again meanwhile; close it again`);
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
    // One rotation at a time (another process may be rotating): the size is checked again under the lock, and
    // while another holds it, this line goes to the log as it is.
    if (statSync(file).size > maxBytes) {
      tryFileLock(`${file}.lock`, () => {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
      }, { waitMs: 200 });
    }
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
  hooks: Hooks;
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
  return patchRoom(rec, (r) => (r.closedBy !== undefined ? r : { ...r, pending: { since, reasons } }), t.env);
}

// A running room with something pending stays open, parked on the couch; `since` is kept across ticks.
function couch(rec: RoomRecord, t: Tick, notes: string[], reasons: string[]): JanitorDecision {
  const since = rec.couch?.since ?? t.now;
  // Never on a record closed since it was read.
  if (!t.dryRun) patchRoom(rec, (r) => (r.closedBy !== undefined ? r : { ...r, couch: { since, reasons } }), t.env);
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

const SKIPPED: Record<CloseSkipped, string> = { busy: 'being closed', opening: 'being opened', closed: 'already closed', changed: 'the room changed' };

// The pending check, then the close. `why` is the decision's reason and, with `minutes`, the minutes' too.
// undefined: something is pending and the room may give up its seat (its couch is written all the same).
async function closeIfClean(s: Seen, t: Tick, why: string, opts: { waitDead: boolean; minutes?: string }): Promise<JanitorDecision | undefined> {
  const { env, dryRun } = t;
  const { running, activity, marker, notes } = s;
  let rec = s.rec;
  const room = rec.room;
  const out = (decision: JanitorDecision['decision'], reasons: string[]): JanitorDecision => ({ room, decision, reasons });
  let ignoredGone: string[] = [];
  if (exists(rec.dir)) {
    ownedDir(rec, env);
    const pending = await checkPending(rec, activity, env, { running, fetch: !dryRun });
    // `/exit` would be typed after a draft the user left in the room's input; a tab herdr lost its Claude in
    // may still hold one.
    const unsent = running ? await unsentInput(rec.herdr!.paneId) : await lostClaude(rec, env, t.workspaces);
    const reasons = unsent !== undefined ? [...pending.reasons, unsent] : pending.reasons;
    if (!running && !dryRun) rec = notePending(rec, reasons, t);
    if (reasons.length > 0) {
      if (!running) return out('skip', [...notes, ...reasons]);
      const couched = couch(rec, t, [...notes], reasons);
      return s.parkWhy !== undefined ? undefined : couched;
    }
    ignoredGone = pending.ignoredGone;
    if (!running && opts.waitDead && !deadLongEnough(rec, activity, t)) return out('skip', [...notes, 'not idle yet']);
  } else {
    gone(rec, env);
    if (running) throw new Error(`room ${room}: ${rec.dir} does not exist`);
    const lost = await lostClaude(rec, env, t.workspaces);
    if (lost !== undefined) return out('skip', [...notes, lost]);
    // A close that died half-way is past the point of no return; anything else waits like a live room.
    if (marker === undefined && opts.waitDead && !deadLongEnough(rec, activity, t)) return out('skip', [...notes, 'not idle yet']);
    if (opts.minutes === undefined) why = 'not running, its folder is already gone';
  }
  if (dryRun) return out('close', [...notes, why]);

  let r: ClosedRoom | CloseSkipped;
  try {
    r = await closeWith(rec, 'janitor', env, { ...t.close, activity, ignoredGone, ...(opts.minutes !== undefined ? { why: opts.minutes } : {}) }, t.hooks);
  } catch (err) {
    if (err instanceof RoomBecameActive || (err instanceof CloseStopped && err.kind === 'active')) return out('skip', [...notes, 'room became active']);
    if (err instanceof CloseStopped) return running ? couch(rec, t, notes, [err.reason]) : out('skip', [...notes, err.reason]);
    if (err instanceof ClosingTakenOver) return out('skip', [...notes, 'another closer took over']);
    throw err;
  }
  if (typeof r === 'string') return out('skip', [...notes, SKIPPED[r]]);
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
  const listed = rec;
  rec = current;
  const marker = readClosing(room, env);
  if (marker !== undefined && closerAlive(marker)) return out('skip', ['being closed']);
  if (isOpening(room, env)) return out('skip', ['being opened']);

  // Another session's tabs are invisible from here: that is not the same as the room being dead.
  if (rec.herdr !== undefined && rec.herdr.session !== herdrSession(env)) return out('skip', ['could not check: the room belongs to another herdr session']);
  let live: RoomLiveness;
  try {
    // A record that changed since the tick's list (a wake that ended meanwhile) may name a tab newer than the tabs listed.
    if (rec.herdr?.workspaceId !== listed.herdr?.workspaceId) t.workspaces = await listWorkspaces();
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
  // A wake left its tab still starting: not running for herdr, but no dead room's closedAt (it would show parked).
  if (!running && !dryRun && !stillStarting(rec, t.workspaces, env)) rec = patchRoom(rec, (r) => (r.closedAt !== undefined ? r : { ...r, closedAt: Date.now() }), env);
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
    if (dryRun) {
      const blocker = await parkBlocker(rec, activity);
      return blocker !== undefined ? out('skip', [...notes, blocker]) : out('park', [...notes, `quiet, ${parkWhy}`]);
    }
    const p = await park(rec, env, t.park);
    return out(p.result === 'parked' ? 'park' : 'skip', [...notes, p.result === 'parked' ? `quiet, ${parkWhy}` : p.reason]);
  }
  return out('skip', ['not idle', ...notes]);
}

// stopped: the lounge is stopping; no room is decided after it says so.
type TickDeps = { now?: () => number; dryRun?: boolean; close?: CloseDeps; park?: ParkDeps; logMaxBytes?: number; stopped?: () => boolean };

// One pass over every registered room that is not closed (`closedBy` unset). Never throws.
export function janitorTick(env: NodeJS.ProcessEnv = process.env, deps: TickDeps = {}): Promise<JanitorDecision[]> {
  return tick(env, deps, {});
}

// The janitor with a step between closing a room's tab and the rest of its close: for tests only.
export const forTests = {
  janitorTick: (env: NodeJS.ProcessEnv, deps: TickDeps & Hooks): Promise<JanitorDecision[]> => tick(env, deps, { afterTabClosed: deps.afterTabClosed }),
  closeWithMinutes: (rec: RoomRecord, by: 'janitor' | 'user', env: NodeJS.ProcessEnv, deps: CloseDeps, hooks: Hooks) => closeWith(rec, by, env, deps, hooks),
};

async function tick(env: NodeJS.ProcessEnv, deps: TickDeps, hooks: Hooks): Promise<JanitorDecision[]> {
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
  const t: Tick = { env, now: clock(), idleMs, releaseMs, dryRun, workspaces, close: deps.close ?? {}, park: { releaseMs, now: clock, ...deps.park }, hooks };
  const decisions: JanitorDecision[] = [];
  for (const rec of recs) {
    if (deps.stopped?.() === true) break;
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
