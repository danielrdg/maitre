import { releaseClosing, retryClosings, takeClosing } from './closing.js';
import { settings } from './config.js';
import { doormanTick, type DoormanResult } from './doorman.js';
import { ensureServer } from './herdr.js';
import { janitorTick, type JanitorDecision } from './janitor.js';
import { notifyDesktop } from './open-app.js';
import { NOTICE_PROMPT, readPr } from './pr-state.js';
import { prTick, type PrEvent } from './pr-watch.js';
import { liveReservations } from './queue.js';
import { UNSENT_TEXT, deliverToRoom, isRecord, probeRoom, unsentInput, type Delivered, type RoomLiveness } from './room-open.js';
import { listRooms, readRoom, type RoomRecord } from './rooms.js';
import type { RoomState } from './room-state.js';
import { offersWake, wakeRoom, type WakeDeps, type Woken } from './wake.js';

// The janitor and the doorman, run by the long-lived lounge process.
export interface TickDeps {
  janitor?: (env: NodeJS.ProcessEnv) => Promise<JanitorDecision[]>;
  doorman?: (env: NodeJS.ProcessEnv) => Promise<DoormanResult>;
  // One line when something happened (stdout goes to the journal); failures go to warn.
  log?: (line: string) => void;
  warn?: (line: string) => void;
  // A desktop notification, best effort: a queued room gave up.
  notify?: (message: string) => void;
  // After every tick, e.g. so the lounge shows a couch or a queue the tick changed.
  after?: () => void;
  intervalMs?: number;
  debounceMs?: number;
  // How often the opening reservations are checked for one released (0: never).
  seatPollMs?: number;
  watchdogMs?: number;
  // The PR watcher, on its own timer (pr.pollMinutes), and what pr.autoWake does with its news.
  pr?: (env: NodeJS.ProcessEnv) => Promise<PrEvent[]>;
  pollMs?: number;
  liveness?: (rec: RoomRecord, env: NodeJS.ProcessEnv) => Promise<RoomLiveness>;
  wake?: (room: string, env: NodeJS.ProcessEnv, deps?: WakeDeps) => Promise<Woken>;
  deliver?: (room: string, text: string, env: NodeJS.ProcessEnv, opts: { closing: string; woken: boolean }) => Promise<Pick<Delivered, 'result'>>;
  // What the room's input box holds that is not sent (undefined: nothing), as closing checks it.
  unsent?: (rec: RoomRecord) => Promise<string | undefined>;
}

export interface Ticks {
  // A seat may be free: the doorman runs once, DOORMAN_DEBOUNCE_MS after the first call of a burst.
  roomChanged(): void;
  // A room the lounge sent: only a change that can free a seat calls roomChanged().
  roomUpdate(room: RoomState): void;
  // Resolves once no tick runs and none is due.
  idle(): Promise<void>;
  stop(): void;
}

export const DOORMAN_DEBOUNCE_MS = 2_000;
const SEAT_POLL_MS = 1_000;
const WATCHDOG_MS = 10 * 60_000;
// A room leaving, delivering (a PR) or parked on the couch stops counting as active. A closed room is
// sent as exit too. Busy rooms working send many other events: none of them can free a seat.
const FREES_SEAT = new Set(['exit', 'whisky', 'couch', 'parked']);
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 2 * 60_000;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/;
// A GitHub login (a bot as `app/<name>` or `<name>[bot]`): nothing else from outside reaches a room.
const LOGIN = /^(app\/)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/;
// setInterval fires at once past this (with a warning), and a tick needs at least a moment.
const MAX_INTERVAL_MS = 2 ** 31 - 1;
const MIN_INTERVAL_MS = 1_000;

const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
const message = (err: unknown): string => firstLine(err instanceof Error ? err.message : String(err)) || 'unknown error';

// Why autoWake did not tell a room, in its own words: a reworded janitor reason must not change it.
export const AUTOWAKE_DRAFT = 'a draft sits in its input box';

// What pr.autoWake tells a room: the kind, the author's login and the URL, never text from the PR
// (a comment body or a check name could carry instructions).
export function noticeLine(kind: 'ci' | 'review', url: string, login?: string): string {
  const who = kind === 'review' && login !== undefined && LOGIN.test(login) ? ` from ${login}` : '';
  return `${NOTICE_PROMPT}${kind}${who}): ${url}`;
}

