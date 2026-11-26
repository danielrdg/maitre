import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from './env.js';
import { liveLounge, probeLounge, type LoungeInfo } from './lounge-file.js';
import { maitreHome } from './paths.js';

const MAITRE_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'maitre');
// Chromium is never tried: on Ubuntu its apt packages exec the snap, which cannot use a profile under a hidden directory.
const CHROMES = ['google-chrome', 'google-chrome-stable'];
const PROMPT_W = 560;
const PROMPT_H = 180;
const START_MS = 10_000;
const POLL_MS = 100;
const TICKET_MS = 5_000;
const TOOL_MS = 2_000;
const MAX_TICKET_BYTES = 4096;

export type WindowKind = 'lounge' | 'prompt';

export interface Screen {
  w: number;
  h: number;
  x: number;
  y: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function findBinary(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

export function hasDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// The primary output's current mode, else the first output's; x and y place it on the whole desktop.
export function screenSize(env: NodeJS.ProcessEnv = process.env): Screen | undefined {
  const xrandr = findBinary('xrandr', env);
  if (xrandr === undefined) return undefined;
  const r = spawnSync(xrandr, ['--current'], { env, encoding: 'utf8', timeout: TOOL_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
  let first: Screen | undefined;
  let output: { primary: boolean; x: number; y: number; done: boolean } | undefined;
  for (const line of r.stdout.split('\n')) {
    const head = /^\S+ connected( primary)?(?: \d+x\d+\+(\d+)\+(\d+))?/.exec(line);
    if (head) {
      output = { primary: head[1] !== undefined, x: Number(head[2] ?? 0), y: Number(head[3] ?? 0), done: false };
      continue;
    }
    if (!/^\s/.test(line)) {
      output = undefined;
      continue;
    }
    const mode = /^\s+(\d+)x(\d+)\S*\s.*\*/.exec(line);
    if (mode === null || output === undefined || output.done) continue;
    output.done = true;
    const screen = { w: Number(mode[1]), h: Number(mode[2]), x: output.x, y: output.y };
    if (output.primary) return screen;
    first ??= screen;
  }
  return first;
}

function launch(bin: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  // A cold Chrome launcher lives as long as the browser, so it is never waited for.
  const child = spawn(bin, args, { stdio: 'ignore', detached: true, env });
  child.on('error', () => {});
  child.unref();
  return true;
}

export function openWindow(kind: WindowKind, url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!hasDisplay(env)) return false;
  const childEnv = cleanEnv(env);
  const chrome = CHROMES.map((b) => findBinary(b, env)).find((p) => p !== undefined);
  if (chrome === undefined) {
    const xdg = findBinary('xdg-open', env);
    return xdg !== undefined && launch(xdg, [url], childEnv);
  }
  const profile = join(maitreHome(env), 'chrome');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const args = [`--user-data-dir=${profile}`, '--class=maitre', '--no-first-run', '--no-default-browser-check', `--app=${url}`];
  // Chrome honours size and position only on a cold profile start; the prompt page also places itself.
  if (kind === 'prompt') {
    args.push(`--window-size=${PROMPT_W},${PROMPT_H}`);
    const s = screenSize(env);
    if (s !== undefined) {
      const x = s.x + Math.max(0, Math.floor((s.w - PROMPT_W) / 2));
      const y = s.y + Math.max(0, Math.floor((s.h - PROMPT_H) / 2));
      args.push(`--window-position=${x},${y}`);
    }
  }
  return launch(chrome, args, childEnv);
}

function requestTicket(info: LoungeInfo): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: info.port,
        path: '/api/ticket',
        method: 'POST',
        agent: false,
        timeout: TICKET_MS,
        headers: { 'x-maitre-token': info.token, 'content-length': 0 },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
          if (body.length > MAX_TICKET_BYTES) req.destroy(new Error('the lounge sent an oversized ticket'));
        });
        res.on('end', () => {
          let ticket: unknown;
          try {
            ticket = (JSON.parse(body) as { ticket?: unknown } | null)?.ticket;
          } catch {
            ticket = undefined;
          }
          if (res.statusCode === 200 && typeof ticket === 'string' && /^[0-9a-f]{64}$/.test(ticket)) resolve(ticket);
          else reject(new Error(`the lounge refused a ticket (HTTP ${res.statusCode})`));
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('the lounge did not answer the ticket request')));
    req.on('error', reject);
    req.end();
  });
}

export async function ticketUrl(info: LoungeInfo, path: '/' | '/prompt.html'): Promise<string> {
  if (!(await probeLounge(info))) throw new Error('the lounge is not running');
  return `http://127.0.0.1:${info.port}${path}?ticket=${await requestTicket(info)}`;
}

export function unitFile(env: NodeJS.ProcessEnv): string {
  const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(config, 'systemd', 'user', 'maitre.service');
}

function startServe(env: NodeJS.ProcessEnv, log: string): ChildProcess {
  const home = maitreHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const fd = openSync(log, 'a', 0o600);
  try {
    chmodSync(log, 0o600);
    const child = spawn(process.execPath, [MAITRE_BIN, 'serve'], { cwd: home, detached: true, stdio: ['ignore', fd, fd], env: { ...cleanEnv(env), MAITRE_HOME: home } });
    child.on('error', () => {});
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
}

export async function ensureLounge(env: NodeJS.ProcessEnv = process.env, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<LoungeInfo> {
  const running = await liveLounge(env);
  if (running !== undefined) return running;
  let hint: string;
  let exited = false;
  if (existsSync(unitFile(env))) {
    hint = 'see journalctl --user -u maitre';
    const systemctl = findBinary('systemctl', env);
    const r = systemctl === undefined ? undefined : spawnSync(systemctl, ['--user', 'start', 'maitre'], { env, stdio: 'ignore', timeout: START_MS });
    if (r?.status !== 0) throw new Error(`the lounge did not start; ${hint}`);
  } else {
    const log = join(maitreHome(env), 'serve.log');
    hint = `see ${log}`;
    startServe(env, log).on('exit', () => (exited = true));
  }
  const deadline = Date.now() + (opts.timeoutMs ?? START_MS);
  for (;;) {
    await sleep(opts.pollMs ?? POLL_MS);
    const stop = exited || Date.now() >= deadline;
    const info = await liveLounge(env);
    if (info !== undefined) return info;
    if (stop) throw new Error(`the lounge did not start; ${hint}`);
  }
}

export function notifyDesktop(message: string, env: NodeJS.ProcessEnv = process.env): void {
  const bin = findBinary('notify-send', env);
  if (bin === undefined) return;
  try {
    spawnSync(bin, ['maître', message], { env, stdio: 'ignore', timeout: TOOL_MS });
  } catch {
    // A notification is best effort.
  }
}
