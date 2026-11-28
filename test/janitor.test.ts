import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closingFile, isClosing, processStart, releaseClosing, takeClosing } from '../src/closing.js';
import { closeRoom, closeWithMinutes, forTests, janitorLog, janitorTick } from '../src/janitor.js';
import { writeMinutes } from '../src/minutes.js';
import { roomDir } from '../src/paths.js';
import { writePr, type PrState } from '../src/pr-state.js';
import { writeIndex, type Project } from '../src/projects.js';
import { checkInput, closeRoomTab, openRoom, sendToRoom } from '../src/room-open.js';
import { readRoom, writeRoom, type RoomRecord } from '../src/rooms.js';
import { openingFile } from '../src/queue.js';
import { herdrSandbox, type HerdrSandbox } from './herdr-sandbox.js';

const MAITRE = fileURLToPath(new URL('../../bin/maitre', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../../test/fixtures/fake-claude-router.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('../../test/fixtures/fake-gh.mjs', import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const FAST = { trustTimeoutMs: 120_000, pollMs: 10 };
const HOURS = 3_600_000;
const SUMMARY = '## What was asked\nfix it\n\n## What was done\nfixed it\n\n## Links\nnone\n\n## Loose ends\nnone';

let sb: HerdrSandbox;
let fakes: NodeJS.ProcessEnv;

// Fake claude and gh in the sandbox's bin (first on PATH), and a temp HOME: no real Haiku, gh or git config.
beforeEach(() => {
  sb = herdrSandbox();
  for (const [name, script] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(sb.bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(sb.bin, name), 0o755);
  }
  const userHome = join(sb.dir, 'user');
  mkdirSync(userHome);
  fakes = {
    HOME: userHome,
    XDG_CONFIG_HOME: join(userHome, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    FAKE_CLAUDE_LOG: join(sb.dir, 'claude.log'),
    FAKE_GH_LOG: join(sb.dir, 'gh.log'),
  };
  Object.assign(process.env, fakes);
  Object.assign(sb.env, fakes);
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
  writeFileSync(join(clone, '.gitignore'), 'node_modules/\n');
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

function event(room: string, ev: string, extra: Record<string, unknown> = {}, ts = Date.now()): void {
  writeFileSync(eventsFile(room), JSON.stringify({ v: 1, ts, room, session: 's1', event: ev, ...extra }) + '\n', { flag: 'a' });
}

// Every hook line of the room moved back in time: the room has been idle that long.
function age(room: string, ms: number): void {
  const lines = readFileSync(eventsFile(room), 'utf8').split('\n').filter((l) => l !== '');
  const ts = Date.now() - ms;
  writeFileSync(eventsFile(room), lines.map((l) => JSON.stringify({ ...JSON.parse(l), ts })).join('\n') + '\n');
}

function transcript(): string {
  const p = join(sb.dir, 'transcript.jsonl');
  writeFileSync(p, [{ type: 'user', message: { content: 'fix it' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'fixed' }] } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

// The tab is gone, as after a herdr restart: the room is dead.
function killTabs(): void {
  sb.setState({ ...sb.state(), workspaces: {}, panes: {} });
}

const minutesDir = () => join(sb.home, 'memory', 'minutes');
const minutesFiles = () => (existsSync(minutesDir()) ? readdirSync(minutesDir()) : []);
const branchExists = (clone: string, b: string) => git(clone, 'branch', '--list', b) !== '';
const logLines = () => (existsSync(janitorLog()) ? readFileSync(janitorLog(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const claudeCalls = () => (existsSync(fakes.FAKE_CLAUDE_LOG!) ? readFileSync(fakes.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').length : 0);

// What the room's tab shows: Claude Code's input box holding `typed` (see the fake herdr's empty box).
function typeInto(room: string, typed: string): void {
  const st = sb.state();
  const rule = '─'.repeat(40);
  st.panes[readRoom(room)!.herdr!.paneId]!.screen = `${rule}\n❯\u00a0${typed}\n${rule}\n`;
  sb.setState(st);
}

const exitSent = () => sb.calls().some((c) => c[0] === 'agent' && c[1] === 'prompt' && c[3] === '/exit');

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(r.pid);
  return r.pid!;
}

test('an idle, clean code room is closed: minutes, tab closed, worktree removed, branch kept, logged', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  mkdirSync(join(rec.dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(rec.dir, 'node_modules', 'dep', 'index.js'), 'x');
  event('a', 'Stop', { transcript: transcript() });
  age('a', 5 * HOURS);
  process.env.FAKE_CLAUDE_STDOUT = JSON.stringify({ type: 'result', is_error: false, result: SUMMARY });

  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'close', reasons: ['idle, nothing pending'] }]);

  const after = readRoom('a')!;
  assert.equal(after.closedBy, 'janitor');
  assert.equal(typeof after.closedAt, 'number');
  assert.equal(after.couch, undefined);
  assert.equal(existsSync(rec.dir), false);
  assert.ok(branchExists(p.path, 'maitre/a'));
  assert.deepEqual(sb.state().workspaces, {});
  const [file] = minutesFiles();
  const text = readFileSync(join(minutesDir(), file!), 'utf8');
  assert.match(text, /closedBy: janitor/);
  assert.ok(text.includes('## What was done\nfixed it'));
  assert.match(text, /Ignored files that went with the worktree:\n\n- `node_modules\/`/);
  assert.equal(existsSync(closingFile('a')), false);
  assert.deepEqual(logLines().map(({ room, decision, reasons }) => ({ room, decision, reasons })), [{ room: 'a', decision: 'close', reasons: ['idle, nothing pending'] }]);
  assert.equal(statSync(janitorLog()).mode & 0o777, 0o600);

  assert.deepEqual(await janitorTick(), [], 'a closed room is not looked at again');
});

test('an idle room with commits not pushed goes to the couch, and nothing is removed', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  writeFileSync(join(rec.dir, 'f.txt'), 'x');
  git(rec.dir, 'add', 'f.txt');
  git(rec.dir, 'commit', '-q', '-m', 'f');
  age('a', 5 * HOURS);
  const before = Date.now();

  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'couch', reasons: ['1 commit(s) not pushed'] }]);
  const couch = readRoom('a')!.couch!;
  assert.deepEqual(couch.reasons, ['1 commit(s) not pushed']);
  assert.ok(couch.since >= before);
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.ok(existsSync(join(rec.dir, 'f.txt')));
  assert.ok(branchExists(p.path, 'maitre/a'));
  assert.equal(Object.keys(sb.state().workspaces).length, 1);
  assert.deepEqual(minutesFiles(), []);

  await janitorTick();
  assert.equal(readRoom('a')!.couch!.since, couch.since, 'a second tick keeps when the room went to the couch');
});

test('a couch whose room got a new event is cleared', async () => {
  await open('a');
  age('a', 5 * HOURS);
  writeRoom({ ...readRoom('a')!, couch: { since: Date.now() - HOURS, reasons: ['uncommitted changes'] } });
  event('a', 'UserPromptSubmit', { prompt: 'more' });
  const [d] = await janitorTick();
  assert.equal(d!.decision, 'skip');
  assert.ok(d!.reasons.includes('couch cleared: the room is active again'));
  assert.equal(readRoom('a')!.couch, undefined);
});

test("Claude Code's Notification after Stop neither clears a couch nor resets the idle clock", async () => {
  await open('a');
  age('a', 5 * HOURS);
  const since = Date.now() - HOURS;
  writeRoom({ ...readRoom('a')!, couch: { since, reasons: ['uncommitted changes'] } });
  event('a', 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  const [d] = await janitorTick();
  assert.equal(d!.decision, 'close', 'still idle: the scratch room has nothing pending and closes');
  assert.ok(!d!.reasons.includes('couch cleared: the room is active again'));
});

test('a dead room with nothing pending, idle long enough, is closed with fallback minutes', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  killTabs();
  age('a', 5 * HOURS);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'close', reasons: ['not running, nothing pending'] }]);
  assert.equal(readRoom('a')!.closedBy, 'janitor');
  assert.equal(existsSync(rec.dir), false);
  assert.ok(branchExists(p.path, 'maitre/a'));
  const text = readFileSync(join(minutesDir(), minutesFiles()[0]!), 'utf8');
  assert.match(text, /no summary/);
  assert.equal(claudeCalls(), 0);
});

test('a dead room with something pending is skipped and left untouched', async () => {
  project();
  const rec = await open('a', 'proj');
  writeFileSync(join(rec.dir, 'wip.txt'), 'work');
  killTabs();
  const [d] = await janitorTick();
  assert.deepEqual(d, { room: 'a', decision: 'skip', reasons: ['uncommitted changes: wip.txt'] });
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.equal(readRoom('a')!.couch, undefined, 'a dead room is never on the couch');
  assert.deepEqual(readRoom('a')!.pending?.reasons, ['uncommitted changes: wip.txt'], 'its reasons are kept for maitre room list');
  assert.equal(readFileSync(join(rec.dir, 'wip.txt'), 'utf8'), 'work');
  assert.deepEqual(minutesFiles(), []);

  const since = readRoom('a')!.pending!.since;
  await janitorTick();
  assert.equal(readRoom('a')!.pending!.since, since, 'a second tick keeps since');
  rmSync(join(rec.dir, 'wip.txt'));
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['not idle yet'] }]);
  assert.equal(readRoom('a')!.pending, undefined, 'dropped once nothing is pending');
});

