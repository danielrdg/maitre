import { randomBytes } from 'node:crypto';
import { cpSync, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, settings, writeJsonAtomic } from './config.js';
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

const taken = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const exists = (path: string) => Object.assign(new Error(`${path} already exists`), { code: 'EEXIST' });

// A rename that never replaces what is at `to`: a file (or symlink) is linked there, which fails if the name
// is taken, then unlinked here; a folder is renamed only after a look (renaming onto an empty folder, the
// one case the look can miss, loses nothing). EEXIST when the name is taken.
export function noClobberRename(from: string, to: string): void {
  if (!lstatSync(from).isDirectory()) {
    try {
      linkSync(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EXDEV') throw err;
      // A filesystem without hard links: the look-then-rename below.
      if (taken(to)) throw exists(to);
      renameSync(from, to);
      return;
    }
    unlinkSync(from);
    return;
  }
  if (taken(to)) throw exists(to);
  renameSync(from, to);
}

const REAL_OPS: MoveOps = {
  rename: noClobberRename,
  copy: (from, to) => cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true }),
  remove: (path) => rmSync(path, { recursive: true }),
};

// A copy across devices goes first to `<vault>/rooms/.maitre-moving/<room>-<token>-<name>`, listed in
// `<room>.json` there before it is made, and takes its own name only once checked whole. Only what that list
// names is ever removed (a room's own scratch files can never land there: room names do not start with '.').
const MOVING = '.maitre-moving';

interface Moving {
  dir: string;
  room: string;
}

const manifest = (m: Moving) => join(m.dir, `${m.room}.json`);

function listed(m: Moving): string[] {
  try {
    const v = readJson(manifest(m));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.startsWith(`${m.room}-`) && !x.includes('/')) : [];
  } catch {
    return [];
  }
}

const list = (m: Moving, names: string[]) => (names.length === 0 ? rmSync(manifest(m), { force: true }) : writeJsonAtomic(manifest(m), names));

// What a crash left half-copied: its source is still in the scratch folder, so it goes.
function cleanMoving(m: Moving): void {
  const names = listed(m);
  for (const name of names) rmSync(join(m.dir, name), { recursive: true, force: true });
  list(m, []);
}

// Every path below `path` with its kind, size (files) or target (symlinks): what a full copy has too.
function shape(path: string, rel = ''): string[] {
  const st = lstatSync(join(path, rel));
  if (st.isSymbolicLink()) return [`${rel} -> ${readlinkSync(join(path, rel))}`];
  if (!st.isDirectory()) return [`${rel} ${st.size}`];
  const out = [`${rel}/`];
  for (const name of readdirSync(join(path, rel)).sort()) out.push(...shape(path, rel === '' ? name : join(rel, name)));
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// Into `dir` under a free name (the next one when a writer takes it meanwhile); the source goes only once
// its copy across devices is checked whole. A failed copy is removed and the source stays.
function moveEntry(from: string, dir: string, name: string, ops: MoveOps, moving: Moving): void {
  for (;;) {
    const to = join(dir, freeName(dir, name));
    try {
      ops.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') continue;
      if (code !== 'EXDEV') throw err;
    }
    ownFolder(moving.dir);
    mkdirSync(moving.dir, { recursive: true, mode: 0o700 });
    const tmpName = `${moving.room}-${randomBytes(4).toString('hex')}-${name}`;
    const tmp = join(moving.dir, tmpName);
    list(moving, [...listed(moving), tmpName]);
    const unlist = () => list(moving, listed(moving).filter((n) => n !== tmpName));
    try {
      ops.copy(from, tmp);
      if (!same(shape(tmp), shape(from))) throw new Error(`the copy of ${name} into the vault is not whole`);
      for (;;) {
        const final = join(dir, freeName(dir, name));
        try {
          noClobberRename(tmp, final);
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      unlist();
      throw err;
    }
    unlist();
    ops.remove(from);
    return;
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

// One rule for maître's folders: the roots (maître's home, the configured vault) may be symlinks, the
// folders maître makes under them may not. The path guard refuses a symlinked scratch/ or worktrees/<project>
// (the room folder no longer resolves to the expected path); the vault's rooms/, rooms/<room>, its move folder
// and minutes/ are refused where they are used.
export function ownFolder(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink: maître's folders in the vault must be real folders`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// Scratch files are never deleted: they move into the room's folder in the vault, merging with what is there.
export function moveScratch(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env, ops: MoveOps = REAL_OPS): string {
  if (rec.kind !== 'scratch') throw new Error(`room ${rec.room} is not a scratch room`);
  const src = ownedDir(rec, env);
  const rooms = join(settings(env).vault, 'rooms');
  const dest = join(rooms, rec.room);
  ownFolder(rooms);
  ownFolder(dest);
  // Private: what a room leaves can hold private text.
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const moving: Moving = { dir: join(rooms, MOVING), room: rec.room };
  ownFolder(moving.dir);
  cleanMoving(moving);
  for (const name of readdirSync(src)) moveEntry(join(src, name), dest, name, ops, moving);
  rmdirSync(src);
  return dest;
}
