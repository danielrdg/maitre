import type { IncomingMessage, ServerResponse } from 'node:http';
import { isClosing } from './closing.js';
import { countsAsActivity, type HookLine } from './events.js';
import { herdrSession } from './herdr.js';
import type { LoungeAuth, TicketStore } from './lounge-server.js';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { roomDir } from './paths.js';
import { shownText } from './pending.js';
import { patchPr, readPr, readsNotice, type PrState } from './pr-state.js';
import { queueFile, readQueue, type QueueEntry } from './queue.js';
import { couchHolds, parked, readRoom, type RoomRecord } from './rooms.js';
import { modelKey, reduce, type RoomState } from './room-state.js';
import { isSessionId } from './wake.js';

const PING_MS = 15_000;
const WATCH_MS = 1_000;
const NOTICE_MAX = 200;
const DANCES_OVER = new Set(['ready', 'coffee', 'whisky', 'couch', 'parked']);
// The only links the lounge is given: the page puts it in an href.
const PR_LINK = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// A queued room has no events: what the lounge shows comes from its queue entry alone.
function queuedState(e: QueueEntry, position: number): RoomState {
  const project = typeof e.route.project === 'string' && e.route.project !== '' ? e.route.project : undefined;
  return {
    room: e.room,
    session: '',
    model: 'unknown',
    state: 'queue',
    since: e.queuedAt,
    updatedAt: e.queuedAt,
    task: '',
    steps: [],
    subagents: [],
    ...(project !== undefined ? { project } : {}),
    kind: project !== undefined ? 'code' : 'scratch',
    queuePosition: position,
  };
}

export class LiveRooms {
  // Holds the reducer's own return values: they carry its private bookkeeping into the next reduce.
  private readonly rooms = new Map<string, RoomState>();
  private readonly listeners = new Set<(room: RoomState) => void>();
  // The newest hook line per room that counts as activity, as the janitor reads it: any after `couch.since`
  // makes the couch stale.
  private readonly lastEvent = new Map<string, number>();
  // What each room was last sent as, so refresh() sends only what changed.
  private readonly shown = new Map<string, { state: string; json: string }>();
  private queue: { stamp: string; rooms: Map<string, RoomState> } = { stamp: '', rooms: new Map() };
  // Entries the doorman opened (a record stamped with their queuedAt): shown queued until the room's own
  // events reach the tail, so the agent walks from the sidewalk to its table instead of out and back in.
  private readonly handoff = new Map<string, RoomState>();

  // The newest real prompt per room (the main agent's, not synthetic): a PR notice older than it is read.
  private readonly lastPrompt = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  // Keyed by room.json's mtime: the file is read again only when it changes.
  private readonly registry = new Map<string, { stamp: string; rec: RoomRecord | undefined }>();
  // pr.json, keyed the same way.
  private readonly prs = new Map<string, { stamp: string; pr: PrState | undefined }>();

  // This opening's PR (as roomPr reads it): one an earlier room of the same name left says nothing.
  private prOf(rec: RoomRecord): PrState | undefined {
    let stamp: string;
    try {
      const st = statSync(join(roomDir(rec.room, this.env), 'pr.json'));
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.prs.delete(rec.room);
      return undefined;
    }
    let hit = this.prs.get(rec.room);
    if (hit?.stamp !== stamp) {
      hit = { stamp, pr: readPr(rec.room, this.env) };
      this.prs.set(rec.room, hit);
    }
    const pr = hit.pr;
    return pr !== undefined && pr.headRefName === rec.branch && pr.seenAt >= rec.createdAt ? pr : undefined;
  }

  // Claude stopped with the room still open: released for its seat, or gone with a session to resume.
  // Gone is an exit line, or closedAt (found not running) with nothing since: a reboot writes no exit line.
  // A room being closed is not parked: its tab closes before closedBy is written.
  private parked(state: RoomState): boolean {
    const rec = this.record(state.room);
    if (rec === undefined || rec.closedBy !== undefined) return false;
    const dead =
      state.state === 'exit' || (typeof rec.closedAt === 'number' && (this.lastEvent.get(state.room) ?? state.updatedAt) <= rec.closedAt);
    if (!dead) return false;
    const seat: unknown = rec.seat;
    if (typeof seat === 'object' && seat !== null && isSessionId((seat as { session?: unknown }).session)) return true;
    if (!isSessionId(state.session)) return false;
    if (rec.herdr !== undefined && rec.herdr.session !== herdrSession(this.env)) return false;
    return !isClosing(state.room, this.env);
  }

