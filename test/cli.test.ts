import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookLine } from '../src/events.js';
import { HELP, parseArgs } from '../src/cli.js';
import { loungeFile } from '../src/lounge-file.js';
import { roomDir } from '../src/paths.js';
import { fakeBin, type FakeBin } from './fake-bin.js';

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

test('parseArgs parses serve, which never opens a window', () => {
  assert.deepEqual(parseArgs(['serve']), { cmd: 'serve', demo: false, port: 8737, open: false, lang: 'en' });
  assert.deepEqual(parseArgs(['serve', '--port', '9000', '--lang', 'pt-BR']), { cmd: 'serve', demo: false, port: 9000, open: false, lang: 'pt-BR' });
});

test('parseArgs defaults', () => {
  assert.deepEqual(parseArgs(['lounge']), { cmd: 'lounge', demo: false, port: 8737, open: true, lang: 'en' });
  assert.equal(parseArgs([]).cmd, 'start');
  assert.equal(parseArgs(['--version']).cmd, 'version');
});

test('parseArgs parses open and prompt, and HELP lists the doors', () => {
  assert.deepEqual(parseArgs(['open']), { cmd: 'open' });
  assert.deepEqual(parseArgs(['prompt']), { cmd: 'prompt' });
  assert.equal(parseArgs(['open', 'x']).cmd, 'usage');
  assert.equal(parseArgs(['prompt', '--x']).cmd, 'usage');
  for (const cmd of ['serve', 'open', 'prompt']) assert.match(HELP, new RegExp(`^  maitre ${cmd}\\b`, 'm'), cmd);
  assert.match(HELP, /^  maitre serve \[--port <n>\]$/m);
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
  assert.deepEqual(parseArgs(['room', 'run', 'x', '--brief-file', '/b.md', '--', '--model', 'm']), {
    cmd: 'room-run',
    room: 'x',
    extra: ['--model', 'm'],
    briefFile: '/b.md',
  });
  assert.deepEqual(parseArgs(['room', 'run', 'x', '--brief-file', '/b.md']), { cmd: 'room-run', room: 'x', extra: [], briefFile: '/b.md' });
});

test('parseArgs parses room open, send, list and close', () => {
  assert.deepEqual(parseArgs(['room', 'open', 'Nf Bug', '--project', 'api', '--model', 'opus', '--task', 'build', '--brief', '-x "y"']), {
    cmd: 'room-open',
    name: 'Nf Bug',
    project: 'api',
    model: 'opus',
    taskType: 'build',
    brief: '-x "y"',
  });
  assert.deepEqual(parseArgs(['room', 'open', 'x', '--brief-file', '/b', '--task', 'simple', '--model', 'haiku']), {
    cmd: 'room-open',
    name: 'x',
    model: 'haiku',
    taskType: 'simple',
    briefFile: '/b',
  });
  assert.deepEqual(parseArgs(['room', 'send', 'x', '--model opus']), { cmd: 'room-send', room: 'x', text: '--model opus' });
  assert.deepEqual(parseArgs(['room', 'list']), { cmd: 'room-list' });
  assert.deepEqual(parseArgs(['room', 'close', 'x']), { cmd: 'room-close', room: 'x' });
});

