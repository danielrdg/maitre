import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from '../src/config.js';
import { readIndex, scanProjects, writeIndex } from '../src/projects.js';

const MAITRE = fileURLToPath(new URL('../../bin/maitre', import.meta.url));

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'maitre-proj-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const emptyCfg = { roots: [], projects: {} };

test('scanProjects lists repos, skipping worktrees and node_modules', () => {
  withTmp((dir) => {
    const root = join(dir, 'root');
    initRepo(join(root, 'alpha'));
    initRepo(join(root, 'group', 'beta'));
    git(join(root, 'alpha'), 'worktree', 'add', '-q', join(root, 'alpha-wt'), '-b', 'wt');
    mkdirSync(join(root, 'node_modules', 'x', '.git'), { recursive: true });
    const found = scanProjects([root], emptyCfg);
    assert.deepEqual(found.map((p) => p.name).sort(), ['alpha', 'beta']);
    const alpha = found.find((p) => p.name === 'alpha')!;
    assert.equal(alpha.path, join(root, 'alpha'));
    assert.equal(alpha.base, 'main');
    assert.equal(alpha.branchPrefix, 'maitre/');
  });
});

test('scanProjects takes base from origin/HEAD, and config override wins', () => {
  withTmp((dir) => {
    const bare = join(dir, 'remote.git');
    mkdirSync(bare);
    git(bare, 'init', '-q', '--bare', '-b', 'dev');
    const seed = join(dir, 'seed');
    initRepo(seed);
    git(seed, 'branch', '-m', 'dev');
    git(seed, 'push', '-q', bare, 'dev');
    const root = join(dir, 'root');
    mkdirSync(root);
    git(root, 'clone', '-q', bare, 'app');
    const [p] = scanProjects([root], emptyCfg);
    assert.equal(p.base, 'dev');
    assert.equal(p.remote, bare);
    const [o] = scanProjects([root], { roots: [], projects: { app: { base: 'release', branchPrefix: 'x/' } } });
    assert.equal(o.base, 'release');
    assert.equal(o.branchPrefix, 'x/');
  });
});

test('scanProjects dedupes name collisions as <parent>-<name>', () => {
  withTmp((dir) => {
    const root = join(dir, 'root');
    initRepo(join(root, 'a', 'api'));
    initRepo(join(root, 'b', 'api'));
    const names = scanProjects([root], emptyCfg).map((p) => p.name).sort();
    assert.deepEqual(names, ['a-api', 'b-api']);
  });
});

test('scanProjects never gives two projects the same name', () => {
  withTmp((dir) => {
    const root = join(dir, 'root');
    initRepo(join(root, 'x', 'api'));
    initRepo(join(root, 'y', 'api'));
    initRepo(join(root, 'x-api'));
    const other = join(dir, 'other');
    initRepo(join(other, 'x', 'api'));
    const names = scanProjects([root, other], emptyCfg).map((p) => p.name);
    assert.equal(new Set(names).size, names.length, names.join(' '));
    assert.deepEqual([...names].sort(), ['x-api', 'x-api-2', 'x-api-3', 'y-api']);
  });
});

test('scanProjects skips a folder whose .git file cannot be read and indexes the rest', (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads any file');
  withTmp((dir) => {
    const root = join(dir, 'root');
    initRepo(join(root, 'alpha'));
    const broken = join(root, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, '.git'), 'gitdir: /x/.git/worktrees/broken\n');
    chmodSync(join(broken, '.git'), 0o000);
    try {
      assert.deepEqual(scanProjects([root], emptyCfg).map((p) => p.name), ['alpha']);
    } finally {
      chmodSync(join(broken, '.git'), 0o600);
    }
  });
});

test('config and index round-trip with 0600 files', () => {
  withTmp((dir) => {
    const env = { MAITRE_HOME: join(dir, 'home') };
    assert.deepEqual(loadConfig(env), { roots: [], projects: {} });
    saveConfig({ roots: ['/x'], projects: { a: { base: 'dev' } } }, env);
    assert.deepEqual(loadConfig(env), { roots: ['/x'], projects: { a: { base: 'dev' } } });
    assert.equal(statSync(join(dir, 'home', 'config.json')).mode & 0o777, 0o600);
    assert.deepEqual(readIndex(env), []);
    const projects = [{ name: 'a', path: '/x/a', base: 'main', branchPrefix: 'maitre/' }];
    writeIndex(projects, env);
    assert.deepEqual(readIndex(env), projects);
    assert.equal(statSync(join(dir, 'home', 'state', 'projects.json')).mode & 0o777, 0o600);
  });
});

function maitre(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [MAITRE, ...args], { encoding: 'utf8', env: { ...process.env, MAITRE_HOME: home } });
}

test('maitre index without roots hints at --root', () => {
  withTmp((dir) => {
    const r = maitre(join(dir, 'home'), 'index');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /add a root: maitre index --root <dir>/);
  });
});

test('maitre index --root persists the root and maitre projects prints the index', () => {
  withTmp((dir) => {
    const home = join(dir, 'home');
    const root = join(dir, 'root');
    initRepo(join(root, 'alpha'));
    const r = maitre(home, 'index', '--root', root);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(loadConfig({ MAITRE_HOME: home }).roots, [root]);
    const again = maitre(home, 'index');
    assert.equal(again.status, 0, again.stderr);
    const list = maitre(home, 'projects');
    assert.equal(list.status, 0);
    assert.equal(list.stdout.trim(), `alpha  main  ${join(root, 'alpha')}`);
  });
});

test('maitre index --root refuses a root that does not exist, saving nothing', () => {
  withTmp((dir) => {
    const home = join(dir, 'home');
    const missing = join(dir, 'nope');
    const r = maitre(home, 'index', '--root', missing);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `maitre: root not found: ${missing}\n`);
    assert.deepEqual(loadConfig({ MAITRE_HOME: home }).roots, []);
    assert.equal(existsSync(join(home, 'state', 'projects.json')), false);
  });
});
