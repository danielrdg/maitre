import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isActive, isIdle, roomActivity, type RoomActivity } from '../src/activity.js';
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
    assert.deepEqual(roomActivity('r1', env), { state: 'ready', lastEventAt: 3000 });
  });
});

test("Claude Code's Notification is not activity: lastEventAt stays at the turn's last event", () => {
  withHome((env) => {
    write(env, 'r1', [start(1000), prompt(2000), stop(3000), { ts: 63_000, event: 'Notification', notification_type: 'idle_prompt' }]);
    assert.deepEqual(roomActivity('r1', env), { state: 'ready', lastEventAt: 3000 });
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
  assert.equal(isActive(rec(), act({ prUrl: 'https://github.com/o/r/pull/1' }), true), false);
  assert.equal(isActive(rec(), act({ state: 'whisky' }), true), false);
});

test('closedAt alone does not close a room', () => {
  assert.equal(isActive(rec({ closedAt: 5 }), act(), true), true);
});
