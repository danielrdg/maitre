import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookLine } from '../src/events.js';
import { HerdrError, shellQuote } from '../src/herdr.js';
import { roomDir } from '../src/paths.js';
import { readPr, writePr } from '../src/pr-state.js';
import { writeIndex, type Project } from '../src/projects.js';
import { closeRoom } from '../src/janitor.js';
import { BRIEF_HEADER, deliverToRoom, describeDelivery, inputText, listRoomRows, markNotRunning, openRoom, promptMatches, roomLabel, sendToRoom, unwrapPasted } from '../src/room-open.js';
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
  await assert.rejects(sendToRoom('x', 'hi'), /^Error: room x is not running — wake it with: maitre room wake x$/);
  assert.equal(typeof readRoom('x')?.closedAt, 'number');
  assert.deepEqual(herdrCalls('agent', 'prompt'), []);
  // A record from before the wake stamp (its Claude died before the upgrade): not offered, but its session is known.
  const { resumable: _r, ...old } = readRoom('x')!;
  writeRoom(old);
  await assert.rejects(sendToRoom('x', 'hi'), /^Error: room x is not running — open it again with: maitre room open … \(or, if its Claude crashed, wake it with: maitre room wake x\)$/);
  writeFileSync(join(roomDir('x'), 'events.jsonl'), '');
  await assert.rejects(sendToRoom('x', 'hi'), /^Error: room x is not running — open it again with: maitre room open …$/, 'no session to resume');
});

test('room open refuses a parked room (a seat on its record): wake it, or close it first; nothing is touched', async () => {
  await openScratch();
  writePr('x', { url: 'https://github.com/o/r/pull/7', number: 7, state: 'OPEN', headRefName: 'maitre/x', seenAt: Date.now(), failing: [] });
  const parked = { ...readRoom('x')!, seat: { releasedAt: Date.now(), session: 's1' } };
  writeRoom(parked);
  sb.setState({ ...sb.state(), workspaces: {}, panes: {} });
  const before = herdrCalls('workspace', 'create').length;
  await assert.rejects(openScratch(), /^Error: room x is parked — wake it with: maitre room wake x \(or close it first with: maitre room close x\)$/);
  assert.equal(herdrCalls('workspace', 'create').length, before);
  assert.deepEqual(readRoom('x'), parked);
  assert.equal(readPr('x')?.number, 7);
  await closeRoom('x', process.env, { exitTimeoutMs: 200 });
  assert.equal(readRoom('x')!.closedBy, 'user');
  await openScratch();
  assert.equal(readRoom('x')!.seat, undefined, 'the close the message points at lets it open fresh');
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

const enters = () => sb.calls().filter((c) => c[0] === 'agent' && c[1] === 'send-keys' && c.slice(3).join(' ') === 'enter');

test('a request left typed in the input box gets one more Enter, and is confirmed then', async () => {
  await openScratch();
  process.env.FAKE_HERDR_PROMPT_HOOK = 'typed';
  assert.deepEqual(await deliverToRoom('x', 'check the logout too', process.env, { confirmMs: 300 }), { result: 'delivered', busy: false });
  assert.equal(enters().length, 1);
});

test('a request still unsent after that Enter is reported typed, to be sent by hand', async () => {
  await openScratch();
  process.env.FAKE_HERDR_PROMPT_HOOK = 'typed-stuck';
  const r = await deliverToRoom('x', 'check the logout too', process.env, { confirmMs: 300 });
  assert.deepEqual(r, { result: 'unsent', busy: false });
  assert.equal(enters().length, 1, 'one Enter, not more');
  assert.equal(describeDelivery('x', r), "typed into x's input but not sent — press Enter in its tab");
});

test("text in the input box that maître did not type never gets an Enter: the request is reported unsent", async () => {
  await openScratch();
  const st = sb.state();
  st.panes['w1:p1']!.screen = `${'─'.repeat(40)}\n❯\u00a0my own draft\n${'─'.repeat(40)}\n`;
  sb.setState(st);
  process.env.FAKE_HERDR_PROMPT_HOOK = '0';
  assert.deepEqual(await deliverToRoom('x', 'check the logout too', process.env, { confirmMs: 300 }), { result: 'unsent', busy: false });
  assert.deepEqual(enters(), []);
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
    { room: 'b', model: 'sonnet', herdr: 'not running', lounge: 'parked — wake: maitre room wake b' },
  ]);
  assert.equal(typeof readRoom('b')?.closedAt, 'number');
  assert.equal(readRoom('a')?.closedAt, undefined);
});