test("a dead woken room left blocked by maître's starting note closes after the idle time, its worktree removed", async () => {
  const p = project();
  const rec = await open('a', 'proj');
  event('a', 'SessionStart');
  event('a', 'Stop');
  event('a', 'MaitreStatus', { session: '', status: 'blocked', text: 'Room is still starting — check its tab', options: [], starting: true, resumes: 's1' });
  killTabs();
  age('a', 5 * HOURS);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'close', reasons: ['not running, nothing pending'] }]);
  assert.equal(readRoom('a')!.closedBy, 'janitor');
  assert.equal(existsSync(rec.dir), false, 'the check right before the removal does not count the note either');
  assert.ok(branchExists(p.path, 'maitre/a'));
});

test('a dead room whose Claude died asking for a permission keeps waiting on you', async () => {
  project();
  const rec = await open('a', 'proj');
  event('a', 'SessionStart');
  event('a', 'PermissionRequest', { tool: 'Bash', input: { command: 'rm -rf build' } });
  killTabs();
  age('a', 5 * HOURS);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['waiting on you'] }]);
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.ok(existsSync(rec.dir));
});

test('git worktree remove failing: the room still closes, the branch and folder stay, the minutes say so', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  git(p.path, 'worktree', 'lock', rec.dir);
  age('a', 5 * HOURS);
  const [d] = await janitorTick();
  assert.equal(d!.decision, 'close');
  assert.match(d!.reasons.join('\n'), /worktree kept at .*locked/);
  assert.equal(readRoom('a')!.closedBy, 'janitor');
  assert.ok(existsSync(rec.dir));
  assert.ok(branchExists(p.path, 'maitre/a'));
  const text = readFileSync(join(minutesDir(), minutesFiles()[0]!), 'utf8');
  assert.match(text, /## Not done when closing\n\n- worktree kept at /);
});

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path);
      out.push(`${relative(root, path)} ${st.mode} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}

test('maitre janitor --dry-run prints one line per room and changes no file', async () => {
  project();
  const clean = await open('clean', 'proj');
  const busy = await open('busy', 'proj');
  writeFileSync(join(busy.dir, 'wip.txt'), 'x');
  await open('fresh');
  age('clean', 5 * HOURS);
  age('busy', 5 * HOURS);
  writeRoom({ ...readRoom('fresh')!, couch: { since: 1, reasons: ['old'] } });
  const before = tree(sb.home);

  const r = spawnSync(process.execPath, [MAITRE, 'janitor', '--dry-run'], { env: sb.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    ['busy   couch  uncommitted changes: wip.txt', 'clean  close  idle, nothing pending', 'fresh  skip   not idle; couch cleared: the room is active again', ''].join('\n'),
  );
  assert.deepEqual(tree(sb.home), before);
  assert.ok(existsSync(clean.dir));
  assert.equal(readRoom('fresh')!.couch?.since, 1);
});

test('maitre janitor without --dry-run runs one real tick', async () => {
  await open('a');
  killTabs();
  age('a', 5 * HOURS);
  const r = spawnSync(process.execPath, [MAITRE, 'janitor'], { env: sb.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'a  close  not running, nothing pending\n');
  assert.equal(readRoom('a')!.closedBy, 'janitor');
});

test('two concurrent closeWithMinutes: one closes, the other is busy', async () => {
  const rec = await open('a');
  const results = await Promise.all([closeWithMinutes(rec, 'janitor'), closeWithMinutes(rec, 'janitor')]);
  assert.equal(results.filter((r) => r === 'busy').length, 1);
  assert.equal(minutesFiles().length, 1);
  assert.equal(readRoom('a')!.closedBy, 'janitor');
  assert.equal(existsSync(closingFile('a')), false);
});

test('room close by hand writes minutes with the loose ends and keeps the worktree', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  writeFileSync(join(rec.dir, 'f.txt'), 'x');
  git(rec.dir, 'add', 'f.txt');
  git(rec.dir, 'commit', '-q', '-m', 'f');
  const closed = await closeRoom('a', process.env, { exitTimeoutMs: 2000 });
  assert.ok(!('dequeued' in closed));
  assert.equal(closed.closedBy, 'user');
  assert.ok(existsSync(join(rec.dir, 'f.txt')));
  assert.ok(branchExists(p.path, 'maitre/a'));
  assert.deepEqual(sb.state().workspaces, {});
  const text = readFileSync(closed.minutes!, 'utf8');
  assert.match(text, /closedBy: user/);
  assert.match(text, /## Left behind\n\n- 1 commit\(s\) not pushed/);
});

test('a scratch room from before M3a (no transcript) closes with fallback minutes and its files move to the vault', async () => {
  const rec = await open('old');
  writeFileSync(join(rec.dir, 'notes.md'), 'keep me');
  age('old', 5 * HOURS);
  assert.deepEqual(await janitorTick(), [{ room: 'old', decision: 'close', reasons: ['idle, nothing pending'] }]);
  assert.equal(claudeCalls(), 0);
  assert.match(readFileSync(join(minutesDir(), minutesFiles()[0]!), 'utf8'), /no summary/);
  assert.equal(readFileSync(join(sb.home, 'memory', 'rooms', 'old', 'notes.md'), 'utf8'), 'keep me');
  assert.equal(existsSync(rec.dir), false);
});

test('a real M2a dead room (closedAt set, no closedBy) is processed, not skipped', async () => {
  await open('a');
  killTabs();
  age('a', 5 * HOURS);
  writeRoom({ ...readRoom('a')!, closedAt: 1234 });
  const [d] = await janitorTick();
  assert.equal(d!.decision, 'close');
  assert.equal(readRoom('a')!.closedBy, 'janitor');
  assert.equal(readRoom('a')!.closedAt, 1234);
});

test('a room whose dir is outside maître folders is an error and nothing is moved', async () => {
  await open('a');
  const elsewhere = join(sb.dir, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'precious.txt'), 'x');
  writeRoom({ ...readRoom('a')!, dir: elsewhere });
  killTabs();
  const [d] = await janitorTick();
  assert.equal(d!.decision, 'error');
  assert.match(d!.reasons[0]!, /outside maître's folders/);
  assert.ok(existsSync(join(elsewhere, 'precious.txt')));
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.deepEqual(minutesFiles(), []);
});

test('an event arriving while the minutes are written aborts the close: room became active, tab still open', async () => {
  project();
  const rec = await open('a', 'proj');
  age('a', 5 * HOURS);
  const decisions = await janitorTick(process.env, {
    close: {
      writeMinutes: async (input, env) => {
        event('a', 'UserPromptSubmit', { prompt: 'wait, one more thing' });
        return writeMinutes(input, env);
      },
    },
  });
  assert.deepEqual(decisions, [{ room: 'a', decision: 'skip', reasons: ['room became active'] }]);
  assert.equal(Object.keys(sb.state().workspaces).length, 1);
  assert.ok(existsSync(rec.dir));
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.deepEqual(minutesFiles(), [], 'the minutes of a close that did not happen are dropped');
  assert.equal(existsSync(closingFile('a')), false);
});

test('a Notification arriving while the minutes are written does not abort the close', async () => {
  project();
  await open('a', 'proj');
  age('a', 5 * HOURS);
  const decisions = await janitorTick(process.env, {
    close: {
      writeMinutes: async (input, env) => {
        event('a', 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
        return writeMinutes(input, env);
      },
    },
  });
  assert.deepEqual(decisions, [{ room: 'a', decision: 'close', reasons: ['idle, nothing pending'] }]);
  assert.equal(readRoom('a')!.closedBy, 'janitor');
});

test('unsent text in an idle room\'s input: couched, never /exit, no minutes, tab and worktree kept', async () => {
  project();
  const rec = await open('a', 'proj');
  age('a', 5 * HOURS);
  typeInto('a', 'draft text');
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'couch', reasons: ['unsent text in its input'] }]);
  assert.deepEqual(readRoom('a')!.couch!.reasons, ['unsent text in its input']);
  assert.ok(sb.calls().some((c) => c[0] === 'pane' && c[1] === 'read' && c.includes('--format') && c.includes('ansi')), 'read with its escape codes: a dim placeholder is no draft');
  assert.equal(exitSent(), false);
  assert.deepEqual(minutesFiles(), []);
  assert.equal(claudeCalls(), 0);
  assert.equal(Object.keys(sb.state().workspaces).length, 1);
  assert.ok(existsSync(rec.dir));

  typeInto('a', '');
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'close', reasons: ['idle, nothing pending'] }], 'cleared: the next tick closes it');
  assert.equal(exitSent(), true);
});

test('an input line that cannot be found counts as unsent text: couched, never /exit', async () => {
  await open('a');
  age('a', 5 * HOURS);
  const st = sb.state();
  st.panes[readRoom('a')!.herdr!.paneId]!.screen = 'something herdr drew\n';
  sb.setState(st);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'couch', reasons: ['could not find its input line'] }]);
  assert.equal(exitSent(), false);
});

test('text typed while the minutes are written: couched, the minutes dropped, never /exit', async () => {
  project();
  await open('a', 'proj');
  age('a', 5 * HOURS);
  const decisions = await janitorTick(process.env, {
    close: {
      writeMinutes: async (input, env) => {
        typeInto('a', 'wait');
        return writeMinutes(input, env);
      },
    },
  });
  assert.deepEqual(decisions, [{ room: 'a', decision: 'couch', reasons: ['unsent text in its input'] }]);
  assert.equal(exitSent(), false);
  assert.deepEqual(minutesFiles(), []);
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.equal(Object.keys(sb.state().workspaces).length, 1);
  assert.equal(existsSync(closingFile('a')), false);
});

test('a janitor close never cuts a turn: the room working when its tab would close stops it', async () => {
  project();
  await open('a', 'proj');
  age('a', 5 * HOURS);
  const decisions = await janitorTick(process.env, {
    close: {
      writeMinutes: async (input, env) => {
        const st = sb.state();
        st.panes[readRoom('a')!.herdr!.paneId]!.agent = 'working';
        sb.setState(st);
        return writeMinutes(input, env);
      },
    },
  });
  assert.deepEqual(decisions, [{ room: 'a', decision: 'skip', reasons: ['room became active'] }]);
  assert.equal(Object.keys(sb.state().workspaces).length, 1);
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.deepEqual(minutesFiles(), []);
});

test('a room herdr reports in an unknown state is never closed by the janitor', async () => {
  project();
  await open('a', 'proj');
  age('a', 5 * HOURS);
  const pane = readRoom('a')!.herdr!.paneId;
  const set = (agent: string) => {
    const st = sb.state();
    st.panes[pane]!.agent = agent;
    sb.setState(st);
  };
  set('unknown');
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['could not check: herdr cannot tell whether the room is idle'] }]);
  set('idle');
  const decisions = await janitorTick(process.env, {
    close: {
      writeMinutes: async (input, env) => {
        set('unknown');
        return writeMinutes(input, env);
      },
    },
  });
  assert.deepEqual(decisions, [{ room: 'a', decision: 'skip', reasons: ['room became active'] }], 'unknown when the tab would close: not cut');
  assert.equal(exitSent(), false);
  assert.equal(Object.keys(sb.state().workspaces).length, 1);
  assert.deepEqual(minutesFiles(), []);
});

test('a by-hand close that cannot find the input line says to check the room, not to clear text', async () => {
  await open('a');
  const st = sb.state();
  st.panes[readRoom('a')!.herdr!.paneId]!.screen = 'something herdr drew\n';
  sb.setState(st);
  await assert.rejects(
    closeRoom('a', process.env, { exitTimeoutMs: 200 }),
    /^CloseStopped: a was not closed: could not find its input line — check the room in its tab \(or exit it there\), then close it again$/,
  );
  assert.equal(exitSent(), false);
});

test('unsent spaces in an idle room\'s input: couched, never /exit', async () => {
  await open('a');
  age('a', 5 * HOURS);
  typeInto('a', '  ');
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'couch', reasons: ['unsent text in its input'] }]);
  assert.equal(exitSent(), false);
});

test('room close by hand with unsent text in the input stops with a clear message, before any minutes', async () => {
  project();
  await open('a', 'proj');
  typeInto('a', 'half a thought');
  await assert.rejects(closeRoom('a', process.env, { exitTimeoutMs: 200 }), /^CloseStopped: a was not closed: unsent text in its input — send or clear it in its tab, then close it again$/);
  assert.equal(exitSent(), false);
  assert.deepEqual(minutesFiles(), []);
  assert.equal(claudeCalls(), 0);
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.equal(Object.keys(sb.state().workspaces).length, 1);
});

test('a closing marker left by a dead pid is taken over and the half-done close completes', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  // The dead closer got as far as the minutes, the tab and the worktree.
  const minutes = await writeMinutes({ rec, activity: { state: 'ready' }, closedBy: 'janitor', looseEnds: [], ignoredGone: [] });
  killTabs();
  git(p.path, 'worktree', 'remove', rec.dir);
  writeFileSync(closingFile('a'), JSON.stringify({ pid: deadPid(), token: 'dead', minutes, createdAt: rec.createdAt }));

  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'close', reasons: ['not running, its folder is already gone'] }]);
  assert.equal(readRoom('a')!.closedBy, 'janitor');
  assert.deepEqual(minutesFiles(), [minutes.split('/').pop()], 'the minutes already written are kept, not written twice');
  assert.equal(existsSync(closingFile('a')), false);
  assert.ok(branchExists(p.path, 'maitre/a'));
});

test('a marker left with pid 0 by a close that died after its tab closed is not reused once the room was reopened', async () => {
  project();
  const first = await open('a', 'proj');
  const minutes = await writeMinutes({ rec: first, activity: { state: 'ready' }, closedBy: 'user', looseEnds: [], ignoredGone: [] });
  writeFileSync(closingFile('a'), JSON.stringify({ pid: 0, token: 'dead', minutes, createdAt: first.createdAt }));
  killTabs();
  const again = await open('a', 'proj');
  assert.notEqual(again.createdAt, first.createdAt);
  const closed = await closeRoom('a', process.env, { exitTimeoutMs: 200 });
  assert.ok(!('dequeued' in closed));
  assert.notEqual(closed.minutes, minutes, 'the reopened room gets minutes of its own');
  assert.equal(minutesFiles().length, 2);
});

test('a closing marker held by a live closer: the janitor skips and deliverToRoom refuses', async () => {
  await open('x');
  const h = takeClosing('x');
  assert.notEqual(h, 'busy');
  try {
    await assert.rejects(sendToRoom('x', 'hi', process.env, { confirmMs: 200 }), { message: 'x is closing' });
    age('x', 5 * HOURS);
    assert.deepEqual(await janitorTick(), [{ room: 'x', decision: 'skip', reasons: ['being closed'] }]);
    assert.equal(readRoom('x')!.closedBy, undefined);
  } finally {
    releaseClosing('x', (h as { token: string }).token);
  }
  assert.equal(isClosing('x'), false);
});

test('a marker naming our own pid with a token this process does not hold is stale', async () => {
  await open('x');
  writeFileSync(closingFile('x'), JSON.stringify({ pid: process.pid, token: 'left-over' }));
  assert.equal(isClosing('x'), false);
});

test('a reused pid (another start time) is stale; age counts only without a start time', async () => {
  await open('x');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const pid = child.pid!;
    const start = processStart(pid);
    assert.ok(start, 'this platform exposes /proc/<pid>/stat');
    writeFileSync(closingFile('x'), JSON.stringify({ pid, token: 't', start }));
    assert.equal(isClosing('x'), true);
    writeFileSync(closingFile('x'), JSON.stringify({ pid, token: 't', start: `${start}9` }));
    assert.equal(isClosing('x'), false, 'another start time: the pid was reused');
    writeFileSync(closingFile('x'), JSON.stringify({ pid, token: 't', start }));
    const old = (Date.now() - 20 * 60_000) / 1000;
    utimesSync(closingFile('x'), old, old);
    assert.equal(isClosing('x'), true, 'with a verified start time, age alone (a suspend) never makes it stale');
    writeFileSync(closingFile('x'), JSON.stringify({ pid, token: 't' }));
    utimesSync(closingFile('x'), old, old);
    assert.equal(isClosing('x'), false, 'without a start time, a marker nobody refreshed for that long is abandoned');
    age('x', 5 * HOURS);
    assert.deepEqual(await janitorTick(), [{ room: 'x', decision: 'close', reasons: ['idle, nothing pending'] }]);
    assert.equal(existsSync(closingFile('x')), false);
  } finally {
    child.kill();
  }
});

test('an ignored .env appearing between the pending check and the removal keeps the worktree, with a note', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  appendFileSync(join(p.path, '.git', 'info', 'exclude'), '.env\n');
  age('a', 5 * HOURS);
  const [d] = await janitorTick(process.env, {
    close: {
      writeMinutes: async (input, env) => {
        writeFileSync(join(rec.dir, '.env'), 'SECRET=1');
        return writeMinutes(input, env);
      },
    },
  });
  assert.equal(d!.decision, 'close');
  assert.match(d!.reasons.join('\n'), /worktree kept at .*untracked \.env files: \.env/);
  assert.equal(readFileSync(join(rec.dir, '.env'), 'utf8'), 'SECRET=1');
  assert.ok(branchExists(p.path, 'maitre/a'));
  assert.match(readFileSync(join(minutesDir(), minutesFiles()[0]!), 'utf8'), /## Not done when closing\n\n- worktree kept at /);
});

test('a room closed by hand while a tick runs is not closed again by that tick', async () => {
  const p = project();
  await open('a', 'proj');
  const b = await open('b', 'proj');
  killTabs();
  age('a', 5 * HOURS);
  age('b', 5 * HOURS);
  const decisions = await janitorTick(process.env, {
    close: {
      writeMinutes: async (input, env) => {
        if (input.rec.room === 'a') await closeRoom('b', env, { exitTimeoutMs: 200 });
        return writeMinutes(input, env);
      },
    },
  });
  assert.deepEqual(decisions.map((d) => [d.room, d.decision, d.reasons]), [
    ['a', 'close', ['not running, nothing pending']],
    ['b', 'skip', ['already closed']],
  ]);
  assert.equal(readRoom('b')!.closedBy, 'user');
  assert.ok(existsSync(b.dir), 'room close by hand keeps the worktree');
  assert.ok(branchExists(p.path, 'maitre/b'));
  assert.equal(minutesFiles().filter((f) => f.endsWith('-b.md')).length, 1);
});

test('closeWithMinutes with a record someone else closed meanwhile does nothing', async () => {
  const rec = await open('a');
  writeRoom({ ...rec, closedAt: 1, closedBy: 'user' });
  assert.equal(await closeWithMinutes(rec, 'janitor'), 'closed');
  assert.deepEqual(minutesFiles(), []);
  assert.equal(readRoom('a')!.closedBy, 'user');
});

test('a malformed config.json makes every room an error, and the tick does not throw', async () => {
  await open('a');
  killTabs();
  age('a', 5 * HOURS);
  writeFileSync(join(sb.home, 'config.json'), 'not json {');
  const [d] = await janitorTick();
  assert.equal(d!.decision, 'error');
  assert.match(d!.reasons[0]!, /^could not read the settings: /);
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.equal(logLines()[0].decision, 'error');
});

test('herdr failing to answer is never read as dead rooms: everything is skipped', async () => {
  project();
  const rec = await open('a', 'proj');
  process.env.FAKE_HERDR_FAIL_workspace_list = 'boom';
  const [d] = await janitorTick();
  assert.equal(d!.decision, 'skip');
  assert.match(d!.reasons[0]!, /^could not check: herdr/);
  assert.ok(existsSync(rec.dir));
  assert.equal(readRoom('a')!.closedBy, undefined);
});

test('a room herdr cannot probe is skipped, never closed as dead', async () => {
  project();
  const rec = await open('a', 'proj');
  process.env.FAKE_HERDR_FAIL_agent_get = 'boom';
  const [d] = await janitorTick();
  assert.equal(d!.decision, 'skip');
  assert.match(d!.reasons[0]!, /^could not check: herdr/);
  assert.ok(existsSync(rec.dir));
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.equal(readRoom('a')!.closedAt, undefined);
});

test('a file appearing after the pending check makes git refuse the removal (no --force): closed, file and branch kept', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  age('a', 5 * HOURS);
  const [d] = await janitorTick(process.env, {
    close: {
      writeMinutes: async (input, env) => {
        writeFileSync(join(rec.dir, 'late.txt'), 'late work');
        return writeMinutes(input, env);
      },
    },
  });
  assert.equal(d!.decision, 'close');
  assert.match(d!.reasons.join('\n'), /worktree kept at /);
  assert.equal(readFileSync(join(rec.dir, 'late.txt'), 'utf8'), 'late work');
  assert.ok(branchExists(p.path, 'maitre/a'));
  assert.equal(readRoom('a')!.closedBy, 'janitor');
});

test('a room of another herdr session is skipped, never read as dead', async () => {
  await open('a');
  writeRoom({ ...readRoom('a')!, herdr: { ...readRoom('a')!.herdr!, session: 'other' } });
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['could not check: the room belongs to another herdr session'] }]);
  assert.equal(readRoom('a')!.closedAt, undefined);
});

test('a dead clean room whose last event is recent waits: skip, not idle yet, nothing touched', async () => {
  project();
  const rec = await open('a', 'proj');
  killTabs();
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['not idle yet'] }]);
  assert.ok(existsSync(rec.dir));
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.equal(Object.keys(sb.state().workspaces).length, 0);
  assert.deepEqual(minutesFiles(), []);
});

test('a dead room without events waits from when it was opened', async () => {
  await open('a');
  killTabs();
  writeFileSync(eventsFile('a'), '');
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['not idle yet'] }]);
  writeRoom({ ...readRoom('a')!, createdAt: Date.now() - 5 * HOURS });
  assert.equal((await janitorTick())[0]!.decision, 'close');
});

test('the log keeps every close, couch and error but an unchanged skip only once', async () => {
  await open('a');
  await janitorTick();
  await janitorTick();
  assert.deepEqual(logLines().map((l) => [l.room, l.decision, l.reasons]), [['a', 'skip', ['not idle']]]);
  age('a', 5 * HOURS);
  writeFileSync(join(readRoom('a')!.dir, 'x'), 'y');
  writeRoom({ ...readRoom('a')!, dir: join(sb.dir, 'nowhere') });
  await janitorTick();
  await janitorTick();
  assert.deepEqual(logLines().map((l) => l.decision), ['skip', 'error', 'error']);
});

test('the log is rotated to janitor.log.1 once it passes its size', async () => {
  await open('a');
  mkdirSync(join(sb.home, 'state'), { recursive: true });
  writeFileSync(janitorLog(), 'old line\n'.repeat(20));
  writeFileSync(`${janitorLog()}.1`, 'older\n');
  await janitorTick(process.env, { logMaxBytes: 100 });
  assert.equal(readFileSync(`${janitorLog()}.1`, 'utf8'), 'old line\n'.repeat(20));
  assert.deepEqual(logLines().map((l) => l.decision), ['skip']);
});

function takeOverMarker(room: string, pid: number): void {
  writeFileSync(closingFile(room), JSON.stringify({ pid, token: 'second-closer', start: processStart(pid) }));
}

test('a closer whose marker was taken over before the tab closes stops: tab open, worktree and record untouched', async () => {
  project();
  const rec = await open('a', 'proj');
  age('a', 5 * HOURS);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const [d] = await janitorTick(process.env, {
      close: {
        writeMinutes: async (input, env) => {
          takeOverMarker('a', child.pid!);
          return writeMinutes(input, env);
        },
      },
    });
    assert.deepEqual(d, { room: 'a', decision: 'skip', reasons: ['another closer took over'] });
    assert.equal(Object.keys(sb.state().workspaces).length, 1);
    assert.ok(existsSync(rec.dir));
    assert.equal(readRoom('a')!.closedBy, undefined);
    assert.equal(JSON.parse(readFileSync(closingFile('a'), 'utf8')).token, 'second-closer', "the second closer's marker is left alone");
    assert.equal(logLines().at(-1).reasons[0], 'another closer took over');
  } finally {
    child.kill();
  }
});

test('a closer taken over after its tab closed neither removes the worktree nor writes the record', async () => {
  project();
  const rec = await open('a', 'proj');
  age('a', 5 * HOURS);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const [d] = await forTests.janitorTick(process.env, { afterTabClosed: () => takeOverMarker('a', child.pid!) });
    assert.deepEqual(d, { room: 'a', decision: 'skip', reasons: ['another closer took over'] });
    assert.ok(existsSync(rec.dir));
    assert.equal(readRoom('a')!.closedBy, undefined);
    assert.equal(JSON.parse(readFileSync(closingFile('a'), 'utf8')).token, 'second-closer');
  } finally {
    child.kill();
  }
});

test('a scratch closer taken over after its tab closed moves no files', async () => {
  const rec = await open('s');
  writeFileSync(join(rec.dir, 'notes.md'), 'x');
  age('s', 5 * HOURS);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const [d] = await forTests.janitorTick(process.env, { afterTabClosed: () => takeOverMarker('s', child.pid!) });
    assert.equal(d!.decision, 'skip');
    assert.ok(existsSync(join(rec.dir, 'notes.md')));
    assert.equal(readRoom('s')!.closedBy, undefined);
  } finally {
    child.kill();
  }
});

test('the heartbeat keeps a held marker fresh and stops on release', async () => {
  await open('x');
  const h = takeClosing('x', process.env, { heartbeatMs: 20 });
  assert.notEqual(h, 'busy');
  const token = (h as { token: string }).token;
  const old = (Date.now() - HOURS) / 1000;
  utimesSync(closingFile('x'), old, old);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(Date.now() - statSync(closingFile('x')).mtimeMs < 5_000, 'the heartbeat touched the marker');
  releaseClosing('x', token);
  assert.equal(existsSync(closingFile('x')), false);
  assert.equal(isClosing('x'), false);
});

test('the check right before removal is local: the fake gh is called only by the decision', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  git(p.path, 'remote', 'set-url', 'origin', 'https://github.com/example/repo.git');
  age('a', 5 * HOURS);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'close', reasons: ['idle, nothing pending'] }]);
  assert.equal(existsSync(rec.dir), false);
  const calls = readFileSync(fakes.FAKE_GH_LOG!, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1);
});

test('a resumed close taken over after its tab closed does not write the record', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  killTabs();
  git(p.path, 'worktree', 'remove', rec.dir);
  writeFileSync(closingFile('a'), JSON.stringify({ pid: deadPid(), token: 'dead' }));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const [d] = await forTests.janitorTick(process.env, { afterTabClosed: () => takeOverMarker('a', child.pid!) });
    assert.deepEqual(d, { room: 'a', decision: 'skip', reasons: ['another closer took over'] });
    assert.equal(readRoom('a')!.closedBy, undefined);
  } finally {
    child.kill();
  }
});

test('a room being opened (an opening reservation by a live process) is skipped by the tick and refused by the closer', async () => {
  project();
  const rec = await open('a', 'proj');
  age('a', 5 * HOURS);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(openingFile(), JSON.stringify([{ room: 'a', pid: child.pid, since: Date.now() }]));
    assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['being opened'] }]);
    assert.equal(await closeWithMinutes(rec, 'janitor'), 'opening');
    await assert.rejects(closeRoom('a'), /^Error: a is opening; close it once it is open$/);
    assert.equal(Object.keys(sb.state().workspaces).length, 1);
    assert.ok(existsSync(rec.dir));
    assert.deepEqual(minutesFiles(), []);
    assert.equal(readRoom('a')!.closedBy, undefined);
  } finally {
    child.kill();
  }
  // Its opener gone, the reservation is stale: the next tick closes the room.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await janitorTick())[0].decision, 'close');
});

test('the closer never stamps closedBy on a record reopened while it closed', async () => {
  const rec = await open('s');
  age('s', 5 * HOURS);
  const reopened = { ...rec, createdAt: rec.createdAt + 1, herdr: { ...rec.herdr!, workspaceId: 'w99' } };
  const r = await forTests.closeWithMinutes(rec, 'user', process.env, {}, { afterTabClosed: () => writeRoom(reopened) });
  assert.notEqual(r, 'busy');
  const after = readRoom('s')!;
  assert.equal(after.closedBy, undefined);
  assert.equal(after.createdAt, reopened.createdAt);
});

// M3b: parking and PR-driven closes.

const PR_URL = 'https://github.com/o/r/pull/7';

function pr(rec: RoomRecord, extra: Partial<PrState> = {}): void {
  writePr(rec.room, { url: PR_URL, number: 7, state: 'OPEN', headRefName: rec.branch ?? '', seenAt: Date.now(), failing: [], ...extra });
}

function unpushed(rec: RoomRecord): void {
  writeFileSync(join(rec.dir, 'f.txt'), 'x');
  git(rec.dir, 'add', 'f.txt');
  git(rec.dir, 'commit', '-q', '-m', 'f');
}

// Parked by hand: the seat is recorded and the tab is gone, as parkRoom leaves it.
function parkedByHand(room: string): void {
  writeRoom({ ...readRoom(room)!, seat: { releasedAt: Date.now() - 60_000, session: 's1' } });
  killTabs();
}

test('a quiet room on the couch is parked by the tick; once parked it stays parked, its seat and couch kept', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  unpushed(rec);
  age('a', 5 * HOURS);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'couch', reasons: ['1 commit(s) not pushed'] }]);
  const couch = readRoom('a')!.couch!;

  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'park', reasons: ['quiet, on the couch'] }]);
  const seat = readRoom('a')!.seat!;
  assert.equal(seat.session, 's1');
  assert.equal(Object.keys(sb.state().workspaces).length, 0);
  assert.ok(existsSync(join(rec.dir, 'f.txt')));
  assert.ok(branchExists(p.path, 'maitre/a'));

  // Real Claude writes its SessionEnd as it exits: that is no sign of life in a parked room.
  event('a', 'SessionEnd', { reason: 'prompt_input_exit' });
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['1 commit(s) not pushed'] }]);
  const after = readRoom('a')!;
  assert.deepEqual(after.seat, seat);
  assert.deepEqual(after.couch, couch, 'the couch is neither cleared nor written again');
  assert.equal(after.closedBy, undefined);
  assert.deepEqual(minutesFiles(), []);
});

test('a quiet room with an open PR is parked; a working one, or one quiet for less than the release time, is not', async () => {
  project();
  const rec = await open('a', 'proj');
  pr(rec);
  age('a', 10 * 60_000);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['not idle'] }]);
  age('a', HOURS);
  const st = sb.state();
  st.panes[rec.herdr!.paneId]!.agent = 'working';
  sb.setState(st);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['not idle'] }]);
  st.panes[rec.herdr!.paneId]!.agent = 'idle';
  sb.setState(st);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'park', reasons: ['quiet, its PR is open'] }]);
  assert.equal(readRoom('a')!.seat?.session, 's1');
});

test('a seat left on a running room is taken back by the tick, and the room parks again when it may', async () => {
  await open('a');
  age('a', HOURS);
  writeRoom({ ...readRoom('a')!, seat: { releasedAt: 1, session: 'old' } });
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['not idle', 'seat taken back: its Claude is running'] }]);
  assert.equal(readRoom('a')!.seat, undefined, 'a running room never claims a seat');
  writeRoom({ ...readRoom('a')!, seat: { releasedAt: 1, session: 'old' }, couch: { since: Date.now() - 1000, reasons: ['x'] } });
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'park', reasons: ['seat taken back: its Claude is running', 'quiet, on the couch'] }]);
  assert.equal(readRoom('a')!.seat?.session, 's1');
});

test('a running room with a closedAt left by a passing herdr hiccup has it dropped by the tick, not by a dry run', async () => {
  await open('a');
  const rec = readRoom('a')!;
  writeRoom({ ...rec, closedAt: Date.now() });
  await janitorTick(process.env, { dryRun: true });
  assert.equal(typeof readRoom('a')!.closedAt, 'number');
  await janitorTick();
  assert.deepEqual(readRoom('a'), rec);
});

test('a quiet room with neither a couch nor an open PR is not parked: plain idle rooms keep their Claude', async () => {
  project();
  await open('a', 'proj');
  age('a', HOURS);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['not idle'] }]);
  assert.equal(readRoom('a')!.seat, undefined);
  assert.equal(exitSent(), false);
});

test('a draft in a quiet couched room: skip, no seat, never /exit', async () => {
  await open('a');
  age('a', 5 * HOURS);
  writeRoom({ ...readRoom('a')!, couch: { since: Date.now() - HOURS, reasons: ['x'] } });
  typeInto('a', 'draft');
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['unsent text in its input'] }]);
  assert.equal(readRoom('a')!.seat, undefined);
  assert.equal(exitSent(), false);
});

test('a parked clean room closes after idleHours, and the closed record drops its seat', async () => {
  const rec = await open('a');
  age('a', HOURS);
  parkedByHand('a');
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['not idle yet'] }]);
  assert.ok(readRoom('a')!.seat, 'still parked');
  age('a', 5 * HOURS);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'close', reasons: ['not running, nothing pending'] }]);
  const after = readRoom('a')!;
  assert.equal(after.closedBy, 'janitor');
  assert.equal(after.seat, undefined);
  assert.equal(existsSync(rec.dir), false, 'the scratch files went to the vault');
});

test('a merged PR: the running clean room dances, then closes with the merge in its minutes, branch kept', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  pr(rec, { state: 'MERGED', dance: { until: Date.now() + HOURS } });
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['dancing'] }]);
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.equal(Object.keys(sb.state().workspaces).length, 1);

  pr(rec, { state: 'MERGED', dance: { until: Date.now() - 1 } });
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'close', reasons: [`PR merged: ${PR_URL}`] }]);
  assert.equal(readRoom('a')!.closedBy, 'janitor');
  assert.equal(exitSent(), true);
  assert.equal(existsSync(rec.dir), false);
  assert.ok(branchExists(p.path, 'maitre/a'));
  const text = readFileSync(join(minutesDir(), minutesFiles()[0]!), 'utf8');
  assert.ok(text.includes(`## Why it closed\n\n- PR merged: ${PR_URL}`));
});

