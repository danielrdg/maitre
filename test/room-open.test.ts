import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookLine } from '../src/events.js';
import { HerdrError, shellQuote } from '../src/herdr.js';
import { roomDir } from '../src/paths.js';
import { writeIndex, type Project } from '../src/projects.js';
import { BRIEF_HEADER, closeRoom, listRoomRows, openRoom, promptMatches, roomLabel, sendToRoom, unwrapPasted } from '../src/room-open.js';
import { reduce, type RoomState } from '../src/room-state.js';
import { readRoom, writeRoom, type RoomRecord } from '../src/rooms.js';
import { herdrSandbox, type HerdrSandbox } from './herdr-sandbox.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAITRE = join(ROOT, 'bin', 'maitre');
// Harmless if a bug ever executed it; still every shell metacharacter that matters.
const HOSTILE = "it''s $(rm -rf ~/.maitre-test-canary) `id` && echo pwned > /dev/null; x='y'\nline2\n--model opus";
// Large on purpose: these tests expect the trust wait to end early, never at the timeout.
const FAST = { trustTimeoutMs: 120_000, pollMs: 10 };
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

let sb: HerdrSandbox;

beforeEach(() => {
  sb = herdrSandbox();
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
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(clone, 'push', '-q', 'origin', 'main');
  const p: Project = { name: 'proj', path: clone, base: 'main', branchPrefix: 'maitre/' };
  writeIndex([p]);
  return p;
}

function events(room: string): HookLine[] {
  const file = join(roomDir(room), 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as HookLine);
}

const herdrCalls = (a: string, b: string) => sb.calls().filter((c) => c[0] === a && c[1] === b);

function openScratch(name = 'x', brief = 'do it'): Promise<RoomRecord> {
  return openRoom({ name, model: 'sonnet', taskType: 'simple', brief }, process.env, FAST);
}

test('openRoom: a code room gets a worktree, a herdr tab running only quoted maître tokens, and a registry entry', async () => {
  const p = project();
  const rec = await openRoom({ name: 'NF Bug', project: 'proj', model: 'sonnet', taskType: 'change', brief: HOSTILE }, process.env, FAST);
  const dir = join(sb.home, 'worktrees', 'proj', 'nf-bug');
  assert.equal(rec.room, 'nf-bug');
  assert.equal(rec.kind, 'code');
  assert.equal(rec.project, 'proj');
  assert.equal(rec.dir, dir);
  assert.equal(rec.branch, 'maitre/nf-bug');
  assert.equal(rec.model, 'sonnet');
  assert.equal(rec.taskType, 'change');
  assert.deepEqual(rec.herdr, { session: 'maitre-test', workspaceId: 'w1', paneId: 'w1:p1' });
  assert.equal(rec.closedAt, undefined);
  assert.deepEqual(rec.warnings, []);
  assert.equal(rec.needsTrust, false);
  const { warnings: _w, needsTrust: _t, ...stored } = rec;
  assert.deepEqual(readRoom('nf-bug'), stored);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'maitre/nf-bug');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), git(p.path, 'rev-parse', 'origin/main'));

  assert.deepEqual(herdrCalls('workspace', 'create'), [
    ['workspace', 'create', '--cwd', dir, '--label', 'proj / nf-bug', '--env', 'MAITRE_ROOM=nf-bug', '--env', `MAITRE_HOME=${sb.home}`, '--no-focus'],
  ]);

  const briefPath = join(roomDir('nf-bug'), 'brief.md');
  assert.equal(readFileSync(briefPath, 'utf8'), `${BRIEF_HEADER}\n\n${HOSTILE}`);
  assert.equal(statSync(briefPath).mode & 0o777, 0o600);

  const run = herdrCalls('pane', 'run');
  assert.equal(run.length, 1);
  const cmd = run[0][3];
  assert.equal(run[0][2], 'w1:p1');
  assert.equal(cmd, [MAITRE, 'room', 'run', 'nf-bug', '--brief-file', briefPath, '--', '--model', 'sonnet'].map(shellQuote).join(' '));
  assert.match(cmd, /^'[^'\n]*'( '[^'\n]*')*$/, 'every token is single-quoted, on one line');
  assert.ok(!cmd.includes('rm -rf'));
});