test('parseArgs rejects malformed room commands', () => {
  for (const argv of [
    ['room'],
    ['room', 'list', 'x'],
    ['room', 'close'],
    ['room', 'close', 'x', 'y'],
    ['room', 'send', 'x'],
    ['room', 'send', 'x', 'a', 'b'],
    ['room', 'send', '-x', 'a'],
    ['room', 'open', 'x', '--model', 'm', '--task', 't'],
    ['room', 'open', 'x', '--model', 'm', '--task', 't', '--brief', 'b', '--brief-file', 'f'],
    ['room', 'open', 'x', '--task', 't', '--brief', 'b'],
    ['room', 'open', 'x', '--model', 'm', '--brief', 'b'],
    ['room', 'open', 'x', '--model', 'm', '--task', 't', '--brief'],
    ['room', 'open', 'x', '--model', 'm', '--task', 't', '--brief', 'b', '--color', 'red'],
    ['room', 'open', 'x', '--model', 'm', '--model', 'n', '--task', 't', '--brief', 'b'],
    ['room', 'open', '--model', 'm', '--task', 't', '--brief', 'b'],
    ['room', 'run', 'x', '--brief-file'],
    ['room', 'run', 'x', '--brief-file', '--', '--model', 'm'],
    ['room', 'run', 'x', '--', '--agents', '{}'],
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
    const info = JSON.parse(readFileSync(loungeFile({ MAITRE_HOME: home }), 'utf8')) as { port: number; token: string; pid: number };
    assert.deepEqual(info, { port: Number(new URL(url).port), token: key, pid: child.pid });
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
    assert.equal(readInfo(home).pid, 0);
    rmSync(home, { recursive: true, force: true });
  }
});

interface Running {
  child: ChildProcessWithoutNullStreams;
  out: () => string;
  line: (re: RegExp) => Promise<RegExpExecArray>;
  exited: Promise<number | null>;
}

function run(home: string, args: string[], extra: NodeJS.ProcessEnv = {}): Running {
  const child = spawn(process.execPath, [MAITRE, ...args], {
    env: { PATH: process.env.PATH ?? '', MAITRE_HOME: home, ...extra },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const waiters: (() => void)[] = [];
  const onData = (c: string) => {
    out += c;
    for (const w of [...waiters]) w();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
  const line = (re: RegExp) =>
    new Promise<RegExpExecArray>((res, rej) => {
      const check = () => {
        const m = re.exec(out);
        if (m) res(m);
      };
      waiters.push(check);
      check();
      void exited.then(() => rej(new Error(`exited before ${re}: ${out}`)));
    });
  return { child, out: () => out, line, exited };
}

function readInfo(home: string): { port: number; token: string; pid: number } {
  return JSON.parse(readFileSync(loungeFile({ MAITRE_HOME: home }), 'utf8')) as { port: number; token: string; pid: number };
}

test('maitre serve owns lounge.json, prints no key, a second lounge refuses to start, and a restart keeps the token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-serve-'));
  const first = run(home, ['serve', '--port', '0']);
  try {
    const m = await first.line(/maitre serve: \S+:(\d+)\S*\n/);
    const port = Number(m[1]);
    const info = readInfo(home);
    assert.deepEqual(info, { port, token: info.token, pid: first.child.pid });
    assert.match(info.token, /^[0-9a-f]{64}$/);
    assert.equal(statSync(loungeFile({ MAITRE_HOME: home })).mode & 0o777, 0o600);
    assert.doesNotMatch(first.out(), /key=/);
    assert.ok(!first.out().includes(info.token), 'the token is never printed');

    const api = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'x-maitre-token': info.token } });
    assert.equal(api.status, 200);

    for (const [args, code] of [[['serve', '--port', '0'], 0], [['lounge', '--no-open', '--port', '0'], 1]] as const) {
      const second = run(home, [...args]);
      assert.equal(await second.exited, code, args.join(' '));
      assert.equal(second.out(), `maitre: a lounge is already running on port ${port}\n`);
    }
    assert.deepEqual(readInfo(home), info);

    const demo = run(home, ['lounge', '--demo', '--no-open', '--port', '0']);
    await demo.line(/maitre lounge: \S+demo=1/);
    assert.deepEqual(readInfo(home), info);
    demo.child.kill('SIGTERM');
    assert.equal(await demo.exited, 0);
    assert.deepEqual(readInfo(home), info);

    first.child.kill('SIGTERM');
    assert.equal(await first.exited, 0);
    assert.deepEqual(readInfo(home), { ...info, pid: 0 });
    const again = run(home, ['serve', '--port', '0']);
    try {
      const m2 = await again.line(/maitre serve: \S+:(\d+)\S*\n/);
      assert.deepEqual(readInfo(home), { port: Number(m2[1]), token: info.token, pid: again.child.pid });
      const reuse = await fetch(`http://127.0.0.1:${m2[1]}/api/state`, { headers: { cookie: `maitre_key_${m2[1]}=${info.token}` } });
      assert.equal(reuse.status, 200);
    } finally {
      again.child.kill('SIGTERM');
      assert.equal(await again.exited, 0);
    }
  } finally {
    first.child.kill('SIGTERM');
    await first.exited;
    rmSync(home, { recursive: true, force: true });
  }
});