test('a merged PR with a commit not pushed: the room goes to the couch, nothing removed', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  unpushed(rec);
  pr(rec, { state: 'MERGED', dance: { until: Date.now() - 1 } });
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'couch', reasons: ['1 commit(s) not pushed'] }]);
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.ok(existsSync(join(rec.dir, 'f.txt')));
  assert.ok(branchExists(p.path, 'maitre/a'));
  assert.deepEqual(minutesFiles(), []);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'couch', reasons: ['1 commit(s) not pushed'] }], 'not quiet yet: stays on the couch');

  age('a', HOURS);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'park', reasons: ['quiet, on the couch'] }], 'couched and quiet: gives up its seat');
});

test('a merged PR never cuts a turn: a working room is skipped', async () => {
  project();
  const rec = await open('a', 'proj');
  pr(rec, { state: 'MERGED', dance: { until: Date.now() - 1 } });
  const st = sb.state();
  st.panes[rec.herdr!.paneId]!.agent = 'working';
  sb.setState(st);
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['not idle'] }]);
  assert.equal(readRoom('a')!.closedBy, undefined);
});

test("a parked room whose PR merges closes after the dance, without the dead room's wait; a crashed one waits", async () => {
  project();
  const a = await open('a', 'proj');
  const b = await open('b', 'proj');
  for (const rec of [a, b]) {
    age(rec.room, HOURS);
    pr(rec, { state: 'MERGED', dance: { until: Date.now() - 1 } });
  }
  writeRoom({ ...readRoom('a')!, seat: { releasedAt: Date.now() - 60_000, session: 's1' } });
  killTabs();
  assert.deepEqual(await janitorTick(), [
    { room: 'a', decision: 'close', reasons: [`PR merged: ${PR_URL}`] },
    { room: 'b', decision: 'skip', reasons: ['not idle yet'] },
  ]);
  assert.equal(readRoom('a')!.closedBy, 'janitor');
  assert.equal(readRoom('a')!.seat, undefined);
  assert.equal(readRoom('b')!.closedBy, undefined);
});

