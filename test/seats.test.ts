import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closingFile, isClosing, releaseClosing, takeClosing } from '../src/closing.js';
import { roomDir } from '../src/paths.js';
import { writePr, type PrState } from '../src/pr-state.js';
import { writeIndex, type Project } from '../src/projects.js';
import { openRoom } from '../src/room-open.js';
import { readRoom, writeRoom, type RoomRecord } from '../src/rooms.js';
import { park, parkRoom } from '../src/seats.js';
import { herdrSandbox, type HerdrSandbox } from './herdr-sandbox.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../../test/fixtures/fake-claude-router.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('../../test/fixtures/fake-gh.mjs', import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const FAST = { trustTimeoutMs: 120_000, pollMs: 10 };
const HOURS = 3_600_000;

let sb: HerdrSandbox;

beforeEach(() => {
  sb = herdrSandbox();
  for (const [name, script] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(sb.bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(sb.bin, name), 0o755);
  }
  const userHome = join(sb.dir, 'user');
  mkdirSync(userHome);
  Object.assign(process.env, { HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config'), GIT_CONFIG_NOSYSTEM: '1', FAKE_GH_LOG: join(sb.dir, 'gh.log') });
});

afterEach(() => sb.restore());

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function project(): Project {
  const remote = join(sb.dir, 'remote.git');
  const clone = join(sb.dir, 'clone');
  git(sb.dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(sb.dir, 'clone', '-q', remote, clone);
  writeFileSync(join(clone, 'README'), 'x');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'init');
  git(clone, 'push', '-q', 'origin', 'main');
  const p: Project = { name: 'proj', path: clone, base: 'main', branchPrefix: 'maitre/' };
  writeIndex([p]);
  return p;
}

function open(name: string, proj?: string): Promise<RoomRecord> {
  return openRoom({ name, ...(proj !== undefined ? { project: proj } : {}), model: 'sonnet', taskType: 'change', brief: 'do it' }, process.env, FAST);
}

const eventsFile = (room: string) => join(roomDir(room), 'events.jsonl');

function age(room: string, ms: number): void {
  const lines = readFileSync(eventsFile(room), 'utf8').split('\n').filter((l) => l !== '');
  const ts = Date.now() - ms;
  writeFileSync(eventsFile(room), lines.map((l) => JSON.stringify({ ...JSON.parse(l), ts })).join('\n') + '\n');
}

function couched(room: string): void {
  writeRoom({ ...readRoom(room)!, couch: { since: Date.now() - 1000, reasons: ['1 commit(s) not pushed'] } });
}

function openPr(rec: RoomRecord, extra: Partial<PrState> = {}): void {
  writePr(rec.room, { url: 'https://github.com/o/r/pull/7', number: 7, state: 'OPEN', headRefName: rec.branch ?? '', seenAt: Date.now(), failing: [], ...extra });
}

function typeInto(room: string, typed: string): void {
  const st = sb.state();
  const rule = '─'.repeat(40);
  st.panes[readRoom(room)!.herdr!.paneId]!.screen = `${rule}\n❯ ${typed}\n${rule}\n`;
  sb.setState(st);
}

function setAgent(room: string, agent: string): void {
  const st = sb.state();
  st.panes[readRoom(room)!.herdr!.paneId]!.agent = agent;
  sb.setState(st);
}

const exitSent = () => sb.calls().some((c) => c[0] === 'agent' && c[1] === 'prompt' && c[3] === '/exit');
const tabs = () => Object.keys(sb.state().workspaces).length;
const minutesDir = () => join(sb.home, 'memory', 'minutes');

test('a quiet room on the couch parks: the seat (with its session) is written before Claude stops, under the marker', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  age('a', HOURS);
  couched('a');
  let during: { seat: RoomRecord['seat']; tabs: number; closing: boolean; exited: boolean } | undefined;
  const before = Date.now();

  const r = await park(rec, process.env, {
    beforeStop: () => {
      during = { seat: readRoom('a')!.seat, tabs: tabs(), closing: isClosing('a'), exited: exitSent() };
    },
  });

  assert.deepEqual(r, { result: 'parked', reason: 'parked' });
  assert.equal(during?.seat?.session, 's1', 'the session id of the room, from its hook events');
  assert.ok(during!.seat!.releasedAt >= before);
  assert.equal(during!.tabs, 1, 'the seat is recorded while the tab is still open');
  assert.equal(during!.closing, true, 'parking holds the closing marker');
  assert.equal(during!.exited, false);
  assert.equal(exitSent(), true, 'Claude was told to /exit on an empty input');
  assert.equal(tabs(), 0);
  const after = readRoom('a')!;
  assert.deepEqual(after.seat, during!.seat);
  assert.equal(after.closedBy, undefined);
  assert.ok(existsSync(rec.dir), 'the worktree stays');
  assert.notEqual(git(p.path, 'branch', '--list', 'maitre/a'), '', 'the branch stays');
  assert.equal(existsSync(closingFile('a')), false, 'the marker is released');
  assert.equal(existsSync(minutesDir()), false, 'parking writes no minutes');
});

test('a quiet room with an open PR parks, and its pr.json is left as it was', async () => {
  project();
  const rec = await open('a', 'proj');
  age('a', HOURS);
  openPr(rec);
  const pr = readFileSync(join(roomDir('a'), 'pr.json'), 'utf8');
  assert.equal(await parkRoom(rec), 'parked');
  assert.equal(readRoom('a')!.seat?.session, 's1');
  assert.equal(readFileSync(join(roomDir('a'), 'pr.json'), 'utf8'), pr);
});

test('a quiet room neither on the couch nor with an open PR does not park', async () => {
  project();
  const rec = await open('a', 'proj');
  age('a', HOURS);
  assert.deepEqual(await park(rec), { result: 'skip', reason: 'neither on the couch nor with an open PR' });
  openPr(rec, { state: 'MERGED' });
  assert.equal(await parkRoom(rec), 'skip', 'a merged PR is no reason to park');
  openPr(rec, { headRefName: 'other' });
  assert.equal(await parkRoom(rec), 'skip', "another branch's PR is not the room's");
  assert.equal(readRoom('a')!.seat, undefined);
  assert.equal(tabs(), 1);
  assert.equal(exitSent(), false);
});

test('a room not quiet for the release time, or working, never parks', async () => {
  const rec = await open('a');
  couched('a');
  assert.deepEqual(await park(rec), { result: 'skip', reason: 'not quiet' }, 'its last event is recent');
  age('a', HOURS);
  couched('a');
  setAgent('a', 'working');
  assert.deepEqual(await park(rec), { result: 'skip', reason: 'not quiet' });
  setAgent('a', 'idle');
  assert.deepEqual(await park(rec, process.env, { releaseMs: 2 * HOURS }), { result: 'skip', reason: 'not quiet' });
  assert.equal(readRoom('a')!.seat, undefined);
  assert.equal(exitSent(), false);
});

test('a draft in the input: skip, no seat, never /exit; the next try parks once it is cleared', async () => {
  const rec = await open('a');
  age('a', HOURS);
  couched('a');
  typeInto('a', 'half a thought');
  assert.deepEqual(await park(rec), { result: 'skip', reason: 'unsent text in its input' });
  assert.equal(readRoom('a')!.seat, undefined);
  assert.equal(exitSent(), false);
  assert.equal(tabs(), 1);
  typeInto('a', '');
  assert.equal(await parkRoom(rec), 'parked');
});

test('text typed after the seat is written: the seat is taken back, Claude keeps running', async () => {
  const rec = await open('a');
  age('a', HOURS);
  couched('a');
  const r = await park(rec, process.env, { beforeStop: () => typeInto('a', 'wait') });
  assert.deepEqual(r, { result: 'skip', reason: 'unsent text in its input' });
  assert.equal(readRoom('a')!.seat, undefined, 'the record never claims a seat while Claude runs');
  assert.equal(exitSent(), false);
  assert.equal(tabs(), 1);
  assert.equal(existsSync(closingFile('a')), false);
});

test('an event after the seat is written: the seat is taken back', async () => {
  const rec = await open('a');
  age('a', HOURS);
  couched('a');
  const r = await park(rec, process.env, {
    beforeStop: () => writeFileSync(eventsFile('a'), JSON.stringify({ v: 1, ts: Date.now(), room: 'a', session: 's1', event: 'UserPromptSubmit', prompt: 'more' }) + '\n', { flag: 'a' }),
  });
  assert.deepEqual(r, { result: 'skip', reason: 'room became active' });
  assert.equal(readRoom('a')!.seat, undefined);
  assert.equal(tabs(), 1);
});

test('another closer holding the marker: skip, nothing touched', async () => {
  const rec = await open('a');
  age('a', HOURS);
  couched('a');
  const held = takeClosing('a');
  assert.notEqual(held, 'busy');
  try {
    assert.deepEqual(await park(rec), { result: 'skip', reason: 'being closed' });
  } finally {
    releaseClosing('a', (held as { token: string }).token);
  }
  assert.equal(readRoom('a')!.seat, undefined);
  assert.equal(tabs(), 1);
});

test('no session id in the room events: skip', async () => {
  const rec = await open('a');
  writeFileSync(eventsFile('a'), JSON.stringify({ v: 1, ts: Date.now() - HOURS, room: 'a', session: '', event: 'Stop' }) + '\n');
  couched('a');
  assert.deepEqual(await park(rec), { result: 'skip', reason: 'no session id' });
  assert.equal(readRoom('a')!.seat, undefined);
  assert.equal(tabs(), 1);
});

test('a seat left on a room whose Claude still runs (a park that died half-way) is written again and the room parks', async () => {
  await open('a');
  age('a', HOURS);
  couched('a');
  writeRoom({ ...readRoom('a')!, seat: { releasedAt: 1, session: 'old' } });
  assert.equal(await parkRoom(readRoom('a')!), 'parked');
  assert.equal(readRoom('a')!.seat?.session, 's1');
  assert.ok(readRoom('a')!.seat!.releasedAt > 1);
  assert.equal(tabs(), 0);
});

test('an already parked or closed room, or one reopened since, is not parked again', async () => {
  const rec = await open('a');
  age('a', HOURS);
  couched('a');
  assert.equal(await parkRoom(rec), 'parked');
  assert.deepEqual(await park(readRoom('a')!), { result: 'skip', reason: 'already parked' });
  assert.deepEqual(await park({ ...rec, createdAt: rec.createdAt - 1 }), { result: 'skip', reason: 'the room changed' });
  assert.deepEqual(readdirSync(roomDir('a')).filter((f) => f.startsWith('closing')), []);
});
