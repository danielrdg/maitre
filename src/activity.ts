import { countsAsActivity } from './events.js';
import type { PrState } from './pr-state.js';
import { readEventsTail, type RoomLiveness } from './room-open.js';
import { reduce, startingOnly, type LiveState, type RoomState } from './room-state.js';
import type { RoomRecord } from './rooms.js';

export interface RoomActivity {
  state: LiveState | 'none';
  lastEventAt?: number;
  prUrl?: string;
  transcript?: string;
  // The reducer's current session: a late line from a session before /clear does not count.
  session?: string;
  // Blocked only by maître's own starting note: no question Claude asked through its hooks.
  starting?: true;
}

// Disk only, so the CLI and the lounge decide alike: the same bounded tail the lounge listing reads.
export function roomActivity(room: string, env: NodeJS.ProcessEnv = process.env): RoomActivity {
  const lines = readEventsTail(room, env);
  if (lines.length === 0) return { state: 'none' };
  let state: RoomState | undefined;
  let transcript: string | undefined;
  let lastEventAt: number | undefined;
  for (const l of lines) {
    state = reduce(state, l);
    if (typeof l.transcript === 'string' && l.transcript !== '') transcript = l.transcript;
    if (countsAsActivity(l)) lastEventAt = l.ts;
  }
  return {
    state: state?.state ?? 'none',
    ...(lastEventAt !== undefined ? { lastEventAt } : {}),
    ...(state?.prUrl !== undefined ? { prUrl: state.prUrl } : {}),
    ...(transcript !== undefined ? { transcript } : {}),
    ...(state !== undefined && state.session !== '' ? { session: state.session } : {}),
    ...(state !== undefined && startingOnly(state) ? { starting: true as const } : {}),
  };
}

export function isIdle(a: RoomActivity, now: number, idleMs: number): boolean {
  return (a.state === 'ready' || a.state === 'coffee') && a.lastEventAt !== undefined && now - a.lastEventAt > idleMs;
}

// Quiet: parked-worthy silence (ready, coffee, whisky or couch with herdr idle and no countable event for `ms`).
export function isQuiet(a: RoomActivity, herdr: RoomLiveness, now: number, ms: number): boolean {
  const resting = a.state === 'ready' || a.state === 'coffee' || a.state === 'whisky' || a.state === 'couch';
  return resting && herdr === 'idle' && a.lastEventAt !== undefined && now - a.lastEventAt > ms;
}

// `running` is the caller's liveness probe; a present couch counts as couched (staleness is the janitor's call).
// With `pr` (pr.json) the PR decides; without it, only a room resting on its delivered PR (whisky) is out:
// the reducer never forgets a prUrl, so a room that works again counts again.
export function isActive(rec: RoomRecord, a: RoomActivity, running: boolean, pr?: Pick<PrState, 'state'>): boolean {
  if (rec.closedBy !== undefined || !running || rec.couch !== undefined || rec.seat !== undefined) return false;
  if (pr !== undefined) return pr.state !== 'OPEN';
  return a.state !== 'whisky';
}
