import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RoomBlockedError,
  agentInfo,
  agentStatus,
  closeWorkspace,
  createWorkspace,
  ensureServer,
  herdrSession,
  listWorkspaces,
  prompt,
  readPane,
  runInPane,
  sendKeys,
  shellQuote,
} from '../src/herdr.js';

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-herdr.mjs', import.meta.url));
const SAVED = { ...process.env };
let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maitre-herdr-'));
  const bin = join(dir, 'bin');
  execFileSync('mkdir', [bin]);
  writeFileSync(join(bin, 'herdr'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(bin, 'herdr'), 0o755);
  log = join(dir, 'argv.log');
  process.env.PATH = `${bin}${delimiter}${SAVED.PATH}`;
  process.env.FAKE_HERDR_LOG = log;
  delete process.env.MAITRE_HERDR_SESSION;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  rmSync(dir, { recursive: true, force: true });
});

function calls(): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('herdrSession defaults to maitre and honors MAITRE_HERDR_SESSION', () => {
  assert.equal(herdrSession({}), 'maitre');
  assert.equal(herdrSession({ MAITRE_HERDR_SESSION: 'other' }), 'other');
});

test('createWorkspace sends cwd, label, env pairs and --no-focus; ids come from the JSON', async () => {
  const r = await createWorkspace({ cwd: '/work/x', label: 'room-x', env: { MAITRE_ROOM: 'x', A: 'b c' } });
  assert.deepEqual(r, { workspaceId: 'w1', paneId: 'w1:p1' });
  assert.deepEqual(calls(), [
    ['--session', 'maitre', 'workspace', 'create', '--cwd', '/work/x', '--label', 'room-x', '--env', 'MAITRE_ROOM=x', '--env', 'A=b c', '--no-focus'],
  ]);
});

test('the session comes from MAITRE_HERDR_SESSION', async () => {
  process.env.MAITRE_HERDR_SESSION = 'alt';
  await closeWorkspace('w1');
  assert.deepEqual(calls(), [['--session', 'alt', 'workspace', 'close', 'w1']]);
});

test('runInPane, readPane, sendKeys, listWorkspaces use the expected argv', async () => {
  await runInPane('w1:p1', "claude --x 'y'");
  assert.equal(await readPane('w1:p1', 30), '$ echo hi\nhi\n$\n');
  await readPane('w1:p1');
  await sendKeys('w1:p1', 'down', 'enter');
  assert.deepEqual(await listWorkspaces(), [{ id: 'w1', label: 'probe' }]);
  assert.deepEqual(calls(), [
    ['--session', 'maitre', 'pane', 'run', 'w1:p1', "claude --x 'y'"],
    ['--session', 'maitre', 'pane', 'read', 'w1:p1', '--source', 'visible', '--lines', '30'],
    ['--session', 'maitre', 'pane', 'read', 'w1:p1', '--source', 'visible'],
    ['--session', 'maitre', 'agent', 'send-keys', 'w1:p1', 'down', 'enter'],
    ['--session', 'maitre', 'workspace', 'list'],
  ]);
});

test('prompt waits by default and reports idle; --timeout is passed through', async () => {
  assert.equal(await prompt('w1:p1', 'hello', { timeoutMs: 90000 }), 'idle');
  assert.deepEqual(calls(), [['--session', 'maitre', 'agent', 'prompt', 'w1:p1', 'hello', '--wait', '--timeout', '90000']]);
});

test('prompt reports blocked when the wait settles blocked', async () => {
  process.env.FAKE_HERDR_REPLY_agent_prompt = JSON.stringify({ id: 'x', result: { type: 'agent_prompted', agent: { agent_status: 'blocked' } } });
  assert.equal(await prompt('w1:p1', 'go'), 'blocked');
});

test('prompt with wait:false sends without --wait and returns sent', async () => {
  assert.equal(await prompt('w1:p1', 'go', { wait: false }), 'sent');
  assert.deepEqual(calls(), [['--session', 'maitre', 'agent', 'prompt', 'w1:p1', 'go']]);
});

test('prompt keeps dash-leading text positional, before the options', async () => {
  assert.equal(await prompt('w1:p1', '-x --wait', { timeoutMs: 5 }), 'idle');
  assert.deepEqual(calls(), [['--session', 'maitre', 'agent', 'prompt', 'w1:p1', '-x --wait', '--wait', '--timeout', '5']]);
});

test('prompt rejects a non-JSON success (e.g. help output) instead of reporting sent', async () => {
  process.env.FAKE_HERDR_REPLY_agent_prompt = 'usage: herdr agent prompt';
  await assert.rejects(prompt('w1:p1', '-h', { wait: false }), /unexpected response/);
});

test('prompt maps the agent_blocked error to RoomBlockedError', async () => {
  process.env.FAKE_HERDR_REPLY_agent_prompt = JSON.stringify({ error: { code: 'agent_blocked', message: 'blocked' } });
  process.env.FAKE_HERDR_EXIT_agent_prompt = '1';
  await assert.rejects(prompt('w1:p1', 'go'), RoomBlockedError);
});

test('agentInfo returns status and agent name', async () => {
  assert.deepEqual(await agentInfo('w1:p1'), { status: 'idle', agent: 'claude' });
  assert.equal(await agentStatus('w1:p1'), 'idle');
  assert.deepEqual(calls()[0], ['--session', 'maitre', 'agent', 'get', 'w1:p1']);
});

