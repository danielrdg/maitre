import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookLine } from '../src/events.js';
import { parseArgs } from '../src/cli.js';
import { openApp } from '../src/open-app.js';
import { roomDir } from '../src/paths.js';

const MAITRE = fileURLToPath(new URL('../../bin/maitre', import.meta.url));

test('parseArgs parses lounge flags', () => {
  assert.deepEqual(parseArgs(['lounge', '--demo', '--port', '9000', '--no-open', '--lang', 'pt-BR']), {
    cmd: 'lounge',
    demo: true,
    port: 9000,
    open: false,
    lang: 'pt-BR',
  });
});

test('parseArgs defaults', () => {
  assert.deepEqual(parseArgs(['lounge']), { cmd: 'lounge', demo: false, port: 8737, open: true, lang: 'en' });
  assert.equal(parseArgs([]).cmd, 'help');
  assert.equal(parseArgs(['--version']).cmd, 'version');
});

test('openApp returns false without a display', () => {
  assert.equal(openApp('http://x', {}), false);
});

test('bin/maitre asks for a build when dist/ is missing', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dir = mkdtempSync(join(tmpdir(), 'maitre-bin-'));
  try {
    mkdirSync(join(dir, 'bin'));
    copyFileSync(join(root, 'bin', 'maitre'), join(dir, 'bin', 'maitre'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const r = spawnSync(process.execPath, [join(dir, 'bin', 'maitre'), '--version'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Run `npm run build` first/);
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs parses room run with extra claude args after --', () => {
  assert.deepEqual(parseArgs(['room', 'run', 'Nf Bug', '--', '--model', 'haiku', '--port', '1', '--help']), {
    cmd: 'room-run',
    room: 'Nf Bug',
    extra: ['--model', 'haiku', '--port', '1', '--help'],
  });
  assert.deepEqual(parseArgs(['room', 'run', 'x']), { cmd: 'room-run', room: 'x', extra: [] });
  assert.deepEqual(parseArgs(['room', 'run', 'x', '--']), { cmd: 'room-run', room: 'x', extra: [] });
});

test('parseArgs rejects malformed room commands', () => {
  for (const argv of [
    ['room'],
    ['room', 'list'],
    ['room', 'run'],
    ['room', 'run', '--'],
    ['room', 'run', 'x', '--model', 'haiku'],
    ['room', 'run', 'x', '--', '--settings', 'other.json'],
    ['room', 'run', 'x', '--', '--append-system-prompt', 'p'],
    ['room', 'run', 'x', '--', '--append-system-prompt-file=p.md'],
  ]) {
    assert.equal(parseArgs(argv).cmd, 'usage', argv.join(' '));
  }
});

test('parseArgs parses status with options', () => {
  assert.deepEqual(parseArgs(['status', 'blocked', 'Pick one', '--option', 'A', '--option', 'B']), {
    cmd: 'status',
    status: 'blocked',
    text: 'Pick one',
    options: ['A', 'B'],
  });
  assert.deepEqual(parseArgs(['status', 'waiting', 'lounge']), { cmd: 'status', status: 'waiting', text: 'lounge', options: [] });
  assert.deepEqual(parseArgs(['status', 'working', '--demo']), { cmd: 'status', status: 'working', text: '--demo', options: [] });
});

test('parseArgs rejects malformed status commands', () => {
  for (const argv of [['status'], ['status', 'sleeping', 'x'], ['status', 'waiting'], ['status', 'waiting', 'x', '--option'], ['status', 'waiting', 'x', 'y']]) {
    assert.equal(parseArgs(argv).cmd, 'usage', argv.join(' '));
  }
});

test('maitre status appends a MaitreStatus line to the room', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-status-'));
  try {
    const r = spawnSync(process.execPath, [MAITRE, 'status', 'waiting', 'CI'], {
      env: { PATH: process.env.PATH ?? '', MAITRE_ROOM: 't1', MAITRE_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    const dir = roomDir('t1', { MAITRE_HOME: home });
    const file = join(dir, 'events.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 1);
    const l = JSON.parse(lines[0]) as HookLine;
    assert.equal(l.v, 1);
    assert.equal(l.room, 't1');
    assert.equal(l.session, '');
    assert.equal(l.event, 'MaitreStatus');
    assert.equal(l.status, 'waiting');
    assert.equal(l.text, 'CI');
    assert.deepEqual(l.options, []);
    assert.ok(Number.isFinite(l.ts));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('maitre status outside a room exits 1 with one line and writes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-status-'));
  try {
    for (const room of [undefined, '', '!!!']) {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', MAITRE_HOME: home };
      if (room !== undefined) env.MAITRE_ROOM = room;
      const r = spawnSync(process.execPath, [MAITRE, 'status', 'waiting', 'CI'], { env, encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /^maitre: [^\n]+\n$/);
    }
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('maitre prints one usage line and exits 2 on a malformed command', () => {
  const r = spawnSync(process.execPath, [MAITRE, 'status', 'sleeping', 'x'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^maitre: [^\n]+\n$/);
});

test('maitre lounge serves the live state of real rooms', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-lounge-'));
  const dir = roomDir('t1', { MAITRE_HOME: home });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ v: 1, ts: 1, room: 't1', session: 's1', event: 'SessionStart', model: 'claude-haiku-4-5' }) + '\n');
  const child = spawn(process.execPath, [MAITRE, 'lounge', '--no-open', '--port', '0'], {
    env: { PATH: process.env.PATH ?? '', MAITRE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
  try {
    const url = await new Promise<string>((res, rej) => {
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        out += c;
        const m = /maitre lounge: (\S+)/.exec(out);
        if (m) res(m[1]);
      });
      child.on('exit', () => rej(new Error(`lounge exited early: ${out}`)));
    });
    assert.doesNotMatch(url, /demo=1/);
    const key = new URL(url).searchParams.get('key');
    const api = new URL(url);
    api.pathname = '/api/state';
    api.search = `?key=${key}`;
    const res = await fetch(api);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rooms: { room: string }[] };
    assert.deepEqual(body.rooms.map((r) => r.room), ['t1']);
  } finally {
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    rmSync(home, { recursive: true, force: true });
  }
});