test('a PR closed without merge closes the room with a note in its minutes; the branch is kept', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  pr(rec, { state: 'CLOSED' });
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'close', reasons: [`PR closed without merge: ${PR_URL}`] }]);
  assert.equal(readRoom('a')!.closedBy, 'janitor');
  assert.ok(branchExists(p.path, 'maitre/a'));
  const text = readFileSync(join(minutesDir(), minutesFiles()[0]!), 'utf8');
  assert.ok(text.includes(`- PR closed without merge: ${PR_URL}`));
});

test('a PR closed without merge with uncommitted work: couched, nothing removed', async () => {
  project();
  const rec = await open('a', 'proj');
  writeFileSync(join(rec.dir, 'wip.txt'), 'x');
  pr(rec, { state: 'CLOSED' });
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'couch', reasons: ['uncommitted changes: wip.txt'] }]);
  assert.equal(readFileSync(join(rec.dir, 'wip.txt'), 'utf8'), 'x');
});

test("a pr.json left by an earlier opening of the room is not this room's PR", async () => {
  project();
  const rec = await open('a', 'proj');
  pr(rec, { state: 'MERGED', seenAt: rec.createdAt - 1 });
  assert.deepEqual(await janitorTick(), [{ room: 'a', decision: 'skip', reasons: ['not idle'] }]);
  assert.equal(readRoom('a')!.closedBy, undefined);
});

