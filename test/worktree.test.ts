import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRooms } from '../src/rooms.js';
import type { Project } from '../src/projects.js';
import { createScratch, createWorktree } from '../src/worktree.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setup(fn: (ctx: { project: Project; env: NodeJS.ProcessEnv; root: string; remote: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'maitre-wt-'));
  try {
    const remote = join(root, 'remote.git');
    const clone = join(root, 'clone');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'clone', '-q', remote, clone);
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(clone, 'push', '-q', 'origin', 'main');
    const project: Project = { name: 'proj', path: clone, base: 'main', branchPrefix: 'maitre/' };
    fn({ project, env: { MAITRE_HOME: join(root, 'home') }, root, remote });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('new room: worktree on maitre/<room> from origin/<base>, no upstream', () => {
  setup(({ project, env }) => {
    const wt = createWorktree(project, 'alpha', env);
    assert.equal(wt.branch, 'maitre/alpha');
    assert.equal(wt.dir, join(env.MAITRE_HOME!, 'worktrees', 'proj', 'alpha'));
    assert.deepEqual(wt.warnings, []);
    assert.equal(git(wt.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'maitre/alpha');
    assert.equal(git(wt.dir, 'rev-parse', 'HEAD'), git(project.path, 'rev-parse', 'origin/main'));
    assert.throws(() => git(wt.dir, 'rev-parse', '--abbrev-ref', '@{upstream}'));
  });
});

test('fetch failure falls back to local origin/<base> with a warning', () => {
  setup(({ project, env, remote }) => {
    rmSync(remote, { recursive: true, force: true });
    const wt = createWorktree(project, 'alpha', env);
    assert.match(wt.warnings.join('\n'), /fetch/);
    assert.equal(git(wt.dir, 'rev-parse', 'HEAD'), git(project.path, 'rev-parse', 'origin/main'));
  });
});

test('existing branch is reused, with a warning', () => {
  setup(({ project, env }) => {
    git(project.path, 'branch', 'maitre/alpha', 'origin/main');
    const wt = createWorktree(project, 'alpha', env);
    assert.equal(git(wt.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'maitre/alpha');
    assert.deepEqual(wt.warnings, ['reopened existing branch maitre/alpha']);
  });
});

test('existing worktree for the same branch is reused, with a warning', () => {
  setup(({ project, env }) => {
    const first = createWorktree(project, 'alpha', env);
    const second = createWorktree(project, 'alpha', env);
    assert.deepEqual(second, { dir: first.dir, branch: first.branch, warnings: ['reopened existing worktree on maitre/alpha'] });
  });
});

test('foreign dir at the path throws and leaves no branch, worktree or registry', () => {
  setup(({ project, env }) => {
    const dir = join(env.MAITRE_HOME!, 'worktrees', 'proj', 'alpha');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x'), 'x');
    assert.throws(() => createWorktree(project, 'alpha', env), /worktree path in use/);
    assert.equal(git(project.path, 'branch', '--list', 'maitre/alpha'), '');
    assert.equal(git(project.path, 'worktree', 'list').split('\n').length, 1);
    assert.deepEqual(listRooms(env), []);
  });
});

test('dir that is a worktree of this repo on another branch is not reused', () => {
  setup(({ project, env }) => {
    const dir = join(env.MAITRE_HOME!, 'worktrees', 'proj', 'alpha');
    mkdirSync(join(dir, '..'), { recursive: true });
    git(project.path, 'worktree', 'add', '-q', '-b', 'other', dir, 'origin/main');
    assert.throws(() => createWorktree(project, 'alpha', env), /worktree path in use/);
    assert.equal(git(project.path, 'branch', '--list', 'maitre/alpha'), '');
  });
});

test('dirty clone does not block and stays untouched', () => {
  setup(({ project, env }) => {
    writeFileSync(join(project.path, 'dirty.txt'), 'wip');
    const wt = createWorktree(project, 'alpha', env);
    assert.ok(existsSync(wt.dir));
    assert.match(git(project.path, 'status', '--porcelain'), /dirty\.txt/);
  });
});

test('missing origin/<base> throws without creating a branch', () => {
  setup(({ project, env }) => {
    assert.throws(() => createWorktree({ ...project, base: 'nope' }, 'alpha', env));
    assert.equal(git(project.path, 'branch', '--list', 'maitre/alpha'), '');
    assert.equal(existsSync(join(env.MAITRE_HOME!, 'worktrees', 'proj', 'alpha')), false);
  });
});

test('createScratch makes a 0700 dir under scratch/', () => {
  setup(({ env }) => {
    const dir = createScratch('Notes', env);
    assert.equal(dir, join(env.MAITRE_HOME!, 'scratch', 'notes'));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

test('failed worktree add leaves no branch created by this call', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores permissions');
  setup(({ project, env }) => {
    const parent = join(env.MAITRE_HOME!, 'worktrees', 'proj');
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o500);
    try {
      assert.throws(() => createWorktree(project, 'alpha', env));
      assert.equal(git(project.path, 'branch', '--list', 'maitre/alpha'), '');
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});

test('fetch to an unreachable remote falls back fast with a warning', () => {
  setup(({ project, env }) => {
    git(project.path, 'remote', 'set-url', 'origin', 'file:///nonexistent/maitre-remote.git');
    const wt = createWorktree(project, 'alpha', env);
    assert.match(wt.warnings.join('\n'), /fetch/);
  });
});
