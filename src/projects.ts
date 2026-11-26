import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readJson, writeJsonAtomic, type MaitreConfig } from './config.js';
import { maitreHome } from './paths.js';

export interface Project {
  name: string;
  path: string;
  remote?: string;
  base: string;
  branchPrefix: string;
}

const MAX_DEPTH = 2;

function gitOut(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

type RepoKind = 'repo' | 'worktree' | 'none' | 'unreadable';

function repoKind(dir: string): RepoKind {
  const dotGit = join(dir, '.git');
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return 'none';
  }
  if (st.isDirectory()) return 'repo';
  let pointer: string;
  try {
    pointer = readFileSync(dotGit, 'utf8');
  } catch {
    return 'unreadable';
  }
  return /[\\/]worktrees[\\/]/.test(pointer) ? 'worktree' : 'repo';
}

function findRepos(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'node_modules') continue;
    const child = join(dir, name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    const kind = repoKind(child);
    if (kind === 'repo') out.push(child);
    else if (kind === 'none') findRepos(child, depth + 1, out);
  }
}

export function scanProjects(roots: string[], cfg: MaitreConfig): Project[] {
  const paths: string[] = [];
  for (const root of roots) if (existsSync(root)) findRepos(root, 1, paths);
  const unique = [...new Set(paths)];
  const counts = new Map<string, number>();
  for (const p of unique) counts.set(basename(p), (counts.get(basename(p)) ?? 0) + 1);
  const used = new Set<string>();
  return unique.map((path) => {
    const folder = basename(path);
    const base = (counts.get(folder) ?? 0) > 1 ? `${basename(dirname(path))}-${folder}` : folder;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    const override = cfg.projects[name] ?? {};
    const head = gitOut(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const project: Project = {
      name,
      path,
      base: override.base ?? head?.replace(/^origin\//, '') ?? 'main',
      branchPrefix: override.branchPrefix ?? 'maitre/',
    };
    const remote = gitOut(path, ['remote', 'get-url', 'origin']);
    if (remote !== undefined) project.remote = remote;
    return project;
  });
}

function indexPath(env: NodeJS.ProcessEnv): string {
  return join(maitreHome(env), 'state', 'projects.json');
}

export function writeIndex(projects: Project[], env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(indexPath(env), projects);
}

export function readIndex(env: NodeJS.ProcessEnv = process.env): Project[] {
  const raw = readJson(indexPath(env));
  return Array.isArray(raw) ? (raw as Project[]) : [];
}
