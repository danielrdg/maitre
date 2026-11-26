import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { delimiter, isAbsolute, join } from 'node:path';
import { cleanEnv } from './env.js';
import { HerdrError, focusWorkspace, herdrSession, listWorkspaces } from './herdr.js';
import type { LoungeAuth } from './lounge-server.js';
import { roomSlug } from './paths.js';
import { isRecord, probeRoom, roomLabel } from './room-open.js';
import { readRoom, type RoomRecord } from './rooms.js';
import { dispatchRouteDetailed, isRequestId, readRequests, routeRequests, storedRequestIds } from './router.js';
import { storeRequest } from './requests.js';

export type ReceptionReply =
  | { kind: 'question'; id: string; text: string }
  | { kind: 'dispatched'; id: string; room: string; lines: string[]; needsYou: boolean }
  | { kind: 'error'; message: string };

export interface ReceptionDeps {
  store?: typeof storeRequest;
  route?: typeof routeRequests;
  dispatch?: typeof dispatchRouteDetailed;
}

export type TerminalCommand = { cmd: string; args: string[] };
type SpawnTerminal = (c: TerminalCommand, env: NodeJS.ProcessEnv) => void | Promise<void>;

const MAX_BODY_BYTES = 16 * 1024;
const MAX_WAITING = 3;
const TIMEOUT_MS = 150_000;
const SHOW_ENV_TIMEOUT_MS = 5_000;
const BUSY = 'the maître is busy, try again';
const TOO_SLOW = 'the maître took too long to answer; check the lounge before sending it again';
const NO_DISPLAY = 'no display; run maitre in a terminal';
const NO_TERMINAL = 'no terminal found; install x-terminal-emulator or gnome-terminal';
// What a terminal needs from the graphical session; only filled in when the service env lacks them.
const SESSION_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'];

export class BusyError extends Error {
  constructor() {
    super(BUSY);
    this.name = 'BusyError';
  }
}

export class TimeoutError extends Error {
  constructor() {
    super(TOO_SLOW);
    this.name = 'TimeoutError';
  }
}

// One job runs at a time. The ceiling counts from run(): a job still waiting when it passes is dropped,
// one already running keeps the slot until it really ends, so jobs never overlap.
export class ReceptionQueue {
  private readonly maxWaiting: number;
  private readonly timeoutMs: number;
  private running = false;
  private readonly waiting: (() => void)[] = [];

  constructor(opts: { maxWaiting?: number; timeoutMs?: number } = {}) {
    this.maxWaiting = opts.maxWaiting ?? MAX_WAITING;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running && this.waiting.length >= this.maxWaiting) return Promise.reject(new BusyError());
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running = true;
        new Promise<T>((r) => r(job()))
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timer);
            this.running = false;
            this.waiting.shift()?.();
          });
      };
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(start);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new TimeoutError());
      }, this.timeoutMs);
      if (this.running) this.waiting.push(start);
      else start();
    });
  }
}

type Checked = { text: string; answers?: string } | { error: string };

function checkReception(body: unknown, env: NodeJS.ProcessEnv): Checked {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'the request must be a JSON object with a text string' };
  const { text, answers } = body as Record<string, unknown>;
  if (typeof text !== 'string') return { error: 'the request must be a JSON object with a text string' };
  if (text.trim() === '') return { error: 'the request text is empty' };
  if (text.includes('\0')) return { error: 'the request text contains a NUL character' };
  if (answers === undefined) return { text };
  if (typeof answers !== 'string' || !isRequestId(answers)) return { error: `invalid request id ${JSON.stringify(answers)}` };
  try {
    readRequests([answers], env);
  } catch (err) {
    return { error: (err as Error).message };
  }
  return { text, answers };
}

function confirmOpts(env: NodeJS.ProcessEnv): { confirmMs?: number } {
  const ms = Number(env.MAITRE_SEND_CONFIRM_MS);
  return Number.isFinite(ms) && ms > 0 ? { confirmMs: ms } : {};
}

