import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS } from './events.js';
import { maitreHome } from './paths.js';

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
const HOOK_SCRIPT = join(HOOKS_DIR, 'maitre-hook.mjs');
const REQUEST_HOOK = join(HOOKS_DIR, 'reception-request.mjs');
const GUARD_HOOK = join(HOOKS_DIR, 'reception-guard.mjs');

function quote(path: string): string {
  if (/["$`\\]/.test(path)) throw new Error(`unsafe path for a hook command: ${path}`);
  return `"${path}"`;
}

export function hookSettings(hookScriptPath: string, nodePath: string = process.execPath): object {
  const command = `${quote(nodePath)} ${quote(resolve(hookScriptPath))}`;
  const hooks: Record<string, unknown> = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command }] }];
  return { hooks };
}

function writeSettings(env: NodeJS.ProcessEnv, name: string, value: object): string {
  const path = join(maitreHome(env), 'settings', name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
  return path;
}

export function writeHookSettings(env: NodeJS.ProcessEnv = process.env): string {
  return writeSettings(env, 'room-hooks.json', hookSettings(HOOK_SCRIPT));
}

// `--setting-sources ""` drops the user's hooks, herdr's state hook with them; it is registered
// again exactly as herdr installs it. The request hook also runs on SessionStart to leave the
// started marker. `|| exit 2` makes a guard that cannot run (no node, no script) block, not allow.
export function receptionSettings(opts: { requestHook: string; guardHook: string; herdrHook?: string; nodePath?: string }): object {
  const node = quote(opts.nodePath ?? process.execPath);
  const request = { type: 'command', command: `${node} ${quote(resolve(opts.requestHook))}` };
  const sessionStart: unknown[] = [{ hooks: [request] }];
  if (opts.herdrHook !== undefined) {
    sessionStart.push({ matcher: '*', hooks: [{ type: 'command', command: `bash ${quote(opts.herdrHook)} session`, timeout: 10 }] });
  }
  const hooks = {
    UserPromptSubmit: [{ hooks: [request] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: `${node} ${quote(resolve(opts.guardHook))} || exit 2` }] }],
    SessionStart: sessionStart,
  };
  // `maitre dispatch` to a parked room wakes it and delivers: up to about two minutes under load, past the
  // Bash tool's default 120 s, which would cut the reply (and what it says about the room) short.
  return { permissions: { allow: ['Bash(maitre:*)'] }, env: { BASH_DEFAULT_TIMEOUT_MS: '300000' }, hooks };
}

export function writeReceptionSettings(env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): string {
  const herdrHook = join(userHome, '.claude', 'hooks', 'herdr-agent-state.sh');
  const settings = receptionSettings({ requestHook: REQUEST_HOOK, guardHook: GUARD_HOOK, ...(existsSync(herdrHook) ? { herdrHook } : {}) });
  return writeSettings(env, 'reception.json', settings);
}