test('maitre serve takes over after a crashed owner and keeps its token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-serve-'));
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const free = await new Promise<number>((res) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => res(p));
    });
  });
  const token = 'cd'.repeat(32);
  writeFileSync(loungeFile({ MAITRE_HOME: home }), JSON.stringify({ port: free, token, pid: dead }));
  const s = run(home, ['serve', '--port', '0']);
  try {
    const m = await s.line(/maitre serve: \S+:(\d+)\S*\n/);
    assert.deepEqual(readInfo(home), { port: Number(m[1]), token, pid: s.child.pid });
    assert.equal(statSync(loungeFile({ MAITRE_HOME: home })).mode & 0o777, 0o600);
    assert.doesNotMatch(s.out(), /key=/);
  } finally {
    s.child.kill('SIGTERM');
    assert.equal(await s.exited, 0);
    rmSync(home, { recursive: true, force: true });
  }
});

test('maitre lounge --demo never touches lounge.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-demo-'));
  const s = run(home, ['lounge', '--demo', '--no-open', '--port', '0']);
  try {
    await s.line(/maitre lounge: \S+demo=1/);
    assert.equal(existsSync(loungeFile({ MAITRE_HOME: home })), false);
  } finally {
    s.child.kill('SIGTERM');
    assert.equal(await s.exited, 0);
    assert.equal(existsSync(loungeFile({ MAITRE_HOME: home })), false);
    rmSync(home, { recursive: true, force: true });
  }
});

function postJson(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

test('the live lounge answers the reception and terminal endpoints; the demo lounge has neither', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-serve-'));
  const live = run(home, ['serve', '--port', '0']);
  const demo = run(home, ['lounge', '--demo', '--no-open', '--port', '0']);
  try {
    const port = Number((await live.line(/maitre serve: \S+:(\d+)\S*\n/))[1]);
    const auth = { 'x-maitre-token': readInfo(home).token };
    const empty = await postJson(port, '/api/reception', auth, JSON.stringify({ text: '  ' }));
    assert.equal(empty.status, 400);
    assert.deepEqual(JSON.parse(empty.body), { kind: 'error', message: 'the request text is empty' });
    const ghost = await postJson(port, '/api/rooms/ghost/terminal', auth, '');
    assert.equal(ghost.status, 409);
    assert.deepEqual(JSON.parse(ghost.body), { kind: 'error', message: 'ghost is not running' });

    const url = new URL((await demo.line(/maitre lounge: (\S+demo=1)/))[1]);
    const same = { origin: url.origin, 'x-maitre-request': '1' };
    for (const path of ['/api/reception', '/api/rooms/ghost/terminal']) {
      const res = await postJson(Number(url.port), `${path}?key=${url.searchParams.get('key')}`, same, JSON.stringify({ text: 'hi' }));
      assert.equal(res.status, 403, path);
    }
    assert.equal(existsSync(join(home, 'reception', 'requests')), false);
  } finally {
    live.child.kill('SIGTERM');
    demo.child.kill('SIGTERM');
    await live.exited;
    await demo.exited;
    rmSync(home, { recursive: true, force: true });
  }
});

// A display and a PATH holding only recording fakes: no real browser, systemctl or notify-send can run.
function doors(home: string): { fb: FakeBin; env: NodeJS.ProcessEnv } {
  const fb = fakeBin();
  for (const name of ['google-chrome', 'notify-send', 'systemctl']) fb.add(name);
  fb.add('xrandr', { stdout: 'DP-1 connected primary 1920x1080+0+0 (normal) 0mm x 0mm\n   1920x1080     60.00*+\n' });
  return { fb, env: { PATH: fb.bin, DISPLAY: ':99', HOME: home, XDG_CONFIG_HOME: join(home, 'config') } };
}

function appUrl(argv: string[]): URL {
  const app = argv.find((a) => a.startsWith('--app='));
  assert.ok(app, JSON.stringify(argv));
  return new URL(app.slice('--app='.length));
}

async function assertTicketWorks(url: URL): Promise<void> {
  const res = await fetch(new URL(`/?ticket=${url.searchParams.get('ticket')}`, url));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
}

