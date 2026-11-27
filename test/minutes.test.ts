import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoomActivity } from '../src/activity.js';
import { MINUTES_SYSTEM, roomNotes, transcriptExcerpt, writeMinutes } from '../src/minutes.js';
import { roomDir } from '../src/paths.js';
import { writeIndex } from '../src/projects.js';
import type { RoomRecord } from '../src/rooms.js';
import { moveScratch, ownedDir, type MoveOps } from '../src/vault.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../../test/fixtures/fake-claude-router.mjs', import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

interface Ctx {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  vault: string;
  claudeLog: string;
  transcript(lines: unknown[]): string;
  rec(over?: Partial<RoomRecord>): RoomRecord;
  events(room: string, lines: unknown[]): void;
}

async function withCtx(fn: (c: Ctx) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'maitre-minutes-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
    const home = join(root, 'home');
    const claudeLog = join(root, 'claude.log');
    const env: NodeJS.ProcessEnv = { PATH: bin, HOME: root, MAITRE_HOME: home, FAKE_CLAUDE_LOG: claudeLog, GIT_CONFIG_NOSYSTEM: '1' };
    await fn({
      root,
      home,
      env,
      vault: join(home, 'memory'),
      claudeLog,
      transcript(lines) {
        const p = join(root, `t-${Math.random().toString(36).slice(2)}.jsonl`);
        writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
        return p;
      },
      rec: (over = {}) => ({ room: 'alpha', project: 'proj', kind: 'code', dir: join(home, 'worktrees', 'proj', 'alpha'), branch: 'maitre/alpha', model: 'opus', taskType: 'code', createdAt: Date.UTC(2026, 10, 1, 9), ...over }),
      events(room, lines) {
        mkdirSync(roomDir(room, env), { recursive: true });
        writeFileSync(join(roomDir(room, env), 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (content: unknown) => ({ type: 'assistant', message: { role: 'assistant', content } });
const envelope = (result: string) => JSON.stringify({ type: 'result', is_error: false, result });
const ACT: RoomActivity = { state: 'ready', lastEventAt: 1 };
const claudeCalls = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }) : []);

test('excerpt keeps prompts and answers in order and drops tool traffic', async () => {
  await withCtx((c) => {
    const p = c.transcript([
      { type: 'summary', summary: 'x' },
      user('fix the bug'),
      assistant([{ type: 'text', text: 'looking' }, { type: 'tool_use', name: 'Bash', input: { command: 'SECRET-CMD' } }]),
      user([{ type: 'tool_result', content: 'TOOL-OUTPUT' }]),
      'not json {',
      user([{ type: 'text', text: 'and the tests' }]),
      assistant([{ type: 'text', text: 'done' }]),
    ]);
    const out = transcriptExcerpt(p);
    assert.equal(out, 'User: fix the bug\n\nAssistant: looking\n\nUser: and the tests\n\nAssistant: done');
    assert.ok(!out.includes('TOOL-OUTPUT') && !out.includes('SECRET-CMD'));
  });
});

test('excerpt cuts a huge transcript to maxChars keeping the newest', async () => {
  await withCtx((c) => {
    const lines = Array.from({ length: 500 }, (_, i) => user(`message number ${i} ${'x'.repeat(50)}`));
    const out = transcriptExcerpt(c.transcript(lines), 1000);
    assert.equal(out.length, 1000);
    assert.ok(out.includes('message number 499'));
    assert.ok(!out.includes('message number 0 '));
  });
});

test('excerpt of a missing file is empty', () => {
  assert.equal(transcriptExcerpt('/nonexistent/maitre-transcript.jsonl'), '');
});

test('minutes: file name, front matter, links and the exact haiku call', async () => {
  await withCtx(async (c) => {
    c.env.FAKE_CLAUDE_STDOUT = envelope('## What was asked\nfix\n\n## What was done\nfixed\n\n## Links\nnone\n\n## Loose ends\nnone');
    const t = c.transcript([user('fix the bug'), assistant([{ type: 'text', text: 'fixed ``` it' }])]);
    const path = await writeMinutes({ rec: c.rec(), activity: { ...ACT, transcript: t }, closedBy: 'janitor', looseEnds: ['unpushed commits'], ignoredGone: ['.env'] }, c.env);
    const day = new Date().toISOString().slice(0, 4);
    assert.match(path, new RegExp(`/memory/minutes/${day}-\\d\\d-\\d\\d-alpha\\.md$`));
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^---\nroom: "alpha"\nproject: "proj"\nbranch: "maitre\/alpha"\nmodel: "opus"\nopened: 2026-11-01T09:00:00.000Z\nclosed: \S+\nclosedBy: janitor\n---/);
    assert.ok(text.includes('[[proj]]') && text.includes('[[alpha]]'));
    assert.ok(text.includes('## What was done\nfixed'));
    assert.ok(text.includes('- unpushed commits') && text.includes('`.env`'));
    assert.ok(!text.includes('no summary'));
    const [call] = claudeCalls(c.claudeLog);
    const a = call!.argv;
    assert.equal(a[0], '-p');
    assert.deepEqual(a.slice(2), ['--model', 'haiku', '--setting-sources', '', '--tools', '', '--system-prompt', MINUTES_SYSTEM, '--output-format', 'json']);
    assert.ok(a[1]!.includes('User: fix the bug'));
    assert.ok(a[1]!.includes('````'), 'the data fence is longer than any backtick run inside');
  });
});

test('a second close the same day gets a numeric suffix', async () => {
  await withCtx(async (c) => {
    const a = await writeMinutes({ rec: c.rec(), activity: ACT, closedBy: 'user', looseEnds: [], ignoredGone: [] }, c.env);
    const b = await writeMinutes({ rec: c.rec(), activity: ACT, closedBy: 'user', looseEnds: [], ignoredGone: [] }, c.env);
    const d = await writeMinutes({ rec: c.rec(), activity: ACT, closedBy: 'user', looseEnds: [], ignoredGone: [] }, c.env);
    assert.match(b, /-alpha-2\.md$/);
    assert.match(d, /-alpha-3\.md$/);
    assert.ok(a.endsWith('-alpha.md'));
    assert.equal(readdirSync(join(c.vault, 'minutes')).length, 3);
  });
});

for (const [name, extra] of [
  ['timeout', { FAKE_CLAUDE_SLEEP_MS: '3000', MAITRE_MINUTES_TIMEOUT_MS: '200', FAKE_CLAUDE_STDOUT: envelope('late') }],
  ['non-JSON', { FAKE_CLAUDE_STDOUT: 'sorry, no' }],
  ['empty result', { FAKE_CLAUDE_STDOUT: envelope('   ') }],
  ['error exit', { FAKE_CLAUDE_STDOUT: '', FAKE_CLAUDE_EXIT: '2' }],
] as const) {
  test(`fallback minutes on ${name}`, async () => {
    await withCtx(async (c) => {
      Object.assign(c.env, extra);
      const t = c.transcript([user('fix the bug'), assistant([{ type: 'text', text: 'ok' }])]);
      c.events('alpha', [
        { v: 1, ts: 1, room: 'alpha', session: 's', event: 'SessionStart', model: 'opus' },
        { v: 1, ts: 2, room: 'alpha', session: 's', event: 'UserPromptSubmit', prompt: 'Fix the login bug' },
        { v: 1, ts: 3, room: 'alpha', session: 's', event: 'PreToolUse', tool: 'Bash', tool_use_id: 'a', input: { command: 'npm test' } },
        { v: 1, ts: 4, room: 'alpha', session: 's', event: 'Stop', last_message: 'All green now' },
      ]);
      const path = await writeMinutes({ rec: c.rec(), activity: { ...ACT, transcript: t }, closedBy: 'janitor', looseEnds: ['open PR'], ignoredGone: [] }, c.env);
      const text = readFileSync(path, 'utf8');
      assert.ok(text.includes('no summary'));
      assert.ok(text.includes('Fix the login bug'));
      assert.ok(text.includes('Bash: npm test'));
      assert.ok(text.includes('All green now'));
      assert.ok(text.includes('- open PR'));
      assert.ok(text.includes('maitre/alpha'));
    });
  });
}

test('room notes after a park and a resume still carry what was asked, done and replied, and the PR', async () => {
  await withCtx(async (c) => {
    const pr = 'https://github.com/example/repo/pull/7';
    c.events('alpha', [
      { v: 1, ts: 1, room: 'alpha', session: 's', event: 'SessionStart', model: 'opus' },
      { v: 1, ts: 2, room: 'alpha', session: 's', event: 'UserPromptSubmit', prompt: 'Fix the login bug' },
      { v: 1, ts: 3, room: 'alpha', session: 's', event: 'PreToolUse', tool: 'Bash', tool_use_id: 'a', input: { command: 'gh pr create --fill' } },
      { v: 1, ts: 4, room: 'alpha', session: 's', event: 'PostToolUse', tool: 'Bash', tool_use_id: 'a', response: { stdout: `${pr}\n` } },
      { v: 1, ts: 5, room: 'alpha', session: 's', event: 'Stop', last_message: 'PR open' },
      { v: 1, ts: 6, room: 'alpha', session: 's', event: 'SessionEnd' },
      { v: 1, ts: 7, room: 'alpha', session: 's', event: 'SessionStart' },
    ]);
    const notes = await roomNotes(c.rec(), c.env);
    assert.match(notes, /## What was asked\n\nFix the login bug\n/);
    assert.ok(notes.includes('- Bash: gh pr create --fill'), notes);
    assert.ok(notes.includes('> PR open'), notes);
    assert.ok(notes.includes(`PR: ${pr}`), notes);
  });
});

test('fallback lists the commits ahead of the base, and survives a git failure', async () => {
  await withCtx(async (c) => {
    const remote = join(c.root, 'remote.git');
    const clone = join(c.root, 'clone');
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: 'pipe' });
    git(c.root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(c.root, 'clone', '-q', remote, clone);
    writeFileSync(join(clone, 'a'), '1');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'init');
    git(clone, 'push', '-q', 'origin', 'main');
    git(clone, 'checkout', '-q', '-b', 'maitre/alpha');
    writeFileSync(join(clone, 'b'), '2');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'add the b file');
    writeIndex([{ name: 'proj', path: clone, base: 'main', branchPrefix: 'maitre/' }], c.env);
    c.env.FAKE_CLAUDE_STDOUT = 'garbage';
    const good = await writeMinutes({ rec: c.rec({ dir: clone }), activity: ACT, closedBy: 'user', looseEnds: [], ignoredGone: [] }, c.env);
    assert.ok(readFileSync(good, 'utf8').includes('add the b file'));
    const bad = await writeMinutes({ rec: c.rec({ dir: join(c.root, 'nowhere') }), activity: ACT, closedBy: 'user', looseEnds: [], ignoredGone: [] }, c.env);
    assert.ok(readFileSync(bad, 'utf8').includes('no summary'));
  });
});

