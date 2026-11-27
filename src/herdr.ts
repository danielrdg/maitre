import { execFile, spawn } from 'node:child_process';
import { cleanEnv } from './env.js';

export type PaneStatus = 'working' | 'blocked' | 'idle' | 'unknown' | 'gone';

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly argv: string[],
  ) {
    super(message);
    this.name = 'HerdrError';
  }
}

export class RoomBlockedError extends HerdrError {
  constructor(argv: string[], message = 'agent is blocked on a prompt') {
    super('agent_blocked', message, argv);
    this.name = 'RoomBlockedError';
  }
}

const SERVER_START_TIMEOUT_MS = 10_000;
// Every call answers within this; a hung herdr is killed so its caller (the lounge's ticks) moves on.
const CALL_TIMEOUT_MS = 30_000;

function callTimeout(env: NodeJS.ProcessEnv): number {
  const ms = Number(env.MAITRE_HERDR_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : CALL_TIMEOUT_MS;
}
const SERVER_POLL_MS = 100;

export function herdrSession(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAITRE_HERDR_SESSION || 'maitre';
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface Raw {
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
}

// The arguments may hold the user's text: an error names the subcommand and the errno or signal only.
function execFailed(args: string[], argv: string[], err: { code?: unknown; signal?: unknown; killed?: unknown }, timeoutMs?: number): HerdrError {
  const why =
    err.code === 'ENOENT'
      ? 'not found on PATH'
      : err.killed === true && timeoutMs !== undefined
        ? `timed out after ${timeoutMs / 1000} s`
        : String(err.code ?? err.signal ?? 'failed');
  return new HerdrError('exec_failed', `herdr ${args.slice(0, 2).join(' ')}: ${why}`, argv);
}

// timeoutMs 0: no limit, for a call that waits on purpose.
function rawHerdr(args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = callTimeout(env)): Promise<Raw> {
  const argv = ['--session', herdrSession(env), ...args];
  return new Promise((resolve, reject) => {
    try {
      execFile('herdr', argv, { env, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          reject(execFailed(args, argv, err, timeoutMs > 0 ? timeoutMs : undefined));
          return;
        }
        resolve({ argv, code: err ? (err.code as number) : 0, stdout, stderr });
      });
    } catch (err) {
      // E2BIG and similar spawn failures throw instead of reaching the callback.
      reject(execFailed(args, argv, err as NodeJS.ErrnoException));
    }
  });
}

function parseJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

// herdr 0.8.2 prints its error JSON on stderr; stdout is checked too, in case that changes.
function toError(raw: Raw, json: any): HerdrError {
  if (!json?.error) json = parseJson(raw.stderr);
  if (json?.error?.code) {
    const code = String(json.error.code);
    const msg = String(json.error.message ?? code);
    return code === 'agent_blocked' ? new RoomBlockedError(raw.argv, msg) : new HerdrError(code, msg, raw.argv);
  }
  return new HerdrError('exec_failed', raw.stderr.trim() || `herdr exited with ${raw.code}`, raw.argv);
}

async function herdr(args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs?: number): Promise<any> {
  const raw = await rawHerdr(args, env, timeoutMs);
  const json = parseJson(raw.stdout);
  if (raw.code !== 0 || json?.error) throw toError(raw, json);
  return json;
}

async function serverRunning(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const raw = await rawHerdr(['status', 'server', '--json'], env);
    return raw.code === 0 && parseJson(raw.stdout)?.running === true;
  } catch {
    return false;
  }
}

export async function ensureServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (await serverRunning(env)) return;
  const argv = ['--session', herdrSession(env), 'server'];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('herdr', argv, { detached: true, stdio: 'ignore', env: cleanEnv(env) });
    child.once('error', (e) => reject(new HerdrError('exec_failed', `herdr server: ${e.message}`, argv)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await serverRunning(env)) return;
    await new Promise((r) => setTimeout(r, SERVER_POLL_MS));
  }
  throw new HerdrError('server_timeout', `herdr server did not start within ${SERVER_START_TIMEOUT_MS / 1000}s`, argv);
}

export interface AgentInfo {
  status: PaneStatus;
  agent?: string;
}

function mapStatus(s: unknown): PaneStatus {
  if (s === 'working' || s === 'blocked' || s === 'idle') return s;
  if (s === 'done') return 'idle';
  return 'unknown';
}

