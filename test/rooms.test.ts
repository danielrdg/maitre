import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roomDir } from '../src/paths.js';
import { listRooms, patchRoom, readRoom, writeRoom, type RoomRecord } from '../src/rooms.js';

function withHome(fn: (env: NodeJS.ProcessEnv) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'maitre-rooms-'));
  try {
    fn({ MAITRE_HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const rec: RoomRecord = {
  room: 'alpha',
  project: 'p',
  kind: 'code',
  dir: '/x',
  branch: 'maitre/alpha',
  model: 'sonnet',
  taskType: 'feature',
  herdr: { session: 's', workspaceId: 'w', paneId: 'pa' },
  createdAt: 1,
  closedAt: 2,
};

test('registry round-trips with 0600 permissions', () => {
  withHome((env) => {
    assert.equal(readRoom('alpha', env), undefined);
    writeRoom(rec, env);
    assert.deepEqual(readRoom('alpha', env), rec);
    assert.equal(statSync(join(roomDir('alpha', env), 'room.json')).mode & 0o777, 0o600);
  });
});

test('listRooms lists only dirs with room.json', () => {
  withHome((env) => {
    assert.deepEqual(listRooms(env), []);
    writeRoom(rec, env);
    writeRoom({ ...rec, room: 'beta' }, env);
    mkdirSync(roomDir('gamma', env), { recursive: true });
    assert.deepEqual(listRooms(env).map((r) => r.room), ['alpha', 'beta']);
  });
});

test('listRooms skips corrupt or non-object room.json', () => {
  withHome((env) => {
    writeRoom(rec, env);
    for (const [name, body] of [['bad', '{oops'], ['str', '"x"'], ['nul', 'null']]) {
      mkdirSync(roomDir(name, env), { recursive: true });
      writeFileSync(join(roomDir(name, env), 'room.json'), body);
    }
    assert.deepEqual(listRooms(env).map((r) => r.room), ['alpha']);
  });
});

test('a patch waits for the record lock another process holds, so a write it makes meanwhile is not lost', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-rooms-'));
  const env = { MAITRE_HOME: home };
  try {
    writeRoom(rec, env);
    const lock = join(roomDir('alpha', env), 'room.json.lock');
    const file = join(roomDir('alpha', env), 'room.json');
    // Another process holds the lock, writes the record (a close) and lets go.
    const script = `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: process.pid, token: 'other' }));
      setTimeout(() => {
        const r = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
        fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ ...r, closedBy: 'user' }));
        fs.unlinkSync(${JSON.stringify(lock)});
      }, 300);
      setTimeout(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    const t0 = Date.now();
    while (!existsSync(lock) && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 10));
    const out = patchRoom(rec, (r) => ({ ...r, couch: { since: 5, reasons: ['x'] } }), env);
    assert.equal(readRoom('alpha', env)!.closedBy, 'user', 'the write made under the lock is kept');
    assert.deepEqual(out.couch, { since: 5, reasons: ['x'] });
    assert.equal(existsSync(lock), false);
    child.kill();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a whole write waits for the record lock too: it lands after the other process let go', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-rooms-'));
  const env = { MAITRE_HOME: home };
  try {
    writeRoom(rec, env);
    const lock = join(roomDir('alpha', env), 'room.json.lock');
    const file = join(roomDir('alpha', env), 'room.json');
    const script = `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: process.pid, token: 'other' }));
      setTimeout(() => {
        const r = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
        fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ ...r, closedBy: 'user' }));
        fs.unlinkSync(${JSON.stringify(lock)});
      }, 300);
      setTimeout(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    const t0 = Date.now();
    while (!existsSync(lock) && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 10));
    const start = Date.now();
    writeRoom({ ...rec, model: 'opus' }, env);
    assert.ok(Date.now() - start >= 200, 'it waited');
    assert.deepEqual(readRoom('alpha', env), { ...rec, model: 'opus' });
    child.kill();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