export async function handleReception(body: unknown, env: NodeJS.ProcessEnv, deps: ReceptionDeps = {}): Promise<{ status: number; json: ReceptionReply }> {
  const checked = checkReception(body, env);
  if ('error' in checked) return { status: 400, json: { kind: 'error', message: checked.error } };
  const store = deps.store ?? storeRequest;
  const route = deps.route ?? routeRequests;
  const dispatch = deps.dispatch ?? dispatchRouteDetailed;
  try {
    const id = await store(checked.text, env);
    // An answer extends the conversation the question came from, so a second question keeps the first request.
    const before = checked.answers === undefined ? [] : (storedRequestIds(checked.answers, env) ?? [checked.answers]);
    const { route: found } = await route([...before, id], env);
    if (found.question !== undefined) return { status: 200, json: { kind: 'question', id, text: found.question } };
    const d = await dispatch(id, env, confirmOpts(env));
    return { status: 200, json: { kind: 'dispatched', id, room: d.room, lines: d.lines, needsYou: d.needsYou } };
  } catch (err) {
    return { status: 500, json: { kind: 'error', message: (err as Error).message } };
  }
}

// Absolute PATH entries only: a relative one would resolve against the service's working directory.
function which(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function terminalCommand(env: NodeJS.ProcessEnv): TerminalCommand | undefined {
  const attach = [which('herdr', env) ?? 'herdr', '--session', herdrSession(env)];
  const x = which('x-terminal-emulator', env);
  if (x !== undefined) return { cmd: x, args: ['-e', ...attach] };
  const gnome = which('gnome-terminal', env);
  if (gnome !== undefined) return { cmd: gnome, args: ['--', ...attach] };
  return undefined;
}

const hasDisplay = (env: NodeJS.ProcessEnv) => Boolean(env.DISPLAY) || Boolean(env.WAYLAND_DISPLAY);

function userManagerEnv(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    try {
      execFile('systemctl', ['--user', 'show-environment'], { env: cleanEnv(env), timeout: SHOW_ENV_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
        const out: Record<string, string> = {};
        if (err !== null) return resolve(out);
        for (const line of stdout.split('\n')) {
          const eq = line.indexOf('=');
          if (eq <= 0) continue;
          const value = line.slice(eq + 1);
          // systemd prints values with special characters as $'…' escapes; none of the session vars needs one.
          if (value.startsWith("$'")) continue;
          out[line.slice(0, eq)] = value;
        }
        resolve(out);
      });
    } catch {
      resolve({});
    }
  });
}

export async function displayEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv | undefined> {
  if (hasDisplay(env)) return { ...env };
  const found = await userManagerEnv(env);
  if (!hasDisplay(found)) return undefined;
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of SESSION_VARS) if (!out[k] && found[k]) out[k] = found[k];
  return out;
}

function spawnDetached(c: TerminalCommand, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', env });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function send(res: ServerResponse, status: number, json: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(JSON.stringify(json));
}

const fail = (res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}) =>
  send(res, status, { kind: 'error', message }, extra);

function notAllowed(req: IncomingMessage, res: ServerResponse): true {
  req.resume();
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' });
  res.end('Method not allowed');
  return true;
}

function isJson(req: IncomingMessage): boolean {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

// undefined: the body passed MAX_BODY_BYTES; reading stops there.
function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.off('data', onData);
        req.off('end', onEnd);
        resolve(undefined);
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => resolve(Buffer.concat(chunks));
    req.on('data', onData);
    req.on('end', onEnd);
    req.once('error', reject);
  });
}

function tooLarge(res: ServerResponse): void {
  fail(res, 413, 'the request is too long (at most 16 KiB)', { connection: 'close' });
}