test('maitre open and maitre prompt open app windows with a ticket, never the token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-doors-'));
  const { fb, env } = doors(home);
  const serve = run(home, ['serve', '--port', '0']);
  try {
    const port = Number((await serve.line(/maitre serve: \S+:(\d+)\S*\n/))[1]);
    const { token } = readInfo(home);
    const open = run(home, ['open'], env);
    assert.equal(await open.exited, 0, open.out());
    const prompt = run(home, ['prompt'], env);
    assert.equal(await prompt.exited, 0, prompt.out());

    const calls = await fb.waitCalls('google-chrome', 2);
    assert.equal(calls.length, 2);
    for (const argv of calls) {
      assert.ok(!argv.join(' ').includes(token), 'no token in argv');
      assert.ok(argv.includes(`--user-data-dir=${join(home, 'chrome')}`));
      assert.ok(argv.includes('--class=maitre'));
    }
    const lounge = calls.find((c) => appUrl(c).pathname === '/')!;
    const small = calls.find((c) => appUrl(c).pathname === '/prompt.html')!;
    assert.equal(appUrl(lounge).origin, `http://127.0.0.1:${port}`);
    assert.match(appUrl(small).search, /^\?ticket=[0-9a-f]{64}$/);
    assert.ok(!lounge.some((a) => a.startsWith('--window-')), 'the lounge window keeps its own size');
    assert.ok(small.includes('--window-size=560,180'));
    assert.ok(small.includes('--window-position=680,450'));
    await assertTicketWorks(appUrl(lounge));
    await assertTicketWorks(appUrl(small));
    assert.deepEqual(fb.calls('systemctl'), []);
    assert.deepEqual(fb.calls('notify-send'), []);
  } finally {
    serve.child.kill('SIGTERM');
    await serve.exited;
    fb.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test('maitre open without a display prints a one-time URL and exits 1', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-doors-'));
  const { fb, env } = doors(home);
  const serve = run(home, ['serve', '--port', '0']);
  try {
    const port = Number((await serve.line(/maitre serve: \S+:(\d+)\S*\n/))[1]);
    const open = run(home, ['open'], { ...env, DISPLAY: undefined });
    assert.equal(await open.exited, 1);
    const m = /no display for a window; open (http:\/\/127\.0\.0\.1:(\d+)\/\?ticket=[0-9a-f]{64}) within a minute/.exec(open.out());
    assert.ok(m, open.out());
    assert.equal(Number(m[2]), port);
    assert.ok(!open.out().includes(readInfo(home).token));
    await assertTicketWorks(new URL(m[1]!));
    assert.deepEqual(fb.calls('google-chrome'), []);
  } finally {
    serve.child.kill('SIGTERM');
    await serve.exited;
    fb.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test('maitre prompt that cannot start the lounge says so, also as a desktop notification', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-doors-'));
  const { fb, env } = doors(home);
  try {
    mkdirSync(join(home, 'config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(home, 'config', 'systemd', 'user', 'maitre.service'), '# Managed by maitre setup\n');
    const p = run(home, ['prompt'], { ...env, MAITRE_LOUNGE_WAIT_MS: '300' });
    assert.equal(await p.exited, 1);
    assert.equal(p.out(), 'maitre: the lounge did not start; see journalctl --user -u maitre\n');
    assert.deepEqual(fb.calls('systemctl'), [['--user', 'start', 'maitre']]);
    assert.deepEqual(fb.calls('notify-send'), [['maître', 'the lounge did not start; see journalctl --user -u maitre']]);
    assert.deepEqual(fb.calls('google-chrome'), []);
  } finally {
    fb.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test('maitre lounge opens its own window with a ticket and still prints its key URL', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-doors-'));
  const { fb, env } = doors(home);
  const live = run(home, ['lounge', '--port', '0', '--lang', 'pt-BR'], env);
  try {
    const printed = new URL((await live.line(/maitre lounge: (\S+)\n/))[1]!);
    const { token } = readInfo(home);
    assert.equal(printed.searchParams.get('key'), token);
    const [argv] = await fb.waitCalls('google-chrome');
    assert.ok(argv && !argv.join(' ').includes(token), 'no token in argv');
    const url = appUrl(argv!);
    assert.equal(url.origin, printed.origin);
    assert.equal(url.searchParams.get('lang'), 'pt-BR');
    await assertTicketWorks(url);
  } finally {
    live.child.kill('SIGTERM');
    await live.exited;
    fb.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test('maitre lounge --demo opens its window with a ticket too', async () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-doors-'));
  const { fb, env } = doors(home);
  const demo = run(home, ['lounge', '--demo', '--port', '0'], env);
  try {
    const printed = new URL((await demo.line(/maitre lounge: (\S+demo=1)\n/))[1]!);
    const key = printed.searchParams.get('key')!;
    const [argv] = await fb.waitCalls('google-chrome');
    assert.ok(argv && !argv.join(' ').includes(key), 'no key in argv');
    const url = appUrl(argv!);
    assert.equal(url.searchParams.get('demo'), '1');
    await assertTicketWorks(url);
  } finally {
    demo.child.kill('SIGTERM');
    await demo.exited;
    fb.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});
