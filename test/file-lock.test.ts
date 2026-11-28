import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryFileLock, withFileLock } from '../src/file-lock.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'maitre-lock-'));
  dirs.push(d);
  return d;
}

const deadPid = () => spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid!;
const old = (path: string) => utimesSync(path, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

async function livePid(): Promise<number> {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  children.push(c);
  await new Promise((r) => setTimeout(r, 50));
  return c.pid!;
}

test('the lock file is never seen empty or half-written: it is whole from its first byte', () => {
  const d = dir();
  const lock = join(d, 'x.lock');
  let seen = '';
  withFileLock(lock, () => {
    seen = readFileSync(lock, 'utf8');
  });
  assert.match(seen, /"pid":\d+/);
  assert.deepEqual(readdirSync(d), [], 'no lock and no temporary file left');
});

test('an old lock whose holder is alive is never broken', async () => {
  const lock = join(dir(), 'x.lock');
  writeFileSync(lock, JSON.stringify({ pid: await livePid(), token: 'live' }));
  old(lock);
  assert.equal(tryFileLock(lock, () => 'ran', { waitMs: 50 }), undefined);
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'live');
});

test('a fresh lock of a dead holder is not broken yet', () => {
  const lock = join(dir(), 'x.lock');
  writeFileSync(lock, JSON.stringify({ pid: deadPid(), token: 'dead' }));
  assert.equal(tryFileLock(lock, () => 'ran', { waitMs: 50 }), undefined);
});

test('an old lock of a dead holder is broken, and so is an old empty one', () => {
  const d = dir();
  const lock = join(d, 'x.lock');
  writeFileSync(lock, JSON.stringify({ pid: deadPid(), token: 'dead' }));
  old(lock);
  assert.equal(tryFileLock(lock, () => 'ran', { waitMs: 50 }), 'ran');
  writeFileSync(lock, '');
  old(lock);
  assert.equal(tryFileLock(lock, () => 'ran', { waitMs: 50 }), 'ran');
  assert.deepEqual(readdirSync(d), []);
});

test('files a crashed holder or breaker left beside the lock are removed once their process is gone', () => {
  const d = dir();
  const lock = join(d, 'x.lock');
  const pid = deadPid();
  const left = [`x.lock.${pid}.abcd.new`, `x.lock.${pid}.abcd.stale`].map((f) => join(d, f));
  for (const f of left) writeFileSync(f, '{}');
  withFileLock(lock, () => undefined);
  assert.deepEqual(left.filter((f) => existsSync(f)), []);
});
