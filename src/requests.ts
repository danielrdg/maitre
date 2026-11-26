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
