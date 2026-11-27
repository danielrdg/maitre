import { after, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closingFile, isClosing, processStart, releaseClosing, takeClosing } from '../src/closing.js';
import { admit, doormanTick, readQueue, type DoormanResult } from '../src/doorman.js';
import type { JanitorDecision } from '../src/janitor.js';
import { LiveRooms } from '../src/live-api.js';
import { loungeFile } from '../src/lounge-file.js';
import { startTicks, type Ticks } from '../src/lounge-ticks.js';
import { roomDir } from '../src/paths.js';
import { openingFile, writeQueue } from '../src/queue.js';
import type { LiveState, RoomState } from '../src/room-state.js';
import { openRoom } from '../src/room-open.js';
import { readRoom } from '../src/rooms.js';
import type { Route } from '../src/router.js';
import { herdrSandbox, type HerdrSandbox } from './herdr-sandbox.js';

const MAITRE = fileURLToPath(new URL('../../bin/maitre', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../../test/fixtures/fake-claude-router.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('../../test/fixtures/fake-gh.mjs', import.meta.url));
const FAST = { trustTimeoutMs: 120_000, pollMs: 10 };
const HOURS = 3_600_000;
const MIN = 60_000;

let sb: HerdrSandbox;
let ticks: Ticks | undefined;

beforeEach(() => {
  sb = herdrSandbox();
  for (const [name, script] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(sb.bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(sb.bin, name), 0o755);
  }
  const userHome = join(sb.dir, 'user');
  mkdirSync(userHome);
  const fakes = { HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config'), GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: join(sb.dir, 'claude.log'), FAKE_GH_LOG: join(sb.dir, 'gh.log') };
  Object.assign(process.env, fakes);
  Object.assign(sb.env, fakes);
});

afterEach(() => {
  ticks?.stop();
  ticks = undefined;
  mock.timers.reset();
  sb.restore();
});

// A janitor and a doorman that only count their calls, each held open until released.
function fakes(opts: { janitor?: () => Promise<JanitorDecision[]>; doorman?: () => Promise<string[] | DoormanResult> } = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    calls,
    out,
    err,
    deps: {
      janitor: async () => {
        calls.push('janitor');
        return opts.janitor ? opts.janitor() : [];
      },
      doorman: async () => {
        calls.push('doorman');
        const r = opts.doorman ? await opts.doorman() : [];
        return Array.isArray(r) ? { opened: r, gaveUp: [] } : r;
      },
      log: (l: string) => out.push(l),
      warn: (l: string) => err.push(l),
    },
  };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

test('ticks run the janitor then the doorman once at start, then every interval', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const f = fakes();
  ticks = startTicks(process.env, { ...f.deps, intervalMs: 5 * MIN });
  await ticks.idle();
  assert.deepEqual(f.calls, ['janitor', 'doorman']);
  mock.timers.tick(5 * MIN - 1);
  await ticks.idle();
  assert.equal(f.calls.length, 2);
  mock.timers.tick(1);
  await ticks.idle();
  mock.timers.tick(5 * MIN);
  await ticks.idle();
  assert.deepEqual(f.calls, ['janitor', 'doorman', 'janitor', 'doorman', 'janitor', 'doorman']);
  assert.deepEqual(f.out, [], 'nothing happened: nothing printed');
});

test('the interval comes from the settings, a malformed config falls back to 5 minutes with a warning', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ roots: [], projects: {}, janitor: { intervalMinutes: 1 } }));
  const f = fakes();
  ticks = startTicks(process.env, f.deps);
  await ticks.idle();
  mock.timers.tick(MIN);
  await ticks.idle();
  assert.equal(f.calls.filter((c) => c === 'janitor').length, 2);
  ticks.stop();

  writeFileSync(join(sb.home, 'config.json'), '{broken');
  const g = fakes();
  ticks = startTicks(process.env, g.deps);
  await ticks.idle();
  mock.timers.tick(MIN);
  await ticks.idle();
  assert.equal(g.calls.filter((c) => c === 'janitor').length, 1);
  mock.timers.tick(4 * MIN);
  await ticks.idle();
  assert.equal(g.calls.filter((c) => c === 'janitor').length, 2);
  assert.match(g.err.join('\n'), /settings/);
});

