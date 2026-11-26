import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roomDir } from '../src/paths.js';
import { listRooms, readRoom, writeRoom, type RoomRecord } from '../src/rooms.js';

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
