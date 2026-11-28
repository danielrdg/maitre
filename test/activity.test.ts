import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isActive, isIdle, isQuiet, roomActivity, type RoomActivity } from '../src/activity.js';
import type { HookLine } from '../src/events.js';
import { roomDir } from '../src/paths.js';
import type { RoomRecord } from '../src/rooms.js';

const HOUR = 3_600_000;

function withHome(fn: (env: NodeJS.ProcessEnv) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'maitre-activity-'));
  try {
    fn({ MAITRE_HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function write(env: NodeJS.ProcessEnv, room: string, lines: Partial<HookLine>[]): void {
  const dir = roomDir(room, env);
  mkdirSync(dir, { recursive: true });
  for (const l of lines) appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ v: 1, room, session: 's1', ...l }) + '\n');
}

const start = (ts: number, extra: Partial<HookLine> = {}): Partial<HookLine> => ({ ts, event: 'SessionStart', model: 'opus', ...extra });
const stop = (ts: number, extra: Partial<HookLine> = {}): Partial<HookLine> => ({ ts, event: 'Stop', ...extra });
const prompt = (ts: number): Partial<HookLine> => ({ ts, event: 'UserPromptSubmit', prompt: 'do it' });

const rec = (extra: Partial<RoomRecord> = {}): RoomRecord => ({
  room: 'r1',
  kind: 'scratch',
  dir: '/x',
  model: 'opus',
  taskType: 'code',
  createdAt: 0,
  ...extra,
});
const act = (extra: Partial<RoomActivity> = {}): RoomActivity => ({ state: 'ready', lastEventAt: 0, ...extra });

test('a room with no events has no activity', () => {
  withHome((env) => {
    assert.deepEqual(roomActivity('ghost', env), { state: 'none' });
  });
});

test('activity reduces the events: state, newest event time, PR link', () => {
  withHome((env) => {
    write(env, 'r1', [start(1000), prompt(2000), stop(3000)]);
    assert.deepEqual(roomActivity('r1', env), { state: 'ready', lastEventAt: 3000, session: 's1' });
  });
});

test("Claude Code's Notification is not activity: lastEventAt stays at the turn's last event", () => {
  withHome((env) => {
    write(env, 'r1', [start(1000), prompt(2000), stop(3000), { ts: 63_000, event: 'Notification', notification_type: 'idle_prompt' }]);
    assert.deepEqual(roomActivity('r1', env), { state: 'ready', lastEventAt: 3000, session: 's1' });
  });
});

test("the session is the reducer's: a late SessionEnd of the session before /clear is not it", () => {
  withHome((env) => {
    write(env, 'r1', [start(1000), stop(2000), start(3000, { session: 's2' }), stop(4000, { session: 's2' }), { ts: 5000, event: 'SessionEnd', session: 's1' }]);
    assert.equal(roomActivity('r1', env).session, 's2');
  });
});

test('transcript comes from the newest line that has one; none before M3a', () => {
  withHome((env) => {
    write(env, 'old', [start(1000), stop(2000)]);
    assert.equal(roomActivity('old', env).transcript, undefined);
    write(env, 'r1', [start(1000, { transcript: '/t/a.jsonl' }), prompt(2000), stop(3000, { transcript: '/t/b.jsonl' }), { ts: 4000, event: 'Notification' }]);
    assert.equal(roomActivity('r1', env).transcript, '/t/b.jsonl');
  });
});

test('isIdle: ready and coffee past the limit; work, blocked, smoke never; recent events never', () => {
  const now = 10 * HOUR;
  for (const state of ['ready', 'coffee'] as const) {
    assert.equal(isIdle(act({ state, lastEventAt: 0 }), now, 4 * HOUR), true, state);
    assert.equal(isIdle(act({ state, lastEventAt: now - HOUR }), now, 4 * HOUR), false, state);
  }
  for (const state of ['work', 'blocked', 'smoke', 'whisky', 'exit'] as const) {
    assert.equal(isIdle(act({ state, lastEventAt: 0 }), now, 4 * HOUR), false, state);
  }
  assert.equal(isIdle({ state: 'none' }, now, 4 * HOUR), false);
});

test('isActive: running, open, not couched, no PR', () => {
  assert.equal(isActive(rec(), act(), true), true);
  assert.equal(isActive(rec(), act(), false), false);
  assert.equal(isActive(rec({ closedBy: 'user' }), act(), true), false);
  assert.equal(isActive(rec({ couch: { since: 1, reasons: ['dirty'] } }), act(), true), false);
  assert.equal(isActive(rec(), act({ prUrl: 'https://github.com/o/r/pull/1', state: 'whisky' }), true), false);
  assert.equal(isActive(rec(), act({ state: 'whisky' }), true), false);
});

