import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoomState } from '../src/room-state.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAITRE = join(ROOT, 'bin', 'maitre');
const REPLAY = join(ROOT, 'scripts', 'replay-events.mjs');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'hook-events.jsonl');

function replay(home: string, fixture: string, extra: string[] = []) {
  return spawnSync(process.execPath, [REPLAY, fixture, '--room', 'Demo Room', '--delay', '0', ...extra], {
    env: { PATH: process.env.PATH ?? '', MAITRE_HOME: home },
    encoding: 'utf8',
  });
}

// Starts the lounge on the given home and returns the rooms its /api/state reports.
async function loungeRooms(home: string): Promise<RoomState[]> {
  const child = spawn(process.execPath, [MAITRE, 'lounge', '--no-open', '--port', '0'], {
    env: { PATH: process.env.PATH ?? '', MAITRE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
  try {
    const url = await new Promise<string>((res, rej) => {
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        out += c;
        const m = /maitre lounge: (\S+)/.exec(out);
        if (m) res(m[1]);
      });
      child.on('exit', () => rej(new Error(`lounge exited early: ${out}`)));
    });
    const api = new URL(url);
    api.pathname = '/api/state';
    api.search = `?key=${new URL(url).searchParams.get('key')}`;
    const res = await fetch(api);
    assert.equal(res.status, 200);
    return ((await res.json()) as { rooms: RoomState[] }).rooms;
  } finally {
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  }
}

test('replaying the fixture up to the PR shows a room waiting for merge', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-replay-'));
  try {
    const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.match(lines.at(-1)!, /"hook_event_name":"SessionEnd"/);
    const partial = join(home, 'until-pr.jsonl');
    writeFileSync(partial, lines.slice(0, -1).join('\n') + '\n');

    const r = replay(home, partial);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`${lines.length - 1} event\\(s\\) replayed`));

    const rooms = await loungeRooms(home);
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].room, 'demo-room');
    assert.equal(rooms[0].state, 'whisky');
    assert.equal(rooms[0].model, 'haiku');
    assert.equal(rooms[0].prUrl, 'https://github.com/acme/app/pull/12');
    assert.equal(rooms[0].block, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('replaying the whole fixture ends the room, so it leaves the snapshot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-replay-'));
  try {
    const r = replay(home, FIXTURE);
    assert.equal(r.status, 0, r.stderr);
    const events = readFileSync(join(home, 'state', 'rooms', 'demo-room', 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(events.length, readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim() !== '').length);
    assert.deepEqual(await loungeRooms(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('replay-events rejects bad arguments', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-replay-'));
  try {
    for (const args of [[], [FIXTURE, '--delay', '-1'], [FIXTURE, '--room', '--'], [FIXTURE, '--bogus']]) {
      const r = spawnSync(process.execPath, [REPLAY, ...args], { env: { PATH: process.env.PATH ?? '', MAITRE_HOME: home }, encoding: 'utf8' });
      assert.equal(r.status, 2, `args ${JSON.stringify(args)}`);
      assert.match(r.stderr, /^replay-events: /);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('replay-events refuses to run without MAITRE_HOME', () => {
  // HOME points at an empty folder, so a regression could not replay into the real ~/.maitre.
  const home = mkdtempSync(join(tmpdir(), 'maitre-replay-'));
  try {
    for (const env of [{}, { MAITRE_HOME: '' }]) {
      const r = spawnSync(process.execPath, [REPLAY, FIXTURE, '--delay', '0'], { env: { PATH: process.env.PATH ?? '', HOME: home, ...env }, encoding: 'utf8' });
      assert.equal(r.status, 2, JSON.stringify(env));
      assert.match(r.stderr, /^replay-events: set MAITRE_HOME .*\n$/);
      assert.equal(r.stderr.split('\n').length, 2, 'one line');
      assert.equal(r.stdout, '');
      assert.deepEqual(readdirSync(home), [], 'nothing written under HOME');
    }
    const help = spawnSync(process.execPath, [REPLAY, '--help'], { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' });
    assert.equal(help.status, 0, 'help still works without it');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
