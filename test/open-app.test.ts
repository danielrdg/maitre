import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loungeFile, readLoungeInfo, type LoungeInfo } from '../src/lounge-file.js';
import { ensureLounge, notifyDesktop, openWindow, screenSize, ticketUrl, uiLang } from '../src/open-app.js';
import { fakeBin, type FakeBin } from './fake-bin.js';

const MAITRE = fileURLToPath(new URL('../../bin/maitre', import.meta.url));
const TOKEN = 'ab'.repeat(32);
const TICKET = 'cd'.repeat(32);
const XRANDR = [
  'Screen 0: minimum 320 x 200, current 4480 x 1440, maximum 16384 x 16384',
  'HDMI-1 connected 1920x1080+0+0 (normal left inverted right x axis y axis) 527mm x 296mm',
  '   1920x1080     60.00*+  50.00    59.94',
  '   1280x720      60.00    50.00',
  'eDP-1 connected primary 2560x1440+1920+0 (normal left inverted right x axis y axis) 309mm x 174mm',
  '   2560x1440     60.00*+',
  '   1920x1080     60.00',
  'DP-1 disconnected (normal left inverted right x axis y axis)',
  '',
].join('\n');

const cleanups: (() => void)[] = [];
after(() => {
  for (const c of cleanups) c();
});

function sandbox(): { fb: FakeBin; home: string; env: NodeJS.ProcessEnv } {
  const fb = fakeBin();
  const home = mkdtempSync(join(tmpdir(), 'maitre-open-'));
  cleanups.push(() => {
    fb.cleanup();
    rmSync(home, { recursive: true, force: true });
  });
  return { fb, home, env: { PATH: fb.bin, DISPLAY: ':99', MAITRE_HOME: home, HOME: home, XDG_CONFIG_HOME: join(home, 'config') } };
}

const chromeArgs = (home: string, url: string) => [
  `--user-data-dir=${join(home, 'chrome')}`,
  '--class=maitre',
  '--no-first-run',
  '--no-default-browser-check',
  `--app=${url}`,
];

test('openWindow is false without a display and starts nothing', async () => {
  const { fb, env } = sandbox();
  fb.add('google-chrome');
  assert.equal(openWindow('lounge', 'http://127.0.0.1:1/?ticket=x', { ...env, DISPLAY: undefined }), false);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(fb.calls('google-chrome'), []);
});

test('openWindow opens the lounge as a google-chrome app window on maître\'s own profile', async () => {
  const { fb, home, env } = sandbox();
  fb.add('google-chrome');
  fb.add('xdg-open');
  const url = `http://127.0.0.1:8737/?ticket=${TICKET}`;
  assert.equal(openWindow('lounge', url, env), true);
  assert.deepEqual(await fb.waitCalls('google-chrome'), [chromeArgs(home, url)]);
  assert.deepEqual(fb.calls('xdg-open'), []);
});

test('openWindow sizes the prompt window and centers it on the primary screen, offset included', async () => {
  const { fb, home, env } = sandbox();
  fb.add('google-chrome');
  fb.add('xrandr', { stdout: XRANDR });
  const url = `http://127.0.0.1:8737/prompt.html?ticket=${TICKET}`;
  assert.equal(openWindow('prompt', url, env), true);
  assert.deepEqual(await fb.waitCalls('google-chrome'), [[...chromeArgs(home, url), '--window-size=560,180', '--window-position=2920,630']]);
  assert.deepEqual(fb.calls('xrandr'), [['--current']]);
});

test('openWindow still sizes the prompt when the screen size is unknown', async () => {
  const { fb, home, env } = sandbox();
  fb.add('google-chrome');
  const url = `http://127.0.0.1:8737/prompt.html?ticket=${TICKET}`;
  assert.equal(openWindow('prompt', url, env), true);
  assert.deepEqual(await fb.waitCalls('google-chrome'), [[...chromeArgs(home, url), '--window-size=560,180']]);
});