test('maitre janitor --dry-run shows park and the PR decisions, and changes no file', async () => {
  project();
  const quiet = await open('quiet', 'proj');
  const merged = await open('merged', 'proj');
  const dancing = await open('dancing', 'proj');
  age('quiet', HOURS);
  pr(quiet);
  pr(merged, { state: 'MERGED', dance: { until: Date.now() - 1 } });
  pr(dancing, { state: 'MERGED', dance: { until: Date.now() + HOURS } });
  const before = tree(sb.home);

  const r = spawnSync(process.execPath, [MAITRE, 'janitor', '--dry-run'], { env: sb.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    ['dancing  skip   dancing', `merged   close  PR merged: ${PR_URL}`, 'quiet    park   quiet, its PR is open', ''].join('\n'),
  );
  assert.deepEqual(tree(sb.home), before);
  assert.equal(exitSent(), false);
});

test('the stale-seat take-back removes only the seat it read: a fresh seat written meanwhile (a park) survives', async () => {
  await open('a');
  writeRoom({ ...readRoom('a')!, seat: { releasedAt: 1, session: 'old' } });
  const fresh = { releasedAt: 2, session: 's1' };
  const staged = join(sb.dir, 'room.json.staged');
  writeFileSync(staged, JSON.stringify({ ...readRoom('a')!, seat: fresh }));
  // Lands right after decide's herdr probe: between its read of the record and its patch.
  process.env.FAKE_HERDR_THEN_agent_get = JSON.stringify([staged, join(roomDir('a'), 'room.json')]);
  const [d] = await janitorTick();
  assert.deepEqual(readRoom('a')!.seat, fresh);
  assert.ok(!d.reasons.includes('seat taken back: its Claude is running'), d.reasons.join('; '));
});

test('a room woken while the tick runs (its record changed after the tabs were listed) is not stamped not running', async () => {
  const rec = (room: string, workspaceId: string): RoomRecord => ({
    room, kind: 'scratch', dir: join(sb.home, 'scratch', room), model: 'sonnet', taskType: 'simple',
    herdr: { session: 'maitre-test', workspaceId, paneId: `${workspaceId}:p1` }, createdAt: 1, resumable: true,
  });
  mkdirSync(join(sb.home, 'scratch', 'woke'), { recursive: true });
  writeRoom({ ...rec('woke', 'w2'), seat: { releasedAt: 1, session: 's1' } });
  const base = { next: 9, workspaces: {}, panes: {} };
  sb.setState(base);
  // What a wake that finishes right after the tick listed the tabs leaves: its new tab, and the record naming it.
  const woken = join(sb.dir, 'woken-state.json');
  const wokenRec = join(sb.dir, 'woken-room.json');
  writeFileSync(woken, JSON.stringify({ ...base, workspaces: { w5: { label: 'scratch / woke' } }, panes: { 'w5:p1': { ws: 'w5', agent: 'idle' } } }));
  writeFileSync(wokenRec, JSON.stringify(rec('woke', 'w5')));
  process.env.FAKE_HERDR_THEN_workspace_list = JSON.stringify({ after: 1, moves: [[woken, sb.stateFile], [wokenRec, join(roomDir('woke'), 'room.json')]] });
  await janitorTick();
  assert.equal(existsSync(woken), false, 'the wake landed during the tick');
  assert.equal(readRoom('woke')!.herdr!.workspaceId, 'w5');
  assert.equal(readRoom('woke')!.closedAt, undefined, 'not stamped not running');
});


// #40: janitor, parking and closing edge cases.

// herdr no longer detects the agent in the room's own tab, which still shows `screen`.
function lostByHerdr(room: string, screen: string): void {
  const st = sb.state();
  const pane = st.panes[readRoom(room)!.herdr!.paneId]!;
  pane.agent = 'shell';
  pane.screen = screen;
  sb.setState(st);
}
const box = (typed: string) => `${'─'.repeat(40)}\n❯ ${typed}\n${'─'.repeat(40)}\n`;

test("a dead room whose own tab still shows Claude's box (herdr lost it) is not closed: no /exit, tab kept, no minutes", async () => {
  await open('a');
  age('a', 5 * HOURS);
  lostByHerdr('a', box('half a thought'));
  const [d] = await janitorTick();
  assert.deepEqual(d, { room: 'a', decision: 'skip', reasons: ['unsent text in its input'] });
  lostByHerdr('a', box(''));
  const [e] = await janitorTick();
  assert.deepEqual(e, { room: 'a', decision: 'skip', reasons: ['its tab shows a Claude herdr does not detect'] });
  assert.equal(Object.keys(sb.state().workspaces).length, 1);
  assert.equal(exitSent(), false);
  assert.deepEqual(minutesFiles(), []);
  assert.equal(readRoom('a')!.closedBy, undefined);
  await assert.rejects(closeRoom('a'), /its tab shows a Claude herdr does not detect/);
});

test("a dead room whose own tab shows a shell, or whose run's exit line is there, is closed", async () => {
  await open('a');
  age('a', 5 * HOURS);
  lostByHerdr('a', '$ \n');
  assert.equal((await janitorTick())[0]!.decision, 'close');
  await open('b');
  age('b', 5 * HOURS);
  lostByHerdr('b', box('left on screen after it exited'));
  event('b', 'MaitreExit', { run: readRoom('b')!.run }, Date.now() - 5 * HOURS);
  assert.equal((await janitorTick()).find((x) => x.room === 'b')!.decision, 'close');
});

test('--dry-run does not promise a park that a draft or a missing session id would skip', async () => {
  await open('draft');
  await open('nosession');
  for (const room of ['draft', 'nosession']) writeRoom({ ...readRoom(room)!, couch: { since: Date.now() - HOURS, reasons: ['x'] } });
  event('draft', 'Stop');
  age('draft', 2 * HOURS);
  // Only lines without a session id.
  writeFileSync(eventsFile('nosession'), JSON.stringify({ v: 1, ts: Date.now() - 2 * HOURS, room: 'nosession', event: 'Stop' }) + '\n');
  typeInto('draft', 'not sent');
  const ds = await janitorTick(process.env, { dryRun: true });
  assert.deepEqual(ds, [
    { room: 'draft', decision: 'skip', reasons: ['unsent text in its input'] },
    { room: 'nosession', decision: 'skip', reasons: ['no session id'] },
  ]);
});

test('a room that may park but has something pending is on the couch even when its park is skipped', async () => {
  project();
  const rec = await open('a', 'proj');
  unpushed(rec);
  pr(rec);
  age('a', 5 * HOURS);
  typeInto('a', 'draft');
  const [d] = await janitorTick();
  assert.deepEqual(d, { room: 'a', decision: 'skip', reasons: ['unsent text in its input'] });
  assert.deepEqual(readRoom('a')!.couch?.reasons, ['1 commit(s) not pushed', 'unsent text in its input']);
});

test('ignored files that appear between the decision and the removal are in the minutes too', async () => {
  project();
  const rec = await open('a', 'proj');
  age('a', 5 * HOURS);
  const [d] = await forTests.janitorTick(process.env, {
    afterTabClosed: () => {
      mkdirSync(join(rec.dir, 'node_modules', 'late'), { recursive: true });
      writeFileSync(join(rec.dir, 'node_modules', 'late', 'x.js'), 'x');
    },
  });
  assert.equal(d!.decision, 'close');
  const text = readFileSync(join(minutesDir(), minutesFiles()[0]!), 'utf8');
  assert.match(text, /`node_modules\/`/);
});

test('a log rotation waits for one in progress: janitor.log.1 is never overwritten by a second rotation', async () => {
  await open('a');
  mkdirSync(join(sb.home, 'state'), { recursive: true });
  writeFileSync(janitorLog(), 'x'.repeat(100) + '\n');
  writeFileSync(`${janitorLog()}.1`, 'OLD\n');
  // Another process holds the rotation lock.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(`${janitorLog()}.lock`, JSON.stringify({ pid: child.pid, token: 'other' }));
    await janitorTick(process.env, { logMaxBytes: 10 });
    assert.equal(readFileSync(`${janitorLog()}.1`, 'utf8'), 'OLD\n', 'not rotated while another rotation holds the lock');
  } finally {
    child.kill();
  }
  rmSync(`${janitorLog()}.lock`);
  writeFileSync(janitorLog(), 'x'.repeat(100) + '\n');
  // A decision not logged before (an unchanged skip is not logged again).
  await open('b');
  await janitorTick(process.env, { logMaxBytes: 10 });
  assert.match(readFileSync(`${janitorLog()}.1`, 'utf8'), /^x+\n/);
});

