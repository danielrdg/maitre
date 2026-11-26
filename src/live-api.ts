import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HookLine } from './events.js';
import { reduce, type RoomState } from './room-state.js';

const PING_MS = 15_000;

export class LiveRooms {
  // Holds the reducer's own return values: they carry its private bookkeeping into the next reduce.
  private readonly rooms = new Map<string, RoomState>();
  private readonly listeners = new Set<(room: RoomState) => void>();

  apply(line: HookLine): RoomState {
    const prev = this.rooms.get(line.room);
    const next = reduce(prev, line);
    if (next === prev) return next;
    this.rooms.set(line.room, next);
    if (prev?.state === 'exit' && next.state === 'exit') return next;
    for (const fn of [...this.listeners]) {
      try {
        fn(next);
      } catch {
        // One broken subscriber must not starve the others.
      }
    }
    return next;
  }

  snapshot(): RoomState[] {
    return [...this.rooms.values()]
      .filter((r) => r.state !== 'exit')
      .sort((a, b) => (a.room < b.room ? -1 : a.room > b.room ? 1 : 0));
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

export function liveRoutes(
  rooms: LiveRooms,
  opts: { pingMs?: number } = {},
): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const pingMs = opts.pingMs ?? PING_MS;
  return (req, res, url) => {
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

    return false;
  };
}
