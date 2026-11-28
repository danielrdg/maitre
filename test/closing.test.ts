import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closingFile, isClosing, noteClosing, processStart, readClosing, pendingClosings, releaseClosing, retryClosings, takeClosing } from '../src/closing.js';
import { roomDir } from '../src/paths.js';

const homes: string[] = [];
after(() => {
  for (const d of homes) rmSync(d, { recursive: true, force: true });
});

function home(): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), 'maitre-closing-'));
  homes.push(d);
  const env = { MAITRE_HOME: d };
  mkdirSync(roomDir('a', env), { recursive: true });
  return env;
}

function take(env: NodeJS.ProcessEnv): string {
  const h = takeClosing('a', env);
  assert.notEqual(h, 'busy');
  return (h as { token: string }).token;
}

// Another closer in the middle of a takeover: the short lock is fresh, so it is not broken.
const busyLock = (env: NodeJS.ProcessEnv) => {
  const lock = `${closingFile('a', env)}.takeover`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other' }));
  return () => unlinkSync(lock);
};

const marker = (env: NodeJS.ProcessEnv) => JSON.parse(readFileSync(closingFile('a', env), 'utf8')) as { pid: number; minutes?: string };

test('a release that finds the takeover lock busy is kept and done by the next retry', () => {
  const env = home();
  const token = take(env);
  const free = busyLock(env);
  releaseClosing('a', token, env);
  assert.equal(existsSync(closingFile('a', env)), true, 'not released while the lock is busy');
  assert.equal(isClosing('a', env), true, 'still held: the token is kept for the retry');
  assert.equal(pendingClosings(), 1);
  assert.equal(retryClosings(), 1, 'still busy: kept for the next one');
  assert.equal(existsSync(closingFile('a', env)), true);
  free();
  assert.equal(retryClosings(), 0);
  assert.equal(existsSync(closingFile('a', env)), false);
  assert.equal(isClosing('a', env), false);
  assert.equal(pendingClosings(), 0);
});

test('notes and the release wait behind a busy note, in order: a pid 0 marker is kept, not removed', () => {
  const env = home();
  const token = take(env);
  const free = busyLock(env);
  noteClosing('a', token, { minutes: '/m.md' }, env);
  noteClosing('a', token, { pid: 0 }, env);
  releaseClosing('a', token, env);
  assert.equal(marker(env).pid, process.pid, 'nothing applied while busy');
  assert.equal(marker(env).minutes, undefined);
  assert.equal(isClosing('a', env), true);
  free();
  assert.equal(retryClosings(), 0);
  assert.deepEqual([marker(env).pid, marker(env).minutes], [0, '/m.md'], 'both notes applied, the release left the handed-over marker');
  assert.equal(isClosing('a', env), false, 'a pid 0 marker is a dead closer for everyone');
});

test('with the lock free, note and release act at once and nothing is kept', () => {
  const env = home();
  const token = take(env);
  noteClosing('a', token, { minutes: '/m.md' }, env);
  assert.equal(marker(env).minutes, '/m.md');
  releaseClosing('a', token, env);
  assert.equal(existsSync(closingFile('a', env)), false);
  assert.equal(pendingClosings(), 0);
});

test('a kept release whose room folder is gone is dropped, not retried forever', () => {
  const env = home();
  const token = take(env);
  busyLock(env);
  releaseClosing('a', token, env);
  rmSync(roomDir('a', env), { recursive: true, force: true });
  assert.equal(retryClosings(), 0);
  assert.equal(isClosing('a', env), false);
});

test('the createdAt a closer notes survives the later pid 0 note', () => {
  const env = home();
  const token = take(env);
  noteClosing('a', token, { minutes: '/m.md', createdAt: 42 }, env);
  noteClosing('a', token, { pid: 0 }, env);
  const m = readClosing('a', env)!;
  assert.deepEqual([m.pid, m.minutes, m.createdAt], [0, '/m.md', 42]);
});

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill();
});

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return r.pid!;
}

const old = (path: string) => utimesSync(path, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

test('an old takeover lock whose holder is still alive is never broken', async () => {
  const env = home();
  const child = sleeper();
  await new Promise((r) => setTimeout(r, 50));
  // A dead closer's marker, and a live process holding the short lock for a long time.
  writeFileSync(closingFile('a', env), JSON.stringify({ pid: deadPid(), token: 'gone' }));
  const lock = `${closingFile('a', env)}.takeover`;
  writeFileSync(lock, JSON.stringify({ pid: child.pid, token: 'live' }));
  old(lock);
  assert.equal(takeClosing('a', env), 'busy');
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'live');
});

test('an old takeover lock of a dead holder is broken, and the dead closer taken over', () => {
  const env = home();
  writeFileSync(closingFile('a', env), JSON.stringify({ pid: deadPid(), token: 'gone' }));
  const lock = `${closingFile('a', env)}.takeover`;
  writeFileSync(lock, JSON.stringify({ pid: deadPid(), token: 'dead' }));
  old(lock);
  const token = take(env);
  assert.equal(marker(env).pid, process.pid);
  releaseClosing('a', token, env);
  assert.equal(existsSync(lock), false);
});

test('files a crashed closer left half-written beside the marker are cleaned up by the next closer', () => {
  const env = home();
  const pid = deadPid();
  const left = [`closing.${pid}.abcd.new`, `closing.${pid}.abcd.tmp`, `closing.takeover.${pid}.abcd.new`].map((f) => join(roomDir('a', env), f));
  for (const f of left) writeFileSync(f, '{}');
  const mine = join(roomDir('a', env), `closing.${process.pid}.ffff.tmp`);
  writeFileSync(mine, '{}');
  const token = take(env);
  releaseClosing('a', token, env);
  assert.deepEqual(left.filter((f) => existsSync(f)), []);
  assert.equal(existsSync(mine), true, 'a live process\'s files are left alone');
});

test('a live closer that held its marker for 2 hours of its own running time no longer counts as closing; a suspend does not count', async () => {
  const env = home();
  const child = sleeper();
  await new Promise((r) => setTimeout(r, 50));
  const start = processStart(child.pid!);
  // Taken 3 hours ago by the wall clock, but most of it the machine slept: its closer ran for 10 minutes.
  writeFileSync(closingFile('a', env), JSON.stringify({ pid: child.pid, token: 'slept', start, since: Date.now() - 3 * 3_600_000, awakeMs: 10 * 60_000 }));
  assert.equal(isClosing('a', env), true);
  writeFileSync(closingFile('a', env), JSON.stringify({ pid: child.pid, token: 'hung', start, since: Date.now() - 3 * 3_600_000, awakeMs: 3 * 3_600_000 }));
  assert.equal(isClosing('a', env), false);
});

test('the heartbeat records how long its closer has been running', async () => {
  const env = home();
  const h = takeClosing('a', env, { heartbeatMs: 20 });
  assert.notEqual(h, 'busy');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok((readClosing('a', env)!.awakeMs ?? 0) > 0);
  releaseClosing('a', (h as { token: string }).token, env);
});

test('a marker records when its close started', () => {
  const env = home();
  const token = take(env);
  assert.ok(Math.abs((readClosing('a', env)!.since ?? 0) - Date.now()) < 5_000);
  noteClosing('a', token, { minutes: '/m.md' }, env);
  assert.equal(typeof readClosing('a', env)!.since, 'number');
  releaseClosing('a', token, env);
});