test('a bare shell pane (agent_not_found, pane exists) is unknown without an agent', async () => {
  process.env.FAKE_HERDR_REPLY_agent_get = JSON.stringify({ error: { code: 'agent_not_found', message: 'nf' } });
  process.env.FAKE_HERDR_EXIT_agent_get = '1';
  assert.deepEqual(await agentInfo('w1:p1'), { status: 'unknown' });
  assert.equal(await agentStatus('w1:p1'), 'unknown');
});

test('agentStatus is gone when herdr reports the pane missing', async () => {
  process.env.FAKE_HERDR_REPLY_agent_get = JSON.stringify({ error: { code: 'agent_not_found', message: 'nf' } });
  process.env.FAKE_HERDR_EXIT_agent_get = '1';
  process.env.FAKE_HERDR_REPLY_pane_get = JSON.stringify({ error: { code: 'pane_not_found', message: 'nf' } });
  process.env.FAKE_HERDR_EXIT_pane_get = '1';
  assert.equal(await agentStatus('w9:p9'), 'gone');
});

test('error JSON on stderr, where herdr 0.8.2 prints it, keeps its code', async () => {
  process.env.FAKE_HERDR_REPLY_agent_prompt = JSON.stringify({ error: { code: 'agent_blocked', message: 'blocked' } });
  process.env.FAKE_HERDR_EXIT_agent_prompt = '1';
  await assert.rejects(prompt('w1:p1', 'go'), RoomBlockedError);
  process.env.FAKE_HERDR_REPLY_agent_get = JSON.stringify({ error: { code: 'agent_not_found', message: 'nf' } });
  process.env.FAKE_HERDR_EXIT_agent_get = '1';
  assert.deepEqual(await agentInfo('w1:p1'), { status: 'unknown' });
  process.env.FAKE_HERDR_REPLY_pane_get = JSON.stringify({ error: { code: 'pane_not_found', message: 'nf' } });
  process.env.FAKE_HERDR_EXIT_pane_get = '1';
  assert.equal(await agentStatus('w9:p9'), 'gone');
  process.env.FAKE_HERDR_REPLY_workspace_close = JSON.stringify({ error: { code: 'workspace_not_found', message: 'nf' } });
  process.env.FAKE_HERDR_EXIT_workspace_close = '1';
  await assert.rejects(closeWorkspace('w9'), (e: { code?: string }) => e.code === 'workspace_not_found');
});

test('ensureServer does nothing when the server is running', async () => {
  await ensureServer();
  assert.deepEqual(calls(), [['--session', 'maitre', 'status', 'server', '--json']]);
});

test('ensureServer starts the server without session markers, keeping auth and the desktop env, and polls until running', async () => {
  process.env.FAKE_HERDR_SERVER_DOWN = '1';
  const env = {
    ...process.env,
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 's',
    CLAUDE_CODE_CHILD_SESSION: '1',
    ANTHROPIC_API_KEY: 'k',
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    CLAUDE_CONFIG_DIR: '/cfg',
    CLAUDE_CODE_USE_BEDROCK: '1',
    SSH_AUTH_SOCK: '/run/ssh',
    DISPLAY: ':0',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus',
  };
  await ensureServer(env);
  const argvs = calls().map((c) => c.join(' '));
  assert.equal(argvs[0], '--session maitre status server --json');
  assert.ok(argvs.includes('--session maitre server'));
  assert.equal(argvs.at(-1), '--session maitre status server --json');
  const seen = JSON.parse(readFileSync(`${log}.serverenv`, 'utf8'));
  assert.equal(seen.CLAUDECODE, undefined);
  const kept = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH'];
  for (const k of Object.keys(seen)) if (k.startsWith('CLAUDE_CODE_')) assert.ok(kept.includes(k), k);
  assert.equal(seen.ANTHROPIC_API_KEY, 'k');
  assert.equal(seen.ANTHROPIC_BASE_URL, 'https://gateway.example');
  assert.equal(seen.CLAUDE_CONFIG_DIR, '/cfg');
  assert.equal(seen.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(seen.SSH_AUTH_SOCK, '/run/ssh');
  assert.equal(seen.DISPLAY, ':0');
  assert.equal(seen.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/bus');
});

test('a herdr call that cannot start names the subcommand only, never its arguments', async () => {
  const secret = `SECRET-${'x'.repeat(200_000)}`;
  await assert.rejects(prompt('w1:p1', secret, { wait: false }), (e: unknown) => {
    const err = e as { code?: string; message: string };
    assert.equal(err.code, 'exec_failed');
    assert.equal(err.message, 'herdr agent prompt: E2BIG');
    return true;
  });
});

test("shellQuote round-trips through sh -c 'printf %s ' + q", () => {
  for (const s of ["it's $(x)", '', 'a b `c` "d" \\ \n e', "''"]) {
    const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(s)}`], { encoding: 'utf8' });
    assert.equal(out, s);
  }
});

test('a herdr call that never answers is killed after the timeout and fails with a clear error', async () => {
  process.env.FAKE_HERDR_HANG_workspace_list = '1';
  process.env.MAITRE_HERDR_TIMEOUT_MS = '300';
  const t0 = Date.now();
  await assert.rejects(listWorkspaces(), { code: 'exec_failed', message: 'herdr workspace list: timed out after 0.3 s' });
  assert.ok(Date.now() - t0 < 5_000);
});