test('a tick never overlaps the one before: ticks due meanwhile run once, after it', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const slow = gate();
  let first = true;
  const f = fakes({
    janitor: async () => {
      if (first) {
        first = false;
        await slow.wait;
      }
      return [];
    },
  });
  ticks = startTicks(process.env, { ...f.deps, intervalMs: MIN });
  mock.timers.tick(3 * MIN);
  ticks.roomChanged();
  mock.timers.tick(2_000);
  assert.deepEqual(f.calls, ['janitor'], 'still in the first tick');
  slow.open();
  await ticks.idle();
  assert.deepEqual(f.calls, ['janitor', 'doorman', 'janitor', 'doorman'], 'one full tick after it, the doorman request folded in');
});

test('janitor and doorman failures are logged and the next tick still runs', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const f = fakes({
    janitor: () => Promise.reject(new Error('disk full')),
    doorman: () => Promise.reject(new Error('herdr: not running\nstack')),
  });
  ticks = startTicks(process.env, { ...f.deps, intervalMs: MIN });
  await ticks.idle();
  assert.deepEqual(f.calls, ['janitor', 'doorman'], 'the doorman runs even when the janitor failed');
  assert.deepEqual(f.err, ['maitre: janitor: disk full', 'maitre: doorman: herdr: not running']);
  mock.timers.tick(MIN);
  await ticks.idle();
  assert.equal(f.calls.length, 4);
  assert.equal(f.err.length, 2, 'the same failure again is not repeated');
});

test('a repeated failure is told once, and how often it repeated is told when it changes', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const errors = ['herdr: down', 'herdr: down', 'herdr: down', 'herdr: other', undefined, undefined];
  const f = fakes({
    doorman: async () => {
      const e = errors.shift();
      if (e !== undefined) throw new Error(e);
      return [];
    },
  });
  ticks = startTicks(process.env, { ...f.deps, intervalMs: MIN });
  for (let i = 0; i < 6; i++) {
    await ticks.idle();
    mock.timers.tick(MIN);
  }
  await ticks.idle();
  assert.deepEqual(f.err, ['maitre: doorman: herdr: down', 'maitre: doorman: herdr: other (the previous failure repeated 3 times)']);
});

test('a room change runs the doorman alone, 2 s later, once for a burst', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const f = fakes();
  ticks = startTicks(process.env, { ...f.deps, intervalMs: 5 * MIN });
  await ticks.idle();
  f.calls.length = 0;
  ticks.roomChanged();
  mock.timers.tick(1_000);
  ticks.roomChanged();
  ticks.roomChanged();
  mock.timers.tick(999);
  await ticks.idle();
  assert.deepEqual(f.calls, []);
  mock.timers.tick(1);
  await ticks.idle();
  assert.deepEqual(f.calls, ['doorman']);
});

const live = (room: string, state: LiveState) => ({ room, state }) as RoomState;

test('only a change that can free a seat wakes the doorman: busy rooms working do not', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const f = fakes();
  ticks = startTicks(process.env, { ...f.deps, intervalMs: 5 * MIN, seatPollMs: 0 });
  await ticks.idle();
  f.calls.length = 0;
  for (let i = 0; i < 20; i++) {
    for (const s of ['work', 'smoke', 'blocked', 'ready', 'coffee'] as const) ticks.roomUpdate(live(`r${i % 3}`, s));
    mock.timers.tick(1_000);
    await ticks.idle();
  }
  assert.deepEqual(f.calls, [], 'no doorman tick, so no herdr probe, while rooms just work');
  for (const state of ['exit', 'whisky', 'couch'] as const) {
    ticks.roomUpdate(live('r1', state));
    mock.timers.tick(2_000);
    await ticks.idle();
    ticks.roomUpdate(live('r1', state));
    mock.timers.tick(2_000);
    await ticks.idle();
  }
  assert.deepEqual(f.calls, ['doorman', 'doorman', 'doorman'], 'once per transition, not per repeated event');
});