async function liveness(rec: RoomRecord, env: NodeJS.ProcessEnv): Promise<RoomLiveness> {
  await ensureServer(env);
  return probeRoom(rec, undefined, env);
}

export function startTicks(env: NodeJS.ProcessEnv = process.env, deps: TickDeps = {}): Ticks {
  const janitor = deps.janitor ?? ((e) => janitorTick(e));
  const doorman = deps.doorman ?? ((e) => doormanTick(e));
  const log = deps.log ?? ((l) => console.log(l));
  const warn = deps.warn ?? ((l) => console.error(l));
  const notify = deps.notify ?? ((m) => notifyDesktop(m, env));

  let intervalMs = deps.intervalMs;
  let pollMs = deps.pollMs;
  if (intervalMs === undefined || pollMs === undefined) {
    try {
      const s = settings(env);
      intervalMs ??= s.intervalMs;
      pollMs ??= s.pollMs;
      for (const w of s.warnings) warn(`maitre: warning: ${w}`);
    } catch (err) {
      if (intervalMs === undefined) warn(`maitre: could not read the settings, the janitor runs every 5 minutes: ${message(err)}`);
      intervalMs ??= DEFAULT_INTERVAL_MS;
      pollMs ??= DEFAULT_POLL_MS;
    }
  }
  intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, intervalMs));
  pollMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, pollMs));

  // What was last told per room, and the last failure of each: an unchanged couch or error is told once,
  // and how often it repeated is told when it changes.
  const told = new Map<string, string>();
  const failed = { janitor: { m: '', n: 0 }, doorman: { m: '', n: 0 } };
  const repeated = (n: number) => (n > 1 ? ` (the previous failure repeated ${n} times)` : '');
  const fail = (who: 'janitor' | 'doorman', err: unknown) => {
    const m = message(err);
    const was = failed[who];
    if (was.m === m) was.n++;
    else {
      warn(`maitre: ${who}: ${m}${repeated(was.n)}`);
      failed[who] = { m, n: 1 };
    }
  };
  const ok = (who: 'janitor' | 'doorman') => {
    const was = failed[who];
    if (was.n > 1) warn(`maitre: ${who}: working again${repeated(was.n)}`);
    failed[who] = { m: '', n: 0 };
  };

  const janitorPass = async () => {
    let ds: JanitorDecision[];
    try {
      ds = await janitor(env);
    } catch (err) {
      return fail('janitor', err);
    }
    ok('janitor');
    const parts: string[] = [];
    for (const d of ds) {
      const said = JSON.stringify([d.decision, d.reasons]);
      if (d.decision === 'close') parts.push(`closed ${d.room}`);
      else if (d.decision === 'park') parts.push(`parked ${d.room} (${d.reasons.join('; ')})`);
      else if (d.decision !== 'skip' && told.get(d.room) !== said) parts.push(`${d.decision === 'couch' ? 'couched' : 'error'} ${d.room} (${d.reasons.join('; ')})`);
      if (d.decision === 'close') told.delete(d.room);
      else told.set(d.room, said);
    }
    if (parts.length > 0) log(`maitre: janitor: ${parts.join('; ')}`);
  };

  const doormanPass = async () => {
    try {
      const { opened, gaveUp } = await doorman(env);
      ok('doorman');
      if (opened.length > 0) log(`maitre: doorman: opened ${opened.join(', ')} from the queue`);
      for (const g of gaveUp) {
        log(`maitre: doorman: ${g.room} ${g.reason} (requests ${g.requestIds.join(', ')}); see maitre room list`);
        try {
          notify(`${g.room} ${g.reason}`);
        } catch {
          // best effort
        }
      }
    } catch (err) {
      fail('doorman', err);
    }
  };

  let running: Promise<void> | undefined;
  let due: 'full' | 'doorman' | undefined;
  let stopped = false;

  // In-flight guard: a tick asked for while one runs is folded into one run after it.
  const run = (kind: 'full' | 'doorman'): void => {
    if (stopped) return;
    if (running !== undefined) {
      due = due === 'full' || kind === 'full' ? 'full' : 'doorman';
      return;
    }
    // herdr calls time out, but anything else that hangs would stop every tick after this one: say so.
    const watchdog = setTimeout(
      () => warn(`maitre: a tick has run for more than ${Math.round((deps.watchdogMs ?? WATCHDOG_MS) / 60_000)} minutes; the janitor and the doorman wait for it`),
      deps.watchdogMs ?? WATCHDOG_MS,
    );
    watchdog.unref();
    running = (async () => {
      try {
        retryClosings();
      } catch (err) {
        warn(`maitre: janitor: ${message(err)}`);
      }
      if (kind === 'full') await janitorPass();
      await doormanPass();
      try {
        deps.after?.();
      } catch {
        // the lounge view catches up on its own poll
      }
    })()
      .catch((err) => warn(`maitre: tick: ${message(err)}`))
      .finally(() => {
        clearTimeout(watchdog);
        running = undefined;
        const next = due;
        due = undefined;
        if (next !== undefined) run(next);
      });
  };

  // --- PR watching: its own timer, so a slow gh never holds the janitor or the doorman.
  const prWatch = deps.pr ?? ((e) => prTick(e));
  const wake = deps.wake ?? wakeRoom;
  const deliver = deps.deliver ?? ((room, text, e, opts) => deliverToRoom(room, text, e, opts));
  const probe = deps.liveness ?? liveness;
  const unsentOf = deps.unsent ?? (async (rec: RoomRecord) => (rec.herdr === undefined ? 'it has no tab' : unsentInput(rec.herdr.paneId)));
  // The gh failures being told (by text): told once with the rooms, again only after they stopped.
  let ghFailing = new Set<string>();
  // Merged rooms whose dance ended: the janitor is run once for each, so the room closes without waiting
  // for its interval.
  const danced = new Set<string>();

  const autoWakeOn = (): boolean => {
    try {
      return settings(env).autoWake;
    } catch {
      return false;
    }
  };

  const report = (events: PrEvent[]) => {
    const news = events.filter((e) => e.kind !== 'error').map((e) => `${e.room}: ${e.text}`);
    if (news.length > 0) log(`maitre: pr: ${news.join('; ')}`);
    const failing = new Map<string, string[]>();
    for (const e of events) if (e.kind === 'error') failing.set(e.text, [...(failing.get(e.text) ?? []), e.room]);
    for (const [text, rooms] of failing) if (!ghFailing.has(text)) warn(`maitre: pr: ${text} (${rooms.join(', ')})`);
    ghFailing = new Set(failing.keys());
  };

  // One room, its notices of this poll: woken if its Claude is gone, then told one line per notice.
  const tell = async (room: string, events: PrEvent[]) => {
    const rec = readRoom(room, env);
    if (rec === undefined || !isRecord(rec) || rec.closedBy !== undefined) return;
    const pr = readPr(room, env);
    if (pr === undefined || pr.state !== 'OPEN' || !PR_URL.test(pr.url)) return;
    const lines = events.map((e) => noticeLine(e.kind as 'ci' | 'review', pr.url, e.login));
    const skip = (why: string) => log(`maitre: pr: did not tell ${room} about its PR: ${why}`);
    let woke = false;
    if ((await probe(rec, env)) === 'not running') {
      if (!offersWake(rec)) return skip('it is not running, and its record predates waking');
      const woken = await wake(room, env, { request: lines.join('\n') });
      for (const l of woken.lines) log(`maitre: pr: ${l}`);
      // A fresh Claude has the lines in its brief; one asking something in its tab cannot take them now.
      if (!woken.resumed || woken.needsYou) return;
      woke = true;
    }
    // The closing marker keeps the janitor's park or close (its /exit) off the room while it is told.
    const held = takeClosing(room, env);
    if (held === 'busy') return skip('it is closing');
    try {
      const now = readRoom(room, env);
      if (now === undefined || now.closedBy !== undefined) return;
      if ((await probe(now, env)) === 'not running') return skip('it is not running');
      for (const l of lines) {
        // A draft in its input box would be sent along with the line.
        const unsent = await unsentOf(now);
        if (unsent !== undefined) return skip(unsent === UNSENT_TEXT ? AUTOWAKE_DRAFT : unsent);
        if ((await deliver(room, l, env, { closing: held.token, woken: woke })).result === 'unsent') return skip('the line may be typed in its input, not sent');
      }
    } finally {
      releaseClosing(room, held.token, env);
    }
    log(`maitre: pr: told ${room} about its PR (${events.map((e) => e.kind).join(', ')})`);
  };

  const autoWake = async (events: PrEvent[]) => {
    if (!autoWakeOn()) return;
    const ended = new Set(events.filter((e) => e.kind === 'merged' || e.kind === 'closed').map((e) => e.room));
    const byRoom = new Map<string, PrEvent[]>();
    for (const e of events) {
      if ((e.kind !== 'ci' && e.kind !== 'review') || ended.has(e.room)) continue;
      byRoom.set(e.room, [...(byRoom.get(e.room) ?? []), e]);
    }
    for (const [room, evs] of byRoom) {
      if (stopped) return;
      try {
        await tell(room, evs);
      } catch (err) {
        warn(`maitre: pr: could not tell ${room} about its PR: ${message(err)}`);
      }
    }
  };

  const danceOver = (): boolean => {
    const now = Date.now();
    let due = false;
    for (const rec of listRooms(env)) {
      if (!isRecord(rec) || rec.closedBy !== undefined) continue;
      const pr = readPr(rec.room, env);
      const key = pr?.dance !== undefined ? `${rec.room}:${pr.dance.until}` : undefined;
      if (pr?.state !== 'MERGED' || key === undefined || pr.dance!.until > now || danced.has(key)) continue;
      danced.add(key);
      due = true;
    }
    return due;
  };

  let polling: Promise<void> | undefined;
  // Never overlapping: a poll due while one runs is skipped, the next one comes at its time.
  const poll = (): void => {
    if (stopped || polling !== undefined) return;
    // gh calls time out, but a child that holds stdout open or a herdr call in autoWake could hang: say so.
    const watchdog = setTimeout(
      () => warn(`maitre: a PR poll has run for more than ${Math.round((deps.watchdogMs ?? WATCHDOG_MS) / 60_000)} minutes; PR watching and pr.autoWake wait for it`),
      deps.watchdogMs ?? WATCHDOG_MS,
    );
    watchdog.unref();
    polling = (async () => {
      const events = await prWatch(env);
      if (stopped) return;
      report(events);
      await autoWake(events);
      if (danceOver()) run('full');
      try {
        deps.after?.();
      } catch {
        // the lounge view catches up on its own poll
      }
    })()
      .catch((err) => warn(`maitre: pr: ${message(err)}`))
      .finally(() => {
        clearTimeout(watchdog);
        polling = undefined;
      });
  };

  const timer = setInterval(() => run('full'), intervalMs);
  timer.unref();
  const prTimer = setInterval(poll, pollMs);
  prTimer.unref();
  let debounce: NodeJS.Timeout | undefined;
  const roomChanged = () => {
    if (stopped || debounce !== undefined) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      run('doorman');
    }, deps.debounceMs ?? DOORMAN_DEBOUNCE_MS);
    debounce.unref();
  };

  const states = new Map<string, string>();
  const roomUpdate = (room: RoomState) => {
    const was = states.get(room.room);
    states.set(room.room, room.state);
    if (was !== room.state && FREES_SEAT.has(room.state)) roomChanged();
  };

  // Another process's reservation dropped (its open failed) or left by an opener that died frees a seat.
  // The lounge's own are its doorman's: a failed open there waits for the next interval tick, so a short
  // herdr outage does not burn a queued room's attempts in seconds.
  const reserved = (): Set<string> => {
    try {
      return new Set(liveReservations(env).filter((r) => r.pid !== process.pid).map((r) => r.room));
    } catch {
      return held;
    }
  };
  let held = new Set<string>();
  held = reserved();
  const seatMs = deps.seatPollMs ?? SEAT_POLL_MS;
  const seats = seatMs > 0 ? setInterval(() => {
    const now = reserved();
    if ([...held].some((room) => !now.has(room))) roomChanged();
    held = now;
  }, seatMs) : undefined;
  seats?.unref();
  run('full');
  poll();

  return {
    roomChanged,
    roomUpdate,
    async idle() {
      while (running !== undefined || polling !== undefined) {
        if (polling !== undefined) await polling;
        if (running !== undefined) await running;
      }
    },
    stop() {
      stopped = true;
      due = undefined;
      clearInterval(timer);
      clearInterval(prTimer);
      clearInterval(seats);
      clearTimeout(debounce);
      debounce = undefined;
    },
  };
}
