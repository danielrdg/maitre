import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HookLine } from './events.js';
import type { LoungeAuth, TicketStore } from './lounge-server.js';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { roomDir } from './paths.js';
import { readRoom, type RoomRecord } from './rooms.js';
import { modelKey, reduce, type RoomState } from './room-state.js';

const PING_MS = 15_000;

export class LiveRooms {
  // Holds the reducer's own return values: they carry its private bookkeeping into the next reduce.
  private readonly rooms = new Map<string, RoomState>();
  private readonly listeners = new Set<(room: RoomState) => void>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  // Keyed by room.json's mtime: the file is read again only when it changes.
  private readonly registry = new Map<string, { stamp: string; rec: RoomRecord | undefined }>();

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

  private view(state: RoomState): RoomState {
    const rec = this.record(state.room);
    if (!rec) return state;
    const out: RoomState = { ...state };
    if (typeof rec.project === 'string' && rec.project !== '') out.project = rec.project;
    if (typeof rec.branch === 'string' && rec.branch !== '') out.branch = rec.branch;
    if (rec.kind === 'code' || rec.kind === 'scratch') out.kind = rec.kind;
    if (state.model === 'unknown' && typeof rec.model === 'string') out.model = modelKey(rec.model);
    return out;
  }

  apply(line: HookLine): RoomState {
    const prev = this.rooms.get(line.room);
    const next = reduce(prev, line);
    if (next === prev) return next;
    this.rooms.set(line.room, next);
    if (prev?.state === 'exit' && next.state === 'exit') return next;
    for (const fn of [...this.listeners]) {
      try {
        fn(this.view(next));
      } catch {
        // One broken subscriber must not starve the others.
      }
    }
    return next;
  }

  snapshot(): RoomState[] {
    return [...this.rooms.values()]
      .filter((r) => r.state !== 'exit')
      .sort((a, b) => (a.room < b.room ? -1 : a.room > b.room ? 1 : 0))
      .map((r) => this.view(r));
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