test('a released opening reservation wakes the doorman', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  // Another process opening room x.
  const opener = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  after(() => opener.kill('SIGKILL'));
  const start = processStart(opener.pid!);
  mkdirSync(join(sb.home, 'state'), { recursive: true });
  writeFileSync(openingFile(), JSON.stringify([{ room: 'x', pid: opener.pid, since: 1, ...(start !== undefined ? { start } : {}) }]));
  const f = fakes();
  ticks = startTicks(process.env, { ...f.deps, intervalMs: 5 * MIN });
  await ticks.idle();
  f.calls.length = 0;
  mock.timers.tick(3_000);
  await ticks.idle();
  assert.deepEqual(f.calls, [], 'still held');
  writeFileSync(openingFile(), '[]');
  mock.timers.tick(1_000);
  mock.timers.tick(2_000);
  await ticks.idle();
  assert.deepEqual(f.calls, ['doorman']);
});

test('a malformed decision never crashes the lounge: logged, and the next tick runs', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const f = fakes({ janitor: async () => [{ room: 'x', decision: 'couch', reasons: null } as unknown as JanitorDecision] });
  ticks = startTicks(process.env, { ...f.deps, intervalMs: MIN });
  await ticks.idle();
  assert.equal(f.err.length, 1);
  assert.match(f.err[0]!, /^maitre: tick: /);
  mock.timers.tick(MIN);
  await ticks.idle();
  assert.equal(f.calls.filter((c) => c === 'janitor').length, 2);
});

test('a tick running past 10 minutes is told once; the next ticks wait for it', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const hung = gate();
  let first = true;
  const f = fakes({
    janitor: async () => {
      if (first) {
        first = false;
        await hung.wait;
      }
      return [];
    },
  });
  ticks = startTicks(process.env, { ...f.deps, intervalMs: 5 * MIN });
  mock.timers.tick(10 * MIN - 1);
  assert.deepEqual(f.err, []);
  mock.timers.tick(1);
  mock.timers.tick(30 * MIN);
  assert.deepEqual(f.err, ['maitre: a tick has run for more than 10 minutes; the janitor and the doorman wait for it']);
  hung.open();
  await ticks.idle();
  assert.equal(f.err.length, 1);
});

test('a failing open is retried on the interval ticks, never every 2 s', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  writeQueue([{ room: 'c', requestIds: ['1'], route: route('c'), queuedAt: 1, attempts: 0 }]);
  let opening = gate();
  let opens = 0;
  let clock = Date.now();
  const doorman = (env: NodeJS.ProcessEnv) =>
    doormanTick(env, {
      now: () => clock,
      open: async () => {
        opens++;
        await opening.wait;
        throw new Error('herdr is down');
      },
    });
  const f = fakes();
  ticks = startTicks(process.env, { ...f.deps, doorman, intervalMs: 5 * MIN });
  while (opens === 0) await new Promise((r) => setImmediate(r));
  mock.timers.tick(1_000);
  opening.open();
  await ticks.idle();
  opening = gate();
  opening.open();
  for (let i = 0; i < 30; i++) {
    mock.timers.tick(1_000);
    await ticks.idle();
  }
  assert.equal(opens, 1, 'the reservation the lounge itself dropped wakes nobody');
  assert.equal(readQueue()[0]?.attempts, 1);
  mock.timers.tick(5 * MIN);
  clock += 5 * MIN;
  await ticks.idle();
  assert.equal(opens, 2);
  assert.equal(readQueue()[0]?.attempts, 2);
});

