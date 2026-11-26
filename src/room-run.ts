import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeHookSettings } from './hook-settings.js';
import { maitreHome, roomSlug } from './paths.js';
import { appendRoomLine } from './status.js';

const BIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin');

export const ROOM_PROMPT =
  'You are running inside a maître room. When you start waiting on something outside your control (CI, a build, a review bot), run `maitre status waiting "<what>"`. When you resume, run `maitre status working "<what>"`.';

// An inherited child-session marker turns transcript saving off in the room's Claude.
export const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_ENTRYPOINT',
] as const;

// The child shares our foreground process group, so the TTY already delivers these to it:
// forwarding would double them. We only outlive them to record the exit.
const GROUP_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGQUIT'] as const;

// Would silently replace the room's hooks or prompt.
const RESERVED_FLAGS = ['--settings', '--append-system-prompt', '--append-system-prompt-file'];

export function reservedFlag(extra: string[]): string | undefined {
  return extra.find((a) => RESERVED_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
}

export interface RoomCommand {
  cmd: 'claude';
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function buildRoomCommand(name: string, extra: string[], env: NodeJS.ProcessEnv): RoomCommand {
  const room = roomSlug(name);
  const home = maitreHome(env);
  const settings = writeHookSettings({ ...env, MAITRE_HOME: home });
  const out: NodeJS.ProcessEnv = { ...env, MAITRE_ROOM: room, MAITRE_HOME: home };
  out.PATH = env.PATH ? `${BIN_DIR}${delimiter}${env.PATH}` : BIN_DIR;
  for (const k of SESSION_MARKERS) delete out[k];
  return { cmd: 'claude', args: ['--settings', settings, '--append-system-prompt', ROOM_PROMPT, ...extra], env: out };
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const n = signal === null ? undefined : constants.signals[signal];
  return n === undefined ? 1 : 128 + n;
}

export function runRoom(name: string, extra: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { cmd, args, env: childEnv } = buildRoomCommand(name, extra, env);
  const room = childEnv.MAITRE_ROOM!;
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: childEnv });
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
      if (err.code === 'ENOENT') console.error('maitre: `claude` was not found on PATH; install Claude Code first');
      else console.error(`maitre: could not start claude: ${err.message}`);
      finish(err.code === 'ENOENT' ? 127 : 1);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      try {
        appendRoomLine(room, 'MaitreExit', {}, childEnv);
      } catch (err) {
        console.error(`maitre: could not record the room exit: ${(err as Error).message}`);
      }
      finish(exitCode(code, signal));
    });
  });
}