  // A real prompt after a notice: the room was told, the notice goes (pr.json too).
  private promptSeen(line: HookLine): void {
    if (!readsNotice(line) || typeof line.ts !== 'number') return;
    this.lastPrompt.set(line.room, Math.max(this.lastPrompt.get(line.room) ?? -Infinity, line.ts));
    const rec = this.record(line.room);
    const since = rec && this.prOf(rec)?.notice?.since;
    if (since === undefined || !(line.ts > since)) return;
    try {
      patchPr(line.room, ({ notice, ...pr }) => (notice !== undefined && line.ts > notice.since ? pr : undefined), this.env);
    } catch {
      // shown as read all the same
    }
  }

  private record(room: string): RoomRecord | undefined {
    let stamp: string;
    try {
      const st = statSync(join(roomDir(room, this.env), 'room.json'));
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.registry.delete(room);
      return undefined;
    }
    const hit = this.registry.get(room);
    if (hit?.stamp === stamp) return hit.rec;
    let rec: RoomRecord | undefined;
    try {
      rec = readRoom(room, this.env);
    } catch {
      rec = undefined;
    }
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) rec = undefined;
    this.registry.set(room, { stamp, rec });
    return rec;
  }

  // Same mtime keying. A queue that cannot be read keeps the last one shown, and is tried again next time.
  private readQueued(): Map<string, RoomState> {
    let stamp = '';
    try {
      const st = statSync(queueFile(this.env));
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      // no queue: nobody waits
    }
    if (stamp === this.queue.stamp) return this.queue.rooms;
    try {
      const entries = stamp === '' ? [] : readQueue(this.env);
      const rooms = new Map(entries.map((e, i) => [e.room, queuedState(e, i + 1)]));
      for (const [room, q] of this.queue.rooms) if (!rooms.has(room) && this.openedFrom(q)) this.handoff.set(room, q);
      this.queue = { stamp, rooms };
    } catch {
      // half-written or corrupt
    }
    return this.queue.rooms;
  }

  private view(state: RoomState, isParked = false): RoomState {
    const rec = this.record(state.room);
    if (!rec) return state;
    const out: RoomState = { ...state };
    if (typeof rec.project === 'string' && rec.project !== '') out.project = rec.project;
    if (typeof rec.branch === 'string' && rec.branch !== '') out.branch = rec.branch;
    if (rec.kind === 'code' || rec.kind === 'scratch') out.kind = rec.kind;
    if (state.model === 'unknown' && typeof rec.model === 'string') out.model = modelKey(rec.model);
    const couch = parked(rec.couch);
    if (couch !== undefined && couchHolds(couch, state.state, this.lastEvent.get(state.room) ?? state.updatedAt)) {
      out.state = 'couch';
      out.couchReasons = couch.reasons;
    }
    if (isParked) out.state = 'parked';
    if (out.state === 'exit') return out;
    const pr = this.prOf(rec);
    const n = pr?.notice;
    if (n !== undefined && (this.lastPrompt.get(state.room) ?? -Infinity) <= n.since) {
      out.notice = { kind: n.kind, text: shownText(n.text, NOTICE_MAX), ...(PR_LINK.test(n.url) ? { url: n.url } : {}) };
    }
    // Only over a room at rest: one that works or needs you keeps its state, its alert and its bell.
    if (pr?.state === 'MERGED' && pr.dance !== undefined && this.now() < pr.dance.until && DANCES_OVER.has(out.state)) {
      if (out.state === 'parked') out.parked = true;
      out.state = 'dance';
      delete out.couchReasons;
    }
    return out;
  }

  private openedFrom(q: RoomState): boolean {
    const rec = this.record(q.room);
    return rec !== undefined && rec.closedBy === undefined && rec.fromQueue === q.since;
  }

  // Closed with minutes and nothing since: a room whose Claude died never wrote its exit line.
  private closed(state: RoomState): boolean {
    const rec = this.record(state.room);
    if (rec?.closedBy === undefined) return false;
    return typeof rec.closedAt !== 'number' || (this.lastEvent.get(state.room) ?? state.updatedAt) <= rec.closedAt;
  }

  // The entry stays in queue.json while its room opens: a session that started after it was queued wins.
  private present(room: string): RoomState | undefined {
    const live = this.rooms.get(room);
    let queued = this.queue.rooms.get(room);
    if (queued === undefined) {
      queued = this.handoff.get(room);
      if (queued !== undefined && ((live !== undefined && live.updatedAt > queued.since) || !this.openedFrom(queued))) {
        this.handoff.delete(room);
        queued = undefined;
      }
    }
    if (live !== undefined && live.state !== 'exit' && (queued === undefined || live.updatedAt > queued.since)) {
      if (!this.closed(live)) return this.view(live, this.parked(live));
      const { couchReasons: _c, ...gone } = this.view(live);
      return { ...gone, state: 'exit' };
    }
    if (queued !== undefined) return queued;
    return live && this.view(live, this.parked(live));
  }

  private emit(room: RoomState): void {
    this.shown.set(room.room, { state: room.state, json: JSON.stringify(room) });
    if (room.state === 'exit' && !this.rooms.has(room.room)) this.shown.delete(room.room);
    for (const fn of [...this.listeners]) {
      try {
        fn(room);
      } catch {
        // One broken subscriber must not starve the others.
      }
    }
  }

  apply(line: HookLine): RoomState {
    if (typeof line.ts === 'number' && countsAsActivity(line)) this.lastEvent.set(line.room, Math.max(this.lastEvent.get(line.room) ?? -Infinity, line.ts));
    this.promptSeen(line);
    const prev = this.rooms.get(line.room);
    const next = reduce(prev, line);
    if (next === prev) return next;
    this.rooms.set(line.room, next);
    if (prev?.state === 'exit' && next.state === 'exit') return next;
    this.emit(this.present(line.room)!);
    return next;
  }

  // What changed without a hook line: the queue, and the registry (a couch set or cleared by the janitor).
  refresh(): void {
    const before = this.queue.rooms;
    const queued = this.readQueued();
    for (const room of new Set([...this.rooms.keys(), ...before.keys(), ...queued.keys(), ...this.handoff.keys()])) {
      const was = this.shown.get(room);
      const quiet = was === undefined || was.state === 'exit';
      const live = this.rooms.get(room);
      if (quiet && live?.state === 'exit' && !queued.has(room) && !this.handoff.has(room) && !this.parked(live)) continue;
      const left = before.get(room);
      const now = this.present(room) ?? (left && { ...withoutPosition(left), state: 'exit' as const });
      if (now === undefined || (now.state === 'exit' && quiet)) continue;
      if (JSON.stringify(now) !== was?.json) this.emit(now);
    }
  }

  // Polls refresh(): queue.json is replaced by a rename, which a file watch would lose.
  watch(ms = WATCH_MS): () => void {
    const timer = setInterval(() => {
      try {
        this.refresh();
      } catch {
        // the next round tries again
      }
    }, ms);
    timer.unref();
    return () => clearInterval(timer);
  }

  // Refreshed first: the subscribers already connected hear of a change before a new snapshot holds it.
  snapshot(): RoomState[] {
    this.refresh();
    return [...new Set([...this.rooms.keys(), ...this.queue.rooms.keys(), ...this.handoff.keys()])]
      .sort()
      .map((room) => this.present(room)!)
      .filter((r) => r.state !== 'exit');
  }

  on(fn: (room: RoomState) => void): () => void {
    const entry = (room: RoomState) => fn(room);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

const withoutPosition = ({ queuePosition: _p, ...r }: RoomState): RoomState => r;

function notAllowed(res: ServerResponse, allow: string): true {
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow });
  res.end('Method not allowed');
  return true;
}

