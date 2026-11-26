import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { maitreHome, roomSlug } from './paths.js';
import type { Project } from './projects.js';

const FETCH_TIMEOUT_MS = 25_000;

function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function commonDir(cwd: string): string | undefined {
  try {
    const out = git(cwd, ['rev-parse', '--git-common-dir']);
    return realpathSync(isAbsolute(out) ? out : resolve(cwd, out));
  } catch {
    return undefined;
  }
}

function isWorktreeOnBranch(project: Project, dir: string, branch: string): boolean {
  const mine = commonDir(project.path);
  if (mine === undefined || commonDir(dir) !== mine) return false;
  try {
    return git(dir, ['symbolic-ref', '--short', 'HEAD']) === branch;
  } catch {
    return false;
  }
}

export function createWorktree(
  project: Project,
  room: string,
  env: NodeJS.ProcessEnv = process.env,
): { dir: string; branch: string; warnings: string[] } {
  const slug = roomSlug(room);
  const dir = join(maitreHome(env), 'worktrees', project.name, slug);
  const branch = `${project.branchPrefix}${slug}`;

  if (existsSync(dir)) {
    if (isWorktreeOnBranch(project, dir, branch)) return { dir, branch, warnings: [`reopened existing worktree on ${branch}`] };
    throw new Error(`worktree path in use: ${dir}`);
  }

  const warnings: string[] = [];
  try {
    const fetchEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (!fetchEnv.GIT_SSH_COMMAND) fetchEnv.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    git(project.path, ['fetch', 'origin', project.base], { env: fetchEnv, timeout: FETCH_TIMEOUT_MS });
  } catch (err) {
    warnings.push(`fetch origin ${project.base} failed, using local origin/${project.base}: ${(err as Error).message.split('\n')[0]}`);
  }

  const branchExists = gitOk(project.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (!branchExists && !gitOk(project.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${project.base}`])) {
    throw new Error(`origin/${project.base} not found in ${project.path}`);
  }

  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const args = branchExists
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '--no-track', dir, '-b', branch, `origin/${project.base}`];
  try {
    git(project.path, args);
  } catch (err) {
    if (!branchExists && gitOk(project.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
      gitOk(project.path, ['branch', '-D', branch]);
    }
    throw err;
  }
  if (branchExists) warnings.push(`reopened existing branch ${branch}`);
  return { dir, branch, warnings };
}

export function createScratch(room: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(maitreHome(env), 'scratch', roomSlug(room));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
