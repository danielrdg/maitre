import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { maitreHome } from './paths.js';

export interface ProjectOverride {
  base?: string;
  branchPrefix?: string;
}

export interface MaitreConfig {
  roots: string[];
  projects: Record<string, ProjectOverride>;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(maitreHome(env), 'config.json');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MaitreConfig {
  const raw = readJson(configPath(env)) as Partial<MaitreConfig> | undefined;
  const roots = Array.isArray(raw?.roots) ? raw.roots.filter((r): r is string => typeof r === 'string') : [];
  const projects = raw?.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects) ? raw.projects : {};
  return { roots, projects };
}

export function saveConfig(cfg: MaitreConfig, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(configPath(env), cfg);
}
