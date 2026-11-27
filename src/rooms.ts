import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './config.js';
import { maitreHome, roomDir } from './paths.js';

export interface RoomRecord {
  room: string;
  project?: string;
  kind: 'code' | 'scratch';
  dir: string;
  branch?: string;
  model: string;
  taskType: string;
  herdr?: { session: string; workspaceId: string; paneId: string };
  createdAt: number;
  closedAt?: number;
  closedBy?: 'janitor' | 'user';
  couch?: { since: number; reasons: string[] };
  // A room found not running with something pending: why the janitor leaves it alone (a dead room is
  // never on the couch, which is for running rooms).
  pending?: { since: number; reasons: string[] };
  // Claude stopped to free the seat; the tab is gone, the worktree, branch and session stay.
  seat?: { releasedAt: number; session: string };
  // The queuedAt of the queue entry the doorman opened this room from.
  fromQueue?: number;
  // Set on every open since rooms could be woken, and on a room found running: a room closed by hand
  // before M3a has only closedAt, like one whose Claude died, and is never offered for waking.
  resumable?: true;
}

function roomFile(room: string, env: NodeJS.ProcessEnv): string {
  return join(roomDir(room, env), 'room.json');
}

export function readRoom(room: string, env: NodeJS.ProcessEnv = process.env): RoomRecord | undefined {
  return readJson(roomFile(room, env)) as RoomRecord | undefined;
}

export function writeRoom(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(roomFile(rec.room, env), rec);
}

export function listRooms(env: NodeJS.ProcessEnv = process.env): RoomRecord[] {
  const root = join(maitreHome(env), 'state', 'rooms');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: RoomRecord[] = [];
  for (const name of names.sort()) {
    const file = join(root, name, 'room.json');
    if (!existsSync(file)) continue;
    try {
      const rec = readJson(file);
      if (typeof rec === 'object' && rec !== null && !Array.isArray(rec)) out.push(rec as RoomRecord);
    } catch {
      continue;
    }
  }
  return out;
}

// The record still names the same opening of the room: a reopen writes a new createdAt and tab.
export function sameRoom(a: RoomRecord | undefined, b: RoomRecord): a is RoomRecord {
  return a !== undefined && a.createdAt === b.createdAt && a.herdr?.workspaceId === b.herdr?.workspaceId;
}

// Read-modify-write against the record on disk, so a close or reopen in between is never overwritten.
// A patch that returns the record unchanged writes nothing.
export function patchRoom(rec: RoomRecord, patch: (r: RoomRecord) => RoomRecord, env: NodeJS.ProcessEnv = process.env): RoomRecord {
  const fresh = readRoom(rec.room, env);
  if (!sameRoom(fresh, rec)) return rec;
  const next = patch(fresh);
  if (next !== fresh) writeRoom(next, env);
  return next;
}

export type Parked = { since: number; reasons: string[] };

// A couch (or pending) as written by the janitor; anything else is ignored.
export function parked(v: unknown): Parked | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const c = v as Record<string, unknown>;
  if (typeof c.since !== 'number' || !Number.isFinite(c.since) || !Array.isArray(c.reasons)) return undefined;
  return { since: c.since, reasons: c.reasons.filter((r): r is string => typeof r === 'string') };
}

// A couch holds only while the room stays at rest (ready, coffee, or whisky: delivered a PR) with no
// event after it was set. The janitor's resting states.
export function couchHolds(c: Parked, state: string, lastEventAt: number | undefined): boolean {
  return (state === 'ready' || state === 'coffee' || state === 'whisky') && (lastEventAt ?? -Infinity) <= c.since;
}
