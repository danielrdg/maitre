import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { maitreHome } from './paths.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface RequestsModule {
  storeRequest(home: string, text: string): number | undefined;
}

let loaded: Promise<RequestsModule> | undefined;

function load(): Promise<RequestsModule> {
  loaded ??= import(pathToFileURL(join(ROOT, 'hooks', 'requests.mjs')).href) as Promise<RequestsModule>;
  return loaded;
}

export async function storeRequest(text: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const id = (await load()).storeRequest(maitreHome(env), text);
  if (id === undefined) throw new Error('could not store the request');
  return String(id);
}

export const isRequestId = (s: string): boolean => /^[0-9]{1,12}$/.test(s);

const requestsDir = (env: NodeJS.ProcessEnv) => join(maitreHome(env), 'reception', 'requests');

export function readRequests(ids: string[], env: NodeJS.ProcessEnv = process.env): string {
  const parts = ids.map((id) => {
    if (!isRequestId(id)) throw new Error(`invalid request id ${JSON.stringify(id)}`);
    const file = join(requestsDir(env), `${id}.md`);
    if (!existsSync(file)) throw new Error(`request ${id} not found`);
    return readFileSync(file, 'utf8');
  });
  if (parts.length === 1) return parts[0];
  return parts.map((p, i) => (i < parts.length - 1 && !p.endsWith('\n') ? `${p}\n` : p)).join('---\n');
}
