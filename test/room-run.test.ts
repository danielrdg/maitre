import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookLine } from '../src/events.js';
import { roomDir } from '../src/paths.js';
import { ROOM_AGENTS, ROOM_PROMPT, buildRoomCommand } from '../src/room-run.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BIN = join(ROOT, 'bin');
const MAITRE = join(BIN, 'maitre');
const MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_ENTRYPOINT',
];
const OUTER_MARKERS = Object.fromEntries(MARKERS.map((k) => [k, 'outer']));

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `maitre-${prefix}-`));
}

interface Sandbox {
  home: string;
  fake: string;
  out: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

// A fake `claude` placed first on PATH; the real one must never run in tests.
function sandbox(script: string, file?: string): Sandbox {
  const base = tmp('room');
  const home = join(base, 'home');
  const fake = join(base, 'fake-bin');
  const out = join(base, 'out');
  mkdirSync(home);
  mkdirSync(fake);
  mkdirSync(out);
  writeFileSync(join(fake, 'claude'), file ?? `#!/bin/sh\n${script}\n`);
  chmodSync(join(fake, 'claude'), 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: [fake, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    MAITRE_HOME: home,
    FAKE_OUT: out,
    ...OUTER_MARKERS,
  };
  return { home, fake, out, env, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function lines(home: string, room: string): HookLine[] {
  const file = join(roomDir(room, { MAITRE_HOME: home }), 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as HookLine);
}

function assertExitLine(l: HookLine, room: string): void {
  assert.equal(l.v, 1);
  assert.equal(l.event, 'MaitreExit');
  assert.equal(l.room, room);
  assert.equal(l.session, '');
  assert.ok(Number.isFinite(l.ts));
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('ROOM_PROMPT is the exact room instruction', () => {
  assert.equal(
    ROOM_PROMPT,
    'You are running inside a maître room. When you start waiting on something outside your control (CI, a build, a review bot), run `maitre status waiting "<what>"`. When you resume, run `maitre status working "<what>"`.',
  );
});

test('buildRoomCommand wires settings, prompt, room env and strips session markers', () => {
  const home = tmp('build');
  try {
    const input: NodeJS.ProcessEnv = { PATH: '/usr/bin', MAITRE_HOME: home, KEEP: 'yes', ANTHROPIC_BASE_URL: 'https://gw', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_USE_VERTEX: '1', ...OUTER_MARKERS };
    const r = buildRoomCommand('Nf Bug', ['--model', 'haiku'], input);
    const settings = join(home, 'settings', 'room-hooks.json');
    assert.equal(r.cmd, 'claude');
    assert.deepEqual(r.args.slice(0, 4), ['--settings', settings, '--append-system-prompt', ROOM_PROMPT]);
    assert.deepEqual(r.args.slice(4), ['--agents', ROOM_AGENTS, '--permission-mode', 'auto', '--model', 'haiku']);
    assert.ok(existsSync(settings));
    assert.equal(r.env.MAITRE_ROOM, 'nf-bug');
    assert.equal(r.env.MAITRE_HOME, home);
    assert.equal(r.env.PATH, `${BIN}${delimiter}/usr/bin`);
    assert.equal(r.env.KEEP, 'yes');
    assert.deepEqual([r.env.ANTHROPIC_BASE_URL, r.env.CLAUDE_CONFIG_DIR, r.env.CLAUDE_CODE_USE_VERTEX], ['https://gw', '/cfg', '1']);
    for (const k of MARKERS) assert.equal(k in r.env, false, `${k} must not reach the room`);
    assert.equal(input.CLAUDECODE, 'outer', 'the caller env is not mutated');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ROOM_AGENTS defines a haiku reader and a read-only sonnet explorer', () => {
  const agents = JSON.parse(ROOM_AGENTS) as Record<string, { description: string; prompt: string; model: string; tools: string[] }>;
  assert.deepEqual(Object.keys(agents).sort(), ['explorer', 'reader']);
  assert.equal(agents.reader.model, 'haiku');
  assert.deepEqual(agents.reader.tools, ['Read', 'Grep', 'Glob']);
  assert.equal(agents.explorer.model, 'sonnet');
  for (const t of agents.explorer.tools) assert.ok(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(t), t);
  for (const a of Object.values(agents)) {
    assert.ok(a.description.length > 0);
    assert.ok(a.prompt.length > 0);
  }
});

test('buildRoomCommand keeps a permission mode given in the extra args, and puts the brief last', () => {
  const home = tmp('build');
  try {
    const env = { MAITRE_HOME: home };
    for (const extra of [['--permission-mode', 'plan'], ['--permission-mode=plan']]) {
      const args = buildRoomCommand('x', extra, env).args;
      assert.equal(args.filter((a) => a.startsWith('--permission-mode')).length, 1, extra.join(' '));
      assert.deepEqual(args.slice(-extra.length), extra);
    }
    const args = buildRoomCommand('x', ['--model', 'opus'], env, '# Brief\n\n-x').args;
    assert.deepEqual(args.slice(-3), ['--model', 'opus', '# Brief\n\n-x']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildRoomCommand leaves no empty PATH entry when PATH is unset', () => {
  const home = tmp('build');
  try {
    assert.equal(buildRoomCommand('x', [], { MAITRE_HOME: home }).env.PATH, BIN);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildRoomCommand rejects a name with no usable characters', () => {
  assert.throws(() => buildRoomCommand('!!!', [], { MAITRE_HOME: '/nonexistent' }), /invalid room name/);
});

test('room run launches claude with the room wiring, lets it declare status, and records its exit', () => {
  const sb = sandbox(
    [
      'printf "%s\\n" "$@" > "$FAKE_OUT/args"',
      'env > "$FAKE_OUT/env"',
      'maitre status waiting "CI" 2> "$FAKE_OUT/status.err" || touch "$FAKE_OUT/status-failed"',
      'exit 3',
    ].join('\n'),
  );
  try {
    const r = spawnSync(process.execPath, [MAITRE, 'room', 'run', 'Nf Bug', '--', '--model', 'haiku'], {
      env: sb.env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 3, r.stderr);
    assert.equal(existsSync(join(sb.out, 'status-failed')), false, readFileSync(join(sb.out, 'status.err'), 'utf8'));

    const args = readFileSync(join(sb.out, 'args'), 'utf8').split('\n').slice(0, -1);
    assert.deepEqual(args, [
      '--settings',
      join(sb.home, 'settings', 'room-hooks.json'),
      '--append-system-prompt',
      ROOM_PROMPT,
      '--agents',
      ROOM_AGENTS,
      '--permission-mode',
      'auto',
      '--model',
      'haiku',
    ]);

    const env = new Map(
      readFileSync(join(sb.out, 'env'), 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as [string, string]),
    );
    assert.equal(env.get('MAITRE_ROOM'), 'nf-bug');
    assert.equal(env.get('MAITRE_HOME'), sb.home);
    assert.ok(env.get('PATH')?.startsWith(BIN + delimiter));
    for (const k of MARKERS) assert.equal(env.has(k), false, `${k} must not reach the room`);

    const got = lines(sb.home, 'nf-bug');
    assert.equal(got.length, 2);
    assert.equal(got[0].event, 'MaitreStatus');
    assert.equal(got[0].status, 'waiting');
    assert.equal(got[0].text, 'CI');
    assertExitLine(got[1], 'nf-bug');
  } finally {
    sb.cleanup();
  }
});

test('room run exits 128+n when claude dies from a signal, and records one exit', () => {
  const sb = sandbox('kill -TERM $$');
  try {
    const r = spawnSync(process.execPath, [MAITRE, 'room', 'run', 't1'], { env: sb.env, encoding: 'utf8' });
    assert.equal(r.status, 143, r.stderr);
    const got = lines(sb.home, 't1');
    assert.equal(got.length, 1);
    assertExitLine(got[0], 't1');
  } finally {
    sb.cleanup();
  }
});

// Counts every signal it gets, then dies from the first one with the default action, late
// enough for a duplicate (e.g. a forwarded copy of a TTY signal) to have been counted.
const COUNTING_CLAUDE = `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
const out = process.env.FAKE_OUT;
let first;
for (const sig of ['SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGTERM']) {
  process.on(sig, () => {
    appendFileSync(out + '/signals', sig + '\\n');
    if (first !== undefined) return;
    first = sig;
    setTimeout(() => {
      process.removeAllListeners(first);
      process.kill(process.pid, first);
    }, 300);
  });
}
setInterval(() => {}, 1000);
writeFileSync(out + '/ready', '');
`;

for (const [sig, code, group] of [
  ['SIGINT', 130, true],
  ['SIGHUP', 129, true],
  ['SIGTERM', 143, false],
] as const) {
  const how = group ? 'to the whole process group (as a terminal does)' : 'to room run alone';
  test(`room run: ${sig} sent ${how} reaches claude exactly once and records one exit`, async () => {
    const sb = sandbox('', COUNTING_CLAUDE);
    // detached: room run leads its own process group, like a shell job in the foreground.
    const child = spawn(process.execPath, [MAITRE, 'room', 'run', 't1'], { env: sb.env, stdio: 'ignore', detached: true });
    const pid = child.pid!;
    try {
      const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
      await waitFor(() => existsSync(join(sb.out, 'ready')));
      process.kill(group ? -pid : pid, sig);
      assert.equal(await exited, code);
      assert.deepEqual(readFileSync(join(sb.out, 'signals'), 'utf8').split('\n').filter((l) => l !== ''), [sig]);
      const got = lines(sb.home, 't1');
      assert.equal(got.length, 1);
      assertExitLine(got[0], 't1');
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      sb.cleanup();
    }
  });
}

test('room run refuses extra args that would replace the room hooks or prompt', () => {
  const sb = sandbox('touch "$FAKE_OUT/ran"');
  try {
    for (const flag of ['--settings', '--append-system-prompt', '--append-system-prompt-file', '--settings=x.json', '--agents', '--agents={}']) {
      const r = spawnSync(process.execPath, [MAITRE, 'room', 'run', 't1', '--', '--model', 'haiku', flag, 'x'], {
        env: sb.env,
        encoding: 'utf8',
      });
      assert.equal(r.status, 2, flag);
      assert.match(r.stderr, /^maitre: [^\n]*--(settings|append-system-prompt|agents)[^\n]*\n$/);
    }
    assert.equal(existsSync(join(sb.out, 'ran')), false);
    assert.deepEqual(lines(sb.home, 't1'), []);
  } finally {
    sb.cleanup();
  }
});

test('room run --run <id> stamps its exit line with that id, on every way it ends', () => {
  for (const [script, mode] of [['exit 0', 0o755], ['exit 0', 0o644]] as const) {
    const sb = sandbox(script);
    try {
      chmodSync(join(sb.fake, 'claude'), mode);
      const r = spawnSync(process.execPath, [MAITRE, 'room', 'run', 't1', '--run', 'r-0001', '--', '--model', 'haiku'], { env: sb.env, encoding: 'utf8' });
      assert.notEqual(r.status, null, r.stderr);
      const got = lines(sb.home, 't1');
      assert.equal(got.length, 1, `${mode.toString(8)}: ${r.stderr}`);
      assertExitLine(got[0]!, 't1');
      assert.equal(got[0]!.run, 'r-0001');
    } finally {
      sb.cleanup();
    }
  }
});

test('room run without claude on PATH prints one line and exits 127', () => {
  const sb = sandbox('exit 0');
  try {
    const r = spawnSync(process.execPath, [MAITRE, 'room', 'run', 't1'], {
      env: { ...sb.env, PATH: sb.out },
      encoding: 'utf8',
    });
    assert.equal(r.status, 127);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^maitre: .*claude.*\n$/);
    const got = lines(sb.home, 't1');
    assert.equal(got.length, 1, 'a run that ended is recorded however it ended');
    assertExitLine(got[0]!, 't1');
  } finally {
    sb.cleanup();
  }
});

const ARGV_CLAUDE = `#!${process.execPath}
require('node:fs').writeFileSync(process.env.FAKE_OUT + '/argv.json', JSON.stringify(process.argv.slice(2)));
`;

test('room run --brief-file passes the file content verbatim as the last argument', () => {
  const sb = sandbox('', ARGV_CLAUDE);
  try {
    const brief = "# Brief from the maître reception\n\nit''s $(touch x) `id`\n--model opus\n";
    const file = join(sb.out, 'brief.md');
    writeFileSync(file, brief);
    const r = spawnSync(process.execPath, [MAITRE, 'room', 'run', 't1', '--brief-file', file, '--', '--model', 'haiku'], {
      env: sb.env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const argv = JSON.parse(readFileSync(join(sb.out, 'argv.json'), 'utf8')) as string[];
    assert.equal(argv.at(-1), brief);
    assert.deepEqual(argv.slice(-3, -1), ['--model', 'haiku']);
  } finally {
    sb.cleanup();
  }
});

test('room run with an unreadable brief file prints one line, exits 1 and never starts claude', () => {
  const sb = sandbox('touch "$FAKE_OUT/ran"');
  try {
    const r = spawnSync(process.execPath, [MAITRE, 'room', 'run', 't1', '--brief-file', join(sb.out, 'missing.md')], {
      env: sb.env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^maitre: [^\n]*brief[^\n]*\n$/);
    assert.equal(existsSync(join(sb.out, 'ran')), false);
    assert.deepEqual(lines(sb.home, 't1').map((l) => l.event), ['MaitreExit']);
  } finally {
    sb.cleanup();
  }
});

test('buildRoomCommand passes --resume through after the model, with no brief to submit as a prompt', () => {
  const home = tmp('build');
  try {
    const args = buildRoomCommand('x', ['--model', 'sonnet', '--resume', 's1'], { MAITRE_HOME: home }).args;
    assert.deepEqual(args.slice(-4), ['--model', 'sonnet', '--resume', 's1']);
    assert.deepEqual(args.slice(0, -4), buildRoomCommand('x', ['--model', 'sonnet'], { MAITRE_HOME: home }, 'brief').args.slice(0, -3));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
