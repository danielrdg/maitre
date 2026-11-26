import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../../hooks/reception-guard.mjs', import.meta.url));
const REQUEST = fileURLToPath(new URL('../../hooks/reception-request.mjs', import.meta.url));

function guard(input: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const bash = (command: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, ...extra } });

function assertAllowed(input: string, label: string): void {
  const r = guard(input);
  assert.equal(r.status, 0, label);
  assert.equal(r.stdout, '', label);
}

function assertDenied(input: string, label: string): string {
  const r = guard(input);
  assert.equal(r.status, 0, label);
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse', label);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', label);
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /maître reception guard/, label);
  return reason;
}

test('guard allows exactly the id-only maitre commands', () => {
  for (const cmd of [
    'maitre route 7',
    'maitre route 7 8',
    'maitre route 1 2 3 4 5 6 7 8',
    `maitre route ${Array.from({ length: 32 }, (_, i) => i + 1).join(' ')}`,
    'maitre route 123456789012',
    'maitre dispatch 8',
    'maitre room list',
    'maitre room close nf-bug',
    'maitre room close a',
    `maitre room close ${'a'.repeat(40)}`,
    'maitre projects',
  ]) {
    assertAllowed(bash(cmd), cmd);
  }
  assertAllowed(bash('maitre dispatch 8', { description: 'Dispatch request 8', timeout: 120000 }), 'with description and timeout');
});

test('guard denies everything else, each with a reason', () => {
  for (const cmd of [
    'maitre route "x"',
    'maitre index; rm -rf x',
    'maitre route $(id)',
    'bash -c maitre',
    'maitre dispatch 8 | sh',
    'maitre route 7\nmaitre index',
    'maitre route 7\n',
    'maitre route 7 ',
    ' maitre route 7',
    'maitre  route 7',
    'maitre\troute 7',
    './maitre route 7',
    '/usr/local/bin/maitre route 7',
    'X=1 maitre route 7',
    'maitre route 7 --json',
    'maitre route',
    'maitre route 1234567890123',
    `maitre route ${Array.from({ length: 33 }, (_, i) => i + 1).join(' ')}`,
    'maitre route 7\r',
    'maitre route\r7',
    'maitre\u00a0route 7',
    'maitre route\u00a07',
    'maitre route 7\u0000',
    'maitre route 7\u0000; rm -rf x',
    '\ufeffmaitre route 7',
    'maitre projects\ufeff',
    'maitre route -7',
    'maitre dispatch',
    'maitre dispatch 8 9',
    'maitre dispatch x',
    'maitre room close',
    'maitre room close NF-bug',
    'maitre room close nf_bug',
    'maitre room close -x',
    `maitre room close ${'a'.repeat(41)}`,
    'maitre room close nf-bug other',
    'maitre room list --all',
    'maitre room open x --model opus --task build --brief hi',
    'maitre room send nf-bug hi',
    'maitre room run x',
    'maitre projects x',
    'maitre index',
    'maitre index --root /',
    'maitre lounge',
    'maitre reception',
    'maitre',
    'maitre route ７',
    'ls',
    '',
  ]) {
    assertDenied(bash(cmd), JSON.stringify(cmd));
  }
});

test('guard denies any tool but Bash, odd inputs and background runs', () => {
  for (const tool of ['Write', 'Edit', 'Read', 'WebFetch', 'Task', 'mcp__x__y']) {
    const reason = assertDenied(JSON.stringify({ tool_name: tool, tool_input: { file_path: '/tmp/x', command: 'maitre projects' } }), tool);
    assert.match(reason, new RegExp(tool.replace(/_/g, '_')));
  }
  assertDenied(bash('maitre projects', { run_in_background: true }), 'background');
  assertDenied(bash(['maitre', 'projects']), 'array command');
  assertDenied(bash(undefined), 'missing command');
  assertDenied(JSON.stringify({ tool_name: 'Bash' }), 'missing tool_input');
  assertDenied(JSON.stringify({ tool_name: 'Bash', tool_input: 'maitre projects' }), 'string tool_input');
  for (const bad of ['', 'not json', '[]', 'null', '"maitre projects"', '{"tool_name":']) {
    const reason = assertDenied(bad, JSON.stringify(bad));
    assert.ok(reason.length > 0);
  }
});