test('scratch files move byte for byte and the folder goes away', async () => {
  await withCtx((c) => {
    const dir = join(c.home, 'scratch', 'notes');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const bytes = Buffer.from([0, 255, 1, 2, 128]);
    writeFileSync(join(dir, 'bin.dat'), bytes);
    writeFileSync(join(dir, '.hidden'), 'h');
    writeFileSync(join(dir, 'sub', 'x.txt'), 'x');
    const rec = c.rec({ room: 'notes', kind: 'scratch', dir, project: undefined, branch: undefined });
    const dest = moveScratch(rec, c.env);
    assert.equal(dest, join(c.vault, 'rooms', 'notes'));
    assert.ok(readFileSync(join(dest, 'bin.dat')).equals(bytes));
    assert.equal(readFileSync(join(dest, '.hidden'), 'utf8'), 'h');
    assert.equal(readFileSync(join(dest, 'sub', 'x.txt'), 'utf8'), 'x');
    assert.ok(!existsSync(dir));
  });
});

test('a reused room name merges into the folder with file-level suffixes, overwriting nothing', async () => {
  await withCtx((c) => {
    const existing = join(c.vault, 'rooms', 'notes');
    mkdirSync(join(existing, 'dir'), { recursive: true });
    writeFileSync(join(existing, 'old.txt'), 'old');
    writeFileSync(join(existing, 'dir', 'f'), 'f');
    writeFileSync(join(existing, '.hidden'), 'oh');
    const dir = join(c.home, 'scratch', 'notes');
    mkdirSync(join(dir, 'dir'), { recursive: true });
    writeFileSync(join(dir, 'old.txt'), 'new');
    writeFileSync(join(dir, 'dir', 'g'), 'g');
    writeFileSync(join(dir, '.hidden'), 'nh');
    const dest = moveScratch(c.rec({ room: 'notes', kind: 'scratch', dir }), c.env);
    assert.equal(dest, existing);
    assert.equal(readFileSync(join(existing, 'old.txt'), 'utf8'), 'old');
    assert.equal(readFileSync(join(existing, 'old-2.txt'), 'utf8'), 'new');
    assert.equal(readFileSync(join(existing, 'dir', 'f'), 'utf8'), 'f');
    assert.equal(readFileSync(join(existing, 'dir-2', 'g'), 'utf8'), 'g');
    assert.equal(readFileSync(join(existing, '.hidden-2'), 'utf8'), 'nh');
    assert.ok(!existsSync(dir));
    assert.ok(!existsSync(`${existing}-2`));
  });
});