test('openWindow falls back to google-chrome-stable, never to chromium, then to xdg-open', async () => {
  const { fb, home, env } = sandbox();
  fb.add('chromium');
  fb.add('chromium-browser');
  fb.add('google-chrome-stable');
  const url = `http://127.0.0.1:8737/?ticket=${TICKET}`;
  assert.equal(openWindow('lounge', url, env), true);
  assert.deepEqual(await fb.waitCalls('google-chrome-stable'), [chromeArgs(home, url)]);

  const other = sandbox();
  other.fb.add('chromium');
  other.fb.add('chromium-browser');
  other.fb.add('xdg-open');
  assert.equal(openWindow('prompt', url, other.env), true);
  assert.deepEqual(await other.fb.waitCalls('xdg-open'), [[url]]);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(other.fb.calls('chromium'), []);
  assert.deepEqual(other.fb.calls('chromium-browser'), []);

  const none = sandbox();
  none.fb.add('chromium');
  assert.equal(openWindow('lounge', url, none.env), false);
});

test('screenSize reads the primary output, else the first current mode, else nothing', () => {
  const { fb, env } = sandbox();
  assert.equal(screenSize(env), undefined, 'no xrandr');
  fb.add('xrandr', { stdout: XRANDR });
  assert.deepEqual(screenSize(env), { w: 2560, h: 1440, x: 1920, y: 0 });
  const second = sandbox();
  second.fb.add('xrandr', { stdout: XRANDR.replace(' primary', '') });
  assert.deepEqual(screenSize(second.env), { w: 1920, h: 1080, x: 0, y: 0 });
  const failing = sandbox();
  failing.fb.add('xrandr', { stdout: XRANDR, exit: 1 });
  assert.equal(screenSize(failing.env), undefined);
});