// `agent get` answers agent_not_found for both a bare shell and a missing pane; `pane get` tells them apart.
export async function agentInfo(paneId: string): Promise<AgentInfo> {
  try {
    const json = await herdr(['agent', 'get', paneId]);
    const agent = json?.result?.agent;
    const info: AgentInfo = { status: mapStatus(agent?.agent_status) };
    if (typeof agent?.agent === 'string') info.agent = agent.agent;
    return info;
  } catch (e) {
    if (!(e instanceof HerdrError) || e.code !== 'agent_not_found') throw e;
  }
  try {
    await herdr(['pane', 'get', paneId]);
    return { status: 'unknown' };
  } catch (e) {
    if (e instanceof HerdrError && e.code === 'pane_not_found') return { status: 'gone' };
    throw e;
  }
}

export async function agentStatus(paneId: string): Promise<PaneStatus> {
  return (await agentInfo(paneId)).status;
}

export async function createWorkspace(opts: {
  cwd: string;
  label: string;
  env: Record<string, string>;
}): Promise<{ workspaceId: string; paneId: string }> {
  const args = ['workspace', 'create', '--cwd', opts.cwd, '--label', opts.label];
  for (const [k, v] of Object.entries(opts.env)) args.push('--env', `${k}=${v}`);
  args.push('--no-focus');
  const json = await herdr(args);
  const workspaceId = json?.result?.workspace?.workspace_id;
  const paneId = json?.result?.root_pane?.pane_id;
  if (typeof workspaceId !== 'string' || typeof paneId !== 'string') {
    throw new HerdrError('bad_response', 'workspace create returned no workspace_id/pane_id', args);
  }
  return { workspaceId, paneId };
}

export async function runInPane(paneId: string, command: string): Promise<void> {
  await herdr(['pane', 'run', paneId, command]);
}

// ansi: keeps the escape codes, e.g. to tell Claude Code's dim placeholder from typed text.
export async function readPane(paneId: string, lines?: number, opts: { ansi?: boolean } = {}): Promise<string> {
  const args = ['pane', 'read', paneId, '--source', 'visible'];
  if (lines !== undefined) args.push('--lines', String(lines));
  if (opts.ansi === true) args.push('--format', 'ansi');
  const raw = await rawHerdr(args);
  if (raw.code !== 0) throw toError(raw, parseJson(raw.stdout));
  return raw.stdout;
}

export async function sendKeys(paneId: string, ...keys: string[]): Promise<void> {
  await herdr(['agent', 'send-keys', paneId, ...keys]);
}

export async function prompt(
  paneId: string,
  text: string,
  opts: { wait?: boolean; timeoutMs?: number } = {},
): Promise<'idle' | 'blocked' | 'sent'> {
  const wait = opts.wait ?? true;
  // herdr's parser takes the first two positionals as target and text, so a dash-leading text is safe
  // only before the options; `--` is rejected ("unknown option") by herdr 0.8.2.
  const args = ['agent', 'prompt', paneId, text];
  if (wait) args.push('--wait');
  if (opts.timeoutMs !== undefined) args.push('--timeout', String(opts.timeoutMs));
  // --wait answers when the turn ends: herdr's own --timeout, plus the usual margin, or no limit.
  const json = await herdr(args, process.env, wait ? (opts.timeoutMs !== undefined ? opts.timeoutMs + callTimeout(process.env) : 0) : undefined);
  if (json?.result?.type !== 'agent_prompted') {
    throw new HerdrError('bad_response', 'agent prompt returned an unexpected response', args);
  }
  if (!wait) return 'sent';
  const status = json?.result?.agent?.agent_status;
  if (status === 'blocked') return 'blocked';
  if (status === 'idle' || status === 'done') return 'idle';
  throw new HerdrError('bad_response', `agent prompt --wait settled in "${String(status)}"`, args);
}

export async function closeWorkspace(workspaceId: string): Promise<void> {
  await herdr(['workspace', 'close', workspaceId]);
}

export async function focusWorkspace(workspaceId: string): Promise<void> {
  await herdr(['workspace', 'focus', workspaceId]);
}

export async function listPanes(workspaceId: string): Promise<string[]> {
  const json = await herdr(['pane', 'list', '--workspace', workspaceId]);
  const list: any[] = json?.result?.panes ?? [];
  return list.map((p) => String(p.pane_id));
}

export async function listWorkspaces(): Promise<{ id: string; label: string }[]> {
  const json = await herdr(['workspace', 'list']);
  const list: any[] = json?.result?.workspaces ?? [];
  return list.map((w) => ({ id: String(w.workspace_id), label: String(w.label ?? '') }));
}