test('a resumed partial move ends in one folder', async () => {
  await withCtx((c) => {
    const dir = join(c.home, 'scratch', 'notes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    const dest = join(c.vault, 'rooms', 'notes');
    const rec = c.rec({ room: 'notes', kind: 'scratch', dir });
    let n = 0;
    const crash: MoveOps = {
      rename: (from, to) => {
        if (n++ === 1) throw new Error('crash');
        renameSync(from, to);
      },
      copy: () => assert.fail('no copy'),
      remove: () => assert.fail('no remove'),
    };
    assert.throws(() => moveScratch(rec, c.env, crash), /crash/);
    assert.equal(readdirSync(dest).length, 1);
    assert.equal(moveScratch(rec, c.env), dest);
    assert.deepEqual(readdirSync(dest).sort(), ['a.txt', 'b.txt']);
    assert.ok(!existsSync(dir));
  });
});

test('across devices the source is removed only after a successful copy', async () => {
  await withCtx((c) => {
    const dir = join(c.home, 'scratch', 'notes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'a');
    const rec = c.rec({ room: 'notes', kind: 'scratch', dir });
    const exdev = () => {
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    };
    const calls: string[] = [];
    const ok: MoveOps = {
      rename: exdev,
      copy: (f, t) => {
        calls.push('copy');
        writeFileSync(t, readFileSync(f));
      },
      remove: (p) => {
        calls.push('remove');
        assert.ok(existsSync(join(c.vault, 'rooms', 'notes', 'a.txt')), 'copied before removing');
        rmSync(p, { recursive: true });
      },
    };
    moveScratch(rec, c.env, ok);
    assert.deepEqual(calls, ['copy', 'remove']);
    assert.equal(readFileSync(join(c.vault, 'rooms', 'notes', 'a.txt'), 'utf8'), 'a');
    assert.ok(!existsSync(dir));
  });
});

test('across devices a failed copy removes nothing', async () => {
  await withCtx((c) => {
    const dir = join(c.home, 'scratch', 'notes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'a');
    const rec = c.rec({ room: 'notes', kind: 'scratch', dir });
    const ops: MoveOps = {
      rename: () => {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      },
      copy: () => {
        throw new Error('disk full');
      },
      remove: () => assert.fail('must not remove'),
    };
    assert.throws(() => moveScratch(rec, c.env, ops), /disk full/);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'a');
  });
});

test('the guard wants exactly the room folder: another room, the parent, a hostile name', async () => {
  await withCtx((c) => {
    mkdirSync(join(c.home, 'scratch', 'other'), { recursive: true });
    mkdirSync(join(c.home, 'worktrees', 'proj', 'other'), { recursive: true });
    mkdirSync(join(c.home, 'worktrees', 'proj', 'alpha'), { recursive: true });
    for (const rec of [
      c.rec({ room: 'notes', kind: 'scratch', dir: join(c.home, 'scratch', 'other') }),
      c.rec({ kind: 'code', dir: join(c.home, 'worktrees', 'proj', 'other') }),
      c.rec({ kind: 'code', dir: join(c.home, 'worktrees', 'proj') }),
      c.rec({ kind: 'code', project: undefined }),
      c.rec({ kind: 'code', project: '../proj' }),
      c.rec({ kind: 'code', project: 'a/b' }),
      c.rec({ room: '../../escaped', kind: 'scratch', dir: join(c.home, 'scratch', 'other') }),
      c.rec({ room: 'Alpha', kind: 'code' }),
    ]) {
      assert.throws(() => ownedDir(rec, c.env), /is outside maître's folders/);
    }
  });
});

test('minutes tolerate a bad createdAt, a hostile room name and a corrupt index', async () => {
  await withCtx(async (c) => {
    mkdirSync(join(c.home, 'state'), { recursive: true });
    writeFileSync(join(c.home, 'state', 'projects.json'), '{not json');
    const path = await writeMinutes(
      { rec: c.rec({ room: '../../escaped', createdAt: undefined as unknown as number }), activity: ACT, closedBy: 'user', looseEnds: [], ignoredGone: [] },
      c.env,
    );
    assert.ok(path.startsWith(join(c.vault, 'minutes') + '/'));
    assert.match(path, /-escaped\.md$/);
    assert.ok(readFileSync(path, 'utf8').includes('opened: unknown'));
    const scratch = await writeMinutes({ rec: c.rec({ kind: 'scratch', project: undefined }), activity: ACT, closedBy: 'user', looseEnds: [], ignoredGone: [] }, c.env);
    assert.ok(readFileSync(scratch, 'utf8').includes('no summary'));
  });
});

test('the path guard refuses folders outside maitre, symlinks out and the wrong kind', async () => {
  await withCtx((c) => {
    const outside = join(c.root, 'precious');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'k');
    mkdirSync(join(c.home, 'scratch'), { recursive: true });
    mkdirSync(join(c.home, 'worktrees'), { recursive: true });
    symlinkSync(outside, join(c.home, 'scratch', 'link'));
    for (const rec of [
      c.rec({ kind: 'scratch', dir: outside }),
      c.rec({ kind: 'scratch', dir: join(c.home, 'scratch', 'link') }),
      c.rec({ kind: 'scratch', dir: join(c.home, 'scratch') }),
      c.rec({ kind: 'scratch', dir: join(c.home, 'worktrees') }),
      c.rec({ kind: 'code', dir: join(c.home, 'scratch', 'link') }),
    ]) {
      assert.throws(() => ownedDir(rec, c.env), /is outside maître's folders/);
    }
    assert.throws(() => moveScratch(c.rec({ kind: 'scratch', dir: join(c.home, 'scratch', 'link') }), c.env), /outside/);
    assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'k');
    mkdirSync(join(c.home, 'worktrees', 'proj', 'alpha'), { recursive: true });
    assert.equal(ownedDir(c.rec(), c.env), join(c.home, 'worktrees', 'proj', 'alpha'));
  });
});