type Routes = (req: IncomingMessage, res: ServerResponse, url: URL, auth?: LoungeAuth) => boolean;

export function liveRoutes(rooms: LiveRooms, opts: { pingMs?: number; tickets?: TicketStore; reception?: Routes } = {}): Routes {
  const pingMs = opts.pingMs ?? PING_MS;
  const tickets = opts.tickets;
  const reception = opts.reception;
  return (req, res, url, auth) => {
    if (url.pathname === '/api/ticket' && tickets) {
      if (req.method !== 'POST') return notAllowed(res, 'POST');
      req.resume();
      if (auth !== 'header') {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return true;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify({ ticket: tickets.issue() }));
      return true;
    }

    if (url.pathname === '/api/state') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return notAllowed(res, 'GET, HEAD');
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ rooms: rooms.snapshot() }));
      return true;
    }

    if (url.pathname === '/api/events') {
      if (req.method !== 'GET') return notAllowed(res, 'GET');
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
      });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Snapshot and subscription in one synchronous block, so no change can fall between them.
      send('snapshot', { rooms: rooms.snapshot() });
      const off = rooms.on((room) => send('room', room));
      const ping = setInterval(() => res.write(': ping\n\n'), pingMs);
      ping.unref();
      const cleanup = () => {
        off();
        clearInterval(ping);
      };
      res.on('close', cleanup);
      if (res.destroyed) cleanup();
      return true;
    }

    return reception ? reception(req, res, url, auth) : false;
  };
}