test('room close exits an idle room, closes its tab, keeps its directory and marks it closed', async () => {
  const rec = await openScratch();
  const closed = await closeRoom('x', process.env, { exitTimeoutMs: 2000 });
  assert.ok(!('dequeued' in closed));
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
  assert.match(close.stdout, /^writing the minutes…\nclosed nf-bug\nminutes: \S+-nf-bug\.md\n$/);

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

test('reopening a not-running room writes a fresh record without closedAt, closedBy or couch', async () => {
  await openScratch();
  writeRoom({ ...readRoom('x')!, closedAt: 1, closedBy: 'janitor', couch: { since: 2, reasons: ['idle'] } });
  sb.setState({ next: 2, workspaces: {}, panes: {} });
  await openScratch();
  const rec = readRoom('x')!;
  assert.equal(rec.closedAt, undefined);
  assert.equal(rec.closedBy, undefined);
  assert.equal(rec.couch, undefined);
  assert.ok(rec.herdr);
});

// Shaped like `herdr pane read --source visible --format ansi` of a real Claude Code room (scrubbed):
// grey rules, the input line between them.
const ESC = '\x1b';
const RULE = `${ESC}[0m${ESC}[38;2;136;136;136m${'─'.repeat(60)}${ESC}[0m\r`;
const HISTORY = `${ESC}[0m${ESC}[38;2;153;153;153m${ESC}[48;2;55;55;55m❯ ${ESC}[0m${ESC}[38;2;255;255;255m${ESC}[48;2;55;55;55mReply with ok.${ESC}[0m\r`;
const boxed = (...inner: string[]) => [HISTORY, '● ok', '✻ Baked for 2s', RULE, ...inner, RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)', ''].join('\n');

test('inputText: an empty box, and the dim placeholder of a fresh room, are empty', () => {
  assert.equal(inputText(boxed('❯\u00a0\r')), '');
  assert.equal(inputText(boxed('❯')), '');
  assert.equal(inputText(boxed(`❯\u00a0${ESC}[0m${ESC}[2mTry "edit <filepath> to…"${ESC}[0m\r`)), '');
});

test('inputText: typed text is a draft, plain, coloured (truecolor holds a 2) or on several lines', () => {
  assert.equal(inputText(boxed('❯\u00a0draft text\r')), 'draft text');
  assert.equal(inputText(boxed(`❯\u00a0${ESC}[38;2;255;255;255m${ESC}[48;2;55;55;55mdraft${ESC}[0m`)), 'draft');
  assert.equal(inputText(boxed(`❯\u00a0${ESC}[38;5;2mdraft${ESC}[0m`)), 'draft');
  assert.equal(inputText(boxed('❯\u00a0first line', '  second line')), 'first line\n  second line');
  assert.equal(inputText(boxed('❯\u00a0', '  only the second line')), '\n  only the second line');
  assert.equal(inputText(boxed(`❯\u00a0${ESC}[2mdim ${ESC}[22mbold-off text`)), 'dim bold-off text');
});

test('inputText: spaces are text: a box holding only spaces is a draft, only the one separator after ❯ is not', () => {
  assert.equal(inputText(boxed('❯\u00a0   \r')), '   ');
  assert.equal(inputText(boxed('❯\u00a0 ')), ' ');
  assert.equal(inputText(boxed('❯ ')), '');
  assert.equal(inputText(boxed('❯\u00a0', '')), '\n', 'an empty second line is a newline typed');
});

test('inputText: dim text is dropped only when it is the placeholder alone; other dim content is a draft', () => {
  assert.equal(inputText(boxed(`❯\u00a0${ESC}[2mTry "fix the tests"${ESC}[0m`)), '');
  assert.equal(inputText(boxed(`❯\u00a0${ESC}[2m[Pasted text #1 +3 lines]${ESC}[0m`)), '[Pasted text #1 +3 lines]');
  assert.equal(inputText(boxed(`❯\u00a0${ESC}[2m[Image #1]${ESC}[0m`)), '[Image #1]');
  assert.equal(inputText(boxed(`❯\u00a0${ESC}[2mTry "fix the tests"${ESC}[0m and more`)), 'Try "fix the tests" and more');
  assert.equal(inputText(boxed(`❯\u00a0${ESC}[2mTry "fix the tests"${ESC}[0m`, `${ESC}[2mmore${ESC}[0m`)), 'Try "fix the tests"\nmore');
});

test('inputText: only the bottom pair of rules is the box: a rule typed in a draft, or a box without ❯, never falls back', () => {
  for (const rule of ['  ────────────', '────────────']) {
    assert.notEqual(inputText(boxed('❯\u00a0', rule, '  real text')), '', 'a rule inside a draft');
  }
  assert.equal(inputText([RULE, '❯\u00a0', RULE, '! ls -la', RULE, ''].join('\n')), undefined, 'a bash-mode box below an empty ❯ line');
  assert.equal(inputText([RULE, '❯\u00a0', RULE, '# remember this', RULE, ''].join('\n')), undefined, 'a memory-mode box');
});

test('inputText: no input box on screen (a history line, a dialog, a shell) is undefined', () => {
  assert.equal(inputText(`${HISTORY}\n● ok\n`), undefined);
  assert.equal(inputText(' Is this a project you trust?\n ❯ 1. No, exit\n   2. Yes, I trust this folder\n'), undefined);
  assert.equal(inputText('$ \n'), undefined);
  assert.equal(inputText(`${RULE}\n  something else\n${RULE}\n`), undefined);
});

test('a room list racing a close by hand keeps closedBy: only closedAt is ever added, to the record on disk', async () => {
  const rec = await openRoom({ name: 'a', model: 'sonnet', taskType: 'change', brief: 'do it' }, process.env, FAST);
  sb.setState({ ...sb.state(), workspaces: {}, panes: {} });
  const file = join(roomDir('a'), 'room.json');
  const closed = join(sb.dir, 'closed-room.json');
  writeFileSync(closed, JSON.stringify({ ...rec, closedAt: 1, closedBy: 'user' }));
  // The close lands between the list reading the records and marking this one not running.
  process.env.FAKE_HERDR_THEN_workspace_list = JSON.stringify([closed, file]);
  await listRoomRows(process.env, { queue: false });
  assert.deepEqual([readRoom('a')!.closedBy, readRoom('a')!.closedAt], ['user', 1]);

  const reopened = { ...rec, createdAt: rec.createdAt + 1 };
  writeRoom(reopened);
  markNotRunning(rec);
  assert.deepEqual(readRoom('a'), reopened, 'a reopen in between is never overwritten');
  markNotRunning(reopened);
  assert.equal(typeof readRoom('a')!.closedAt, 'number');
});

test('room list shows a couch that holds with its reasons, a dead room\'s pending reasons, and closed rooms as closed', async () => {
  for (const name of ['a', 'b', 'c', 'd', 'e']) await openScratch(name);
  const now = Date.now() + 1000;
  const append = (room: string, line: Partial<HookLine>) =>
    appendFileSync(join(roomDir(room), 'events.jsonl'), JSON.stringify({ v: 1, room, session: 's1', ...line }) + '\n');
  writeRoom({ ...readRoom('a')!, couch: { since: now, reasons: ['uncommitted changes: f.txt', 'an open PR'] } });
  append('a', { ts: now + 5, event: 'Notification', notification_type: 'idle_prompt' });
  writeRoom({ ...readRoom('b')!, couch: { since: now, reasons: ['uncommitted changes'] } });
  append('b', { ts: now + 5, event: 'UserPromptSubmit', prompt: 'more' });
  append('b', { ts: now + 6, event: 'Stop' });
  writeRoom({ ...readRoom('c')!, couch: { since: now, reasons: ['left from when it ran'] }, pending: { since: now, reasons: ['2 commits not pushed'] } });
  writeRoom({ ...readRoom('d')!, closedAt: now, closedBy: 'user' });
  const s = sb.state();
  for (const room of ['c', 'd']) {
    const ws = readRoom(room)!.herdr!.workspaceId;
    delete s.workspaces[ws];
    delete s.panes[`${ws}:p1`];
  }
  sb.setState(s);
  assert.deepEqual(
    (await listRoomRows()).map((r) => [r.room, r.herdr, r.lounge]),
    [
      ['a', 'idle', 'couch: uncommitted changes: f.txt; an open PR'],
      ['b', 'idle', 'ready'],
      ['c', 'not running', 'parked, pending: 2 commits not pushed — wake: maitre room wake c'],
      ['d', 'not running', 'closed'],
      ['e', 'idle', 'coffee'],
    ],
  );
});

test('a fresh open of a room name drops the pr.json and pr-seek.json an earlier opening left; a failed open keeps them', async () => {
  project();
  const first = await openRoom({ name: 'a', project: 'proj', model: 'sonnet', taskType: 'change', brief: 'do it' }, process.env, FAST);
  writePr('a', { url: 'https://github.com/o/r/pull/7', number: 7, state: 'MERGED', headRefName: first.branch!, seenAt: Date.now(), failing: [] });
  writeFileSync(join(roomDir('a'), 'pr-seek.json'), JSON.stringify({ discoveredAt: Date.now() }));
  sb.setState({ ...sb.state(), workspaces: {}, panes: {} });

  process.env.FAKE_HERDR_ON_RUN = 'shell';
  await assert.rejects(openRoom({ name: 'a', project: 'proj', model: 'sonnet', taskType: 'change', brief: 'again' }, process.env, { trustTimeoutMs: 200, pollMs: 10 }), /did not start/);
  assert.equal(readPr('a')?.state, 'MERGED', 'a failed open changes nothing');
  assert.ok(existsSync(join(roomDir('a'), 'pr-seek.json')));

  delete process.env.FAKE_HERDR_ON_RUN;
  await openRoom({ name: 'a', project: 'proj', model: 'sonnet', taskType: 'change', brief: 'again' }, process.env, FAST);
  assert.equal(readPr('a'), undefined);
  assert.equal(existsSync(join(roomDir('a'), 'pr.json')), false);
  assert.equal(existsSync(join(roomDir('a'), 'pr-seek.json')), false);
});

test('room list shows a PR notice, filtered and clipped, until the room\'s next real prompt', async () => {
  for (const name of ['a', 'b']) await openScratch(name);
  for (const name of ['a', 'b']) writeRoom({ ...readRoom(name)!, branch: `maitre/${name}` });
  const since = Date.now() + 1000;
  const notice = (text: string) => ({ kind: 'review' as const, text, url: 'https://github.com/o/r/pull/7', since });
  const pr = (name: string, text: string) => writePr(name, { url: 'https://github.com/o/r/pull/7', number: 7, state: 'OPEN', headRefName: `maitre/${name}`, seenAt: since, failing: [], notice: notice(text) });
  pr('a', `New comment from \u202erev ${'x'.repeat(200)}`);
  pr('b', 'New review from rev');
  appendFileSync(join(roomDir('b'), 'events.jsonl'), JSON.stringify({ v: 1, room: 'b', session: 's1', ts: since + 5, event: 'UserPromptSubmit', prompt: 'look' }) + '\n');
  const rows = Object.fromEntries((await listRoomRows(process.env, { queue: false })).map((r) => [r.room, r.lounge]));
  assert.match(rows.a!, /^coffee; PR review: New comment from \?rev x+…$/);
  assert.ok(rows.a!.length < 140, rows.a);
  assert.equal(rows.b, 'work', 'read: a real prompt after it');
});