test('bursts of seat-freeing changes retry a failed queued room at most once a minute', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  writeQueue([{ room: 'c', requestIds: ['1'], route: route('c'), queuedAt: 1, attempts: 0 }]);
  let opens = 0;
  let runs = 0;
  let clock = Date.now();
  const doorman = (env: NodeJS.ProcessEnv) => {
    runs++;
    return doormanTick(env, {
      now: () => clock,
      open: async () => {
        opens++;
        throw new Error('herdr is down');
      },
    });
  };
  const f = fakes();
  ticks = startTicks(process.env, { ...f.deps, doorman, intervalMs: 5 * MIN, seatPollMs: 0 });
  await ticks.idle();
  const burst = async (n: number) => {
    for (let i = 0; i < n; i++) {
      for (const state of ['work', 'exit', 'work', 'whisky', 'work', 'couch'] as LiveState[]) ticks!.roomUpdate(live(`r${i % 3}`, state));
      mock.timers.tick(2_000);
      clock += 2_000;
      await ticks!.idle();
    }
  };
  await burst(29);
  assert.ok(runs > 20, `the doorman was woken (${runs} runs)`);
  assert.equal(opens, 1);
  assert.equal(readQueue()[0]?.attempts, 1);
  await burst(2);
  assert.equal(opens, 2, 'a minute after the first try');
  assert.equal(readQueue()[0]?.attempts, 2);
});

test('a queued room that gave up is told in the journal and as a desktop notification', async () => {
  const notes: string[] = [];
  const f = fakes({ doorman: async () => ({ opened: ['d'], gaveUp: [{ room: 'c', requestIds: ['3', '4'], reason: 'left the queue after 3 failed opens: boom' }] }) });
  ticks = startTicks(process.env, {
    ...f.deps,
    intervalMs: 5 * MIN,
    notify: (m) => {
      notes.push(m);
      throw new Error('no notification daemon');
    },
  });
  await ticks.idle();
  assert.deepEqual(f.out, [
    'maitre: doorman: opened d from the queue',
    'maitre: doorman: c left the queue after 3 failed opens: boom (requests 3, 4); see maitre room list',
  ]);
  assert.deepEqual(notes, ['c left the queue after 3 failed opens: boom']);
  assert.deepEqual(f.err, [], 'a failing notification is no doorman failure');
});

test('stop clears the timers: nothing runs after it', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const f = fakes();
  ticks = startTicks(process.env, { ...f.deps, intervalMs: MIN });
  await ticks.idle();
  ticks.roomChanged();
  ticks.stop();
  mock.timers.tick(10 * MIN);
  await ticks.idle();
  assert.deepEqual(f.calls, ['janitor', 'doorman']);
});

test('one summary line when something happened; a couch or error already told is not told again', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const rounds: JanitorDecision[][] = [
    [
      { room: 'a', decision: 'close', reasons: ['idle, nothing pending'] },
      { room: 'b', decision: 'couch', reasons: ['1 commit not pushed'] },
      { room: 'c', decision: 'error', reasons: ['outside maître folders'] },
      { room: 'd', decision: 'skip', reasons: ['not idle'] },
    ],
    [
      { room: 'b', decision: 'couch', reasons: ['1 commit not pushed'] },
      { room: 'c', decision: 'error', reasons: ['outside maître folders'] },
    ],
    [{ room: 'b', decision: 'couch', reasons: ['an open PR'] }],
  ];
  const opened = [['q']];
  const f = fakes({ janitor: async () => rounds.shift() ?? [], doorman: async () => opened.shift() ?? [] });
  ticks = startTicks(process.env, { ...f.deps, intervalMs: MIN });
  await ticks.idle();
  mock.timers.tick(MIN);
  await ticks.idle();
  mock.timers.tick(MIN);
  await ticks.idle();
  assert.deepEqual(f.out, [
    'maitre: janitor: closed a; couched b (1 commit not pushed); error c (outside maître folders)',
    'maitre: doorman: opened q from the queue',
    'maitre: janitor: couched b (an open PR)',
  ]);
});

test('each tick first retries a release that found the takeover lock busy', async () => {
  mkdirSync(roomDir('a'), { recursive: true });
  const held = takeClosing('a');
  assert.notEqual(held, 'busy');
  const lock = `${closingFile('a')}.takeover`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other' }));
  releaseClosing('a', (held as { token: string }).token);
  assert.equal(isClosing('a'), true);
  unlinkSync(lock);
  const f = fakes();
  ticks = startTicks(process.env, { ...f.deps, intervalMs: MIN });
  await ticks.idle();
  assert.equal(existsSync(closingFile('a')), false);
  assert.equal(isClosing('a'), false);
});

