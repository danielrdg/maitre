import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStart } from '../src/closing.js';
import { RETRY_MS, activeCount, admit, appendToQueued, doormanTick, openQueued, queuedRooms, readFailed, readQueue, type QueueEntry } from '../src/doorman.js';
import { closeRoom, janitorLog } from '../src/janitor.js';
import { roomDir } from '../src/paths.js';
import { writePr } from '../src/pr-state.js';
import { writeIndex } from '../src/projects.js';
import { failedFile, openingFile, queueFile, queueLock, writeQueue } from '../src/queue.js';
import { listRoomRows, openRoom } from '../src/room-open.js';
import { readRoom, writeRoom, type RoomRecord } from '../src/rooms.js';
import type { Route } from '../src/router.js';
import { herdrSandbox, type HerdrSandbox } from './herdr-sandbox.js';

const MAITRE = fileURLToPath(new URL('../../bin/maitre', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../../test/fixtures/fake-claude-router.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('../../test/fixtures/fake-gh.mjs', import.meta.url));
const FAST = { trustTimeoutMs: 120_000, pollMs: 10 };

let sb: HerdrSandbox;
let children: ChildProcess[] = [];

beforeEach(() => {
  sb = herdrSandbox();
  for (const [name, script] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(sb.bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(sb.bin, name), 0o755);
  }
  const userHome = join(sb.dir, 'user');
  mkdirSync(userHome);
  const fakes = { HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config'), FAKE_CLAUDE_LOG: join(sb.dir, 'claude.log'), FAKE_GH_LOG: join(sb.dir, 'gh.log') };
  Object.assign(process.env, fakes);
  Object.assign(sb.env, fakes);
});

afterEach(() => {
  for (const c of children) c.kill('SIGKILL');
  children = [];
  sb.restore();
});

function capacity(n: number): void {
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ roots: [], projects: {}, capacity: n }));
}

function open(name: string): Promise<RoomRecord> {
  return openRoom({ name, model: 'sonnet', taskType: 'change', brief: `work on ${name}` }, process.env, FAST);
}

const route = (name: string, project: string | null = null): Route => ({
  project,
  room: { kind: 'new', name },
  taskType: 'simple',
  model: 'haiku',
  hasCode: false,
  confidence: 0.9,
});

function request(id: number, text: string): void {
  const dir = join(sb.home, 'reception', 'requests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), text);
}

const entry = (room: string, ids: string[], at: number): QueueEntry => ({ room, requestIds: ids, route: route(room), queuedAt: at, attempts: 0 });
const opening = () => (existsSync(openingFile()) ? (JSON.parse(readFileSync(openingFile(), 'utf8')) as { room: string; pid: number }[]) : []);
const herdrCreates = () => sb.calls().filter((c) => c[0] === 'workspace' && c[1] === 'create').length;

function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(c);
  return c;
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return r.pid!;
}

test('past capacity, a new room waits in the queue: the first at position 1, the next at 2', async () => {
  capacity(2);
  await open('a');
  await open('b');
  assert.equal(await activeCount(), 2);
  assert.deepEqual(await admit(route('c'), ['1']), { kind: 'queued', position: 1 });
  assert.deepEqual(await admit(route('d', 'web'), ['2']), { kind: 'queued', position: 2 });
  const q = readQueue();
  assert.deepEqual(
    q.map((e) => [e.room, e.requestIds, e.attempts, e.route.room.name]),
    [
      ['c', ['1'], 0, 'c'],
      ['d', ['2'], 0, 'd'],
    ],
  );
  assert.equal(typeof q[0].queuedAt, 'number');
  assert.deepEqual(queuedRooms(), [
    { room: 'c', position: 1 },
    { room: 'd', position: 2, project: 'web' },
  ]);
  assert.equal(statSync(queueFile()).mode & 0o777, 0o600);
  assert.equal(existsSync(queueLock()), false, 'the lock is gone once the change is written');
  assert.equal(herdrCreates(), 2, 'nothing was opened');
});

