import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readJson, writeJsonAtomic } from './config.js';
import { roomDir } from './paths.js';
import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { RoomActivity } from './activity.js';
import { cleanEnv } from './env.js';
import { readIndex } from './projects.js';
import type { RoomRecord } from './rooms.js';
import { UNSAFE_LINE } from './text.js';

export interface Pending {
  reasons: string[];
  ignoredGone: string[];
}

const GIT_TIMEOUT_MS = 60_000;
export const NET_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const IN_PROGRESS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer'];
// Inherited (e.g. from a git hook), these point git at another repository than the worktree.
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REFLOG_LIMIT = 200;
const BRANCH_REFLOG_LIMIT = 2000;

export class CheckError extends Error {}

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

type Git = (args: string[], timeout?: number) => Promise<Result>;

interface Pr {
  state: string;
  headRefOid: string;
  url: string;
}

function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}

export function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<Result> {
  return new Promise((done, fail) => {
    execFile(cmd, args, { cwd, env, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err === null) return done({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      if (e.code === 'ENOENT') return fail(new CheckError(`${cmd} not found`));
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return fail(new CheckError(`${cmd} ${args[0]}: output too large`));
      if (e.killed) return fail(new CheckError(`${cmd} ${args[0]} timed out`));
      if (typeof e.code === 'number') return done({ code: e.code, stdout, stderr });
      fail(new CheckError(`${cmd} ${args[0]}: ${firstLine(e.message)}`));
    });
  });
}

export function must(cmd: string, args: string[], r: Result): string {
  if (r.code !== 0) throw new CheckError(`${cmd} ${args[0]}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  return r.stdout;
}

export function message(err: unknown): string {
  return err instanceof CheckError ? err.message : firstLine(err instanceof Error ? err.message : String(err));
}

export function toolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...cleanEnv(env), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GH_PROMPT_DISABLED: '1' };
  for (const k of REPO_VARS) delete out[k];
  if (!out.GIT_SSH_COMMAND) out.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return out;
}

export function isGitHubUrl(url: string): boolean {
  let host: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
  } else {
    host = /^(?:[^@/]+@)?([^/:]+):/.exec(url)?.[1];
  }
  return host?.toLowerCase() === 'github.com';
}

// The owner and name of a GitHub repository as a git remote URL names it; undefined for anything else.
export function githubRepo(url: string): { owner: string; repo: string } | undefined {
  if (!isGitHubUrl(url)) return undefined;
  let path: string;
  try {
    path = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? new URL(url).pathname : url.slice(url.indexOf(':') + 1);
  } catch {
    return undefined;
  }
  const m = /^\/?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(path);
  return m === null ? undefined : { owner: m[1]!, repo: m[2]! };
}

// `git status --porcelain -z`: `XY path` per entry; a rename or copy adds its old path as a second field.
function changedPaths(out: string): string[] {
  const fields = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    paths.push(f.slice(3));
    if (/[RC]/.test(f.slice(0, 2))) i++;
  }
  return paths;
}

const SHOWN_PATHS = 3;
const PATH_MAX = 60;

// Outside text (file names, PR check names, logins) reaches room list, the log and the minutes:
// unsafe characters (src/text.ts) are replaced, long text clipped.
export function shownText(s: string, max: number): string {
  const flat = s.replace(UNSAFE_LINE, '?');
  if (flat.length <= max) return flat;
  // Never half a surrogate pair at the cut.
  const cut = flat.slice(0, max - 1);
  return `${/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

function shownPaths(paths: string[]): string {
  const clean = paths.slice(0, SHOWN_PATHS).map((p) => shownText(p, PATH_MAX));
  return [...clean, ...(paths.length > SHOWN_PATHS ? ['…'] : [])].join(', ');
}

function isEnvFile(path: string): boolean {
  const name = basename(path.replace(/\/$/, '')).toLowerCase();
  return name === '.env' || name.startsWith('.env.');
}

// Not only the last segment: patterns like `node_modules/*` or `/node_modules/` list entries below it.
function inNodeModules(path: string): boolean {
  return path.split('/').includes('node_modules');
}

// A walk that meets more than this, or runs longer, says it could not check: a huge ignored folder (a .venv,
// a target/) must not stall a janitor tick.
const WALK_MAX_ENTRIES = 10_000;
const WALK_MAX_MS = 5_000;

type Walk = { entries: number; until: number; top: string };

// git collapses a wholly ignored folder and its pathspec excludes still descend into node_modules,
// so the .env files inside collapsed folders are found here, skipping node_modules at any depth.
async function envFilesUnder(top: string, rel: string, out: string[], walk: Walk = { entries: 0, until: Date.now() + WALK_MAX_MS, top: rel }): Promise<void> {
  const entries = await readdir(join(top, rel), { withFileTypes: true });
  walk.entries += entries.length;
  if (walk.entries > WALK_MAX_ENTRIES || Date.now() > walk.until) throw new CheckError(`too many files under ${shownText(walk.top, PATH_MAX)} to look for .env files`);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const path = `${rel}${e.name}`;
    if (isEnvFile(path)) out.push(e.isDirectory() ? `${path}/` : path);
    if (e.isDirectory() && e.name !== 'node_modules') await envFilesUnder(top, `${path}/`, out, walk);
  }
}

// git can list a wholly ignored folder next to ignored paths inside it: only the outermost are kept.
function outermost(paths: string[]): string[] {
  const dirs = paths.filter((p) => p.endsWith('/'));
  return paths.filter((p) => !dirs.some((d) => d !== p && p.startsWith(d)));
}

const HIDDEN_MAX = 100;

// Files git is told not to look at (assume-unchanged, skip-worktree) whose content on disk is not what the
// index holds: git status never shows these changes, and removing the worktree would lose them.
async function hiddenChanges(cwd: string, gitOut: (args: string[]) => Promise<string>): Promise<string[]> {
  const flagged = (await gitOut(['ls-files', '-v', '-z']))
    .split('\0')
    .filter((e) => e.length > 2 && (e[0] === 'S' || (e[0] !== e[0]!.toUpperCase())))
    .map((e) => e.slice(2))
    .filter((p) => existsSync(join(cwd, p)));
  if (flagged.length === 0) return [];
  if (flagged.length > HIDDEN_MAX) throw new CheckError(`too many files hidden from git status (${flagged.length})`);
  const staged = new Map<string, string>();
  for (const e of (await gitOut(['ls-files', '-s', '-z', '--', ...flagged])).split('\0')) {
    const tab = e.indexOf('\t');
    if (tab > 0) staged.set(e.slice(tab + 1), e.split(' ')[1] ?? '');
  }
  const disk = (await gitOut(['hash-object', '--', ...flagged])).trim().split('\n');
  return flagged.filter((p, i) => disk[i] !== staged.get(p));
}

// A fetch never starts gc or maintenance in the user's repository.
const NO_GC = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

// --repo: gh would otherwise pick the repository from all remotes (a fork, upstream).
type Repo = { owner: string; repo: string };

// `headOwner`: keep only PRs whose head is in that owner (a PR into upstream from the user's fork).
async function listPrs(branch: string, repo: Repo, cwd: string, env: NodeJS.ProcessEnv, headOwner?: string): Promise<Pr[]> {
  const args = ['pr', 'list', '--head', branch, '--state', 'all', '--json', `state,headRefOid,url${headOwner !== undefined ? ',headRepositoryOwner' : ''}`, '--repo', `${repo.owner}/${repo.repo}`];
  const out = must('gh', args, await run('gh', args, cwd, env, NET_TIMEOUT_MS));
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new CheckError('gh pr list: output is not JSON');
  }
  const isPr = (p: unknown): p is Pr =>
    typeof p === 'object' && p !== null && ['state', 'headRefOid', 'url'].every((k) => typeof (p as Record<string, unknown>)[k] === 'string');
  if (!Array.isArray(parsed) || !parsed.every(isPr)) throw new CheckError('gh pr list: unexpected output');
  if (headOwner === undefined) return parsed;
  const owner = (p: Pr): string => {
    const o = (p as unknown as Record<string, unknown>).headRepositoryOwner;
    return typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>).login === 'string' ? ((o as Record<string, unknown>).login as string) : '';
  };
  return parsed.filter((p) => owner(p).toLowerCase() === headOwner.toLowerCase());
}

// Landed: a merged PR whose head is HEAD or contains it (a squash merge leaves HEAD off the base).
async function isLanded(prs: Pr[], head: string, git: Git): Promise<boolean> {
  const hasCommit = async (oid: string): Promise<boolean> => (await git(['cat-file', '-e', `${oid}^{commit}`])).code === 0;
  for (const pr of prs) {
    if (pr.state !== 'MERGED' || !OID.test(pr.headRefOid)) continue;
    if (pr.headRefOid === head) return true;
    if (!(await hasCommit(pr.headRefOid))) {
      try {
        await git([...NO_GC, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', 'origin', pr.headRefOid], NET_TIMEOUT_MS);
      } catch {
        // not fetchable: not landed
      }
      if (!(await hasCommit(pr.headRefOid))) continue;
    }
    const args = ['merge-base', '--is-ancestor', head, pr.headRefOid];
    const r = await git(args);
    if (r.code === 0) return true;
    if (r.code !== 1) must('git', args, r);
  }
  return false;
}

// Commits made on a detached HEAD and left are reachable only from this worktree's HEAD reflog, which
// goes with the worktree. Rebase steps are machine-made copies (a detached result still shows up as
// the tip a checkout moved away from), and commits that were ever on the branch (amend, reset) stay
// in the branch's reflog, which outlives the worktree.
async function onlyInWorktreeHistory(branch: string, git: Git): Promise<boolean> {
  const head = must('git', ['reflog'], await git(['reflog', 'show', '--format=%H %gs', '-n', String(REFLOG_LIMIT), 'HEAD']));
  const oids = new Set<string>();
  for (const line of head.split('\n')) {
    const [oid = '', ...words] = line.split(' ');
    const subject = words.join(' ');
    if (OID.test(oid) && !subject.startsWith('rebase')) oids.add(oid);
    // The detached tip being left, e.g. a rebase finished while detached (its steps are skipped above).
    const left = /^checkout: moving from ([0-9a-f]{40}(?:[0-9a-f]{24})?) to /.exec(subject)?.[1];
    if (left !== undefined) oids.add(left);
  }
  if (oids.size === 0) return false;
  const kept = must('git', ['reflog'], await git(['reflog', 'show', '--format=%H', '-n', String(BRANCH_REFLOG_LIMIT), `refs/heads/${branch}`]));
  const known = kept.split('\n').filter((o) => OID.test(o));
  // A commit whose object is gone (pruned) holds nothing to keep: --ignore-missing drops it, while any
  // other error still fails the check. A branch named like an oid in a checkout line is dropped the same way.
  const out = must('git', ['rev-list'], await git(['rev-list', '--ignore-missing', '--max-count=1', ...oids, '--not', '--all', ...known]));
  return out.trim() !== '';
}

// The unpushed count's fetch of a room's branch runs at most this often (it writes refs/remotes/origin/<branch>
// in the project's clone and goes over the network); in between, the remote-tracking ref as last fetched counts.
const FETCH_EVERY_MS = 30 * 60_000;
const fetchedFile = (rec: RoomRecord, env: NodeJS.ProcessEnv) => join(roomDir(rec.room, env), 'fetched.json');

function fetchedLately(rec: RoomRecord, env: NodeJS.ProcessEnv): boolean {
  try {
    const at = (readJson(fetchedFile(rec, env)) as { at?: unknown } | undefined)?.at;
    return typeof at === 'number' && Number.isFinite(at) && at <= Date.now() && Date.now() - at < FETCH_EVERY_MS;
  } catch {
    return false;
  }
}

function noteFetch(rec: RoomRecord, env: NodeJS.ProcessEnv): void {
  try {
    writeJsonAtomic(fetchedFile(rec, env), { at: Date.now() });
  } catch {
    // not throttled then: the fetch itself is still bounded by its timeout
  }
}

async function checkCode(rec: RoomRecord, env: NodeJS.ProcessEnv, reasons: string[], ignoredGone: string[], local: boolean, fetch: boolean): Promise<void> {
  const cwd = rec.dir;
  const tenv = toolEnv(env);
  const git: Git = (args, timeout = GIT_TIMEOUT_MS) => run('git', args, cwd, tenv, timeout);
  const gitOut = async (args: string[]): Promise<string> => must('git', args, await git(args));
  const attempt = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (err) {
      reasons.push(`could not check: ${message(err)}`);
      return false;
    }
  };

  const branch = rec.branch;
  const usable = await attempt(async () => {
    if (branch === undefined || branch === '') throw new CheckError('room has no branch');
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      // reported just below
    }
    if (!isDir) throw new CheckError(`worktree not found: ${cwd}`);
    const top = (await gitOut(['rev-parse', '--show-toplevel'])).trim();
    if (realpathSync(top) !== realpathSync(cwd)) throw new CheckError(`not the top of a git worktree: ${cwd}`);
  });
  if (!usable || branch === undefined || branch === '') return;

  await attempt(async () => {
    const gitDir = resolve(cwd, (await gitOut(['rev-parse', '--git-dir'])).trim());
    if (IN_PROGRESS.some((name) => existsSync(resolve(gitDir, name)))) reasons.push('git operation in progress');
  });

  let onBranch = false;
  await attempt(async () => {
    onBranch = (await gitOut(['branch', '--show-current'])).trim() === branch;
    if (!onBranch) reasons.push('worktree not on its branch');
  });

  await attempt(async () => {
    const out = await gitOut(['status', '--porcelain', '-z', '--untracked-files=normal', '--ignore-submodules=none']);
    if (out !== '') reasons.push(`uncommitted changes: ${shownPaths(changedPaths(out))}`);
  });

  await attempt(async () => {
    const hidden = await hiddenChanges(cwd, gitOut);
    if (hidden.length > 0) reasons.push(`changes hidden from git status: ${shownPaths(hidden)}`);
  });

  await attempt(async () => {
    const out = await gitOut(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
    const all = out.split('\0').filter((p) => p !== '');
    const kept = (p: string): boolean => isEnvFile(p) && !inNodeModules(p);
    const envs = all.filter(kept);
    const paths = outermost(all);
    for (const p of paths) if (p.endsWith('/') && !isEnvFile(p) && !inNodeModules(p)) await envFilesUnder(cwd, p, envs);
    if (envs.length > 0) reasons.push(`untracked .env files: ${[...new Set(envs)].join(', ')}`);
    const gone = paths.filter((p) => !kept(p)).map((p) => {
      const parts = p.split('/');
      const at = parts.indexOf('node_modules');
      return at === -1 ? p : `${parts.slice(0, at + 1).join('/')}/`;
    });
    ignoredGone.push(...new Set(gone));
  });

  await attempt(async () => {
    if (await onlyInWorktreeHistory(branch, git)) reasons.push("commits only in this worktree's history");
  });

  // Off its branch, HEAD's commits are not the branch's: pushed or landed would answer the wrong question.
  // The local checks stop here: what is pushed or in a PR stays on the kept branch either way.
  if (!onBranch || local) return;

  const refExists = async (ref: string): Promise<boolean> => {
    const args = ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`];
    const r = await git(args);
    if (r.code === 1) return false;
    must('git', args, r);
    return true;
  };

  const baseBranch = async (): Promise<string> => {
    const project = readIndex(env).find((p) => p.name === rec.project);
    if (project !== undefined && typeof project.base === 'string' && project.base !== '') return project.base;
    const args = ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'];
    const r = await git(args);
    if (r.code === 1) throw new CheckError(`no base branch for ${rec.project ?? rec.room}: not in the project index and no origin/HEAD`);
    return must('git', args, r).trim().replace(/^origin\//, '');
  };

  let head = '';
  let unpushed = 0;
  const count = async (): Promise<void> => {
    head = (await gitOut(['rev-parse', 'HEAD'])).trim();
    const upstream = (await gitOut(['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`])).trim();
    // An upstream that is a local branch (branch.<name>.remote = .) says nothing about the remote.
    const candidates = upstream.startsWith('refs/remotes/') ? [upstream] : [];
    candidates.push(`refs/remotes/origin/${branch}`);
    let against: string | undefined;
    for (const ref of candidates) {
      if (await refExists(ref)) {
        against = ref;
        break;
      }
    }
    if (against === undefined) {
      const base = await baseBranch();
      against = `refs/remotes/origin/${base}`;
      if (!(await refExists(against))) throw new CheckError(`origin/${base} not found`);
    }
    const n = (await gitOut(['rev-list', '--count', `${against}..HEAD`])).trim();
    if (!/^\d+$/.test(n)) throw new CheckError('git rev-list: unexpected count');
    unpushed = Number(n);
  };
  const counted = await attempt(async () => {
    await count();
    if (unpushed === 0 || !fetch || fetchedLately(rec, env)) return;
    // The remote refs are as last fetched: a push from another machine shows only after a fetch of the branch.
    // Best effort, at most every FETCH_EVERY_MS per room; without it the count stands, the safe side.
    noteFetch(rec, env);
    const fetched = await git([...NO_GC, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], NET_TIMEOUT_MS).catch(() => undefined);
    if (fetched?.code === 0) await count();
  });
  if (!counted) return;

  let github: Repo | undefined;
  let upstream: Repo | undefined;
  const remoteRead = await attempt(async () => {
    github = githubRepo((await gitOut(['remote', 'get-url', 'origin'])).trim());
    // A fork workflow: origin is the user's fork, its PRs go into upstream. No such remote: none.
    const up = await git(['remote', 'get-url', 'upstream']);
    upstream = up.code === 0 ? githubRepo(up.stdout.trim()) : undefined;
  });

  let prs: Pr[] = [];
  let ghFailure: string | undefined;
  if (remoteRead && github !== undefined) {
    const origin: Repo = github;
    try {
      prs = await listPrs(branch, origin, cwd, tenv);
      if (upstream !== undefined && !(upstream.owner.toLowerCase() === origin.owner.toLowerCase() && upstream.repo.toLowerCase() === origin.repo.toLowerCase())) {
        const seen = new Set(prs.map((p) => p.url));
        prs.push(...(await listPrs(branch, upstream, cwd, tenv, origin.owner)).filter((p) => !seen.has(p.url)));
      }
    } catch (err) {
      ghFailure = `could not check: ${message(err)}`;
    }
  }

  let landed = false;
  if (unpushed > 0 && prs.length > 0) {
    await attempt(async () => {
      landed = await isLanded(prs, head, git);
    });
  }
  if (unpushed > 0 && !landed) reasons.push(`${unpushed} commit(s) not pushed`);
  for (const pr of prs) if (pr.state === 'OPEN') reasons.push(`PR open: ${pr.url}`);
  if (ghFailure !== undefined) reasons.push(ghFailure);
}

// A wrong "nothing pending" deletes someone's work: every check that fails is itself a reason.
// `local`: only what lives in the worktree folder (no remote refs, no gh), for the check right before removal.
// `running: false`: the caller knows its Claude is gone, so maître's own starting note asks nothing.
// `fetch: false` (a dry run): the branch is never fetched and nothing is written.
export async function checkPending(
  rec: RoomRecord,
  activity: RoomActivity,
  env: NodeJS.ProcessEnv = process.env,
  opts: { local?: boolean; running?: boolean; fetch?: boolean } = {},
): Promise<Pending> {
  const reasons: string[] = [];
  const ignoredGone: string[] = [];
  if (rec.kind !== 'scratch') {
    try {
      await checkCode(rec, env, reasons, ignoredGone, opts.local === true, opts.fetch !== false);
    } catch (err) {
      reasons.push(`could not check: ${message(err)}`);
    }
  }
  if (activity.state === 'blocked' && !(opts.running === false && activity.starting === true)) reasons.push('waiting on you');
  return { reasons, ignoredGone };
}