test("a close stopped after its marker was taken over keeps the minutes: they may be the new closer's", async () => {
  const rec = await open('a');
  age('a', 5 * HOURS);
  let written = '';
  await assert.rejects(
    closeWithMinutes(rec, 'janitor', process.env, {
      writeMinutes: async (input, env) => {
        written = await writeMinutes(input, env);
        // Another closer takes the marker over (and may reuse these minutes), and the room moves on.
        writeFileSync(closingFile('a'), JSON.stringify({ pid: 0, token: 'other', minutes: written, createdAt: rec.createdAt }));
        event('a', 'UserPromptSubmit', { prompt: 'more' });
        return written;
      },
    }),
  );
  assert.ok(existsSync(written), 'the minutes stay');
});

test('a skip says why: a record closed meanwhile, reopened meanwhile, or being opened', async () => {
  const rec = await open('a');
  const reopened = { ...rec, createdAt: rec.createdAt + 1 };
  writeRoom(reopened);
  assert.equal(await closeWithMinutes(rec, 'janitor'), 'changed');
});

test('the couch is never written on a record closed meanwhile', async () => {
  project();
  const rec = await open('a', 'proj');
  unpushed(rec);
  age('a', 5 * HOURS);
  const staged = join(sb.dir, 'room.json.staged');
  writeFileSync(staged, JSON.stringify({ ...readRoom('a')!, closedAt: 1, closedBy: 'user' }));
  // Lands right after decide's herdr probe, before the couch is written.
  process.env.FAKE_HERDR_THEN_agent_get = JSON.stringify([staged, join(roomDir('a'), 'room.json')]);
  await janitorTick();
  assert.equal(readRoom('a')!.closedBy, 'user');
  assert.equal(readRoom('a')!.couch, undefined);
});