const route = (name: string): Route => ({ project: null, room: { kind: 'new', name }, taskType: 'simple', model: 'haiku', hasCode: false, confidence: 0.9 });

// Capacity 1, an idle clean scratch room `a` and the request of room `c` waiting on the sidewalk.
async function idleAndQueued(): Promise<void> {
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ roots: [], projects: {}, capacity: 1 }));
  await openRoom({ name: 'a', model: 'sonnet', taskType: 'change', brief: 'work on a' }, process.env, FAST);
  const events = join(roomDir('a'), 'events.jsonl');
  const old = Date.now() - 5 * HOURS;
  writeFileSync(events, JSON.stringify({ v: 1, ts: old, room: 'a', session: 's1', event: 'Stop' }) + '\n', { flag: 'a' });
  writeFileSync(events, readFileSync(events, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.stringify({ ...JSON.parse(l), ts: old })).join('\n') + '\n');
  mkdirSync(join(sb.home, 'reception', 'requests'), { recursive: true });
  writeFileSync(join(sb.home, 'reception', 'requests', '1.md'), 'the queued request\n');
  assert.deepEqual(await admit(route('c'), ['1']), { kind: 'queued', position: 1 });
}

test('a ticking lounge closes an idle clean room and opens the queued one', async () => {
  await idleAndQueued();
  const rooms = new LiveRooms(process.env);
  assert.deepEqual(rooms.snapshot().map((r) => [r.room, r.state, r.queuePosition]), [['c', 'queue', 1]]);
  const seen: string[] = [];
  rooms.on((r) => seen.push(`${r.room}:${r.state}`));
  const out: string[] = [];
  ticks = startTicks(process.env, { log: (l) => out.push(l), warn: (l) => out.push(l), after: () => rooms.refresh() });
  await ticks.idle();

  assert.equal(readRoom('a')?.closedBy, 'janitor');
  assert.equal(readRoom('c')?.closedBy, undefined);
  assert.equal(typeof readRoom('c')?.fromQueue, 'number', 'opened by the doorman from its entry');
  assert.deepEqual(readQueue(), []);
  assert.deepEqual(out, ['maitre: janitor: closed a', 'maitre: doorman: opened c from the queue']);
  assert.equal(seen.length, 0, 'c stays on the sidewalk until its own events reach the lounge');
  const lines = readFileSync(join(roomDir('c'), 'events.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
  assert.ok(lines.length > 0, 'the open wrote an event before the doorman returned');
  for (const l of lines) rooms.apply(JSON.parse(l));
  assert.notEqual(rooms.snapshot().find((r) => r.room === 'c')?.state, 'queue');
  assert.equal(seen.includes('c:exit'), false, 'never walked out');
});

test('maitre serve runs the ticks: the idle room is closed and leaves the lounge, the queued one opens; SIGTERM exits 0', async () => {
  await idleAndQueued();
  const child = spawn(process.execPath, [MAITRE, 'serve', '--port', '0'], { env: sb.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => (out += c));
  child.stderr.on('data', (c: string) => (out += c));
  const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
  try {
    const end = Date.now() + 60_000;
    while (!/opened c from the queue/.test(out)) {
      if (Date.now() > end || child.exitCode !== null) throw new Error(`no tick: ${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(out, /^maitre: janitor: closed a$/m);
    assert.match(out, /^maitre: doorman: opened c from the queue$/m);
    const info = JSON.parse(readFileSync(loungeFile(sb.env), 'utf8')) as { port: number; token: string };
    const res = await fetch(`http://127.0.0.1:${info.port}/api/state`, { headers: { 'x-maitre-token': info.token } });
    const names = ((await res.json()) as { rooms: { room: string }[] }).rooms.map((r) => r.room);
    assert.equal(names.includes('a'), false, 'the closed room left the lounge');
    assert.ok(names.includes('c'));
  } finally {
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  }
});
