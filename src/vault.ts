import { cpSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from './config.js';
import { maitreHome, roomSlug } from './paths.js';
import type { RoomRecord } from './rooms.js';

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const outside = (rec: RoomRecord) => new Error(`room ${rec.room}: ${String(rec.dir)} is outside maître's folders`);

// Where maître puts this room's folder; throws when the record cannot name one of maître's folders.
export function expectedDir(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env): string {
  if ((rec.kind !== 'code' && rec.kind !== 'scratch') || typeof rec.dir !== 'string' || rec.dir === '') throw outside(rec);
  try {
    if (roomSlug(rec.room) !== rec.room) throw outside(rec);
  } catch {
    throw outside(rec);
  }
  const home = real(maitreHome(env));
  if (rec.kind === 'scratch') return join(home, 'scratch', rec.room);
  const p = rec.project;
  if (typeof p !== 'string' || p === '' || p === '.' || p === '..' || p.includes('/') || p.includes('\\')) throw outside(rec);
  return join(home, 'worktrees', p, rec.room);
}

// The one gate before anything destructive: the room's folder must be exactly maître's folder for that room.
export function ownedDir(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env): string {
  const expected = expectedDir(rec, env);
  let dir: string;
  try {
    dir = realpathSync(rec.dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`room ${rec.room}: ${rec.dir} does not exist`);
    throw outside(rec);
  }
  if (dir !== expected) throw outside(rec);
  return dir;
}

export interface MoveOps {
  rename: (from: string, to: string) => void;
  copy: (from: string, to: string) => void;
  remove: (path: string) => void;
}

const REAL_OPS: MoveOps = {
  rename: renameSync,
  copy: (from, to) => cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true }),
  remove: (path) => rmSync(path, { recursive: true }),
};

function moveEntry(from: string, to: string, ops: MoveOps): void {
  try {
    ops.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    ops.copy(from, to);
    ops.remove(from);
  }
}

function taken(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// `name-2.ext`, `dir-2`, `.hidden-2`: never over something already there.
function freeName(dir: string, name: string): string {
  if (!taken(join(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const cand = `${stem}-${n}${ext}`;
    if (!taken(join(dir, cand))) return cand;
  }
}

// Scratch files are never deleted: they move into the room's folder in the vault, merging with what is there.
export function moveScratch(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env, ops: MoveOps = REAL_OPS): string {
  if (rec.kind !== 'scratch') throw new Error(`room ${rec.room} is not a scratch room`);
  const src = ownedDir(rec, env);
  const dest = join(settings(env).vault, 'rooms', rec.room);
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) moveEntry(join(src, name), join(dest, freeName(dest, name)), ops);
  rmdirSync(src);
  return dest;
}
