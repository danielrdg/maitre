import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MAX_SLUG = 40;

export function maitreHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAITRE_HOME ? resolve(env.MAITRE_HOME) : join(homedir(), '.maitre');
}

// Mirrored in hooks/maitre-hook.mjs, which cannot import from dist/.
export function roomSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  if (slug === '') throw new Error('invalid room name');
  return slug;
}

export function roomDir(room: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(maitreHome(env), 'state', 'rooms', roomSlug(room));
}