async function fakeLounge(pid = process.pid): Promise<{ info: LoungeInfo; seen: IncomingMessage[]; close(): Promise<void> }> {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    if (req.url === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'maitre', pid }));
    } else if (req.url === '/api/ticket' && req.method === 'POST' && req.headers['x-maitre-token'] === TOKEN) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ticket: TICKET }));
    } else {
      res.writeHead(403);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    info: { port: (server.address() as AddressInfo).port, token: TOKEN, pid },
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

test('ticketUrl pings first, then asks for a ticket with the token header only', async () => {
  const s = await fakeLounge();
  try {
    assert.equal(await ticketUrl(s.info, '/prompt.html'), `http://127.0.0.1:${s.info.port}/prompt.html?ticket=${TICKET}`);
    assert.equal(await ticketUrl(s.info, '/'), `http://127.0.0.1:${s.info.port}/?ticket=${TICKET}`);
    assert.deepEqual(s.seen.map((r) => `${r.method} ${r.url}`), ['GET /api/ping', 'POST /api/ticket', 'GET /api/ping', 'POST /api/ticket']);
    const post = s.seen[1]!;
    assert.equal(post.headers.origin, undefined);
    assert.equal(post.headers.cookie, undefined);
    assert.ok(!(post.url ?? '').includes(TOKEN));
  } finally {
    await s.close();
  }
});

test('ticketUrl sends no token to a port that fails the ping', async () => {
  const s = await fakeLounge(process.ppid);
  try {
    await assert.rejects(ticketUrl({ ...s.info, pid: process.pid }, '/'), /the lounge is not running/);
    assert.deepEqual(s.seen.map((r) => r.url), ['/api/ping']);
    for (const v of Object.values(s.seen[0]!.headers)) assert.ok(!String(v).includes(TOKEN));
  } finally {
    await s.close();
  }
});

async function stopServe(home: string): Promise<void> {
  const pid = readLoungeInfo({ MAITRE_HOME: home })?.pid;
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('ensureLounge returns a live lounge as is and starts nothing', async () => {
  const { fb, home, env } = sandbox();
  fb.add('systemctl');
  mkdirSync(join(home, 'config', 'systemd', 'user'), { recursive: true });
  writeFileSync(join(home, 'config', 'systemd', 'user', 'maitre.service'), '# Managed by maitre setup\n');
  const s = await fakeLounge();
  try {
    writeFileSync(loungeFile(env), JSON.stringify(s.info));
    assert.deepEqual(await ensureLounge(env), s.info);
    assert.deepEqual(fb.calls('systemctl'), []);
    assert.equal(existsSync(join(home, 'serve.log')), false);
  } finally {
    await s.close();
  }
});

test('ensureLounge without a unit starts serve detached over a stale file and keeps its token', async () => {
  const { fb, home, env } = sandbox();
  fb.add('systemctl');
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  writeFileSync(loungeFile(env), JSON.stringify({ port: 1, token: TOKEN, pid: dead }));
  try {
    const info = await ensureLounge(env);
    assert.equal(info.token, TOKEN);
    assert.notEqual(info.pid, dead);
    assert.deepEqual(readLoungeInfo(env), info);
    const ping = (await (await fetch(`http://127.0.0.1:${info.port}/api/ping`)).json()) as { pid: number };
    assert.equal(ping.pid, info.pid);
    assert.equal(statSync(join(home, 'serve.log')).mode & 0o777, 0o600);
    assert.match(readFileSync(join(home, 'serve.log'), 'utf8'), /maitre serve: http:\/\/127\.0\.0\.1:\d+\/\n/);
    assert.deepEqual(fb.calls('systemctl'), [], 'no unit, no systemctl');
  } finally {
    await stopServe(home);
  }
});

test('ensureLounge with the unit installed starts it through systemctl --user', async () => {
  const { fb, home, env } = sandbox();
  const unitDir = join(home, 'config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'maitre.service'), '# Managed by maitre setup\n');
  fb.add('systemctl', { spawn: [process.execPath, MAITRE, 'serve'] });
  try {
    const info = await ensureLounge(env);
    assert.deepEqual(fb.calls('systemctl'), [['--user', 'start', 'maitre']]);
    assert.deepEqual(readLoungeInfo(env), info);
    assert.equal(existsSync(join(home, 'serve.log')), false, 'the unit logs to the journal');
  } finally {
    await stopServe(home);
  }
});

test('ensureLounge reports where to look when the lounge does not come up', async () => {
  const { fb, home, env } = sandbox();
  const unitDir = join(home, 'config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'maitre.service'), '# Managed by maitre setup\n');
  fb.add('systemctl');
  await assert.rejects(ensureLounge(env, { timeoutMs: 300, pollMs: 20 }), {
    message: 'the lounge did not start; see journalctl --user -u maitre',
  });
  fb.add('systemctl', { exit: 5 });
  await assert.rejects(ensureLounge(env, { timeoutMs: 300, pollMs: 20 }), {
    message: 'the lounge did not start; see journalctl --user -u maitre',
  });
});

test('uiLang follows the config, else the locale, else English', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-lang-'));
  try {
    const env = { MAITRE_HOME: home, LANG: 'pt_BR.UTF-8' };
    assert.equal(uiLang(env), 'pt-BR');
    assert.equal(uiLang({ MAITRE_HOME: home, LANG: 'en_US.UTF-8' }), 'en');
    assert.equal(uiLang({ MAITRE_HOME: home, LC_ALL: 'pt_PT.UTF-8', LANG: 'en_US.UTF-8' }), 'pt-BR');
    assert.equal(uiLang({ MAITRE_HOME: home }), 'en');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ roots: [], projects: {}, lang: 'en' }));
    assert.equal(uiLang(env), 'en');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ roots: [], projects: {}, lang: 'fr' }));
    assert.equal(uiLang(env), 'pt-BR');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ticketUrl adds the language only when it is not English', async () => {
  const s = await fakeLounge();
  try {
    assert.equal(await ticketUrl(s.info, '/prompt.html', 'pt-BR'), `http://127.0.0.1:${s.info.port}/prompt.html?ticket=${TICKET}&lang=pt-BR`);
    assert.equal(await ticketUrl(s.info, '/', 'en'), `http://127.0.0.1:${s.info.port}/?ticket=${TICKET}`);
  } finally {
    await s.close();
  }
});

test("notifyDesktop runs notify-send without the Claude Code session's markers, keeping the desktop's variables", () => {
  const { fb, home, env } = sandbox();
  const out = join(home, 'notify-env.json');
  writeFileSync(join(fb.bin, 'notify-send'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`, { mode: 0o755 });
  notifyDesktop('room a needs you', { ...env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_USE_VERTEX: '1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus' });
  const seen = JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; env: Record<string, string> };
  assert.deepEqual(seen.argv, ['maître', 'room a needs you']);
  assert.equal(seen.env.CLAUDECODE, undefined);
  assert.equal(seen.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(seen.env.CLAUDE_CODE_USE_VERTEX, '1');
  assert.equal(seen.env.DISPLAY, ':99');
  assert.equal(seen.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/bus');
});
