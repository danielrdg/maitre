import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS } from './events.js';
import { maitreHome } from './paths.js';

const HOOK_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'maitre-hook.mjs');

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

export function writeHookSettings(env: NodeJS.ProcessEnv = process.env): string {
  const path = join(maitreHome(env), 'settings', 'room-hooks.json');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(hookSettings(HOOK_SCRIPT), null, 2) + '\n');
  renameSync(tmp, path);
  return path;
}
