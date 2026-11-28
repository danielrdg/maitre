import { statSync } from 'node:fs';
import { roomActivity } from './activity.js';
import { DEFAULTS, readJson, settings, writeJsonAtomic } from './config.js';
import { roomDir } from './paths.js';
import { CheckError, githubRepo, message, must, NET_TIMEOUT_MS, run, shownText, toolEnv } from './pending.js';
import { ownsPr, patchPr, prSeekFile, readPr, writePr, type PrNotice, type PrState } from './pr-state.js';
import { listRooms, type RoomRecord } from './rooms.js';

export interface PrEvent {
  room: string;
  kind: 'adopted' | 'ci' | 'review' | 'merged' | 'closed' | 'error';
  text: string;
  // review: the author of the newest feedback, as gh gave it (not cleaned: check it before showing it).
  login?: string;
}

// stdout of `gh <args>` run in `cwd`; throws on failure.
export type Gh = (args: string[], cwd: string) => Promise<string>;

export interface PrTickDeps {
  now?: () => number;
  gh?: Gh;
  concurrency?: number;
}

const DISCOVERY_MS = 15 * 60_000;
const VIEW_FIELDS = 'state,headRefName,headRepositoryOwner,mergedAt,closedAt,author,statusCheckRollup,latestReviews,comments,reviewDecision';
const LIST_FIELDS = 'url,number,state,headRefName,headRepositoryOwner';
// gh lists a branch's PRs newest first: a few, so a fork's PR on a branch of the same name cannot hide ours.
const LIST_LIMIT = 20;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/;
const FAILED_CONCLUSIONS = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const FAILED_STATES = ['FAILURE', 'ERROR'];
const TEXT_MAX = 200;
const NAME_MAX = 60;
const SHOWN_CHECKS = 3;
const REJECTED_MAX = 20;

interface Feedback {
  kind: 'review' | 'comment';
  login: string;
  at: number;
  iso: string;
  // Tells apart feedback of the same second: gh's id, or (a review's id is empty) its kind and author.
  key: string;
}

type Repo = { owner: string; repo: string };

interface View {
  state: PrState['state'];
  headRefName: string;
  // The owner of the head's repository, when gh gave it: a fork's PR has another.
  headOwner?: string;
  endedAt?: number;
  author: string;
  failing: string[];
  feedback: Feedback[];
  reviewDecision: string;
}

// Branch discovery runs at most every DISCOVERY_MS per room; a reducer prUrl of another branch is
// remembered so it is not viewed on every tick, and one that failed to load waits DISCOVERY_MS.
interface Seek {
  discoveredAt?: number;
  rejected: string[];
  viewFailed?: { url: string; at: number };
}

