import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookLine } from '../src/events.js';
import { roomDir } from '../src/paths.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOOK = join(ROOT, 'hooks', 'maitre-hook.mjs');
const FIXTURES = readFileSync(join(ROOT, 'test', 'fixtures', 'hook-events.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '');
const CEILING_MS = 500;
// Wall-clock limits fail on a busy machine, so they only run on request.
const PERF = process.env.MAITRE_PERF === '1';
const PERF_SKIP = 'wall-time ceiling: set MAITRE_PERF=1 to time the hook';

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  input: string;
  env: Record<string, string | undefined>;
}

function runHook(input: string, env: Record<string, string | undefined>): Run {
  const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [HOOK], { input, env: childEnv, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t0, input, env };
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'maitre-hook-'));
}

function eventsFile(home: string, room = 't1'): string {
  return join(roomDir(room, { MAITRE_HOME: home }), 'events.jsonl');
}

function readLines(file: string): HookLine[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as HookLine);
}

function assertQuiet(r: Run): void {
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  if (PERF) assertFast(r);
}

function assertFast(r: Run): void {
  let ms = r.ms;
  if (ms >= CEILING_MS) {
    // One scheduler hiccup on a loaded machine is not a slow hook: time the same payload once more.
    const home = tmpHome();
    try {
      ms = Math.min(ms, runHook(r.input, { ...r.env, MAITRE_HOME: home }).ms);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  assert.ok(ms < CEILING_MS, `hook took ${r.ms.toFixed(1)} ms, then ${ms.toFixed(1)} ms`);
}

function fixture(pred: (p: Record<string, unknown>) => boolean): string {
  const line = FIXTURES.find((l) => pred(JSON.parse(l) as Record<string, unknown>));
  assert.ok(line, 'fixture not found');
  return line;
}

function hookOne(payload: string): HookLine {
  const home = tmpHome();
  try {
    const r = runHook(payload, { MAITRE_ROOM: 't1', MAITRE_HOME: home });
    assertQuiet(r);
    const lines = readLines(eventsFile(home));
    assert.equal(lines.length, 1);
    return lines[0]!;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Warm the module cache and the disk before anything is timed.
runHook('', { MAITRE_HOME: tmpdir() });

test(`every fixture line is hooked in under ${CEILING_MS} ms`, { skip: !PERF && PERF_SKIP }, () => {
  const home = tmpHome();
  try {
    for (const raw of FIXTURES) assertFast(runHook(raw, { MAITRE_ROOM: 't1', MAITRE_HOME: home }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('fixtures cover every required event kind', () => {
  const kinds = new Set(FIXTURES.map((l) => (JSON.parse(l) as { hook_event_name: string }).hook_event_name));
  for (const k of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Notification',
    'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'PermissionDenied']) {
    assert.ok(kinds.has(k), k);
  }
});

test('each fixture line appends exactly one matching event line', () => {
  const home = tmpHome();
  try {
    const file = eventsFile(home);
    FIXTURES.forEach((raw, i) => {
      const p = JSON.parse(raw) as Record<string, unknown>;
      const before = Date.now();
      const r = runHook(raw, { MAITRE_ROOM: 't1', MAITRE_HOME: home });
      assertQuiet(r);
      const lines = readLines(file);
      assert.equal(lines.length, i + 1, `line ${i + 1}`);
      const ev = lines[i]!;
      assert.equal(ev.v, 1);
      assert.equal(ev.room, 't1');
      assert.equal(ev.event, p.hook_event_name);
      assert.equal(ev.session, 's-0001');
      assert.equal(ev.tool, p.tool_name);
      assert.equal(ev.tool_use_id, p.tool_use_id);
      assert.equal(ev.agent_id, p.agent_id);
      assert.equal(ev.agent_type, p.agent_type);
      assert.ok(ev.ts >= before && ev.ts <= Date.now());
      assert.equal(ev.transcript, p.transcript_path);
      const line = JSON.stringify({ ...ev, transcript: undefined });
      assert.ok(!line.includes('/tmp/room'), 'cwd and paths are not copied, except the transcript path');
      assert.ok(!line.includes('permission_suggestions'));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('SessionStart keeps the model', () => {
  const ev = hookOne(fixture((p) => p.hook_event_name === 'SessionStart'));
  assert.equal(ev.model, 'claude-haiku-5-5');
});

test('UserPromptSubmit keeps the prompt and flags task notifications and agent messages as synthetic', () => {
  const normal = hookOne(fixture((p) => p.hook_event_name === 'UserPromptSubmit' && p.prompt_id === 'p-1'));
  assert.equal(normal.prompt, 'Create an empty file hello.txt');
  assert.equal(normal.synthetic, false);
  const synth = hookOne(fixture((p) => typeof p.prompt === 'string' && p.prompt.startsWith('<task-notification>')));
  assert.equal(synth.synthetic, true);
  const handBack = fixture((p) => typeof p.prompt === 'string' && p.prompt.startsWith('<agent-message'));
  assert.equal(hookOne(handBack).synthetic, true);
  const padded = JSON.parse(handBack) as { prompt: string };
  padded.prompt = `\n  ${padded.prompt}`;
  assert.equal(hookOne(JSON.stringify(padded)).synthetic, true);
  const quoted = JSON.parse(handBack) as { prompt: string };
  quoted.prompt = `see ${quoted.prompt}`;
  assert.equal(hookOne(JSON.stringify(quoted)).synthetic, false);
  for (const prompt of ['<agent-messages are fun> hi', '<agent-message', '<task-notification', '<task-notifications> x']) {
    assert.equal(hookOne(JSON.stringify({ ...quoted, prompt })).synthetic, false, prompt);
  }
  assert.equal(hookOne(JSON.stringify({ ...quoted, prompt: '<agent-message>hi</agent-message>' })).synthetic, true);
});

test('Bash PreToolUse and PermissionRequest keep the same input', () => {
  const pre = hookOne(fixture((p) => p.hook_event_name === 'PreToolUse' && p.tool_use_id === 'toolu_A1'));
  const req = hookOne(fixture((p) => p.hook_event_name === 'PermissionRequest' && p.tool_name === 'Bash'));
  assert.deepEqual(pre.input, { command: 'touch hello.txt', description: 'Create empty hello.txt' });
  assert.deepEqual(req.input, pre.input);
  assert.equal(req.tool_use_id, undefined);
});

test('AskUserQuestion keeps the option labels and the answers', () => {
  for (const kind of ['PreToolUse', 'PermissionRequest']) {
    const ev = hookOne(fixture((p) => p.hook_event_name === kind && p.tool_name === 'AskUserQuestion'));
    const input = ev.input as { questions: { question: string; options: { label: string }[] }[] };
    assert.equal(input.questions[0]!.question, 'Which fruit?');
    assert.deepEqual(input.questions[0]!.options.map((o) => o.label), ['Apple', 'Banana', 'Cherry']);
  }
  const post = hookOne(fixture((p) => p.hook_event_name === 'PostToolUse' && p.tool_name === 'AskUserQuestion'));
  assert.deepEqual(post.response, { answers: { 'Which fruit?': 'Banana' } });
});

test('PostToolUse(Agent) keeps resolvedModel and agentId', () => {
  const ev = hookOne(fixture((p) => p.hook_event_name === 'PostToolUse' && p.tool_name === 'Agent'));
  assert.deepEqual(ev.response, { agentId: 'a1', resolvedModel: 'claude-haiku-5-5' });
});

test('PostToolUse(Bash) keeps only the PR URL from stdout', () => {
  const ev = hookOne(fixture((p) => p.hook_event_name === 'PostToolUse' && p.tool_use_id === 'toolu_P1'));
  assert.deepEqual(ev.response, { stdout: 'https://github.com/acme/app/pull/12' });
  const plain = hookOne(fixture((p) => p.hook_event_name === 'PostToolUse' && p.tool_use_id === 'toolu_G2'));
  assert.equal(plain.response, undefined, 'stdout without a PR URL is not kept');
});

test('stdout never leaks beyond the PR URL', () => {
  const secret = 'API_TOKEN=sk-fake-0000000000000000';
  const base = { hook_event_name: 'PostToolUse', session_id: 's-0008', tool_name: 'Bash', tool_use_id: 't' };
  const none = hookOne(JSON.stringify({ ...base, tool_response: { stdout: `env\n${secret}\n`, stderr: secret } }));
  assert.equal(none.response, undefined);
  assert.ok(!JSON.stringify(none).includes('sk-fake'));
  const withUrl = hookOne(JSON.stringify({
    ...base,
    tool_response: { stdout: `${secret}\nhttps://github.com/acme/app/pull/34\nhttps://github.com/acme/app/pull/35\n` },
  }));
  assert.deepEqual(withUrl.response, { stdout: 'https://github.com/acme/app/pull/34' });
  assert.ok(!JSON.stringify(withUrl).includes('sk-fake'));
});

test('Stop counts running background tasks and keeps the last message', () => {
  const running = hookOne(fixture((p) => p.hook_event_name === 'Stop' && p.prompt_id === 'p-3'));
  assert.equal(running.background_running, 1);
  assert.equal(running.last_message, 'The subagent is running in the background.');
  const normal = hookOne(fixture((p) => p.hook_event_name === 'Stop' && p.prompt_id === 'p-1'));
  assert.equal(normal.background_running, 0);
});

test('Stop counts only running background subagents, not shells', () => {
  const stop = (tasks: unknown[]) => hookOne(JSON.stringify({ hook_event_name: 'Stop', session_id: 's-0009', background_tasks: tasks }));
  const shell = { id: 'b1', type: 'shell', status: 'running', description: 'npm run dev' };
  const sub = { id: 'a1', type: 'subagent', status: 'running', agent_type: 'Explore' };
  assert.equal(stop([shell]).background_running, 0);
  assert.equal(stop([shell, sub, { ...sub, id: 'a2', status: 'completed' }, { status: 'running' }]).background_running, 1);
});

test('subagent events keep agent ids; the phantom SubagentStop keeps an empty agent_type', () => {
  const start = hookOne(fixture((p) => p.hook_event_name === 'SubagentStart'));
  assert.equal(start.agent_id, 'a1');
  assert.equal(start.agent_type, 'general-purpose');
  const phantom = hookOne(fixture((p) => p.hook_event_name === 'SubagentStop' && p.agent_type === ''));
  assert.equal(phantom.agent_type, '');
  const inner = hookOne(fixture((p) => p.hook_event_name === 'PreToolUse' && p.agent_id === 'a1'));
  assert.equal(inner.agent_id, 'a1');
});

test('Notification, PermissionDenied and SessionEnd', () => {
  const n = hookOne(fixture((p) => p.notification_type === 'permission_prompt'));
  assert.equal(n.notification_type, 'permission_prompt');
  assert.equal(n.message, 'Claude needs your permission');
  const d = hookOne(fixture((p) => p.hook_event_name === 'PermissionDenied'));
  assert.equal(d.tool_use_id, 'toolu_D1');
  assert.deepEqual(d.input, { command: 'rm -rf ../outside', description: 'Remove dummy folder' });
  const end = hookOne(fixture((p) => p.hook_event_name === 'SessionEnd'));
  assert.equal(end.event, 'SessionEnd');
});

test('long prompt and last message are truncated, a PR URL is found in a long stdout', () => {
  const big = 'y'.repeat(5000);
  const prompt = hookOne(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's-0002', prompt: big }));
  assert.ok(prompt.prompt!.length <= 300);
  assert.ok(prompt.prompt!.startsWith('yyy'));
  const stop = hookOne(JSON.stringify({ hook_event_name: 'Stop', session_id: 's-0002', last_assistant_message: big }));
  assert.ok(stop.last_message!.length <= 500);
  const post = hookOne(JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 's-0002', tool_name: 'Bash', tool_use_id: 't',
    tool_response: { stdout: big + '\nhttps://github.com/acme/app/pull/13\n' },
  }));
  assert.deepEqual(post.response, { stdout: 'https://github.com/acme/app/pull/13' });
});

test('multibyte and control characters cannot push a line past 5000 bytes', () => {
  const nasty = ('\u0001\u00e9\u4e2d\u001b[31m\ud83d\ude00"\\').repeat(20_000);
  const answers: Record<string, string> = {};
  for (let i = 0; i < 50; i++) answers[nasty.slice(0, 300) + i] = nasty.slice(0, 2000);
  const input = { command: nasty, file_path: nasty, questions: [{ question: nasty, options: [{ label: nasty }] }] };
  const all = {
    session_id: nasty, tool_name: nasty, tool_use_id: nasty, agent_id: nasty, agent_type: nasty,
    tool_input: input, prompt: nasty, last_assistant_message: nasty, message: nasty, notification_type: nasty, model: nasty,
    background_tasks: [{ status: 'running' }],
    tool_response: { stdout: nasty + 'https://github.com/acme/app/pull/9', agentId: nasty, resolvedModel: nasty, answers, is_error: false },
  };
  const home = tmpHome();
  try {
    for (const event of ['PreToolUse', 'PermissionRequest', 'PostToolUseFailure']) {
      assertQuiet(runHook(JSON.stringify({ ...all, hook_event_name: event }), { MAITRE_ROOM: 't1', MAITRE_HOME: home }));
    }
    const raw = readFileSync(eventsFile(home), 'utf8').split('\n').filter((l) => l !== '');
    assert.equal(raw.length, 3);
    for (const l of raw) assert.ok(Buffer.byteLength(l) <= 5000, `${Buffer.byteLength(l)} bytes`);
    const [pre, req] = raw.map((l) => JSON.parse(l) as HookLine);
    assert.ok(Buffer.byteLength(JSON.stringify(pre!.input)) <= 2000);
    assert.ok(Buffer.byteLength(JSON.stringify(pre!.prompt)) <= 400);
    assert.ok(Buffer.byteLength(JSON.stringify(pre!.last_message)) <= 600);
    assert.deepEqual(req!.input, pre!.input, 'Pre and PermissionRequest inputs stay deep-equal');
    assert.equal(pre!.response!.stdout, 'https://github.com/acme/app/pull/9');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a 1 MB tool_input becomes one small line, truncated the same way for Pre and PermissionRequest', () => {
  const input = { command: 'x'.repeat(1024 * 1024), description: 'big' };
  const pre = { hook_event_name: 'PreToolUse', session_id: 's-0003', tool_name: 'Bash', tool_use_id: 'toolu_BIG', tool_input: input };
  const req = { hook_event_name: 'PermissionRequest', session_id: 's-0003', tool_name: 'Bash', tool_input: input };
  const home = tmpHome();
  try {
    for (const p of [pre, req]) assertQuiet(runHook(JSON.stringify(p), { MAITRE_ROOM: 't1', MAITRE_HOME: home }));
    const raw = readFileSync(eventsFile(home), 'utf8').split('\n').filter((l) => l !== '');
    assert.equal(raw.length, 2);
    for (const l of raw) assert.ok(Buffer.byteLength(l) <= 5000, `${Buffer.byteLength(l)} bytes`);
    const [a, b] = raw.map((l) => JSON.parse(l) as HookLine);
    assert.equal(a!.tool, 'Bash');
    assert.equal(a!.tool_use_id, 'toolu_BIG');
    assert.ok(JSON.stringify(a!.input).length <= 2000);
    const cmd = (a!.input as { command: string }).command;
    assert.ok(cmd.startsWith('xxx'), 'input stays an object with a clipped command');
    assert.deepEqual(b!.input, a!.input);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a wide tool_input (many keys, many items) still fits in 2000 chars', () => {
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 5000; i++) wide[`k${i}`] = ['a'.repeat(50), i];
  const ev = hookOne(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's-0004', tool_name: 'Edit', tool_input: wide }));
  assert.ok(JSON.stringify(ev.input).length <= 2000);
});

test('huge notification messages, answers and ids are capped too', () => {
  const big = 'z'.repeat(200_000);
  const answers: Record<string, string> = {};
  for (let i = 0; i < 200; i++) answers[`${big.slice(0, 500)}${i}`] = big;
  const raw = JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: big, tool_name: big, tool_use_id: big,
    agent_id: big, agent_type: big, message: big, notification_type: big, tool_response: { answers, agentId: big, resolvedModel: big },
  });
  const ev = hookOne(raw);
  assert.ok(Buffer.byteLength(JSON.stringify(ev)) <= 5000, `${Buffer.byteLength(JSON.stringify(ev))} bytes`);
  assert.equal(ev.event, 'PostToolUse');
});

test('hostile inputs exit 0, print nothing and write nothing', () => {
  const ok = JSON.stringify({ hook_event_name: 'Stop', session_id: 's-0005' });
  const cases: [string, string, Record<string, string | undefined>][] = [
    ['no MAITRE_ROOM', ok, { MAITRE_ROOM: undefined }],
    ['empty MAITRE_ROOM', ok, { MAITRE_ROOM: '' }],
    ['room that slugs to nothing', ok, { MAITRE_ROOM: '../..' }],
    ['empty stdin', '', { MAITRE_ROOM: 't1' }],
    ['whitespace stdin', '  \n', { MAITRE_ROOM: 't1' }],
    ['invalid JSON', '{"hook_event_name":', { MAITRE_ROOM: 't1' }],
    ['JSON array', '[1,2]', { MAITRE_ROOM: 't1' }],
    ['JSON null', 'null', { MAITRE_ROOM: 't1' }],
    ['no hook_event_name', '{"session_id":"s"}', { MAITRE_ROOM: 't1' }],
  ];
  for (const rel of ['rel-home', './rel-home']) {
    const cwd = tmpHome();
    try {
      const childEnv = { PATH: process.env.PATH ?? '', MAITRE_ROOM: 't1', MAITRE_HOME: rel };
      const r = spawnSync(process.execPath, [HOOK], { input: ok, env: childEnv, cwd, encoding: 'utf8' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout + r.stderr, '');
      assert.deepEqual(readdirSync(cwd), [], `relative MAITRE_HOME ${rel} writes nothing into the cwd`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  for (const [name, input, env] of cases) {
    const home = tmpHome();
    try {
      const r = runHook(input, { MAITRE_HOME: home, ...env });
      assertQuiet(r);
      assert.deepEqual(readdirSync(home), [], name);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('a room name with path characters is slugged, never escapes the rooms dir', () => {
  const home = tmpHome();
  try {
    const r = runHook(JSON.stringify({ hook_event_name: 'Stop', session_id: 's-0006' }), { MAITRE_ROOM: '../Evil Room', MAITRE_HOME: home });
    assertQuiet(r);
    assert.deepEqual(readdirSync(join(home, 'state', 'rooms')), ['evil-room']);
    assert.equal(readLines(eventsFile(home, 'evil-room'))[0]!.room, 'evil-room');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an unwritable MAITRE_HOME exits 0 quietly', () => {
  const home = tmpHome();
  const locked = join(home, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  try {
    const r = runHook(JSON.stringify({ hook_event_name: 'Stop', session_id: 's-0007' }), { MAITRE_ROOM: 't1', MAITRE_HOME: locked });
    assertQuiet(r);
    if (process.getuid?.() !== 0) assert.equal(existsSync(join(locked, 'state')), false);
  } finally {
    chmodSync(locked, 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

test('the hook stores transcript_path as transcript, capped, and omits it when absent', () => {
  const base = { session_id: 's1', hook_event_name: 'Stop' };
  assert.equal(hookOne(JSON.stringify({ ...base, transcript_path: '/h/.claude/projects/p/s1.jsonl' })).transcript, '/h/.claude/projects/p/s1.jsonl');
  assert.equal('transcript' in hookOne(JSON.stringify(base)), false);
  assert.equal('transcript' in hookOne(JSON.stringify({ ...base, transcript_path: 5 })), false);
  const long = hookOne(JSON.stringify({ ...base, transcript_path: '/' + 'a'.repeat(5000) })).transcript!;
  assert.ok(long.length <= 1024 && long.endsWith('…'));
});
