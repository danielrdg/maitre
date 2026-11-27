import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, parseArgs } from '../src/cli.js';
import { shellQuote } from '../src/herdr.js';
import { receptionSettings, writeReceptionSettings } from '../src/hook-settings.js';
import { buildReceptionCommand, startMaitre } from '../src/reception.js';
import { roomDir } from '../src/paths.js';
import { reserve } from '../src/queue.js';
import { WORST_DELIVERY_MS } from '../src/room-open.js';
import { WORST_WAKE_MS } from '../src/wake.js';
import { readRoom, writeRoom, type RoomRecord } from '../src/rooms.js';
import { trustScope } from '../src/trust.js';
import { fakeBin } from './fake-bin.js';
import { herdrSandbox, type HerdrSandbox } from './herdr-sandbox.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAITRE = join(ROOT, 'bin', 'maitre');
const GUARD = join(ROOT, 'hooks', 'reception-guard.mjs');
const REQUEST = join(ROOT, 'hooks', 'reception-request.mjs');
const PROMPT = readFileSync(join(ROOT, 'reception', 'PROMPT.md'), 'utf8');
const FAST = { trustTimeoutMs: 120_000, pollMs: 10, loungeWaitMs: 120_000 };
const KEY = 'ab'.repeat(32);
const TICKET = 'cd'.repeat(32);
const SERVICE_NOTE = 'lounge: run maitre open or use the maître icon';
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_ENTRYPOINT'];

interface Hook {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}
interface Settings {
  permissions: { allow: string[] };
  hooks: Record<string, Hook[]>;
}

test('receptionSettings: Bash(maitre:*), the request hook (also the started marker) and a fail-closed guard on every tool', () => {
  const s = receptionSettings({ requestHook: '/opt/m/hooks/reception-request.mjs', guardHook: '/opt/m/hooks/reception-guard.mjs', nodePath: '/opt/node' });
  const request = { type: 'command', command: '"/opt/node" "/opt/m/hooks/reception-request.mjs"' };
  assert.deepEqual(s, {
    permissions: { allow: ['Bash(maitre:*)'] },
    env: { BASH_DEFAULT_TIMEOUT_MS: '300000' },
    hooks: {
      UserPromptSubmit: [{ hooks: [request] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: '"/opt/node" "/opt/m/hooks/reception-guard.mjs" || exit 2' }] }],
      SessionStart: [{ hooks: [request] }],
    },
  });
});

test("the terminal reception's Bash timeout covers a dispatch's worst case (wake and delivery) with a margin", () => {
  const s = receptionSettings({ requestHook: '/r.mjs', guardHook: '/g.mjs', nodePath: '/n' }) as { env: Record<string, string> };
  assert.ok(Number(s.env.BASH_DEFAULT_TIMEOUT_MS) >= WORST_WAKE_MS + WORST_DELIVERY_MS + 60_000);
});

test('receptionSettings re-adds herdr\'s own state hook the way herdr registers it', () => {
  const s = receptionSettings({ requestHook: '/r.mjs', guardHook: '/g.mjs', nodePath: '/n', herdrHook: '/home/u/.claude/hooks/herdr-agent-state.sh' }) as Settings;
  assert.deepEqual(s.hooks.SessionStart, [
    { hooks: [{ type: 'command', command: '"/n" "/r.mjs"' }] },
    { matcher: '*', hooks: [{ type: 'command', command: 'bash "/home/u/.claude/hooks/herdr-agent-state.sh" session', timeout: 10 }] },
  ]);
  assert.throws(() => receptionSettings({ requestHook: '/r.mjs', guardHook: '/g.mjs', herdrHook: '/home/$x/h.sh' }), /unsafe path/);
});

test('the guard command blocks (exit 2) when node or the script is missing', () => {
  for (const s of [
    receptionSettings({ requestHook: REQUEST, guardHook: GUARD, nodePath: '/nonexistent/node' }),
    receptionSettings({ requestHook: REQUEST, guardHook: '/nonexistent/guard.mjs' }),
  ] as Settings[]) {
    const r = spawnSync('sh', ['-c', s.hooks.PreToolUse![0]!.hooks[0]!.command], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'maitre projects' } }),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    assert.equal(r.status, 2);
  }
});

