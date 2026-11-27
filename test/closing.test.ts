import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closingFile, isClosing, noteClosing, readClosing, pendingClosings, releaseClosing, retryClosings, takeClosing } from '../src/closing.js';
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