function readSeek(room: string, env: NodeJS.ProcessEnv): Seek {
  let raw: unknown;
  try {
    raw = readJson(prSeekFile(room, env));
  } catch {
    return { rejected: [] };
  }
  const s = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    ...(typeof s.discoveredAt === 'number' && Number.isFinite(s.discoveredAt) ? { discoveredAt: s.discoveredAt } : {}),
    rejected: Array.isArray(s.rejected) ? s.rejected.filter((u): u is string => typeof u === 'string') : [],
    ...(isObject(s.viewFailed) && typeof s.viewFailed.url === 'string' && typeof s.viewFailed.at === 'number' && Number.isFinite(s.viewFailed.at)
      ? { viewFailed: { url: s.viewFailed.url, at: s.viewFailed.at } }
      : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function time(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

function login(v: unknown): string {
  return isObject(v) && typeof v.login === 'string' ? v.login : '';
}

// `gh` names a bot PR author `app/<name>`, the same bot elsewhere may be `<name>[bot]`.
function sameLogin(a: string, b: string): boolean {
  const norm = (l: string): string => l.toLowerCase().replace(/^app\//, '').replace(/\[bot\]$/, '');
  return norm(a) === norm(b);
}

function list(v: unknown, what: string): unknown[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new CheckError(`gh pr view: unexpected ${what}`);
  return v;
}

// A CheckRun (name, conclusion) or a StatusContext (context, state), never one for the other. A re-run can
// list the same check twice: the newest run decides (completedAt, else startedAt; a run with neither has not
// started, so it is the newest; between two such, the later one in the list).
function failingChecks(rollup: unknown[]): string[] {
  const latest = new Map<string, { c: Record<string, unknown>; name: string; at?: number }>();
  for (const c of rollup) {
    if (!isObject(c)) continue;
    const kind = typeof c.name === 'string' ? 'run' : 'status';
    const name = typeof c.name === 'string' ? c.name : typeof c.context === 'string' ? c.context : undefined;
    if (name === undefined) continue;
    const key = JSON.stringify([kind, typeof c.workflowName === 'string' ? c.workflowName : '', name]);
    const at = time(c.completedAt) ?? time(c.startedAt);
    const seen = latest.get(key);
    if (seen === undefined || at === undefined || (seen.at !== undefined && at >= seen.at)) latest.set(key, { c, name, ...(at !== undefined ? { at } : {}) });
  }
  const names = new Set<string>();
  for (const { c, name } of latest.values()) {
    const failed =
      (typeof c.conclusion === 'string' && FAILED_CONCLUSIONS.includes(c.conclusion)) || (typeof c.state === 'string' && FAILED_STATES.includes(c.state));
    if (failed) names.add(shownText(name, NAME_MAX));
  }
  return [...names].sort();
}

function parseView(out: string): View {
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch {
    throw new CheckError('gh pr view: output is not JSON');
  }
  if (!isObject(v)) throw new CheckError('gh pr view: unexpected output');
  if (v.state !== 'OPEN' && v.state !== 'MERGED' && v.state !== 'CLOSED') throw new CheckError('gh pr view: unexpected state');
  if (typeof v.headRefName !== 'string') throw new CheckError('gh pr view: no headRefName');
  const feedback: Feedback[] = [];
  const add = (items: unknown[], kind: Feedback['kind'], field: string): void => {
    for (const it of items) {
      if (!isObject(it)) continue;
      const iso = it[field];
      const at = time(iso);
      const who = login(it.author);
      const key = typeof it.id === 'string' && it.id !== '' ? `id:${it.id}` : JSON.stringify([kind, who, iso]);
      if (at !== undefined) feedback.push({ kind, login: who, at, iso: iso as string, key });
    }
  };
  add(list(v.latestReviews, 'latestReviews'), 'review', 'submittedAt');
  add(list(v.comments, 'comments'), 'comment', 'createdAt');
  feedback.sort((a, b) => a.at - b.at);
  const endedAt = v.state === 'MERGED' ? time(v.mergedAt) : v.state === 'CLOSED' ? time(v.closedAt) : undefined;
  return {
    state: v.state,
    headRefName: v.headRefName,
    ...(login(v.headRepositoryOwner) !== '' ? { headOwner: login(v.headRepositoryOwner) } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    author: login(v.author),
    failing: failingChecks(list(v.statusCheckRollup, 'statusCheckRollup')),
    feedback,
    reviewDecision: typeof v.reviewDecision === 'string' ? v.reviewDecision : '',
  };
}

function notice(kind: PrNotice['kind'], text: string, url: string, now: number): PrNotice {
  return { kind, text: shownText(text, TEXT_MAX), url, since: now };
}

function ciText(names: string[], max = SHOWN_CHECKS): string {
  const shown = names.slice(0, max);
  return `CI failed: ${[...shown, ...(names.length > max ? ['…'] : [])].join(', ')}`;
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// Where the room's PR can go: `origin`, and `upstream` when that remote exists (a fork workflow: origin is the
// user's fork and the PR goes into upstream). Its head is always in origin's owner.
interface Repos {
  origin: Repo;
  upstream?: Repo;
}

const inRepo = (url: string, repo: Repo): boolean => {
  const m = PR_URL.exec(url);
  return m !== null && same(m[1]!, repo.owner) && same(m[2]!, repo.repo);
};

// A PR into one of the room's repositories (only gh's URL says that).
const intoRepos = (url: string, repos: Repos): boolean => inRepo(url, repos.origin) || (repos.upstream !== undefined && inRepo(url, repos.upstream));

// A PR that was already over before the room was opened belongs to an older room on a reused branch, and a
// fork's PR on a branch of the same name is someone else's. Into upstream, the head must be shown to be ours.
function belongs(view: View, rec: RoomRecord, url: string, repos: Repos): boolean {
  const origin = repos.origin;
  if (view.headOwner !== undefined ? !same(view.headOwner, origin.owner) : !inRepo(url, origin)) return false;
  return view.headRefName === rec.branch && (view.state === 'OPEN' || (view.endedAt !== undefined && view.endedAt >= rec.createdAt));
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (active < n) active++;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      return await fn();
    } finally {
      // The slot passes straight to the next caller, so a newcomer cannot slip in between.
      const next = waiting.shift();
      if (next !== undefined) next();
      else active--;
    }
  };
}

class Watch {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly now: number,
    private readonly gh: Gh,
    // When a notice is written, after gh answered: a prompt typed meanwhile has not read it.
    private readonly clock: () => number,
  ) {}

  // A pr.json an earlier opening of the room left (or one put there) is no PR of this room: it is replaced
  // by the room's own once found. A PR that ended before the room opened is still never adopted.
  async room(rec: RoomRecord): Promise<PrEvent[]> {
    const before = readPr(rec.room, this.env);
    if (before !== undefined && ownsPr(rec, before)) return before.state === 'OPEN' ? this.poll(rec, before) : [];
    return this.adopt(rec);
  }

  private async view(url: string, cwd: string): Promise<View> {
    return parseView(await this.gh(['pr', 'view', url, '--json', VIEW_FIELDS], cwd));
  }

  private async remote(cwd: string, name: string): Promise<Repo | undefined> {
    const r = await run('git', ['remote', 'get-url', name], cwd, toolEnv(this.env), NET_TIMEOUT_MS);
    return r.code === 0 ? githubRepo(r.stdout.trim()) : undefined;
  }

  private async repos(cwd: string): Promise<Repos | undefined> {
    const origin = await this.remote(cwd, 'origin');
    if (origin === undefined) return undefined;
    const upstream = await this.remote(cwd, 'upstream');
    return upstream !== undefined && !(same(upstream.owner, origin.owner) && same(upstream.repo, origin.repo)) ? { origin, upstream } : { origin };
  }

  private async adopt(rec: RoomRecord): Promise<PrEvent[]> {
    const branch = rec.branch!;
    const seek = readSeek(rec.room, this.env);
    const prUrl = roomActivity(rec.room, this.env).prUrl;
    const waiting = seek.viewFailed !== undefined && seek.viewFailed.url === prUrl && this.now - seek.viewFailed.at < DISCOVERY_MS;
    const candidate = prUrl !== undefined && PR_URL.test(prUrl) && !seek.rejected.includes(prUrl) && !waiting ? prUrl : undefined;
    const due = seek.discoveredAt === undefined || this.now - seek.discoveredAt >= DISCOVERY_MS;
    if (candidate === undefined && !due) return [];
    if (!isDir(rec.dir)) return [];
    const repos = await this.repos(rec.dir);
    if (repos === undefined) {
      // Asked again with the next discovery, not on every tick.
      writeJsonAtomic(prSeekFile(rec.room, this.env), { ...seek, discoveredAt: this.now });
      return [];
    }

    let changed = false;
    const reject = (url: string): void => {
      seek.rejected = [...seek.rejected.filter((u) => u !== url), url].slice(-REJECTED_MAX);
      changed = true;
    };
    const save = (): void => {
      if (changed) writeJsonAtomic(prSeekFile(rec.room, this.env), seek);
    };
    try {
      // A prUrl that cannot be viewed (a 404, a private repo) must not keep discovery from finding the PR.
      let viewError: unknown;
      // A PR into another repository is no PR of this room: remembered, not looked at again.
      if (candidate !== undefined && !intoRepos(candidate, repos)) reject(candidate);
      else if (candidate !== undefined) {
        let view: View | undefined;
        try {
          view = await this.view(candidate, rec.dir);
        } catch (err) {
          viewError = err;
          seek.viewFailed = { url: candidate, at: this.now };
          changed = true;
        }
        if (view !== undefined && belongs(view, rec, candidate, repos)) return this.baseline(rec, candidate, view);
        if (view !== undefined) reject(candidate);
      }
      if (!due) {
        if (viewError !== undefined) throw viewError;
        return [];
      }
      changed = true;
      const events = await this.discover(rec, repos, seek, reject);
      if (events.length === 0 && viewError !== undefined) throw viewError;
      return events;
    } finally {
      save();
    }
  }

  // Mutates `seek`; the caller saves it.
  private async discover(rec: RoomRecord, repos: Repos, seek: Seek, reject: (url: string) => void): Promise<PrEvent[]> {
    const branch = rec.branch!;
    const origin = repos.origin;
    let hit: { url: string } | undefined;
    // origin first, then upstream. --repo: gh would otherwise pick a repository from all remotes.
    for (const repo of [origin, ...(repos.upstream !== undefined ? [repos.upstream] : [])]) {
      const args = ['pr', 'list', '--head', branch, '--state', 'all', '--limit', String(LIST_LIMIT), '--json', LIST_FIELDS, '--repo', `${repo.owner}/${repo.repo}`];
      let found: unknown;
      try {
        found = JSON.parse(await this.gh(args, rec.dir));
      } catch (err) {
        // A broken gh is not retried on every tick either.
        seek.discoveredAt = this.now;
        throw err instanceof SyntaxError ? new CheckError('gh pr list: output is not JSON') : err;
      }
      if (!Array.isArray(found)) throw new CheckError('gh pr list: unexpected output');
      const head = (p: Record<string, unknown>): boolean => (repo === origin && login(p.headRepositoryOwner) === '') || same(login(p.headRepositoryOwner), origin.owner);
      hit = found.find(
        (p): p is { url: string } =>
          isObject(p) && typeof p.url === 'string' && inRepo(p.url, repo) && p.headRefName === branch && head(p) && !seek.rejected.includes(p.url),
      );
      if (hit !== undefined) break;
    }
    if (hit === undefined) {
      seek.discoveredAt = this.now;
      return [];
    }
    // Found but not viewed yet: a failed view is retried on the next tick, not in 15 minutes.
    const view = await this.view(hit.url, rec.dir);
    seek.discoveredAt = this.now;
    if (belongs(view, rec, hit.url, repos)) return this.baseline(rec, hit.url, view);
    reject(hit.url);
    return [];
  }

  // The first sight of a PR: no CI or review notice, only its state.
  private baseline(rec: RoomRecord, url: string, view: View): PrEvent[] {
    const there = readPr(rec.room, this.env);
    if (there !== undefined && ownsPr(rec, there)) return [];
    const number = Number(PR_URL.exec(url)![3]);
    const newest = view.feedback.at(-1);
    const pr: PrState = {
      url,
      number,
      state: view.state,
      headRefName: view.headRefName,
      seenAt: this.now,
      failing: view.failing,
      ...(newest !== undefined ? { lastFeedbackAt: newest.iso, lastFeedbackKeys: keysAt(view, newest.at) } : {}),
      ...(view.reviewDecision !== '' ? { reviewDecision: view.reviewDecision } : {}),
    };
    const events: PrEvent[] = [{ room: rec.room, kind: 'adopted', text: `PR #${number}: ${url}` }];
    this.ended(rec, pr, events);
    if (there === undefined) writePr(rec.room, pr, this.env);
    else if (patchPr(rec.room, (now) => (ownsPr(rec, now) ? undefined : pr), this.env) === undefined) return [];
    return events;
  }

  // An unreadable config.json must not keep a merge from being recorded: the default is used, and the
  // error is reported (the lounge tells the same error once).
  private danceMs(rec: RoomRecord, events: PrEvent[]): number {
    try {
      return settings(this.env).danceMs;
    } catch (err) {
      const text = `could not read the settings: ${message(err)}; the dance lasts ${DEFAULTS.danceMinutes} minutes`;
      events.push({ room: rec.room, kind: 'error', text: shownText(text, TEXT_MAX) });
      return DEFAULTS.danceMinutes * 60_000;
    }
  }

  private ended(rec: RoomRecord, pr: PrState, events: PrEvent[]): void {
    if (pr.state === 'MERGED') {
      pr.dance ??= { until: this.now + this.danceMs(rec, events) };
      pr.notice = notice('merged', `PR #${pr.number} merged`, pr.url, this.clock());
      events.push({ room: rec.room, kind: 'merged', text: pr.notice.text });
    } else if (pr.state === 'CLOSED') {
      pr.notice = notice('closed', `PR #${pr.number} closed without merge`, pr.url, this.clock());
      events.push({ room: rec.room, kind: 'closed', text: pr.notice.text });
    }
  }

  private async poll(rec: RoomRecord, before: PrState): Promise<PrEvent[]> {
    const view = await this.view(before.url, isDir(rec.dir) ? rec.dir : roomDir(rec.room, this.env));
    const events: PrEvent[] = [];
    // Applied to pr.json as it is now: the lounge may have cleared the notice while gh ran.
    patchPr(rec.room, (prev) => (prev.url === before.url && prev.state === 'OPEN' ? this.next(rec, prev, view, events) : undefined), this.env);
    return events;
  }

  private next(rec: RoomRecord, prev: PrState, view: View, events: PrEvent[]): PrState {
    const next: PrState = { ...prev, state: view.state, seenAt: this.now, failing: view.failing };
    delete next.reviewDecision;
    if (view.reviewDecision !== '') next.reviewDecision = view.reviewDecision;

    const newFailing = view.failing.filter((f) => !prev.failing.includes(f));
    let ci: PrNotice | undefined;
    if (newFailing.length > 0) {
      ci = notice('ci', ciText(newFailing), prev.url, this.clock());
      events.push({ room: rec.room, kind: 'ci', text: ci.text });
    }

    const seenAt = time(prev.lastFeedbackAt) ?? -Infinity;
    // A pr.json from before the keys were kept says nothing of the feedback in its last second.
    const seenKeys = prev.lastFeedbackKeys;
    const unseen = (f: Feedback): boolean => f.at > seenAt || (f.at === seenAt && seenKeys !== undefined && !seenKeys.includes(f.key));
    const news = view.feedback.filter((f) => unseen(f) && (view.author === '' || !sameLogin(f.login, view.author)));
    const newest = view.feedback.at(-1);
    if (newest !== undefined && newest.at >= seenAt) {
      next.lastFeedbackAt = newest.iso;
      next.lastFeedbackKeys = keysAt(view, newest.at);
    }
    const fresh = news.at(-1);
    const changesRequested = view.reviewDecision === 'CHANGES_REQUESTED' && prev.reviewDecision !== 'CHANGES_REQUESTED';
    let review: PrNotice | undefined;
    if (fresh !== undefined || changesRequested) {
      const text = fresh !== undefined ? `New ${fresh.kind} from ${shownText(fresh.login || 'unknown', NAME_MAX)}` : 'Changes requested';
      review = notice('review', text, prev.url, this.clock());
      events.push({ room: rec.room, kind: 'review', text: review.text, ...(fresh !== undefined && fresh.login !== '' ? { login: fresh.login } : {}) });
    }

    // pr.json holds one notice: a review landing with a failed check rides on the ci one, so neither is lost.
    const raised = ci !== undefined && review !== undefined ? notice('ci', `${ciText(newFailing, 1)}; ${lowerFirst(review.text)}`, prev.url, this.clock()) : (ci ?? review);
    if (raised !== undefined) next.notice = raised;
    this.ended(rec, next, events);
    return next;
  }
}

const keysAt = (view: View, at: number): string[] => view.feedback.filter((f) => f.at === at).map((f) => f.key);

function watched(rec: RoomRecord): boolean {
  return (
    typeof rec.room === 'string' &&
    rec.kind === 'code' &&
    rec.closedBy === undefined &&
    typeof rec.branch === 'string' &&
    rec.branch !== '' &&
    typeof rec.dir === 'string' &&
    typeof rec.createdAt === 'number'
  );
}

// One pass over the open code rooms: adopt each room's PR, poll it, record notices and merges in its pr.json.
// Never throws; a failure is an `error` event for that room and leaves its pr.json as it was.
export async function prTick(env: NodeJS.ProcessEnv = process.env, deps: PrTickDeps = {}): Promise<PrEvent[]> {
  try {
    const limit = limiter(Math.max(1, deps.concurrency ?? 4));
    const call: Gh =
      deps.gh ?? (async (args, cwd) => must('gh', args, await run('gh', args, cwd, toolEnv(env), NET_TIMEOUT_MS)));
    const gh: Gh = (args, cwd) => limit(() => call(args, cwd));
    const clock = deps.now ?? Date.now;
    const watch = new Watch(env, clock(), gh, clock);
    const rooms = listRooms(env).filter(watched);
    const results = await Promise.all(
      rooms.map(async (rec) => {
        try {
          return await watch.room(rec);
        } catch (err) {
          return [{ room: rec.room, kind: 'error', text: shownText(`could not check PR: ${message(err)}`, TEXT_MAX) } satisfies PrEvent];
        }
      }),
    );
    return results.flat();
  } catch {
    return [];
  }
}