async function reception(req: IncomingMessage, res: ServerResponse, queue: ReceptionQueue, env: NodeJS.ProcessEnv, deps: ReceptionDeps): Promise<void> {
  if (!isJson(req)) {
    req.resume();
    return fail(res, 400, 'the body must be JSON (content-type: application/json)');
  }
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return tooLarge(res);
  const raw = await readBody(req);
  if (raw === undefined) return tooLarge(res);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return fail(res, 400, 'the body is not valid JSON');
  }
  // Checked again in the job; refusing here keeps bad input out of the queue.
  const checked = checkReception(body, env);
  if ('error' in checked) return fail(res, 400, checked.error);
  try {
    const r = await queue.run(() => handleReception(body, env, deps));
    send(res, r.status, r.json);
  } catch (err) {
    if (err instanceof BusyError) return fail(res, 429, err.message);
    if (err instanceof TimeoutError) return fail(res, 504, err.message);
    fail(res, 500, (err as Error).message);
  }
}

function validRoom(name: string): boolean {
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  try {
    return roomSlug(name) === name;
  } catch {
    return false;
  }
}

function registered(room: string, env: NodeJS.ProcessEnv): RoomRecord | undefined {
  try {
    const rec = readRoom(room, env);
    return typeof rec === 'object' && rec !== null && isRecord(rec) ? rec : undefined;
  } catch {
    return undefined;
  }
}

async function terminal(res: ServerResponse, room: string, env: NodeJS.ProcessEnv, spawnTerminal: SpawnTerminal): Promise<void> {
  const notRunning = () => fail(res, 409, `${room} is not running`);
  const rec = registered(room, env);
  if (rec?.herdr === undefined) return notRunning();
  let workspaces: { id: string; label: string }[];
  try {
    workspaces = await listWorkspaces();
    if ((await probeRoom(rec, workspaces, env)) === 'not running') return notRunning();
  } catch (err) {
    // No herdr server (after a reboot, say) means no room runs.
    if (err instanceof HerdrError) return notRunning();
    throw err;
  }
  const ws = workspaces.find((w) => w.id === rec.herdr!.workspaceId && w.label === roomLabel(rec));
  if (ws === undefined) return notRunning();
  const denv = await displayEnv(env);
  if (denv === undefined) return fail(res, 503, NO_DISPLAY);
  const cmd = terminalCommand(denv);
  if (cmd === undefined) return fail(res, 503, NO_TERMINAL);
  await focusWorkspace(ws.id);
  await spawnTerminal(cmd, cleanEnv(denv));
  send(res, 200, { kind: 'ok' });
}

const TERMINAL_PATH = /^\/api\/rooms\/(.+)\/terminal$/;

export function receptionRoutes(opts: {
  queue: ReceptionQueue;
  env: NodeJS.ProcessEnv;
  spawnTerminal?: SpawnTerminal;
  deps?: ReceptionDeps;
}): (req: IncomingMessage, res: ServerResponse, url: URL, auth?: LoungeAuth) => boolean {
  const { queue, env } = opts;
  const spawnTerminal = opts.spawnTerminal ?? spawnDetached;
  const deps = opts.deps ?? {};
  // The server answers a throw with a text 404; these handlers answer every error themselves.
  const guard = (res: ServerResponse, work: Promise<void>) => {
    work.catch((err: unknown) => {
      if (res.headersSent) res.destroy();
      else fail(res, 500, (err as Error).message);
    });
  };

  return (req, res, url) => {
    if (url.pathname === '/api/reception') {
      if (req.method !== 'POST') return notAllowed(req, res);
      guard(res, reception(req, res, queue, env, deps));
      return true;
    }
    const m = TERMINAL_PATH.exec(url.pathname);
    if (m !== null) {
      if (req.method !== 'POST') return notAllowed(req, res);
      req.resume();
      let room: string;
      try {
        room = decodeURIComponent(m[1]);
      } catch {
        fail(res, 400, 'invalid room name');
        return true;
      }
      if (!validRoom(room)) {
        fail(res, 400, `invalid room name ${JSON.stringify(room)}`);
        return true;
      }
      guard(res, terminal(res, room, env, spawnTerminal));
      return true;
    }
    return false;
  };
}