test('writeReceptionSettings writes settings/reception.json, with the herdr hook only when it exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-settings-'));
  const user = mkdtempSync(join(tmpdir(), 'maitre-user-'));
  try {
    const path = writeReceptionSettings({ MAITRE_HOME: home }, user);
    assert.equal(path, join(home, 'settings', 'reception.json'));
    const without = JSON.parse(readFileSync(path, 'utf8')) as Settings;
    assert.deepEqual(without, receptionSettings({ requestHook: REQUEST, guardHook: GUARD }));
    assert.equal(without.hooks.SessionStart!.length, 1);

    const hook = join(user, '.claude', 'hooks', 'herdr-agent-state.sh');
    mkdirSync(join(user, '.claude', 'hooks'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\n');
    writeReceptionSettings({ MAITRE_HOME: home }, user);
    const withHook = JSON.parse(readFileSync(path, 'utf8')) as Settings;
    assert.deepEqual(withHook, receptionSettings({ requestHook: REQUEST, guardHook: GUARD, herdrHook: hook }));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
  }
});

test('the guard command in the settings runs through sh -c and denies a non-maitre command', () => {
  const s = receptionSettings({ requestHook: REQUEST, guardHook: GUARD }) as Settings;
  const r = spawnSync('sh', ['-c', s.hooks.PreToolUse![0]!.hooks[0]!.command], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('buildReceptionCommand is exactly the reception call, with markers stripped and maître first on PATH', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-home-'));
  try {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', MAITRE_HOME: home, KEEP: '1' };
    for (const k of MARKERS) env[k] = 'x';
    env.ANTHROPIC_API_KEY = 'k';
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    const { cmd, args, env: out } = buildReceptionCommand(env);
    assert.equal(cmd, 'claude');
    assert.deepEqual(args, [
      '--model', 'sonnet',
      '--setting-sources', '',
      '--tools', 'Bash',
      '--permission-mode', 'auto',
      '--settings', join(home, 'settings', 'reception.json'),
      '--append-system-prompt', PROMPT,
    ]);
    for (const k of MARKERS) assert.equal(out[k], undefined, k);
    assert.equal(out.ANTHROPIC_API_KEY, 'k');
    assert.equal(out.CLAUDE_CODE_USE_BEDROCK, '1');
    assert.equal(out.PATH, `${join(ROOT, 'bin')}${delimiter}/usr/bin`);
    assert.equal(out.MAITRE_HOME, home);
    assert.equal(out.KEEP, '1');
    assert.ok(existsSync(join(home, 'settings', 'reception.json')));
    const dir = join(home, 'reception');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildReceptionCommand: a relative MAITRE_HOME becomes absolute; MAITRE_RECEPTION_MODEL overrides the model for tests', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'maitre-cwd-'));
  const prev = process.cwd();
  try {
    process.chdir(cwd);
    const { args, env } = buildReceptionCommand({ MAITRE_HOME: 'rel', MAITRE_RECEPTION_MODEL: 'haiku' });
    assert.equal(env.MAITRE_HOME, join(cwd, 'rel'));
    assert.deepEqual(args.slice(0, 2), ['--model', 'haiku']);
    assert.throws(() => buildReceptionCommand({ MAITRE_HOME: 'rel', MAITRE_RECEPTION_MODEL: 'x; rm -rf ~' }), /invalid model/);
  } finally {
    process.chdir(prev);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('trust: the reception directory itself is answered, nothing under or beside it', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-home-'));
  try {
    const env = { MAITRE_HOME: home };
    const dir = join(home, 'reception');
    mkdirSync(join(dir, 'requests'), { recursive: true });
    mkdirSync(join(home, 'reception-evil'));
    const outside = mkdtempSync(join(tmpdir(), 'maitre-out-'));
    const elsewhere = join(outside, 'reception');
    symlinkSync(dir, elsewhere);
    try {
      assert.equal(trustScope(dir, env), 'answer');
      assert.equal(trustScope(`${dir}/`, env), 'answer');
      assert.equal(trustScope(elsewhere, env), 'answer', 'a link resolving to the reception is the reception');
      assert.equal(trustScope(join(dir, 'requests'), env), 'outside');
      assert.equal(trustScope(join(home, 'reception-evil'), env), 'outside');
      assert.equal(trustScope(home, env), 'outside');
      assert.equal(trustScope(join(outside), env), 'outside');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('PROMPT.md is short, English, and every maitre command it names exists in HELP', () => {
  const words = PROMPT.split(/\s+/).filter((w) => w !== '');
  assert.ok(words.length <= 1500, `${words.length} words`);
  const named = new Set([...PROMPT.matchAll(/\bmaitre ((?:room )?[a-z]+)/g)].map((m) => m[1]));
  for (const cmd of ['route', 'dispatch', 'room list', 'room close', 'projects']) assert.ok(named.has(cmd), cmd);
  for (const cmd of named) assert.ok(HELP.includes(`  maitre ${cmd}`), `${cmd} is in HELP`);
  assert.deepEqual([...named].sort(), ['dispatch', 'projects', 'room close', 'room list', 'route']);
  assert.match(PROMPT, /at most 32 ids/);
  assert.match(PROMPT, /without a request id/);
  assert.match(PROMPT, /never reuse an earlier id/);
});

test('PROMPT.md replies follow what the commands print: queued, closed with minutes, removed from the queue', () => {
  assert.match(PROMPT, /"queued: nf-bug waits for a seat \(position 2\)"/);
  assert.match(PROMPT, /`maitre room close <slug>` — write a room's minutes/);
  assert.match(PROMPT, /"removed nf-bug from the queue"/);
  assert.doesNotMatch(PROMPT, /reply "closed nf-bug"\./);
});

test('parseArgs: no arguments is the entrypoint, reception is the pane command', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'start' });
  assert.deepEqual(parseArgs(['reception']), { cmd: 'reception' });
  assert.equal(parseArgs(['reception', 'x']).cmd, 'usage');
  assert.match(HELP, /^ {2}maitre\n/m);
});

let sb: HerdrSandbox;
let server: Server;
let loungeUrl: string;
let ticketUrl: string;
let loungeInfo: { port: number; token: string; pid: number };

// Stands in for the lounge a `lounge` tab starts: the fake herdr claims lounge.json with loungeInfo.
beforeEach(async () => {
  sb = herdrSandbox();
  server = createServer((req, res) => {
    if (req.url === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'maitre', pid: process.pid }));
    } else if (req.url === '/api/ticket' && req.method === 'POST' && req.headers['x-maitre-token'] === KEY) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ticket: TICKET }));
    } else {
      res.writeHead(403);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  loungeUrl = `http://127.0.0.1:${port}/?key=${KEY}`;
  ticketUrl = `http://127.0.0.1:${port}/?ticket=${TICKET}`;
  loungeInfo = { port, token: KEY, pid: process.pid };
  process.env.FAKE_HERDR_LOUNGE_URL = loungeUrl;
  process.env.FAKE_HERDR_LOUNGE_INFO = JSON.stringify(loungeInfo);
});

afterEach(async () => {
  sb.restore();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const herdrCalls = (a: string, b: string) => sb.calls().filter((c) => c[0] === a && c[1] === b);
const labels = () => Object.values(sb.state().workspaces).map((w) => w.label).sort();

test('maitre: creates the reception and the lounge once, quoted tokens only, and opens the lounge', async () => {
  const opened: string[] = [];
  const r = await startMaitre(process.env, { ...FAST, open: (u) => opened.push(u) });
  assert.deepEqual(r.created, ['reception', 'lounge']);
  assert.equal(r.url, loungeUrl);
  assert.deepEqual(opened, [ticketUrl]);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(labels(), ['lounge', 'reception']);

  const dir = join(sb.home, 'reception');
  assert.deepEqual(herdrCalls('workspace', 'create'), [
    ['workspace', 'create', '--cwd', dir, '--label', 'reception', '--env', `MAITRE_HOME=${sb.home}`, '--env', 'MAITRE_HERDR_SESSION=maitre-test', '--no-focus'],
    ['workspace', 'create', '--cwd', sb.home, '--label', 'lounge', '--env', `MAITRE_HOME=${sb.home}`, '--env', 'MAITRE_HERDR_SESSION=maitre-test', '--no-focus'],
  ]);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const runs = herdrCalls('pane', 'run').map((c) => c[3]);
  assert.deepEqual(runs, [
    [MAITRE, 'reception'].map(shellQuote).join(' '),
    [MAITRE, 'lounge', '--no-open'].map(shellQuote).join(' '),
  ]);
  assert.deepEqual(herdrCalls('workspace', 'focus'), [['workspace', 'focus', 'w1']]);

  const before = sb.calls().length;
  const again = await startMaitre(process.env, { ...FAST, open: (u) => opened.push(u) });
  assert.deepEqual(again.created, []);
  assert.deepEqual(labels(), ['lounge', 'reception']);
  const later = sb.calls().slice(before);
  for (const c of later) assert.ok(!['create', 'close', 'run', 'send-keys'].includes(c[1]!), JSON.stringify(c));
  assert.deepEqual(opened, [ticketUrl], 'a running lounge is not opened again');
  assert.deepEqual(again.notes, []);
});

test('maitre: the test-only model override reaches the reception pane', async () => {
  process.env.MAITRE_RECEPTION_MODEL = 'haiku';
  await startMaitre(process.env, { ...FAST, open: () => {} });
  assert.ok(herdrCalls('workspace', 'create')[0]!.includes('MAITRE_RECEPTION_MODEL=haiku'));
});

test('maitre: a restored bare-shell reception and a dead lounge are closed and recreated', async () => {
  await startMaitre(process.env, { ...FAST, open: () => {} });
  const st = sb.state();
  // herdr restored both tabs as bare shells with new ids after a restart.
  st.workspaces = { w7: { label: 'reception' }, w8: { label: 'lounge' }, w9: { label: 'mine' } };
  st.panes = { 'w7:p1': { ws: 'w7', agent: 'shell' }, 'w8:p1': { ws: 'w8', agent: 'shell' }, 'w9:p1': { ws: 'w9', agent: 'idle' } };
  st.next = 10;
  sb.setState(st);
  // The lounge died with herdr's restart and released lounge.json.
  writeFileSync(join(sb.home, 'lounge.json'), JSON.stringify({ ...loungeInfo, pid: 0 }));
  const r = await startMaitre(process.env, { ...FAST, open: () => {} });
  assert.deepEqual(r.created, ['reception', 'lounge']);
  assert.deepEqual(Object.keys(sb.state().workspaces).sort(), ['w10', 'w11', 'w9']);
  assert.deepEqual(labels(), ['lounge', 'mine', 'reception']);
});

test('maitre: a recorded reception tab whose Claude exited (bare shell, same ids) is replaced', async () => {
  await startMaitre(process.env, { ...FAST, open: () => {} });
  const st = sb.state();
  st.panes['w1:p1']!.agent = 'shell';
  sb.setState(st);
  const r = await startMaitre(process.env, { ...FAST, open: () => {} });
  assert.deepEqual(r.created, ['reception']);
  assert.equal(sb.state().workspaces.w1, undefined);
});

test('maitre: a lounge that stopped answering is replaced', async () => {
  await startMaitre(process.env, { ...FAST, open: () => {} });
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  server = createServer((_req, res) => res.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const r = await startMaitre(process.env, { ...FAST, open: () => {} });
  assert.deepEqual(r.created, ['lounge']);
});

test('maitre: the lounge URL is read even when the pane wraps it', async () => {
  process.env.FAKE_HERDR_WRAP = '37';
  const r = await startMaitre(process.env, { ...FAST, open: () => {} });
  assert.equal(r.url, loungeUrl);
});

test('maitre: stale room tabs are closed and marked not running; live rooms are left alone', async () => {
  const rec = (room: string, workspaceId: string): RoomRecord => ({
    room, kind: 'scratch', dir: join(sb.home, 'scratch', room), model: 'sonnet', taskType: 'simple',
    herdr: { session: 'maitre-test', workspaceId, paneId: `${workspaceId}:p1` }, createdAt: 1,
  });
  writeRoom(rec('live', 'w1'));
  writeRoom(rec('gone', 'w2'));
  writeRoom({ ...rec('closed', 'w4'), closedAt: 5 });
  sb.setState({
    next: 5,
    workspaces: { w1: { label: 'scratch / live' }, w3: { label: 'scratch / gone' }, w4: { label: 'scratch / closed' } },
    panes: { 'w1:p1': { ws: 'w1', agent: 'working' }, 'w3:p1': { ws: 'w3', agent: 'shell' }, 'w4:p1': { ws: 'w4', agent: 'shell' } },
  });
  const r = await startMaitre(process.env, { ...FAST, open: () => {} });
  assert.deepEqual(r.closedRooms.sort(), ['closed', 'gone']);
  const ws = sb.state().workspaces;
  assert.equal(ws.w1?.label, 'scratch / live');
  assert.equal(ws.w3, undefined);
  assert.equal(ws.w4, undefined);
  assert.equal(readRoom('live')!.closedAt, undefined);
  assert.equal(typeof readRoom('gone')!.closedAt, 'number');
  assert.equal(readRoom('closed')!.closedAt, 5);
});

test('maitre: a room being woken (its opening reservation held) keeps its new tab while the record still names the old one', async () => {
  writeRoom({
    room: 'waking', kind: 'scratch', dir: join(sb.home, 'scratch', 'waking'), model: 'sonnet', taskType: 'simple',
    herdr: { session: 'maitre-test', workspaceId: 'w2', paneId: 'w2:p1' }, createdAt: 1, closedAt: 5,
  });
  sb.setState({ next: 4, workspaces: { w3: { label: 'scratch / waking' } }, panes: { 'w3:p1': { ws: 'w3', agent: 'idle' } } });
  const release = await reserve('waking');
  try {
    const r = await startMaitre(process.env, { ...FAST, open: () => {} });
    assert.deepEqual(r.closedRooms, []);
    assert.equal(sb.state().workspaces.w3?.label, 'scratch / waking', 'the resume in it goes on');
    assert.equal(readRoom('waking')!.closedAt, 5);
  } finally {
    release();
  }
});

test("maitre: a room left still starting in its tab (its wake's starting note is the newest event) keeps its tab", async () => {
  writeRoom({
    room: 'slow', kind: 'scratch', dir: join(sb.home, 'scratch', 'slow'), model: 'sonnet', taskType: 'simple',
    herdr: { session: 'maitre-test', workspaceId: 'w3', paneId: 'w3:p1' }, createdAt: 1, resumable: true,
  });
  mkdirSync(roomDir('slow'), { recursive: true });
  const line = (l: Record<string, unknown>) => JSON.stringify({ v: 1, ts: Date.now(), room: 'slow', session: 's1', ...l });
  writeFileSync(join(roomDir('slow'), 'events.jsonl'), [line({ event: 'SessionStart' }), line({ event: 'SessionEnd' }), line({ event: 'MaitreStatus', session: '', status: 'blocked', text: 'Room is still starting — check its tab', options: [], starting: true, resumes: 's1' })].join('\n') + '\n');
  sb.setState({ next: 4, workspaces: { w3: { label: 'scratch / slow' } }, panes: { 'w3:p1': { ws: 'w3', agent: 'shell' } } });
  const r = await startMaitre(process.env, { ...FAST, open: () => {} });
  assert.deepEqual(r.closedRooms, []);
  assert.equal(sb.state().workspaces.w3?.label, 'scratch / slow');
  assert.equal(readRoom('slow')!.closedAt, undefined);
});

test('maitre: the reception trust dialog is answered on screen', async () => {
  process.env.FAKE_HERDR_ON_RUN = 'trust';
  const r = await startMaitre(process.env, { ...FAST, open: () => {} });
  assert.equal(r.trust, 'accepted');
  assert.deepEqual(herdrCalls('agent', 'send-keys'), [['agent', 'send-keys', 'w1:p1', 'down', 'enter']]);
});

test('maitre: a live reception tab is kept even when tabs.json is missing or stale', async () => {
  sb.setState({ next: 5, workspaces: { w3: { label: 'reception' }, w4: { label: 'reception' } }, panes: { 'w3:p1': { ws: 'w3', agent: 'shell' }, 'w4:p1': { ws: 'w4', agent: 'idle' } } });
  const r = await startMaitre(process.env, { ...FAST, open: () => {} });
  assert.deepEqual(r.created, ['lounge']);
  assert.deepEqual(Object.keys(sb.state().workspaces).sort(), ['w4', 'w5']);
  assert.deepEqual(JSON.parse(readFileSync(join(sb.home, 'reception', 'tabs.json'), 'utf8')).reception, { workspaceId: 'w4', paneId: 'w4:p1' });

  writeFileSync(join(sb.home, 'reception', 'tabs.json'), JSON.stringify({ session: 'maitre-test', reception: { workspaceId: 'w1', paneId: 'w1:p1' } }));
  const again = await startMaitre(process.env, { ...FAST, open: () => {} });
  assert.deepEqual(again.created, []);
  assert.equal(sb.state().workspaces.w4?.label, 'reception');
  assert.equal(sb.state().workspaces.w5, undefined, 'a lounge tab without a recorded lounge pid is closed');
  assert.deepEqual(again.notes, [SERVICE_NOTE]);
});

test('maitre: the reception settles on its own SessionStart marker, and a stale marker never counts', async () => {
  mkdirSync(join(sb.home, 'reception'), { recursive: true });
  writeFileSync(join(sb.home, 'reception', 'session-started'), 'old');
  process.env.FAKE_HERDR_SESSION_START = '0';
  const r = await startMaitre(process.env, { trustTimeoutMs: 300, pollMs: 10, loungeWaitMs: 120_000, open: () => {} });
  assert.equal(r.trust, 'unresolved');
  assert.deepEqual(r.warnings, ['the reception is still starting — check its tab']);
  assert.equal(existsSync(join(sb.home, 'reception', 'session-started')), false);
});

test('maitre: a reception whose Claude never appears is a clear error', async () => {
  process.env.FAKE_HERDR_ON_RUN = 'shell';
  await assert.rejects(startMaitre(process.env, { trustTimeoutMs: 300, pollMs: 10, loungeWaitMs: 120_000, open: () => {} }), /the reception did not start/);
});

test('bin/maitre does not attach when the reception cannot start', async () => {
  const env = { ...sb.env, FAKE_HERDR_LOUNGE_URL: loungeUrl, FAKE_HERDR_ON_RUN: 'shell', MAITRE_TRUST_TIMEOUT_MS: '300' };
  const out = await new Promise<{ code: number | null; stderr: string }>((done) => {
    const c = spawn(process.execPath, [MAITRE], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    c.stderr.on('data', (d) => (stderr += d));
    c.on('exit', (code) => done({ code, stderr }));
  });
  assert.equal(out.code, 1);
  assert.match(out.stderr, /the reception did not start/);
  assert.notDeepEqual(sb.calls().at(-1), [], 'never attached');
});

test('bin/maitre with no arguments sets everything up, then attaches and exits with herdr\'s code', async () => {
  const env = { ...sb.env, FAKE_HERDR_LOUNGE_URL: loungeUrl, FAKE_HERDR_ATTACH_EXIT: '3' };
  const code = await new Promise<number | null>((done) => {
    const c = spawn(process.execPath, [MAITRE], { env, stdio: 'ignore' });
    c.on('exit', (n) => done(n));
  });
  assert.equal(code, 3);
  const calls = sb.calls();
  assert.deepEqual(calls.at(-1), []);
  assert.deepEqual(labels(), ['lounge', 'reception']);
});

// The window opener, with a display and a fake google-chrome as the only browser on PATH.
function withChrome(): { env: NodeJS.ProcessEnv; chrome: () => Promise<string[][]>; cleanup: () => void } {
  const fb = fakeBin();
  fb.add('google-chrome');
  return {
    env: { ...process.env, DISPLAY: ':99', PATH: `${fb.bin}${delimiter}${sb.bin}` },
    chrome: async () => {
      await new Promise((r) => setTimeout(r, 300));
      return fb.calls('google-chrome');
    },
    cleanup: fb.cleanup,
  };
}

test('maitre: the window it opens for the lounge it started carries a ticket, never the key', async () => {
  const w = withChrome();
  try {
    const r = await startMaitre(w.env, FAST);
    assert.deepEqual(r.created, ['reception', 'lounge']);
    const calls = await w.chrome();
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.includes(`--app=${ticketUrl}`), JSON.stringify(calls));
    assert.ok(!calls[0]!.join(' ').includes(KEY), 'no token in argv');
  } finally {
    w.cleanup();
  }
});

test('maitre: with a lounge already running (the service), no lounge tab and no window, just a note', async () => {
  writeFileSync(join(sb.home, 'lounge.json'), JSON.stringify(loungeInfo), { mode: 0o600 });
  mkdirSync(join(sb.home, 'reception'), { recursive: true });
  // A leftover tab on the very port the service now serves (both default to 8737), from a lounge that exited.
  writeFileSync(join(sb.home, 'reception', 'tabs.json'), JSON.stringify({ session: 'maitre-test', lounge: { workspaceId: 'w3', paneId: 'w3:p1', url: loungeUrl, loungePid: process.ppid } }));
  sb.setState({ next: 5, workspaces: { w3: { label: 'lounge' } }, panes: { 'w3:p1': { ws: 'w3', agent: 'shell' } } });
  const w = withChrome();
  try {
    const r = await startMaitre(w.env, FAST);
    assert.deepEqual(r.created, ['reception']);
    assert.deepEqual(labels(), ['reception'], 'the leftover lounge tab is closed');
    assert.equal(r.url, undefined);
    assert.deepEqual(r.notes, [SERVICE_NOTE]);
    assert.deepEqual(await w.chrome(), []);
    assert.equal(JSON.parse(readFileSync(join(sb.home, 'reception', 'tabs.json'), 'utf8')).lounge, undefined);
  } finally {
    w.cleanup();
  }
});

test('maitre: a second run keeps only the lounge tab whose recorded lounge pid owns lounge.json', async () => {
  const opened: string[] = [];
  await startMaitre(process.env, { ...FAST, open: (u) => opened.push(u) });
  const tabs = JSON.parse(readFileSync(join(sb.home, 'reception', 'tabs.json'), 'utf8'));
  assert.equal(tabs.lounge.loungePid, process.pid, 'the pid found in lounge.json once the URL showed');
  const st = sb.state();
  const owner = tabs.lounge.workspaceId as string;
  st.workspaces.w8 = { label: 'lounge' };
  st.panes['w8:p1'] = { ws: 'w8', agent: 'shell', screen: `maitre lounge: ${loungeUrl}\nPress Ctrl+C to stop.\n` };
  st.workspaces.w9 = { label: 'lounge' };
  st.panes['w9:p1'] = { ws: 'w9', agent: 'shell' };
  st.next = 10;
  sb.setState(st);
  const r = await startMaitre(process.env, { ...FAST, open: (u) => opened.push(u) });
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.notes, []);
  const ws = sb.state().workspaces;
  assert.equal(ws[owner]?.label, 'lounge', 'the owner is kept');
  assert.equal(ws.w8, undefined, 'a tab showing the same port but not recorded is closed');
  assert.equal(ws.w9, undefined, 'a restored bare shell is closed');
  assert.deepEqual(opened, [ticketUrl]);
});