test('a close by hand whose marker another closer took over is logged', async () => {
  const rec = await open('a');
  event('a', 'Stop', { transcript: transcript() });
  process.env.FAKE_CLAUDE_SLEEP_MS = '1500';
  process.env.FAKE_CLAUDE_STDOUT = JSON.stringify({ type: 'result', is_error: false, result: SUMMARY });
  const closing = closeRoom('a');
  const t0 = Date.now();
  while (!existsSync(closingFile('a')) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 300));
  writeFileSync(closingFile('a'), JSON.stringify({ pid: 0, token: 'other' }));
  await assert.rejects(closing, /another closer took over/);
  const last = logLines().at(-1);
  assert.deepEqual([last.room, last.decision, last.reasons], ['a', 'error', ['closed by hand: another closer took over its close']]);
  assert.ok(rec);
});

test('room close on a name both queued and open removes it from the queue and closes the room', async () => {
  await open('a');
  mkdirSync(join(sb.home, 'state'), { recursive: true });
  const route = { room: { kind: 'new', name: 'a' }, project: null, model: 'sonnet', taskType: 'change' };
  writeFileSync(join(sb.home, 'state', 'queue.json'), JSON.stringify([{ room: 'a', requestIds: ['1'], route, queuedAt: 1, attempts: 0 }]));
  const r = await closeRoom('a');
  assert.equal((r as { dequeued?: string }).dequeued, 'queue');
  assert.equal(readRoom('a')!.closedBy, 'user');
  assert.deepEqual(JSON.parse(readFileSync(join(sb.home, 'state', 'queue.json'), 'utf8')), []);
});

