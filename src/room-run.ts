import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from './env.js';
import { writeHookSettings } from './hook-settings.js';
import { maitreHome, roomSlug } from './paths.js';
import { appendRoomLine } from './status.js';

const BIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin');

export const ROOM_PROMPT =
  'You are running inside a maître room. When you start waiting on something outside your control (CI, a build, a review bot), run `maitre status waiting "<what>"`. When you resume, run `maitre status working "<what>"`.';

// The child shares our foreground process group, so the TTY already delivers these to it:
// forwarding would double them. We only outlive them to record the exit.
const GROUP_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGQUIT'] as const;

// Would silently replace the room's hooks, prompt or subagents.
const RESERVED_FLAGS = ['--settings', '--append-system-prompt', '--append-system-prompt-file', '--agents'];

export const ROOM_AGENTS = JSON.stringify({
  reader: {
    description: 'Reads and searches files to gather facts for the main agent. Use it for any reading or searching that does not need judgment.',
    prompt: 'You read and search files and report exactly what you find, with paths and line numbers. You never edit anything.',
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob'],
  },
  explorer: {
    description: 'Explores code and documentation to answer a question that needs some reasoning, without changing anything.',
    prompt: 'You explore code and documentation to answer the question you are given, citing paths and line numbers. You never edit anything.',
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  },
});

export function reservedFlag(extra: string[]): string | undefined {
  return extra.find((a) => RESERVED_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
}

export interface RoomCommand {
  cmd: 'claude';
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function buildRoomCommand(name: string, extra: string[], env: NodeJS.ProcessEnv, brief?: string): RoomCommand {
  const room = roomSlug(name);
  const home = maitreHome(env);
  const settings = writeHookSettings({ ...env, MAITRE_HOME: home });
  const out: NodeJS.ProcessEnv = { ...cleanEnv(env), MAITRE_ROOM: room, MAITRE_HOME: home };
  out.PATH = env.PATH ? `${BIN_DIR}${delimiter}${env.PATH}` : BIN_DIR;
  const args = ['--settings', settings, '--append-system-prompt', ROOM_PROMPT, '--agents', ROOM_AGENTS];
  if (!extra.some((a) => a === '--permission-mode' || a.startsWith('--permission-mode='))) args.push('--permission-mode', 'auto');
  args.push(...extra);
  if (brief !== undefined) args.push(brief);
  return { cmd: 'claude', args, env: out };
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const n = signal === null ? undefined : constants.signals[signal];
  return n === undefined ? 1 : 128 + n;
}

// Runs a child in the foreground of this terminal and resolves with its exit code (128+n for a signal).
export function runForeground(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; notFound?: string },
): Promise<number> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: opts.env, ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) });
    const stay = () => {};
    const forwardTerm = () => {
      child.kill('SIGTERM');
    };
    for (const sig of GROUP_SIGNALS) process.on(sig, stay);
    process.on('SIGTERM', forwardTerm);
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      for (const sig of GROUP_SIGNALS) process.off(sig, stay);
      process.off('SIGTERM', forwardTerm);
      done(code);
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      // After a successful spawn an 'error' only means a failed kill; 'exit' still settles.
      if (settled || child.pid !== undefined) return;
      if (err.code === 'ENOENT') console.error(`maitre: ${opts.notFound ?? `\`${cmd}\` was not found on PATH`}`);
      else console.error(`maitre: could not start ${cmd}: ${err.message}`);
      finish(err.code === 'ENOENT' ? 127 : 1);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      finish(exitCode(code, signal));
    });
  });
}

// The room's exit line, however its run ended (a wake waiting on it reads `run` to know it is its own).
export function recordRoomExit(name: string, env: NodeJS.ProcessEnv, run?: string): void {
  try {
    appendRoomLine(roomSlug(name), 'MaitreExit', run !== undefined ? { run } : {}, { ...env, MAITRE_HOME: maitreHome(env) });
  } catch (err) {
    console.error(`maitre: could not record the room exit: ${(err as Error).message}`);
  }
}

export async function runRoom(name: string, extra: string[], env: NodeJS.ProcessEnv = process.env, brief?: string, run?: string): Promise<number> {
  let command: RoomCommand;
  try {
    command = buildRoomCommand(name, extra, env, brief);
  } catch (err) {
    recordRoomExit(name, env, run);
    throw err;
  }
  const code = await runForeground(command.cmd, command.args, { env: command.env, notFound: '`claude` was not found on PATH; install Claude Code first' });
  recordRoomExit(name, env, run);
  return code;
}
