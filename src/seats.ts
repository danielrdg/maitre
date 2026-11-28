import { isQuiet, roomActivity, type RoomActivity } from './activity.js';
import { ownsClosing, releaseClosing, takeClosing } from './closing.js';
import { settings } from './config.js';
import { ensureServer } from './herdr.js';
import { roomPr, type PrState } from './pr-state.js';
import { isOpening } from './queue.js';
import { CloseStopped, closeRoomTab, probeRoom, unsentInput } from './room-open.js';
import { parked, patchRoom, readRoom, sameRoom, type RoomRecord } from './rooms.js';

export interface ParkDeps {
  now?: () => number;
  releaseMs?: number;
  exitTimeoutMs?: number;
  heartbeatMs?: number;
  // Runs once the seat is written, right before Claude is stopped.
  beforeStop?: () => void | Promise<void>;
}

export type Parking = { result: 'parked' | 'skip'; reason: string };

// Who gives up a seat: a room on the couch (a couch with nothing after it) or with an open PR. A plain
// idle room does not.
export function whyPark(rec: RoomRecord, a: RoomActivity, pr: Pick<PrState, 'state'> | undefined): string | undefined {
  const couch = parked(rec.couch);
  if (couch !== undefined && (a.lastEventAt ?? -Infinity) <= couch.since) return 'on the couch';
  if (pr?.state === 'OPEN') return 'its PR is open';
  return undefined;
}

const withoutSeat = ({ seat: _s, ...r }: RoomRecord): RoomRecord => r;

export async function parkRoom(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env, deps: ParkDeps = {}): Promise<'parked' | 'skip'> {
  return (await park(rec, env, deps)).result;
}

// Stops a quiet room's Claude to free its seat; the worktree, branch, session and pr.json stay. The seat
// is recorded before Claude is stopped, and taken back whenever Claude may still be running.
export async function park(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env, deps: ParkDeps = {}): Promise<Parking> {
  const room = rec.room;
  const skip = (reason: string): Parking => ({ result: 'skip', reason });
  const held = takeClosing(room, env, { heartbeatMs: deps.heartbeatMs });
  if (held === 'busy') return skip('being closed');
  let seat: RoomRecord['seat'];
  let target = rec;
  const unseat = () => {
    const mine = seat!;
    patchRoom(target, (r) => (r.seat?.releasedAt === mine.releasedAt && r.seat.session === mine.session ? withoutSeat(r) : r), env);
  };
  try {
    if (isOpening(room, env)) return skip('being opened');
    const current = readRoom(room, env);
    if (current === undefined || current.closedBy !== undefined || !sameRoom(current, rec)) return skip('the room changed');
    target = current;
    await ensureServer(env);
    const live = await probeRoom(current, undefined, env);
    // A seat on a room whose Claude runs was left by a park that died half-way: it is written again.
    if (current.seat !== undefined && live === 'not running') return skip('already parked');
    const activity = roomActivity(room, env);
    const releaseMs = deps.releaseMs ?? settings(env).releaseMs;
    if (!isQuiet(activity, live, (deps.now ?? Date.now)(), releaseMs)) return skip('not quiet');
    if (whyPark(current, activity, roomPr(current, env)) === undefined) return skip('neither on the couch nor with an open PR');
    if (activity.session === undefined) return skip('no session id');
    // Checked again by closeRoomTab right before /exit; here so a draft never makes the record claim a seat.
    const unsent = await unsentInput(current.herdr!.paneId);
    if (unsent !== undefined) return skip(unsent);

    const mine = { releasedAt: Date.now(), session: activity.session, ...(current.run !== undefined ? { run: current.run } : {}) };
    const was = current.seat;
    const next = patchRoom(current, (r) => (r.seat?.releasedAt !== was?.releasedAt || r.seat?.session !== was?.session ? r : { ...r, seat: mine }), env);
    if (next.seat !== mine) return skip('the room changed');
    seat = mine;
    target = next;
    await deps.beforeStop?.();
    const now = roomActivity(room, env);
    if ((now.lastEventAt ?? -Infinity) > (activity.lastEventAt ?? -Infinity)) {
      unseat();
      return skip('room became active');
    }
    if (!ownsClosing(room, held.token, env)) {
      unseat();
      return skip('another closer took over');
    }
    try {
      await closeRoomTab(next, env, { by: 'janitor', exitTimeoutMs: deps.exitTimeoutMs });
    } catch (err) {
      let after: string;
      try {
        after = await probeRoom(next, undefined, env);
      } catch {
        after = 'unknown';
      }
      if (after !== 'not running') unseat();
      if (err instanceof CloseStopped) return skip(err.kind === 'active' ? 'room became active' : err.reason);
      throw err;
    }
    return { result: 'parked', reason: 'parked' };
  } finally {
    releaseClosing(room, held.token, env);
  }
}