test('a follow-up to a queued room joins its entry: one entry, both request ids', async () => {
  capacity(1);
  await open('a');
  await admit(route('c'), ['1']);
  assert.equal(appendToQueued('c', ['2']), true);
  assert.equal(appendToQueued('c', ['2']), true, 'an id already there is not added twice');
  assert.equal(appendToQueued('nope', ['3']), false);
  assert.deepEqual(await admit(route('c'), ['1', '4']), { kind: 'queued', position: 1 }, 'the same name queued again joins the entry');
  assert.deepEqual(
    readQueue().map((e) => [e.room, e.requestIds]),
    [['c', ['1', '2', '4']]],
  );
  await assert.rejects(admit(route('c', 'web'), ['5']), /a room named c already waits for a seat in scratch/);
});

test('the tick returns at once when the queue is empty: no herdr call', async () => {
  await open('a');
  const before = sb.calls().length;
  assert.deepEqual((await doormanTick()).opened, []);
  assert.equal(sb.calls().length, before);
});

test('after a room closes, the tick opens the oldest queued room only, with its requests as the brief', async () => {
  capacity(2);
  await open('a');
  await open('b');
  request(1, 'first request\n');
  request(2, 'its follow-up\n');
  request(3, 'another room\n');
  await admit(route('c'), ['1']);
  await admit(route('d'), ['3']);
  appendToQueued('c', ['2']);
  assert.deepEqual((await doormanTick()).opened, [], 'no seat yet');
  assert.equal(herdrCreates(), 2);

  await closeRoom('a', process.env, { exitTimeoutMs: 200 });
  assert.deepEqual((await doormanTick()).opened, ['c']);
  assert.equal(readRoom('c')?.kind, 'scratch');
  assert.equal(readRoom('c')?.model, 'haiku');
  assert.match(readFileSync(join(roomDir('c'), 'brief.md'), 'utf8'), /first request\n---\nits follow-up\n$/);
  assert.deepEqual(queuedRooms(), [{ room: 'd', position: 1 }]);
  assert.deepEqual(opening(), [], 'the reservation is dropped once the room is open');
  assert.deepEqual((await doormanTick()).opened, [], 'full again');
});

test('two admits racing for the last seat: one opens, one waits; the reservation counts as active', async () => {
  capacity(2);
  await open('a');
  const [x, y] = await Promise.all([admit(route('c'), ['1']), admit(route('d'), ['2'])]);
  assert.deepEqual([x.kind, y.kind].sort(), ['open', 'queued']);
  const seat = (x.kind === 'open' ? x : y) as { kind: 'open'; release: () => void };
  assert.deepEqual(
    opening().map((r) => [r.room, r.pid]),
    [[x.kind === 'open' ? 'c' : 'd', process.pid]],
  );
  assert.equal(await activeCount(), 2);
  seat.release();
  assert.deepEqual(opening(), []);
  assert.equal(await activeCount(), 1);
});

test('another live process reservation counts; one whose pid died, or was reused, is dropped', async () => {
  capacity(2);
  await open('a');
  const child = sleeper();
  await new Promise((r) => setTimeout(r, 50));
  const now = Date.now();
  writeFileSync(openingFile(), JSON.stringify([{ room: 'x', pid: child.pid, since: now, start: processStart(child.pid!) }]));
  assert.equal(await activeCount(), 2);
  assert.deepEqual(await admit(route('c'), ['1']), { kind: 'queued', position: 1 });
  writeQueue([]);

  writeFileSync(
    openingFile(),
    JSON.stringify([
      { room: 'x', pid: deadPid(), since: now },
      { room: 'y', pid: child.pid, since: now, start: 'another start' },
    ]),
  );
  assert.equal(await activeCount(), 1);
  const seat = await admit(route('d'), ['2']);
  assert.equal(seat.kind, 'open');
  assert.deepEqual(
    opening().map((r) => r.room),
    ['d'],
  );
});

test('the queue lock is never held while herdr is asked or a room opens', async () => {
  process.env.FAKE_HERDR_FAIL_WHILE = queueLock();
  capacity(1);
  await open('a');
  request(1, 'c please\n');
  request(2, 'd please\n');
  await admit(route('c'), ['1']);
  await admit(route('d'), ['2']);
  await closeRoom('a', process.env, { exitTimeoutMs: 200 });
  const seen: boolean[] = [];
  assert.deepEqual(
    await doormanTick(process.env, {
      open: async (e, env) => {
        seen.push(existsSync(queueLock()));
        return openQueued(e, env);
      },
    }),
    { opened: ['c'], gaveUp: [] },
  );
  assert.deepEqual(seen, [false]);
  assert.equal(readQueue()[0].lastError, undefined);
});