function requestHook(home: string, payload: unknown): { status: number | null; stdout: string; stderr: string } {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [REQUEST], { input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', MAITRE_HOME: home } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const submit = (prompt: unknown) => ({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt });

function context(stdout: string): string {
  const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  return out.hookSpecificOutput.additionalContext;
}

test('request hook stores each prompt as the next numbered file and tells the model its id', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-reception-'));
  try {
    const text = "fix the NF bug in backend\n$(rm -rf ~) `id` 'quoted'\n--model opus\n";
    const first = requestHook(home, submit(text));
    assert.equal(first.status, 0);
    assert.equal(first.stderr, '');
    assert.equal(context(first.stdout), 'This message is request 1.');
    const dir = join(home, 'reception', 'requests');
    assert.equal(readFileSync(join(dir, '1.md'), 'utf8'), text);
    assert.equal(statSync(join(dir, '1.md')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);

    assert.equal(context(requestHook(home, submit('second')).stdout), 'This message is request 2.');
    assert.equal(readFileSync(join(dir, '2.md'), 'utf8'), 'second');

    const long = 'x'.repeat(50_000);
    assert.equal(context(requestHook(home, submit(long)).stdout), 'This message is request 3.');
    assert.equal(readFileSync(join(dir, '3.md'), 'utf8'), long, 'never clipped');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('request hook continues after the highest existing id and ignores other files', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-reception-'));
  try {
    const dir = join(home, 'reception', 'requests');
    mkdirSync(dir, { recursive: true });
    for (const f of ['3.md', '10.md', '11.txt', 'notes.md', '99x.md', '1234567890123.md']) writeFileSync(join(dir, f), 'old');
    assert.equal(context(requestHook(home, submit('next')).stdout), 'This message is request 11.');
    assert.equal(readFileSync(join(dir, '11.md'), 'utf8'), 'next');
    assert.equal(readFileSync(join(dir, '10.md'), 'utf8'), 'old');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('request hook: concurrent prompts never share an id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-reception-'));
  try {
    const { spawn } = await import('node:child_process');
    const runs = Array.from({ length: 8 }, (_, i) =>
      new Promise<string>((done) => {
        const c = spawn(process.execPath, [REQUEST], { env: { PATH: process.env.PATH ?? '', MAITRE_HOME: home } });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.on('close', () => done(out));
        c.stdin.end(JSON.stringify(submit(`p${i}`)));
      }),
    );
    const ids = (await Promise.all(runs)).map((o) => context(o));
    assert.equal(new Set(ids).size, 8);
    const files = readdirSync(join(home, 'reception', 'requests')).sort();
    assert.equal(files.length, 8);
    const bodies = files.map((f) => readFileSync(join(home, 'reception', 'requests', f), 'utf8')).sort();
    assert.deepEqual(bodies, Array.from({ length: 8 }, (_, i) => `p${i}`).sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('request hook stores a pasted prompt without Claude Code\'s wrapper', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-reception-'));
  try {
    const inner = 'Quick arithmetic:\nline 1: compute 1 * 7\nline 2: compute 2 * 7';
    requestHook(home, submit(`\n\n<pasted_content id="3999">\n${inner}\n</pasted_content id="3999">\n`));
    requestHook(home, submit(`look at this:\n\n<pasted_content id="4">\n${inner}\n</pasted_content id="4">\n`));
    requestHook(home, submit('  indented, no wrapper\n'));
    const dir = join(home, 'reception', 'requests');
    assert.equal(readFileSync(join(dir, '1.md'), 'utf8'), inner);
    assert.equal(readFileSync(join(dir, '2.md'), 'utf8'), `look at this:\n\n${inner}`);
    assert.equal(readFileSync(join(dir, '3.md'), 'utf8'), '  indented, no wrapper\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('request hook: SessionStart only leaves the started marker, never a request', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-reception-'));
  try {
    const r = requestHook(home, { hook_event_name: 'SessionStart', session_id: 's9', source: 'startup' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(readFileSync(join(home, 'reception', 'session-started'), 'utf8'), 's9');
    assert.equal(statSync(join(home, 'reception')).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(home, 'reception')), ['session-started']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('request hook never blocks: odd input, synthetic prompts and an unwritable home all exit 0 quietly', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-reception-'));
  try {
    for (const bad of ['', 'not json', 'null', '[]', JSON.stringify(submit(42)), JSON.stringify(submit('')), JSON.stringify(submit('<task-notification>done</task-notification>'))]) {
      const r = requestHook(home, bad);
      assert.equal(r.status, 0, bad);
      assert.equal(r.stdout, '', bad);
    }
    assert.deepEqual(readdirSync(home), []);
    const file = join(home, 'blocker');
    writeFileSync(file, '');
    const r = requestHook(file, submit('hello'));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
