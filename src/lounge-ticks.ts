import { retryClosings } from './closing.js';
import { settings } from './config.js';
import { doormanTick, type DoormanResult } from './doorman.js';
import { janitorTick, type JanitorDecision } from './janitor.js';
import { notifyDesktop } from './open-app.js';
import { liveReservations } from './queue.js';
import type { RoomState } from './room-state.js';

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
const FREES_SEAT = new Set(['exit', 'whisky', 'couch']);
const DEFAULT_INTERVAL_MS = 5 * 60_000;
// setInterval fires at once past this (with a warning), and a tick needs at least a moment.
const MAX_INTERVAL_MS = 2 ** 31 - 1;
const MIN_INTERVAL_MS = 1_000;

const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
const message = (err: unknown): string => firstLine(err instanceof Error ? err.message : String(err)) || 'unknown error';

export function startTicks(env: NodeJS.ProcessEnv = process.env, deps: TickDeps = {}): Ticks {
  const janitor = deps.janitor ?? ((e) => janitorTick(e));
  const doorman = deps.doorman ?? ((e) => doormanTick(e));
  const log = deps.log ?? ((l) => console.log(l));
  const warn = deps.warn ?? ((l) => console.error(l));
  const notify = deps.notify ?? ((m) => notifyDesktop(m, env));

  let intervalMs = deps.intervalMs;
  if (intervalMs === undefined) {
    try {
      const s = settings(env);
      intervalMs = s.intervalMs;
      for (const w of s.warnings) warn(`maitre: warning: ${w}`);
    } catch (err) {
      intervalMs = DEFAULT_INTERVAL_MS;
      warn(`maitre: could not read the settings, the janitor runs every 5 minutes: ${message(err)}`);
    }
  }
  intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, intervalMs));

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

  const timer = setInterval(() => run('full'), intervalMs);
  timer.unref();
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

  return {
    roomChanged,
    roomUpdate,
    async idle() {
      while (running !== undefined) await running;
    },
    stop() {
      stopped = true;
      due = undefined;
      clearInterval(timer);
      clearInterval(seats);
      clearTimeout(debounce);
      debounce = undefined;
    },
  };
}