test('room close on a queued room only removes it from the queue; on a failed one, from the failed list', async () => {
  capacity(1);
  await open('a');
  await admit(route('c'), ['1']);
  await admit(route('d'), ['2']);
  const before = sb.calls().length;
  assert.deepEqual(await closeRoom('c'), { room: 'c', dequeued: 'queue' });
  assert.deepEqual(queuedRooms(), [{ room: 'd', position: 1 }]);
  assert.equal(sb.calls().length, before, 'nothing in herdr');
  assert.equal(existsSync(join(sb.home, 'memory')), false, 'no minutes');

  const r = spawnSync(process.execPath, [MAITRE, 'room', 'close', 'd'], { env: sb.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'removed d from the queue\n');
  assert.deepEqual(readQueue(), []);

  writeFileSync(failedFile(), JSON.stringify([{ ...entry('e', ['3'], 1), attempts: 3, lastError: 'boom', failedAt: 2 }]));
  assert.deepEqual(await closeRoom('e'), { room: 'e', dequeued: 'failed' });
  assert.deepEqual(readFailed(), []);
});

test('a queued room that is being opened can neither be closed nor take a follow-up', async () => {
  capacity(1);
  await open('a');
  await admit(route('c'), ['1']);
  const child = sleeper();
  await new Promise((r) => setTimeout(r, 50));
  writeFileSync(openingFile(), JSON.stringify([{ room: 'c', pid: child.pid, since: Date.now() }]));
  await assert.rejects(closeRoom('c'), /^Error: c is opening; close it once it is open$/);
  assert.throws(() => appendToQueued('c', ['2']), /^Error: c is opening; send it again once it is open$/);
  await assert.rejects(admit(route('c'), ['2']), /^Error: c is opening$/);
  assert.deepEqual(
    readQueue().map((e) => e.requestIds),
    [['1']],
  );
});

test('a head that fails 3 times in a row moves to queue-failed.json and the next one opens', async () => {
  capacity(1);
  request(2, 'd please\n');
  writeQueue([entry('c', ['1'], 1), entry('d', ['2'], 2)]);
  let clock = Date.now();
  const deps = {
    now: () => clock,
    open: async (e: QueueEntry, env: NodeJS.ProcessEnv) => {
      if (e.room === 'c') throw new Error('boom\nsecond line');
      return openQueued(e, env);
    },
  };
  assert.deepEqual((await doormanTick(process.env, deps)).opened, []);
  assert.deepEqual(
    readQueue().map((e) => [e.room, e.attempts, e.lastError]),
    [
      ['c', 1, 'boom'],
      ['d', 0, undefined],
    ],
  );
  const rows = await listRoomRows();
  assert.deepEqual(rows, [
    { room: 'c', model: 'haiku', herdr: 'queued', lounge: 'position 1, last try failed: boom' },
    { room: 'd', model: 'haiku', herdr: 'queued', lounge: 'position 2' },
  ]);
  clock += RETRY_MS;
  assert.deepEqual((await doormanTick(process.env, deps)).opened, []);
  clock += RETRY_MS;
  assert.deepEqual(await doormanTick(process.env, deps), {
    opened: ['d'],
    gaveUp: [{ room: 'c', requestIds: ['1'], reason: 'left the queue after 3 failed opens: boom' }],
  });
  assert.deepEqual(readQueue(), []);
  const failed = readFailed();
  assert.deepEqual(
    failed.map((e) => [e.room, e.attempts, e.lastError, e.requestIds]),
    [['c', 3, 'boom', ['1']]],
  );
  assert.equal(typeof failed[0].failedAt, 'number');
  assert.deepEqual(opening(), []);
  assert.deepEqual((await listRoomRows()).slice(1), [{ room: 'c', model: 'haiku', herdr: 'failed', lounge: 'gave up: boom (requests 1)' }]);
  const logged = readFileSync(janitorLog(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    logged.map(({ room, decision, reasons }) => ({ room, decision, reasons })),
    [{ room: 'c', decision: 'error', reasons: ['left the queue after 3 failed opens: boom'] }],
  );
});

test('a head whose open failed is tried again a minute later at the earliest, holding the queue meanwhile', async () => {
  capacity(2);
  writeQueue([entry('c', ['1'], 1), entry('d', ['2'], 2)]);
  let clock = Date.now();
  const tried: string[] = [];
  const deps = {
    now: () => clock,
    open: async (e: QueueEntry) => {
      tried.push(e.room);
      throw new Error('herdr is down');
    },
  };
  await doormanTick(process.env, deps);
  assert.deepEqual(readQueue().map((e) => [e.room, e.attempts, e.lastAttemptAt]), [['c', 1, clock], ['d', 0, undefined]]);
  clock += RETRY_MS - 1;
  await doormanTick(process.env, deps);
  await doormanTick(process.env, deps);
  assert.deepEqual(tried, ['c'], 'within the minute: no attempt, and d waits behind c');
  clock += 1;
  await doormanTick(process.env, deps);
  assert.deepEqual(tried, ['c', 'c']);
  assert.equal(readQueue()[0]!.attempts, 2);

  writeQueue([{ ...readQueue()[0]!, lastAttemptAt: clock + 3_600_000 }]);
  await doormanTick(process.env, deps);
  assert.deepEqual(tried, ['c', 'c', 'c'], 'a stamp from the future (a clock set back) holds nothing');
});

test('admit waits while another process holds the queue lock, and breaks a lock older than 30 s', async () => {
  capacity(1);
  mkdirSync(join(sb.home, 'state'), { recursive: true });
  writeFileSync(queueLock(), JSON.stringify({ pid: 1, token: 'other' }));
  let settled = false;
  const pending = admit(route('c'), ['1']).then((r) => ((settled = true), r));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(settled, false, 'still waiting for the lock');
  assert.equal(existsSync(queueFile()), false);
  assert.equal(existsSync(openingFile()), false);
  unlinkSync(queueLock());
  assert.equal((await pending).kind, 'open');

  writeFileSync(queueLock(), JSON.stringify({ pid: 1, token: 'dead' }));
  const old = new Date(Date.now() - 31_000);
  utimesSync(queueLock(), old, old);
  assert.deepEqual(await admit(route('d'), ['2']), { kind: 'queued', position: 1 });
  assert.equal(existsSync(queueLock()), false);
});

test('a room opened between the probe and the lock takes the seat', async () => {
  capacity(1);
  const r = await admit(route('c'), ['1'], process.env, { afterProbe: async () => void (await open('a')) });
  assert.deepEqual(r, { kind: 'queued', position: 1 });
  assert.deepEqual(opening(), []);
});

test('couched rooms, rooms with a PR, closed and dead rooms do not count', async () => {
  capacity(2);
  const a = await open('a');
  await open('b');
  await open('c');
  await open('d');
  writeRoom({ ...a, couch: { since: Date.now(), reasons: ['uncommitted changes'] } });
  const pr = { v: 1, ts: Date.now(), room: 'b', session: 's1', event: 'PostToolUse', tool: 'Bash', response: { stdout: 'https://github.com/o/r/pull/1\n' } };
  writeFileSync(join(roomDir('b'), 'events.jsonl'), JSON.stringify(pr) + '\n', { flag: 'a' });
  const s = sb.state();
  delete s.workspaces[readRoom('d')!.herdr!.workspaceId];
  sb.setState(s);
  assert.equal(await activeCount(), 1);
  const seat = await admit(route('e'), ['1']);
  assert.equal(seat.kind, 'open');
});

test('maitre room open refuses a name that is being opened, and leaves no reservation behind', async () => {
  mkdirSync(join(sb.home, 'state'), { recursive: true });
  const child = sleeper();
  await new Promise((r) => setTimeout(r, 50));
  writeFileSync(openingFile(), JSON.stringify([{ room: 'x', pid: child.pid, since: Date.now() }]));
  const args = ['room', 'open', 'x', '--model', 'sonnet', '--task', 'change', '--brief', 'hi'];
  const r = spawnSync(process.execPath, [MAITRE, ...args], { env: sb.env, encoding: 'utf8' });
  assert.equal(r.stderr, 'maitre: x is opening\n');
  assert.equal(herdrCreates(), 0);
  writeFileSync(openingFile(), '[]');
  const ok = spawnSync(process.execPath, [MAITRE, ...args], { env: { ...sb.env, MAITRE_TRUST_TIMEOUT_MS: '120000' }, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(herdrCreates(), 1);
  assert.deepEqual(opening(), []);
});

test('a corrupt queue is an error, never read as empty', async () => {
  capacity(1);
  await open('a');
  writeFileSync(queueFile(), '{"not": "a list"}');
  await assert.rejects(admit(route('c'), ['1']), /not a list of queued rooms/);
  await assert.rejects(doormanTick(), /not a list of queued rooms/);
  assert.equal(readFileSync(queueFile(), 'utf8'), '{"not": "a list"}');
  assert.equal(appendToQueued('a', ['2']), false);
  const closed = await closeRoom('a', process.env, { exitTimeoutMs: 200 });
  assert.ok(!('dequeued' in closed) && closed.closedBy === 'user', 'closing an open room does not depend on the queue');
  assert.equal(readFileSync(queueFile(), 'utf8'), '{"not": "a list"}');
});

test('FIFO is strict: with a room queued, a newcomer waits behind it even when a seat is free', async () => {
  capacity(1);
  await open('a');
  request(1, 'c please\n');
  request(2, 'd please\n');
  assert.deepEqual(await admit(route('c'), ['1']), { kind: 'queued', position: 1 });
  await closeRoom('a', process.env, { exitTimeoutMs: 200 });
  assert.deepEqual(await admit(route('d'), ['2']), { kind: 'queued', position: 2 }, 'the free seat belongs to the head');
  assert.deepEqual(opening(), []);
  assert.deepEqual((await doormanTick()).opened, ['c']);
  assert.deepEqual(queuedRooms(), [{ room: 'd', position: 1 }]);
});

test('a head the doorman already opened from this entry (stamped fromQueue) leaves the queue without another open', async () => {
  capacity(2);
  request(1, 'c please\n');
  request(2, 'd please\n');
  const c = entry('c', ['1'], Date.now() - 1000);
  writeQueue([c, entry('d', ['2'], Date.now() - 500)]);
  await openRoom({ name: 'c', model: 'haiku', taskType: 'simple', brief: 'c please\n', fromQueue: c.queuedAt }, process.env, FAST);
  assert.equal(readRoom('c')?.fromQueue, c.queuedAt);
  const before = herdrCreates();
  let calls = 0;
  const opened = await doormanTick(process.env, {
    open: async (e, env) => {
      calls++;
      return openQueued(e, env);
    },
  });
  assert.deepEqual(opened, { opened: ['d'], gaveUp: [] });
  assert.equal(calls, 1, 'only d was opened');
  assert.equal(herdrCreates(), before + 1);
  assert.equal(typeof readRoom('d')?.fromQueue, 'number', 'the doorman stamps what it opens');
  assert.deepEqual(readQueue(), []);
  assert.deepEqual(readFailed(), []);
});

test('a head whose name was opened outside the queue moves to queue-failed.json, logged, never dropped', async () => {
  capacity(2);
  request(2, 'd please\n');
  await open('c');
  writeQueue([entry('c', ['1'], Date.now() - 1000), entry('d', ['2'], Date.now() - 500)]);
  assert.deepEqual(await doormanTick(), { opened: ['d'], gaveUp: [{ room: 'c', requestIds: ['1'], reason: 'left the queue: opened outside the queue' }] });
  assert.deepEqual(readQueue(), []);
  assert.deepEqual(
    readFailed().map((e) => [e.room, e.requestIds, e.lastError]),
    [['c', ['1'], 'opened outside the queue']],
  );
  const logged = readFileSync(janitorLog(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    logged.map(({ room, decision, reasons }) => ({ room, decision, reasons })),
    [{ room: 'c', decision: 'error', reasons: ['left the queue: opened outside the queue'] }],
  );
  assert.deepEqual(
    (await listRoomRows()).filter((r) => r.herdr === 'failed'),
    [{ room: 'c', model: 'haiku', herdr: 'failed', lounge: 'gave up: opened outside the queue (requests 1)' }],
  );
});

test('a running head that another process still holds a reservation for waits for the next tick', async () => {
  capacity(2);
  const c = entry('c', ['1'], Date.now() - 1000);
  writeQueue([c]);
  await openRoom({ name: 'c', model: 'haiku', taskType: 'simple', brief: 'x', fromQueue: c.queuedAt }, process.env, FAST);
  const child = sleeper();
  await new Promise((r) => setTimeout(r, 50));
  writeFileSync(openingFile(), JSON.stringify([{ room: 'c', pid: child.pid, since: Date.now() }]));
  const before = sb.calls().length;
  assert.deepEqual((await doormanTick(process.env, { open: async () => assert.fail('nothing opens') })).opened, []);
  assert.ok(sb.calls().length - before <= 3, 'one probe, no loop');
  assert.deepEqual(
    readQueue().map((e) => e.room),
    ['c'],
  );
});

test('only the doorman opens a queued name; admit refuses an empty list of requests', async () => {
  capacity(1);
  await open('a');
  await admit(route('c'), ['1']);
  const msg = /^Error: c is queued \(position 1\); it opens when a seat frees, or remove it with: maitre room close c$/;
  await assert.rejects(open('c'), msg);
  const r = spawnSync(process.execPath, [MAITRE, 'room', 'open', 'c', '--model', 'sonnet', '--task', 'change', '--brief', 'hi'], { env: sb.env, encoding: 'utf8' });
  assert.equal(r.stderr, 'maitre: c is queued (position 1); it opens when a seat frees, or remove it with: maitre room close c\n');
  assert.equal(herdrCreates(), 1);
  assert.deepEqual(opening(), []);
  await assert.rejects(admit(route('e'), []), /^Error: nothing to queue for e: no request ids$/);
  assert.deepEqual(
    readQueue().map((e) => e.room),
    ['c'],
  );
});

test('maitre room list degrades on a corrupt queue: one warning line, the rooms still listed', async () => {
  await open('a');
  writeFileSync(queueFile(), 'not json');
  const r = spawnSync(process.execPath, [MAITRE, 'room', 'list'], { env: sb.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^a +scratch +sonnet +idle +/);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.match(r.stderr, /^maitre: warning: cannot read .+queue\.json: .+\n$/);
  assert.equal(r.stderr.split('\n').length, 2, 'one warning line');
});

test('a running code room whose pr.json says OPEN frees its seat; once MERGED it holds one again', async () => {
  capacity(1);
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    assert.equal(r.status, 0, r.stderr);
  };
  const remote = join(sb.dir, 'remote.git');
  const clone = join(sb.dir, 'clone');
  git(sb.dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(sb.dir, 'clone', '-q', remote, clone);
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(clone, 'push', '-q', 'origin', 'main');
  writeIndex([{ name: 'proj', path: clone, base: 'main', branchPrefix: 'maitre/' }]);
  const a = await openRoom({ name: 'a', project: 'proj', model: 'sonnet', taskType: 'change', brief: 'work on a' }, process.env, FAST);
  assert.equal(await activeCount(), 1);
  const pr = { url: 'https://github.com/o/r/pull/7', number: 7, headRefName: a.branch!, seenAt: Date.now(), failing: [] };
  writePr('a', { ...pr, state: 'OPEN' });
  assert.equal(await activeCount(), 0, 'at the bar: an open PR does not count, whatever the events say');
  const seat = await admit(route('b'), ['1']);
  assert.equal(seat.kind, 'open');
  if (seat.kind === 'open') seat.release();
  writePr('a', { ...pr, state: 'MERGED' });
  assert.equal(await activeCount(), 1);
});

test('a queued room that continues a closed one opens with the minutes, and a near-limit request does not break the open', async () => {
  const dir = join(sb.home, 'memory', 'minutes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-11-01-old.md'), `---\nroom: "old"\nclosed: 2026-11-01T10:00:00.000Z\n---\n\n## What was asked\n\nthe old one\n\n${'x'.repeat(9000)}\n`);
  request(1, 'r'.repeat(95_000));
  const e = { ...entry('again', ['1'], 1), route: { ...route('again'), continues: 'old' } };
  await openQueued(e, process.env);
  const brief = readFileSync(join(roomDir('again'), 'brief.md'), 'utf8');
  assert.ok(Buffer.byteLength(brief) <= 100_000 + 100);
  assert.match(brief, /# Minutes of old \(closed 2026-11-01\)/);
});