test('closedAt alone does not close a room', () => {
  assert.equal(isActive(rec({ closedAt: 5 }), act(), true), true);
});

test('isActive: a seat released or an OPEN PR keeps a room out; MERGED, CLOSED or absent does not', () => {
  const seat = { releasedAt: 1, session: 's1' };
  const pr = (state: 'OPEN' | 'MERGED' | 'CLOSED') => ({ state });
  assert.equal(isActive(rec({ seat }), act(), true), false);
  assert.equal(isActive(rec({ seat }), act(), true, pr('MERGED')), false);
  assert.equal(isActive(rec(), act(), true, pr('OPEN')), false);
  assert.equal(isActive(rec(), act(), true, pr('MERGED')), true);
  assert.equal(isActive(rec(), act(), true, pr('CLOSED')), true);
  assert.equal(isActive(rec(), act(), true, undefined), true);
  assert.equal(isActive(rec(), act(), false, pr('MERGED')), false);
});

test('isActive: a given PR state replaces the reducer prUrl and whisky rule', () => {
  const stale = act({ prUrl: 'https://github.com/o/r/pull/1', state: 'whisky' });
  assert.equal(isActive(rec(), stale, true), false);
  assert.equal(isActive(rec(), stale, true, { state: 'MERGED' }), true);
  assert.equal(isActive(rec(), stale, true, { state: 'OPEN' }), false);
});

test('isQuiet: resting live state, herdr idle, last countable event older than the threshold', () => {
  const ms = 30 * 60_000;
  const old = 1_000_000;
  const now = old + ms + 1;
  for (const state of ['ready', 'coffee', 'whisky', 'couch'] as const) {
    assert.equal(isQuiet(act({ state, lastEventAt: old }), 'idle', now, ms), true, state);
  }
  for (const state of ['work', 'smoke', 'blocked', 'exit', 'queue', 'none'] as const) {
    assert.equal(isQuiet(act({ state, lastEventAt: old }), 'idle', now, ms), false, state);
  }
  for (const herdr of ['working', 'blocked', 'unknown', 'not running'] as const) {
    assert.equal(isQuiet(act({ state: 'whisky', lastEventAt: old }), herdr, now, ms), false, herdr);
  }
  assert.equal(isQuiet(act({ state: 'ready', lastEventAt: old }), 'idle', old + ms, ms), false);
  assert.equal(isQuiet({ state: 'ready' }, 'idle', now, ms), false);
});

test('isQuiet: a Notification does not count as activity', () => {
  withHome((env) => {
    write(env, 'r1', [start(1_000), stop(2_000), { ts: 9_000_000, event: 'Notification' }]);
    const a = roomActivity('r1', env);
    assert.equal(a.lastEventAt, 2_000);
    assert.equal(isQuiet(a, 'idle', 9_000_001, 60_000), true);
  });
});

test("roomActivity: a block from maître's starting note alone is marked starting; a real question is not", () => {
  withHome((env) => {
    const note: Partial<HookLine> = { ts: 30, event: 'MaitreStatus', session: '', status: 'blocked', text: 'Room is still starting — check its tab', options: [], starting: true, resumes: 's1' };
    write(env, 'r1', [start(10), stop(20), note]);
    assert.deepEqual(roomActivity('r1', env), { state: 'blocked', lastEventAt: 30, session: 's1', starting: true });
    write(env, 'r1', [{ ts: 40, event: 'PermissionRequest', tool: 'Bash', input: { command: 'ls' } }]);
    assert.equal(roomActivity('r1', env).state, 'blocked');
    assert.equal(roomActivity('r1', env).starting, undefined, 'a question Claude asked through its hooks');
    write(env, 'r2', [start(10), { ts: 20, event: 'MaitreStatus', status: 'blocked', text: 'Merge now?', options: ['yes'] }]);
    assert.equal(roomActivity('r2', env).starting, undefined, 'a block the agent declared');
  });
});

test('isActive: without pr.json, a room that once printed a PR counts again once it works', () => {
  const pr = 'https://github.com/o/r/pull/1';
  assert.equal(isActive(rec({ kind: 'scratch' }), act({ prUrl: pr, state: 'work' }), true), true);
  assert.equal(isActive(rec({ kind: 'scratch' }), act({ prUrl: pr, state: 'whisky' }), true), false);
});