test('the pane command, run by a shell, hands claude the brief verbatim as its last argument', async () => {
  const canary = join(sb.dir, 'pwned');
  const brief = `${HOSTILE} $(touch ${canary}) \`touch ${canary}\`; touch ${canary}`;
  await openScratch('x', brief);
  const cmd = herdrCalls('pane', 'run')[0][3];
  const fake = join(sb.dir, 'fake-claude');
  mkdirSync(fake);
  writeFileSync(join(fake, 'claude'), `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.FAKE_OUT, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(join(fake, 'claude'), 0o755);
  const out = join(sb.dir, 'argv.json');
  execFileSync('/bin/sh', ['-c', cmd], {
    env: { PATH: [fake, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), MAITRE_HOME: sb.home, MAITRE_ROOM: 'x', FAKE_OUT: out, HOME: sb.dir },
    stdio: 'ignore',
  });
  const argv = JSON.parse(readFileSync(out, 'utf8')) as string[];
  assert.equal(argv.at(-1), `${BRIEF_HEADER}\n\n${brief}`);
  assert.deepEqual(argv.slice(-3, -1), ['--model', 'sonnet']);
  assert.equal(existsSync(canary), false);
});

test('openRoom: no project means a scratch room', async () => {
  const rec = await openScratch('Quick Q');
  assert.equal(rec.kind, 'scratch');
  assert.equal(rec.project, undefined);
  assert.equal(rec.branch, undefined);
  assert.equal(rec.dir, join(sb.home, 'scratch', 'quick-q'));
  assert.equal(roomLabel(rec), 'scratch / quick-q');
  assert.equal(herdrCalls('workspace', 'create')[0][5], 'scratch / quick-q');
});

test('openRoom answers the trust dialog of its own room', async () => {
  process.env.FAKE_HERDR_ON_RUN = 'trust';
  const rec = await openScratch();
  assert.deepEqual(herdrCalls('agent', 'send-keys'), [['agent', 'send-keys', 'w1:p1', 'down', 'enter']]);
  assert.ok(readRoom(rec.room));
  assert.deepEqual(events('x').map((l) => l.event), ['SessionStart']);
});

test('a worktree room\'s trust dialog is left to the user: no keys, registered, and the lounge rings until SessionStart', async () => {
  project();
  process.env.FAKE_HERDR_ON_RUN = 'trust';
  const rec = await openRoom({ name: 'x', project: 'proj', model: 'sonnet', taskType: 'change', brief: 'b' }, process.env, FAST);
  assert.equal(rec.needsTrust, true);
  assert.deepEqual(herdrCalls('agent', 'send-keys'), []);
  assert.ok(readRoom('x'));
  const got = events('x');
  assert.deepEqual(got.map((l) => [l.event, l.status, l.text, l.starting]), [['MaitreStatus', 'blocked', "Trust this folder? Answer in the room's tab", true]]);
  let st: RoomState | undefined;
  for (const l of got) st = reduce(st, l);
  assert.equal(st?.state, 'blocked');
  st = reduce(st, { v: 1, ts: Date.now(), room: 'x', session: 's1', event: 'SessionStart' });
  assert.equal(st.block, undefined, 'answering the dialog starts the session and clears the line');
});

test('reopening a code room whose worktree is still there warns about it', async () => {
  project();
  const first = await openRoom({ name: 'x', project: 'proj', model: 'sonnet', taskType: 'change', brief: 'b' }, process.env, FAST);
  assert.deepEqual(first.warnings, []);
  await closeRoom('x');
  const again = await openRoom({ name: 'x', project: 'proj', model: 'sonnet', taskType: 'change', brief: 'b' }, process.env, FAST);
  assert.deepEqual(again.warnings, ['reopened existing worktree on maitre/x']);
});

test('maitre room open of a worktree room prints the warning and the trust question in one line', () => {
  project();
  const first = cli(['room', 'open', 'x', '--project', 'proj', '--model', 'opus', '--task', 'build', '--brief', 'b']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(cli(['room', 'close', 'x']).status, 0);
  const r = spawnSync(process.execPath, [MAITRE, 'room', 'open', 'x', '--project', 'proj', '--model', 'opus', '--task', 'build', '--brief', 'b'], {
    env: { ...sb.env, FAKE_HERDR_ON_RUN: 'trust' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'opened x in proj on opus — answer the folder-trust question in its tab\n');
  assert.equal(r.stderr, 'maitre: warning: reopened existing worktree on maitre/x\n');
});

test('an unresolved trust dialog still registers the room and rings the lounge', async () => {
  process.env.FAKE_HERDR_ON_RUN = 'trust';
  process.env.FAKE_HERDR_TRUST_STICKY = '1';
  await openRoom({ name: 'x', model: 'sonnet', taskType: 'simple', brief: 'b' }, process.env, { trustTimeoutMs: 300, pollMs: 10 });
  assert.ok(readRoom('x'));
  const got = events('x');
  assert.equal(got.length, 1);
  assert.equal(got[0].event, 'MaitreStatus');
  assert.equal(got[0].status, 'blocked');
  assert.equal(got[0].text, 'Room is still starting — check its tab');
  assert.equal(got[0].starting, true);
});

test('idle never settles: a room whose SessionStart has not arrived by the deadline is still starting', async () => {
  process.env.FAKE_HERDR_SESSION_START = '0';
  await openRoom({ name: 'x', model: 'sonnet', taskType: 'simple', brief: 'b' }, process.env, { trustTimeoutMs: 300, pollMs: 10 });
  assert.ok(readRoom('x'));
  const got = events('x');
  assert.deepEqual(got.map((l) => [l.event, l.status, l.text, l.starting]), [['MaitreStatus', 'blocked', 'Room is still starting — check its tab', true]]);
});

test('a SessionStart from an earlier run of the same room does not settle the trust wait', async () => {
  process.env.FAKE_HERDR_SESSION_START = '0';
  const { appendRoomLine } = await import('../src/status.js');
  appendRoomLine('x', 'SessionStart', {});
  await openRoom({ name: 'x', model: 'sonnet', taskType: 'simple', brief: 'b' }, process.env, { trustTimeoutMs: 300, pollMs: 10 });
  assert.equal(events('x').at(-1)?.event, 'MaitreStatus');
});

test('openRoom settles on the room\'s own SessionStart, sending no keys', async () => {
  await openScratch();
  assert.deepEqual(herdrCalls('agent', 'send-keys'), []);
  assert.deepEqual(events('x').map((l) => l.event), ['SessionStart']);
});

test('no Claude in the tab by the deadline: openRoom fails clearly, closes the tab and registers nothing', async () => {
  process.env.FAKE_HERDR_ON_RUN = 'shell';
  await assert.rejects(
    openRoom({ name: 'x', model: 'sonnet', taskType: 'simple', brief: 'b' }, process.env, { trustTimeoutMs: 300, pollMs: 10 }),
    /room x did not start: no Claude appeared in its tab/,
  );
  assert.equal(readRoom('x'), undefined);
  assert.deepEqual(sb.state().workspaces, {});
});

test('opening a live room again is refused and creates nothing', async () => {
  await openScratch();
  await assert.rejects(openScratch(), /^Error: room x is already open$/);
  assert.equal(herdrCalls('workspace', 'create').length, 1);
  assert.equal(herdrCalls('pane', 'run').length, 1);
});

test('a room whose tab came back as a bare shell can be opened again, replacing that tab', async () => {
  await openScratch();
  // herdr restarted: the tab is restored as a bare shell under a new id.
  sb.setState({ next: 8, workspaces: { w7: { label: 'scratch / x' } }, panes: { 'w7:p1': { ws: 'w7', agent: 'shell' } } });
  const rec = await openScratch();
  assert.deepEqual(rec.herdr, { session: 'maitre-test', workspaceId: 'w8', paneId: 'w8:p1' });
  assert.deepEqual(Object.keys(sb.state().workspaces), ['w8']);
});

test('herdr failing after the worktree exists leaves no registry entry and closes the tab', async () => {
  project();
  process.env.FAKE_HERDR_FAIL_pane_run = 'boom';
  await assert.rejects(
    openRoom({ name: 'nf', project: 'proj', model: 'opus', taskType: 'build', brief: 'b' }, process.env, FAST),
    (e: unknown) => e instanceof HerdrError && e.code === 'boom',
  );
  assert.equal(readRoom('nf'), undefined);
  assert.deepEqual(herdrCalls('workspace', 'close'), [['workspace', 'close', 'w1']]);
  assert.deepEqual(sb.state().workspaces, {});
  assert.ok(existsSync(join(sb.home, 'worktrees', 'proj', 'nf')), 'the worktree is kept');
});

test('herdr failing to create the tab leaves no registry entry and closes nothing', async () => {
  process.env.FAKE_HERDR_FAIL_workspace_create = 'boom';
  await assert.rejects(openScratch(), /boom/);
  assert.equal(readRoom('x'), undefined);
  assert.deepEqual(herdrCalls('workspace', 'close'), []);
});

test('an unknown project or an unsafe model is refused before anything is created', async () => {
  project();
  await assert.rejects(openRoom({ name: 'x', project: 'nope', model: 'sonnet', taskType: 's', brief: 'b' }, process.env, FAST), /unknown project nope/);
  for (const model of ['sonnet\nrm -rf ~', "opus'", '', '-x']) {
    await assert.rejects(openRoom({ name: 'x', model, taskType: 's', brief: 'b' }, process.env, FAST), /invalid model/, JSON.stringify(model));
  }
  assert.deepEqual(sb.calls().filter((c) => c[0] !== 'status'), []);
  assert.equal(existsSync(join(sb.home, 'scratch')), false);
  assert.equal(readRoom('x'), undefined);
});

test('room send delivers without waiting and confirms by the room hook, even for long hostile text', async () => {
  await openScratch();
  const text = `${HOSTILE} "quoted" 🎉 ${'é\n'.repeat(400)}`;
  assert.equal(await sendToRoom('x', text, process.env, { confirmMs: 3000 }), 'delivered');
  assert.deepEqual(herdrCalls('agent', 'prompt'), [['agent', 'prompt', 'w1:p1', text]]);
  const prompt = events('x').find((l) => l.event === 'UserPromptSubmit')?.prompt ?? '';
  assert.ok(prompt.endsWith('…') && prompt.length < text.length, 'the hook truncated the stored prompt');
});

test('room send reports unconfirmed when the prompt never shows up, ignoring an older identical one', async () => {
  await openScratch();
  assert.equal(await sendToRoom('x', 'hello', process.env, { confirmMs: 3000 }), 'delivered');
  process.env.FAKE_HERDR_PROMPT_HOOK = '0';
  assert.equal(await sendToRoom('x', 'hello', process.env, { confirmMs: 300 }), 'unconfirmed');
});

test('room send to a gone pane says the room is not running and marks it closed', async () => {
  await openScratch();
  sb.setState({ next: 2, workspaces: {}, panes: {} });
  await assert.rejects(sendToRoom('x', 'hi'), /^Error: room x is not running — open it again with: maitre room open …$/);
  assert.equal(typeof readRoom('x')?.closedAt, 'number');
  assert.deepEqual(herdrCalls('agent', 'prompt'), []);
});

test('room send to a restored bare shell, or to a pane id now in another tab, says not running', async () => {
  await openScratch();
  sb.setState({ next: 3, workspaces: { w1: { label: 'scratch / x' } }, panes: { 'w1:p1': { ws: 'w1', agent: 'shell' } } });
  await assert.rejects(sendToRoom('x', 'hi'), /room x is not running/);
  sb.setState({ next: 3, workspaces: { w2: { label: 'other / y' } }, panes: { 'w1:p1': { ws: 'w2', agent: 'idle' } } });
  await assert.rejects(sendToRoom('x', 'hi'), /room x is not running/);
  assert.deepEqual(herdrCalls('agent', 'prompt'), []);
});

test('room send to a blocked room says it is waiting on you', async () => {
  await openScratch();
  const s = sb.state();
  s.panes['w1:p1'].agent = 'blocked';
  sb.setState(s);
  await assert.rejects(sendToRoom('x', 'hi'), /^Error: room x is waiting on you — answer it in its tab$/);
  assert.deepEqual(herdrCalls('agent', 'prompt'), []);
});

test('room send refuses a message over the brief limit with one line, typing nothing', async () => {
  await openScratch();
  const text = 'é'.repeat(50_001);
  await assert.rejects(sendToRoom('x', text), /^Error: the message is too long \(at most 100000 bytes\)$/);
  assert.deepEqual(herdrCalls('agent', 'prompt'), []);
  await sendToRoom('x', 'a'.repeat(100_000));
  assert.equal(herdrCalls('agent', 'prompt').length, 1);
});

test('room send to a working room types it anyway; unconfirmed when the room has only queued it', async () => {
  await openScratch();
  const s = sb.state();
  s.panes['w1:p1'].agent = 'working';
  sb.setState(s);
  process.env.FAKE_HERDR_PROMPT_HOOK = '0';
  assert.equal(await sendToRoom('x', 'later', process.env, { confirmMs: 300 }), 'unconfirmed');
  assert.deepEqual(herdrCalls('agent', 'prompt'), [['agent', 'prompt', 'w1:p1', 'later']]);
});

test('room send confirms a multi-line message the room received as a paste', async () => {
  await openScratch();
  process.env.FAKE_HERDR_PASTE = '1';
  const text = 'first line of the follow-up\nsecond line\nthird line';
  assert.equal(await sendToRoom('x', text, process.env, { confirmMs: 2000 }), 'delivered');
});

test('promptMatches ignores Claude Code\'s pasted-content wrapper on the stored side', () => {
  const sent = 'Quick arithmetic for a scratch room, no project needed:\nline 1';
  assert.ok(promptMatches(`\n\n<pasted_content id="3999">\n${sent}\n</pasted_content id="3999">\n`, sent));
  assert.ok(promptMatches(`\n\n<pasted_content id="3999">\n${sent.slice(0, 50)}…`, sent));
  assert.ok(!promptMatches('\n\n<pasted_content id="3999">\nsomething else entirely, not the message\n</pasted_content id="3999">', sent));
  assert.equal(unwrapPasted('look:\n\n<pasted_content id="1">\nA\nB\n</pasted_content id="1">\n'), 'look:\n\nA\nB');
  assert.equal(unwrapPasted('  plain\n'), '  plain\n', 'text without a wrapper is untouched');
});

test('a detected agent with status unknown is still running', async () => {
  await openScratch();
  const s = sb.state();
  s.panes['w1:p1'].agent = 'unknown';
  sb.setState(s);
  assert.deepEqual(await listRoomRows(), [{ room: 'x', model: 'sonnet', herdr: 'unknown', lounge: 'coffee' }]);
  assert.equal(readRoom('x')?.closedAt, undefined);
  await assert.rejects(openScratch(), /^Error: room x is already open$/);
  assert.deepEqual(Object.keys(sb.state().workspaces), ['w1']);
  assert.equal(await sendToRoom('x', 'hi', process.env, { confirmMs: 3000 }), 'delivered');
  assert.equal(readRoom('x')?.closedAt, undefined);
});

test('room send to an unknown room fails', async () => {
  await assert.rejects(sendToRoom('nope', 'hi'), /no room named nope/);
});

test('room list shows each room with its herdr status and lounge state; restored bare shells are not running', async () => {
  await openScratch('a');
  await openScratch('b');
  await sendToRoom('a', 'hello', process.env, { confirmMs: 3000 });
  const s = sb.state();
  delete s.workspaces.w2;
  delete s.panes['w2:p1'];
  s.workspaces.w9 = { label: 'scratch / b' };
  s.panes['w9:p1'] = { ws: 'w9', agent: 'shell' };
  sb.setState(s);
  const lounge = events('a').reduce<RoomState | undefined>((st, l) => reduce(st, l), undefined)!.state;
  const rows = await listRoomRows();
  assert.deepEqual(rows, [
    { room: 'a', model: 'sonnet', herdr: 'idle', lounge },
    { room: 'b', model: 'sonnet', herdr: 'not running', lounge: 'coffee' },
  ]);
  assert.equal(typeof readRoom('b')?.closedAt, 'number');
  assert.equal(readRoom('a')?.closedAt, undefined);
});

test('room close exits an idle room, closes its tab, keeps its directory and marks it closed', async () => {
  const rec = await openScratch();
  const closed = await closeRoom('x', process.env, { exitTimeoutMs: 2000 });
  assert.deepEqual(herdrCalls('agent', 'prompt'), [['agent', 'prompt', 'w1:p1', '/exit']]);
  assert.deepEqual(herdrCalls('workspace', 'close'), [['workspace', 'close', 'w1']]);
  assert.deepEqual(sb.state().workspaces, {});
  assert.equal(typeof closed.closedAt, 'number');
  assert.equal(readRoom('x')?.closedAt, closed.closedAt);
  assert.ok(existsSync(rec.dir));
});

test('room close of a working room closes the tab without typing /exit', async () => {
  await openScratch();
  const s = sb.state();
  s.panes['w1:p1'].agent = 'working';
  sb.setState(s);
  await closeRoom('x', process.env, { exitTimeoutMs: 200 });
  assert.deepEqual(herdrCalls('agent', 'prompt'), []);
  assert.deepEqual(sb.state().workspaces, {});
});

test('room close closes a restored bare-shell tab and never touches a reused pane id in another tab', async () => {
  await openScratch();
  sb.setState({
    next: 9,
    workspaces: { w2: { label: 'other / y' }, w8: { label: 'scratch / x' } },
    panes: { 'w1:p1': { ws: 'w2', agent: 'idle' }, 'w8:p1': { ws: 'w8', agent: 'shell' } },
  });
  await closeRoom('x', process.env, { exitTimeoutMs: 200 });
  assert.deepEqual(herdrCalls('agent', 'prompt'), []);
  assert.deepEqual(herdrCalls('workspace', 'close'), [['workspace', 'close', 'w8']]);
  assert.deepEqual(Object.keys(sb.state().workspaces), ['w2']);
  assert.equal(typeof readRoom('x')?.closedAt, 'number');
});

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [MAITRE, ...args], { env: sb.env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('maitre room open/list/send/close end to end with the fake herdr', () => {
  const open = cli(['room', 'open', 'Nf Bug', '--model', 'haiku', '--task', 'simple', '--brief', '-starts with a dash']);
  assert.equal(open.status, 0, open.stderr);
  assert.equal(open.stdout, 'opened nf-bug in scratch on haiku\n');
  assert.equal(readFileSync(join(roomDir('nf-bug'), 'brief.md'), 'utf8'), `${BRIEF_HEADER}\n\n-starts with a dash`);

  const list = cli(['room', 'list']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^nf-bug {2}scratch {2}haiku {2}idle {2}coffee\n$/);

  const send = cli(['room', 'send', 'nf-bug', '--model is just text']);
  assert.equal(send.status, 0, send.stderr);
  assert.equal(send.stdout, 'sent to nf-bug\n');
  assert.equal(herdrCalls('agent', 'prompt').at(-1)?.[3], '--model is just text');

  const close = cli(['room', 'close', 'nf-bug']);
  assert.equal(close.status, 0, close.stderr);
  assert.equal(close.stdout, 'closed nf-bug\n');

  const gone = cli(['room', 'send', 'nf-bug', 'hi']);
  assert.equal(gone.status, 1);
  assert.equal(gone.stderr, 'maitre: room nf-bug is not running — open it again with: maitre room open …\n');
});

test('maitre room open takes the brief from a file, and room send to a blocked room exits 1 with one line', () => {
  const file = join(sb.dir, 'req.md');
  writeFileSync(file, HOSTILE);
  const open = cli(['room', 'open', 'x', '--model', 'sonnet', '--task', 'change', '--brief-file', file]);
  assert.equal(open.status, 0, open.stderr);
  assert.equal(readFileSync(join(roomDir('x'), 'brief.md'), 'utf8'), `${BRIEF_HEADER}\n\n${HOSTILE}`);
  const s = sb.state();
  s.panes['w1:p1'].agent = 'blocked';
  sb.setState(s);
  const r = cli(['room', 'send', 'x', 'hi']);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'maitre: room x is waiting on you — answer it in its tab\n');
});

test('maitre room send to a busy room says it will see it during this turn', () => {
  const open = cli(['room', 'open', 'x', '--model', 'sonnet', '--task', 'change', '--brief', 'b']);
  assert.equal(open.status, 0, open.stderr);
  const s = sb.state();
  s.panes['w1:p1'].agent = 'working';
  sb.setState(s);
  const r = spawnSync(process.execPath, [MAITRE, 'room', 'send', 'x', 'later'], {
    env: { ...sb.env, FAKE_HERDR_PROMPT_HOOK: '0', MAITRE_SEND_CONFIRM_MS: '300' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "sent to x — it's busy and will see it during this turn\n");
});

test('maitre room list with no rooms says so', () => {
  const r = cli(['room', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'no rooms\n');
});

test('a hand-made registry entry without herdr ids is not running', async () => {
  mkdirSync(roomDir('old'), { recursive: true });
  writeRoom({ room: 'old', kind: 'scratch', dir: '/nowhere', model: 'haiku', taskType: 'simple', createdAt: 1 });
  appendFileSync(join(roomDir('old'), 'events.jsonl'), '');
  assert.deepEqual(await listRoomRows(), [{ room: 'old', model: 'haiku', herdr: 'not running', lounge: '-' }]);
  writeRoom({ room: 'old', kind: 'scratch', dir: '/nowhere', taskType: 'simple', createdAt: 1 } as unknown as RoomRecord);
  assert.deepEqual(await listRoomRows(), [{ room: 'old', model: '-', herdr: 'not running', lounge: '-' }]);
});
