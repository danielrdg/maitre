import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoomActivity } from '../src/activity.js';
import { checkPending, isGitHubUrl } from '../src/pending.js';
import { writeIndex, type Project } from '../src/projects.js';
import type { RoomRecord } from '../src/rooms.js';
import { createScratch, createWorktree } from '../src/worktree.js';

const FAKE_GH = fileURLToPath(new URL('../../test/fixtures/fake-gh.mjs', import.meta.url));
const GITHUB = 'https://github.com/example/repo.git';
const READY: RoomActivity = { state: 'ready', lastEventAt: 0 };

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    // expected to stop half-way (a conflict)
  }
}

interface Ctx {
  root: string;
  clone: string;
  dir: string;
  rec: RoomRecord;
  env: NodeJS.ProcessEnv;
  commit(name: string, body?: string): string;
  github(): void;
  prs(list: unknown): void;
  ghCalls(): { argv: string[]; cwd: string }[];
}

// PATH is only a directory of our own (a fake `gh` and the real `git`), so no real `gh` is ever reached.
async function withRoom(fn: (ctx: Ctx) => Promise<void>, opts: { gh?: boolean; gitignore?: string } = {}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'maitre-pending-'));
  try {
    const remote = join(root, 'remote.git');
    const clone = join(root, 'clone');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'clone', '-q', remote, clone);
    writeFileSync(join(clone, 'README'), 'hello\n');
    writeFileSync(join(clone, '.gitignore'), opts.gitignore ?? '.env*\nnode_modules/\n*.log\ndist/\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'init');
    git(clone, 'push', '-q', 'origin', 'main');

    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
    if (opts.gh !== false) {
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`);
      chmodSync(join(bin, 'gh'), 0o755);
    }
    const log = join(root, 'gh.log');
    const prsFile = join(root, 'prs.json');
    const env: NodeJS.ProcessEnv = {
      PATH: bin,
      HOME: root,
      MAITRE_HOME: join(root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file',
      FAKE_GH_LOG: log,
      FAKE_GH_PRS: prsFile,
    };
    const project: Project = { name: 'proj', path: clone, base: 'main', branchPrefix: 'maitre/' };
    writeIndex([project], env);
    const wt = createWorktree(project, 'alpha', env);
    const rec: RoomRecord = { room: 'alpha', project: 'proj', kind: 'code', dir: wt.dir, branch: wt.branch, model: 'opus', taskType: 'code', createdAt: 0 };
    await fn({
      root,
      clone,
      dir: wt.dir,
      rec,
      env,
      commit(name, body = name) {
        writeFileSync(join(wt.dir, name), body);
        git(wt.dir, 'add', name);
        git(wt.dir, 'commit', '-q', '-m', name);
        return git(wt.dir, 'rev-parse', 'HEAD');
      },
      github: () => git(clone, 'remote', 'set-url', 'origin', GITHUB),
      prs: (list) => writeFileSync(prsFile, JSON.stringify(list)),
      ghCalls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; cwd: string }) : []),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('fresh room, clean, nothing new vs origin/<base>: nothing pending', async () => {
  await withRoom(async ({ rec, env, github, ghCalls }) => {
    github();
    assert.deepEqual(await checkPending(rec, READY, env), { reasons: [], ignoredGone: [] });
    assert.equal(ghCalls().length, 1);
  });
});

test('pushed with an upstream: nothing pending', async () => {
  await withRoom(async ({ rec, env, dir, commit, github }) => {
    commit('a.txt');
    git(dir, 'push', '-q', '-u', 'origin', rec.branch!);
    github();
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, []);
  });
});

test('modified tracked file: uncommitted changes', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    writeFileSync(join(dir, 'README'), 'changed\n');
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['uncommitted changes: README']);
  });
});

test('untracked file: uncommitted changes, even with status.showUntrackedFiles=no', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    writeFileSync(join(dir, 'new.txt'), 'x');
    git(dir, 'config', 'status.showUntrackedFiles', 'no');
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['uncommitted changes: new.txt']);
  });
});

test('uncommitted changes name up to 3 paths: a rename once, control characters replaced, long names clipped', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    git(dir, 'mv', 'README', 'README.md');
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['uncommitted changes: README.md']);
    writeFileSync(join(dir, 'a\tb\u202e\u0085.txt'), 'x');
    writeFileSync(join(dir, `${'x'.repeat(80)}.txt`), 'x');
    writeFileSync(join(dir, 'z.txt'), 'x');
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, [`uncommitted changes: README.md, a?b??.txt, ${'x'.repeat(59)}…, …`]);
  });
});

test('ignored .env files are pending; other ignored files go with the worktree', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    writeFileSync(join(dir, '.env.local'), 'SECRET=1');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'debug.log'), 'x');
    const r = await checkPending(rec, READY, env);
    assert.deepEqual(r.reasons, ['untracked .env files: .env.local, sub/.env']);
    assert.ok(r.ignoredGone.includes('debug.log'));
    assert.ok(!r.ignoredGone.some((p) => p.endsWith('.env') || p.includes('.env.')));
  });
});

test('ignored node_modules/ is not pending, is listed as gone and is not descended', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(dir, 'node_modules', '.env'), 'SECRET=1');
    assert.deepEqual(await checkPending(rec, READY, env), { reasons: [], ignoredGone: ['node_modules/'] });
  });
});

test('a root .env is pending', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    assert.deepEqual(await checkPending(rec, READY, env), { reasons: ['untracked .env files: .env'], ignoredGone: [] });
  });
});

test('.env files inside a wholly ignored folder are pending; the folder still goes with the worktree', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    mkdirSync(join(dir, 'dist', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'x');
    writeFileSync(join(dir, 'dist', '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'dist', 'deep', '.env.prod'), 'SECRET=1');
    assert.deepEqual(await checkPending(rec, READY, env), { reasons: ['untracked .env files: dist/.env, dist/deep/.env.prod'], ignoredGone: ['dist/'] });
  });
});

test('.env files under node_modules, at any depth, are not reported (by design)', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', '.env'), 'SECRET=1');
    mkdirSync(join(dir, 'dist', 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'node_modules', '.env'), 'SECRET=1');
    assert.deepEqual(await checkPending(rec, READY, env), { reasons: [], ignoredGone: ['dist/', 'node_modules/'] });
  });
});

test('node_modules ignored as node_modules/*: nothing under it is reported or walked, and it goes as one entry', async () => {
  await withRoom(
    async ({ rec, env, dir }) => {
      mkdirSync(join(dir, 'node_modules', 'p', 'deep'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '.env'), 'SECRET=1');
      writeFileSync(join(dir, 'node_modules', 'p', 'index.js'), 'x');
      writeFileSync(join(dir, 'node_modules', 'p', 'deep', '.env'), 'SECRET=1');
      const r = await checkPending(rec, READY, env);
      assert.deepEqual(r, { reasons: [], ignoredGone: ['node_modules/'] });
    },
    { gitignore: '.env*\nnode_modules/*\n' },
  );
});

test('a nested node_modules left out by an anchored /node_modules/ pattern is not reported', async () => {
  await withRoom(
    async ({ rec, env, dir }) => {
      mkdirSync(join(dir, 'a', 'node_modules', 'z'), { recursive: true });
      writeFileSync(join(dir, 'a', 'node_modules', 'z', '.env'), 'SECRET=1');
      assert.deepEqual(await checkPending(rec, READY, env), { reasons: [], ignoredGone: ['a/', 'a/node_modules/'] });
    },
    { gitignore: '.env*\n/node_modules/\n' },
  );
});

test('commits left behind on a detached HEAD: commits only in this worktree\'s history', async () => {
  await withRoom(async ({ rec, env, dir, commit }) => {
    git(dir, 'checkout', '-q', '--detach');
    commit('lost.txt');
    git(dir, 'switch', '-q', rec.branch!);
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ["commits only in this worktree's history"]);
  });
});

test('a rebase resolved on a detached HEAD and left: commits only in this worktree\'s history', async () => {
  await withRoom(async ({ rec, env, dir, commit }) => {
    commit('a.txt', 'mine');
    git(dir, 'push', '-q', '-u', 'origin', rec.branch!);
    git(dir, 'checkout', '-q', '-b', 'up2', 'origin/main');
    commit('a.txt', 'theirs');
    git(dir, 'switch', '-q', rec.branch!);
    git(dir, 'checkout', '-q', '--detach');
    tryGit(dir, 'rebase', 'up2');
    writeFileSync(join(dir, 'a.txt'), 'resolved');
    git(dir, 'add', 'a.txt');
    execFileSync('git', ['rebase', '--continue'], { cwd: dir, env: { ...process.env, ...GIT_ENV, GIT_EDITOR: 'true' }, stdio: 'ignore' });
    git(dir, 'switch', '-q', rec.branch!);
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ["commits only in this worktree's history"]);
  });
});

test('amend, reset and a squashing rebase leave nothing only in the worktree history', async () => {
  await withRoom(async ({ rec, env, dir, commit }) => {
    commit('a.txt', 'one');
    writeFileSync(join(dir, 'a.txt'), 'two');
    git(dir, 'commit', '-q', '-a', '--amend', '-m', 'a2');
    commit('b.txt');
    commit('c.txt');
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    commit('d.txt');
    execFileSync('git', ['rebase', '-q', '-i', 'origin/main'], {
      cwd: dir,
      env: { ...process.env, ...GIT_ENV, GIT_SEQUENCE_EDITOR: "sed -i '2,$s/^pick/squash/'", GIT_EDITOR: 'true' },
      stdio: 'ignore',
    });
    git(dir, 'push', '-q', '-u', 'origin', rec.branch!);
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, []);
  });
});

test('no upstream but pushed as origin/<branch>: nothing pending', async () => {
  await withRoom(async ({ rec, env, dir, commit, github }) => {
    commit('a.txt');
    git(dir, 'push', '-q', 'origin', rec.branch!);
    github();
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, []);
  });
});

test('no upstream, commits not on origin/<base>: not pushed (origin not on GitHub: gh never called)', async () => {
  await withRoom(async ({ rec, env, commit, ghCalls }) => {
    commit('a.txt');
    commit('b.txt');
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['2 commit(s) not pushed']);
    assert.deepEqual(ghCalls(), []);
  });
});

test('pushed, then more commits: counted against origin/<branch>', async () => {
  await withRoom(async ({ rec, env, dir, commit }) => {
    commit('a.txt');
    git(dir, 'push', '-q', 'origin', rec.branch!);
    commit('b.txt');
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['1 commit(s) not pushed']);
  });
});

test('an upstream that is a local branch does not count as pushed', async () => {
  await withRoom(async ({ rec, env, dir, commit }) => {
    commit('a.txt');
    git(dir, 'branch', '-q', 'side');
    git(dir, 'branch', '-q', '--set-upstream-to=side');
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['1 commit(s) not pushed']);
  });
});

test('the base comes from origin/HEAD when the project is not in the index', async () => {
  await withRoom(async ({ rec, env, clone, commit }) => {
    git(clone, 'remote', 'set-head', 'origin', 'main');
    writeIndex([], env);
    commit('a.txt');
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['1 commit(s) not pushed']);
  });
});

test('no base anywhere: could not check', async () => {
  await withRoom(async ({ rec, env, commit }) => {
    writeIndex([], env);
    commit('a.txt');
    const { reasons } = await checkPending(rec, READY, env);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /^could not check: /);
  });
});

test('squash-merged PR whose head is the local HEAD, remote branch deleted: landed', async () => {
  await withRoom(async ({ rec, env, dir, clone, commit, github, prs, ghCalls }) => {
    const head = commit('a.txt');
    git(dir, 'push', '-q', 'origin', rec.branch!);
    git(clone, 'push', '-q', 'origin', '--delete', rec.branch!);
    git(clone, 'fetch', '-q', '--prune', 'origin');
    github();
    prs([{ state: 'MERGED', headRefOid: head, url: 'https://github.com/example/repo/pull/7' }]);
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, []);
    assert.deepEqual(ghCalls(), [{ argv: ['pr', 'list', '--head', rec.branch!, '--state', 'all', '--json', 'state,headRefOid,url'], cwd: dir }]);
  });
});

test('merged PR whose head contains the local HEAD: landed', async () => {
  await withRoom(async ({ rec, env, dir, commit, github, prs }) => {
    commit('a.txt');
    const prHead = commit('b.txt');
    git(dir, 'tag', 'pr-head');
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    github();
    prs([{ state: 'MERGED', headRefOid: prHead, url: 'https://github.com/example/repo/pull/7' }]);
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, []);
  });
});

test('merged PR that does not contain the local HEAD: still not pushed', async () => {
  await withRoom(async ({ rec, env, dir, commit, github, prs }) => {
    const prHead = commit('a.txt');
    git(dir, 'tag', 'pr-head');
    commit('b.txt');
    github();
    prs([{ state: 'MERGED', headRefOid: prHead, url: 'https://github.com/example/repo/pull/7' }]);
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['2 commit(s) not pushed']);
  });
});

test('merged PR head missing locally and not fetchable: not landed', async () => {
  await withRoom(async ({ rec, env, commit, github, prs }) => {
    commit('a.txt');
    github();
    prs([{ state: 'MERGED', headRefOid: 'a'.repeat(40), url: 'https://github.com/example/repo/pull/7' }]);
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['1 commit(s) not pushed']);
  });
});

test('closed (not merged) PR with the local HEAD: still not pushed', async () => {
  await withRoom(async ({ rec, env, commit, github, prs }) => {
    const head = commit('a.txt');
    github();
    prs([{ state: 'CLOSED', headRefOid: head, url: 'https://github.com/example/repo/pull/7' }]);
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['1 commit(s) not pushed']);
  });
});

test('open PR: PR open', async () => {
  await withRoom(async ({ rec, env, dir, commit, github, prs }) => {
    const head = commit('a.txt');
    git(dir, 'push', '-q', '-u', 'origin', rec.branch!);
    github();
    prs([{ state: 'OPEN', headRefOid: head, url: 'https://github.com/example/repo/pull/7' }]);
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['PR open: https://github.com/example/repo/pull/7']);
  });
});

test('gh exiting 1: could not check, and git reasons are kept', async () => {
  await withRoom(async ({ rec, env, commit, github }) => {
    commit('a.txt');
    github();
    const { reasons } = await checkPending(rec, READY, { ...env, FAKE_GH_EXIT: '1' });
    assert.equal(reasons.length, 2);
    assert.equal(reasons[0], '1 commit(s) not pushed');
    assert.match(reasons[1]!, /^could not check: .*fake gh: failed on purpose/);
  });
});

test('gh printing something that is not a PR list: could not check', async () => {
  await withRoom(async ({ rec, env, github, prs }) => {
    github();
    prs({ not: 'a list' });
    const { reasons } = await checkPending(rec, READY, env);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /^could not check: /);
  });
});

test('gh missing: could not check', async () => {
  await withRoom(
    async ({ rec, env, github }) => {
      github();
      const { reasons } = await checkPending(rec, READY, env);
      assert.equal(reasons.length, 1);
      assert.match(reasons[0]!, /^could not check: gh/);
    },
    { gh: false },
  );
});

test('blocked code room: waiting on you', async () => {
  await withRoom(async ({ rec, env }) => {
    assert.deepEqual((await checkPending(rec, { state: 'blocked', lastEventAt: 0 }, env)).reasons, ['waiting on you']);
  });
});

test("a room that is not running, blocked only by maître's starting note: nobody can answer it", async () => {
  await withRoom(async ({ env }) => {
    const dir = createScratch('notes', env);
    const rec: RoomRecord = { room: 'notes', kind: 'scratch', dir, model: 'opus', taskType: 'chat', createdAt: 0 };
    const note = { state: 'blocked', starting: true } as const;
    assert.deepEqual((await checkPending(rec, note, env, { running: false })).reasons, []);
    assert.deepEqual((await checkPending(rec, note, env)).reasons, ['waiting on you'], 'a running room is asking in its tab');
    assert.deepEqual((await checkPending(rec, note, env, { running: true })).reasons, ['waiting on you']);
    assert.deepEqual((await checkPending(rec, { state: 'blocked' }, env, { running: false })).reasons, ['waiting on you'], 'a question Claude asked before it died');
  });
});

test('detached HEAD: worktree not on its branch', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    git(dir, 'checkout', '-q', '--detach');
    assert.ok((await checkPending(rec, READY, env)).reasons.includes('worktree not on its branch'));
  });
});

test('another branch checked out: worktree not on its branch', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    git(dir, 'checkout', '-q', '-b', 'other');
    assert.deepEqual((await checkPending(rec, READY, env)).reasons, ['worktree not on its branch']);
  });
});

test('rebase in progress: git operation in progress', async () => {
  await withRoom(async ({ rec, env, dir, commit }) => {
    commit('a.txt', 'one');
    git(dir, 'branch', '-q', 'side', 'HEAD~1');
    git(dir, 'checkout', '-q', 'side');
    commit('a.txt', 'two');
    git(dir, 'checkout', '-q', rec.branch!);
    tryGit(dir, 'rebase', 'side');
    assert.ok((await checkPending(rec, READY, env)).reasons.includes('git operation in progress'));
  });
});

test('merge in progress: git operation in progress', async () => {
  await withRoom(async ({ rec, env, dir, commit }) => {
    commit('a.txt', 'one');
    git(dir, 'branch', '-q', 'side', 'HEAD~1');
    git(dir, 'checkout', '-q', 'side');
    commit('a.txt', 'two');
    git(dir, 'checkout', '-q', rec.branch!);
    tryGit(dir, 'merge', 'side');
    assert.ok((await checkPending(rec, READY, env)).reasons.includes('git operation in progress'));
  });
});

test('worktree folder gone: could not check', async () => {
  await withRoom(async ({ rec, env }) => {
    const { reasons } = await checkPending({ ...rec, dir: join(rec.dir, 'nope') }, READY, env);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /^could not check: /);
  });
});

test('folder that is not the top of a worktree: could not check', async () => {
  await withRoom(async ({ rec, env, dir }) => {
    mkdirSync(join(dir, 'inner'));
    const { reasons } = await checkPending({ ...rec, dir: join(dir, 'inner') }, READY, env);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /^could not check: /);
  });
});

test('code room without a branch: could not check', async () => {
  await withRoom(async ({ rec, env }) => {
    const { branch: _branch, ...noBranch } = rec;
    const { reasons } = await checkPending(noBranch, READY, env);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /^could not check: /);
  });
});

test('scratch room: only blocked matters', async () => {
  await withRoom(async ({ env, ghCalls }) => {
    const dir = createScratch('notes', env);
    writeFileSync(join(dir, 'draft.md'), 'x');
    const rec: RoomRecord = { room: 'notes', kind: 'scratch', dir, model: 'opus', taskType: 'chat', createdAt: 0 };
    assert.deepEqual(await checkPending(rec, READY, env), { reasons: [], ignoredGone: [] });
    assert.deepEqual(await checkPending(rec, { state: 'blocked' }, env), { reasons: ['waiting on you'], ignoredGone: [] });
    assert.deepEqual(ghCalls(), []);
  });
});

test('isGitHubUrl: https and ssh forms of github.com only', () => {
  for (const url of [
    'https://github.com/o/r.git',
    'https://github.com/o/r',
    'https://user@github.com/o/r.git',
    'git@github.com:o/r.git',
    'ssh://git@github.com/o/r.git',
    'ssh://git@github.com:22/o/r.git',
    'git://github.com/o/r.git',
  ]) {
    assert.equal(isGitHubUrl(url), true, url);
  }
  for (const url of ['/srv/git/r.git', 'file:///srv/r.git', 'https://gitlab.com/o/r.git', 'git@gitlab.com:o/r.git', 'https://github.com.evil.example/o/r', 'https://notgithub.com/o/r']) {
    assert.equal(isGitHubUrl(url), false, url);
  }
});

test('local mode: worktree checks only, no gh call and no pushed/PR question', async () => {
  await withRoom(async ({ rec, env, dir, commit, github, prs, ghCalls }) => {
    commit('a.txt');
    github();
    prs([{ state: 'OPEN', headRefOid: 'x', url: 'https://github.com/example/repo/pull/1' }]);
    assert.deepEqual((await checkPending(rec, READY, env, { local: true })).reasons, []);
    writeFileSync(join(dir, 'wip.txt'), 'x');
    assert.deepEqual((await checkPending(rec, READY, env, { local: true })).reasons, ['uncommitted changes: wip.txt']);
    assert.equal(ghCalls().length, 0);
  });
});