test('a janitor pass told to stop decides no room after that', async () => {
  await open('a');
  await open('b');
  let asked = 0;
  const ds = await janitorTick(process.env, { stopped: () => ++asked > 1 });
  assert.deepEqual(ds.map((d) => d.room), ['a']);
});

// Round 2.

test('room close on a name in queue-failed.json removes that entry only: an open room of that name keeps running', async () => {
  await open('a');
  mkdirSync(join(sb.home, 'state'), { recursive: true });
  const route = { room: { kind: 'new', name: 'a' }, project: null, model: 'sonnet', taskType: 'change' };
  writeFileSync(join(sb.home, 'state', 'queue-failed.json'), JSON.stringify([{ room: 'a', requestIds: ['1'], route, queuedAt: 1, attempts: 3, failedAt: 2, lastError: 'opened outside the queue' }]));
  const r = await closeRoom('a');
  assert.deepEqual(r, { room: 'a', dequeued: 'failed', open: true });
  assert.equal(readRoom('a')!.closedBy, undefined);
  assert.equal(exitSent(), false);
});

test('room close on a queued and open name whose close stops says the queue entry was removed', async () => {
  await open('a');
  mkdirSync(join(sb.home, 'state'), { recursive: true });
  const route = { room: { kind: 'new', name: 'a' }, project: null, model: 'sonnet', taskType: 'change' };
  writeFileSync(join(sb.home, 'state', 'queue.json'), JSON.stringify([{ room: 'a', requestIds: ['1'], route, queuedAt: 1, attempts: 0 }]));
  typeInto('a', 'a draft');
  await assert.rejects(closeRoom('a'), /^Error: removed a from the queue; a was not closed: unsent text in its input/);
  assert.deepEqual(JSON.parse(readFileSync(join(sb.home, 'state', 'queue.json'), 'utf8')), []);
  assert.equal(readRoom('a')!.closedBy, undefined);
});

test('a dry run never fetches: the remote-tracking ref of a branch pushed elsewhere is not written', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  unpushed(rec);
  git(rec.dir, 'push', '-q', join(sb.dir, 'remote.git'), 'HEAD:refs/heads/maitre/a');
  age('a', 5 * HOURS);
  const [d] = await janitorTick(process.env, { dryRun: true });
  assert.deepEqual(d, { room: 'a', decision: 'couch', reasons: ['1 commit(s) not pushed'] });
  assert.equal(git(p.path, 'for-each-ref', 'refs/remotes/origin/maitre/a'), '');
});

// Round 2: each lost-Claude check alone, and the notePending guard.

test('the janitor checks a lost Claude before any minutes: the writer is never called, the reason is kept as pending', async () => {
  await open('a');
  age('a', 5 * HOURS);
  lostByHerdr('a', box('half a thought'));
  let wrote = 0;
  const [d] = await janitorTick(process.env, { close: { writeMinutes: async () => (wrote++, '/nowhere') } });
  assert.deepEqual(d, { room: 'a', decision: 'skip', reasons: ['unsent text in its input'] });
  assert.equal(wrote, 0);
  assert.deepEqual(readRoom('a')!.pending?.reasons, ['unsent text in its input']);
});

test('a dead room whose folder is gone and whose tab still shows Claude is skipped before any minutes', async () => {
  const rec = await open('a');
  age('a', 5 * HOURS);
  rmSync(rec.dir, { recursive: true });
  lostByHerdr('a', box(''));
  let wrote = 0;
  const [d] = await janitorTick(process.env, { close: { writeMinutes: async () => (wrote++, '/nowhere') } });
  assert.deepEqual(d, { room: 'a', decision: 'skip', reasons: ['its tab shows a Claude herdr does not detect'] });
  assert.equal(wrote, 0);
});

test('closeRoomTab alone refuses the tab of a lost Claude', async () => {
  await open('a');
  lostByHerdr('a', box('draft'));
  await assert.rejects(closeRoomTab(readRoom('a')!, process.env, { by: 'user' }), /unsent text in its input/);
  assert.equal(Object.keys(sb.state().workspaces).length, 1);
});

test('the input check of a close by hand alone refuses a lost Claude, before "writing the minutes…"', async () => {
  await open('a');
  lostByHerdr('a', box(''));
  await assert.rejects(checkInput(readRoom('a')!), /its tab shows a Claude herdr does not detect/);
  let writing = false;
  await assert.rejects(closeRoom('a', process.env, { writing: () => (writing = true) }), /herdr does not detect/);
  assert.equal(writing, false);
});

test('pending is never written on a record closed meanwhile', async () => {
  const p = project();
  const rec = await open('a', 'proj');
  writeFileSync(join(rec.dir, 'wip.txt'), 'x');
  git(p.path, 'remote', 'set-url', 'origin', 'https://github.com/example/repo.git');
  killTabs();
  age('a', 5 * HOURS);
  const staged = join(sb.dir, 'room.json.staged');
  writeFileSync(staged, JSON.stringify({ ...readRoom('a')!, closedAt: 1, closedBy: 'user' }));
  // Lands during the pending check (its gh call), before the pending reasons are written.
  process.env.FAKE_GH_THEN = JSON.stringify([staged, join(roomDir('a'), 'room.json')]);
  await janitorTick();
  assert.equal(existsSync(staged), false, 'the close landed');
  assert.equal(readRoom('a')!.closedBy, 'user');
  assert.equal(readRoom('a')!.pending, undefined);
});
