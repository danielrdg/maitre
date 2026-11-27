import { countsAsActivity } from './events.js';
import { readEventsTail } from './room-open.js';
import { reduce, type LiveState, type RoomState } from './room-state.js';
import type { RoomRecord } from './rooms.js';

export interface RoomActivity {
  state: LiveState | 'none';
  lastEventAt?: number;
  prUrl?: string;
  transcript?: string;
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
  };
}

export function isIdle(a: RoomActivity, now: number, idleMs: number): boolean {
  return (a.state === 'ready' || a.state === 'coffee') && a.lastEventAt !== undefined && now - a.lastEventAt > idleMs;
}

// `running` is the caller's liveness probe; a present couch counts as couched (staleness is the janitor's call).
export function isActive(rec: RoomRecord, a: RoomActivity, running: boolean): boolean {
  return rec.closedBy === undefined && running && rec.couch === undefined && a.prUrl === undefined && a.state !== 'whisky';
}
