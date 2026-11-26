import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookLine } from '../src/events.js';
import { EventTail } from '../src/event-tail.js';
import { LiveRooms, liveRoutes } from '../src/live-api.js';
import { startLoungeServer, type LoungeServer } from '../src/lounge-server.js';
import { roomDir } from '../src/paths.js';
import { writeRoom as writeRoomRecord } from '../src/rooms.js';
import { reduce, type RoomState } from '../src/room-state.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOOK = join(ROOT, 'hooks', 'maitre-hook.mjs');
const TOKEN = 'tok-live';

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

// The fixture's raw hook payloads, turned into event lines by the real hook (room "t1").
const FIXTURE_LINES: string[] = (() => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-live-fixture-'));
  try {
    const raw = readFileSync(join(ROOT, 'test', 'fixtures', 'hook-events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    for (const input of raw) {
      const r = spawnSync(process.execPath, [HOOK], {
        input,
        env: { PATH: process.env.PATH ?? '', MAITRE_ROOM: 't1', MAITRE_HOME: home },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0);
    }
    const lines = readFileSync(join(roomDir('t1', { MAITRE_HOME: home }), 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    assert.equal(lines.length, raw.length);
    assert.equal((JSON.parse(lines.at(-1)!) as HookLine).event, 'SessionEnd');
    return lines;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
})();

function asRoom(lines: string[], room: string): string[] {
  return lines.map((l) => JSON.stringify({ ...(JSON.parse(l) as HookLine), room }));
}

function fold(lines: string[]): RoomState {
  let s: RoomState | undefined;
  for (const l of lines) s = reduce(s, JSON.parse(l) as HookLine);
  assert.ok(s);
  return s;
}

function writeRoom(home: string, room: string, lines: string[]): string {
  const dir = roomDir(room, { MAITRE_HOME: home });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, lines.map((l) => l + '\n').join(''));
  return file;
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Daemon {
  rooms: LiveRooms;
  server: LoungeServer;
  stop(): Promise<void>;
}

async function startDaemon(home: string, pingMs?: number): Promise<Daemon> {
  const root = tmp('maitre-live-root-');
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
  const rooms = new LiveRooms();
  const tail = new EventTail(join(home, 'state'), (l) => rooms.apply(l), { pollMs: 50 });
  tail.start();
  const server = await startLoungeServer({
    root,
    port: 0,
    token: TOKEN,
    routes: liveRoutes(rooms, pingMs === undefined ? undefined : { pingMs }),
  });
  return {
    rooms,
    server,
    stop: async () => {
      tail.stop();
      await server.close();
    },
  };
}

function call(
  port: number,
  path: string,
  opts: { method?: string; key?: boolean } = {},
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = opts.key === false ? {} : { cookie: `maitre_key_${port}=${TOKEN}` };
    const r = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

interface SseEvent {
  event: string;
  data: string;
}

interface SseClient {
  events: SseEvent[];
  comments: string[];
  headers: () => IncomingMessage['headers'];
  close(): void;
}

function sse(port: number): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const events: SseEvent[] = [];
    const comments: string[] = [];
    let buf = '';
    let req: ClientRequest;
    let res: IncomingMessage | undefined;
    req = request(
      { host: '127.0.0.1', port, path: '/api/events', headers: { cookie: `maitre_key_${port}=${TOKEN}`, accept: 'text/event-stream' } },
      (r) => {
        res = r;
        if (r.statusCode !== 200) return reject(new Error(`status ${r.statusCode}`));
        r.setEncoding('utf8');
        r.on('data', (c: string) => {
          buf += c;
          let i: number;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = 'message';
            const data: string[] = [];
            for (const ln of block.split('\n')) {
              if (ln.startsWith(':')) comments.push(ln.slice(1).trim());
              else if (ln.startsWith('event: ')) event = ln.slice(7);
              else if (ln.startsWith('data: ')) data.push(ln.slice(6));
            }
            if (data.length > 0) events.push({ event, data: data.join('\n') });
          }
        });
        r.on('error', () => {});
        resolve({ events, comments, headers: () => r.headers, close: () => req.destroy() });
      },
    );
    req.on('error', (e) => {
      if (res === undefined) reject(e);
    });
    req.end();
  });
}

test('LiveRooms: emits changes, emits exit once, omits exit rooms from the snapshot', () => {
  const rooms = new LiveRooms();
  const seen: RoomState[] = [];
  const off = rooms.on((r) => seen.push(r));
  const ev = (event: string, extra: Partial<HookLine> = {}): HookLine => ({ v: 1, ts: Date.now(), room: 'a', session: 's-1', event, ...extra });

  rooms.apply(ev('SessionStart'));
  rooms.apply(ev('UserPromptSubmit', { prompt: 'go' }));
  assert.deepEqual(
    rooms.snapshot().map((r) => [r.room, r.state]),
    [['a', 'work']],
  );
  rooms.apply(ev('Stop', { session: 's-old' }));
  assert.equal(seen.length, 2, 'a stale-session event changes nothing and is not emitted');

  const exited = rooms.apply(ev('SessionEnd'));
  assert.equal(exited.state, 'exit');
  rooms.apply(ev('SessionEnd'));
  rooms.apply(ev('MaitreExit', { session: '' }));
  assert.deepEqual(
    seen.map((r) => r.state),
    ['coffee', 'work', 'exit'],
  );
  assert.deepEqual(rooms.snapshot(), []);

  rooms.apply(ev('SessionStart', { session: 's-2' }));
  assert.deepEqual(
    rooms.snapshot().map((r) => [r.room, r.session, r.state]),
    [['a', 's-2', 'coffee']],
  );
  off();
  rooms.apply(ev('UserPromptSubmit', { session: 's-2', prompt: 'x' }));
  assert.equal(seen.length, 4);
  assert.equal(rooms.listenerCount(), 0);
});

test('LiveRooms: a late same-session line after SessionEnd does not bring the room back', () => {
  const lines = asRoom(FIXTURE_LINES, 'late');
  const end = JSON.parse(lines.at(-1)!) as HookLine;
  assert.equal(end.event, 'SessionEnd');
  const lateLine: HookLine = { v: 1, ts: end.ts + 1, room: 'late', session: end.session, event: 'PostToolUse', tool: 'Bash', tool_use_id: 'toolu_LATE' };
  const rooms = new LiveRooms();
  const seen: RoomState[] = [];
  rooms.on((r) => seen.push(r));
  for (const l of [...lines, JSON.stringify(lateLine)]) rooms.apply(JSON.parse(l) as HookLine);
  assert.deepEqual(rooms.snapshot(), []);
  assert.equal(seen.at(-1)!.state, 'exit');
  assert.equal(seen.filter((r) => r.state === 'exit').length, 1);
});

test('LiveRooms: snapshot is sorted by room and holds only public fields', () => {
  const rooms = new LiveRooms();
  for (const room of ['b', 'a']) rooms.apply({ v: 1, ts: 1, room, session: 's', event: 'SessionStart' });
  const snap = rooms.snapshot();
  assert.deepEqual(
    snap.map((r) => r.room),
    ['a', 'b'],
  );
  assert.deepEqual(Object.getOwnPropertySymbols(JSON.parse(JSON.stringify(snap[0]))), []);
});

test('/api/state is token-gated and returns the folded rooms', async () => {
  const home = tmp('maitre-live-');
  const live = FIXTURE_LINES.slice(0, -1);
  writeRoom(home, 't1', live);
  const d = await startDaemon(home);
  try {
    assert.equal((await call(d.server.port, '/api/state', { key: false })).status, 403);
    const res = await call(d.server.port, '/api/state');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] ?? '', /application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = JSON.parse(res.body) as { rooms: RoomState[] };
    assert.equal(body.rooms.length, 1);
    assert.equal(JSON.stringify(body.rooms[0]), JSON.stringify(fold(live)));
    assert.notEqual(body.rooms[0]?.state, 'exit');

    const head = await call(d.server.port, '/api/state', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  } finally {
    await d.stop();
  }
});

test('API routes reject other methods with 405', async () => {
  const home = tmp('maitre-live-');
  const d = await startDaemon(home);
  try {
    for (const [method, path] of [
      ['POST', '/api/state'],
      ['DELETE', '/api/state'],
      ['POST', '/api/events'],
      ['HEAD', '/api/events'],
    ] as const) {
      const res = await call(d.server.port, path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.ok(res.headers.allow, `${method} ${path} has Allow`);
    }
  } finally {
    await d.stop();
  }
});

test('a //host request target never reaches the API', async () => {
  const home = tmp('maitre-live-');
  writeRoom(home, 't1', FIXTURE_LINES.slice(0, -1));
  const d = await startDaemon(home);
  try {
    for (const path of ['//evil.example/api/state', '/\\evil.example/api/state']) {
      const res = await call(d.server.port, path);
      assert.notEqual(res.status, 200, path);
      assert.ok(!res.body.includes('"rooms"'), `${path} leaked state`);
    }
  } finally {
    await d.stop();
  }
});

test('/api/events streams a snapshot, then room changes; every connection gets a full snapshot', async () => {
  const home = tmp('maitre-live-');
  const file = writeRoom(home, 't1', FIXTURE_LINES.slice(0, -2));
  const d = await startDaemon(home);
  const clients: SseClient[] = [];
  try {
    const a = await sse(d.server.port);
    clients.push(a);
    assert.match(a.headers()['content-type'] ?? '', /^text\/event-stream/);
    assert.equal(a.headers()['cache-control'], 'no-cache');
    assert.equal(a.headers()['connection'], 'keep-alive');
    await waitFor(() => a.events.length === 1);
    assert.equal(a.events[0]?.event, 'snapshot');
    const first = JSON.parse(a.events[0]!.data) as { rooms: RoomState[] };
    assert.equal(JSON.stringify(first.rooms), JSON.stringify([fold(FIXTURE_LINES.slice(0, -2))]));

    appendFileSync(file, FIXTURE_LINES.at(-2)! + '\n');
    await waitFor(() => a.events.length === 2);
    assert.equal(a.events[1]?.event, 'room');
    const changed = JSON.parse(a.events[1]!.data) as RoomState;
    assert.equal(JSON.stringify(changed), JSON.stringify(fold(FIXTURE_LINES.slice(0, -1))));

    const b = await sse(d.server.port);
    clients.push(b);
    await waitFor(() => b.events.length === 1);
    assert.equal(b.events[0]?.event, 'snapshot');
    assert.equal(JSON.stringify((JSON.parse(b.events[0]!.data) as { rooms: RoomState[] }).rooms), JSON.stringify([changed]));
    assert.equal(d.rooms.listenerCount(), 2);

    appendFileSync(file, FIXTURE_LINES.at(-1)! + '\n');
    await waitFor(() => a.events.length === 3 && b.events.length === 2);
    for (const e of [a.events[2]!, b.events[1]!]) {
      assert.equal(e.event, 'room');
      assert.equal((JSON.parse(e.data) as RoomState).state, 'exit');
    }
    assert.deepEqual(JSON.parse((await call(d.server.port, '/api/state')).body), { rooms: [] });

    a.close();
    b.close();
    await waitFor(() => d.rooms.listenerCount() === 0);
  } finally {
    for (const c of clients) c.close();
    await d.stop();
  }
});

test('/api/events sends a ping comment on its interval', async () => {
  const home = tmp('maitre-live-');
  const d = await startDaemon(home, 30);
  let c: SseClient | undefined;
  try {
    c = await sse(d.server.port);
    await waitFor(() => c!.comments.includes('ping'));
    assert.deepEqual(
      c.events.map((e) => e.event),
      ['snapshot'],
    );
  } finally {
    c?.close();
    await d.stop();
  }
});

test('a fresh start that replays files drops rooms that ended (SessionEnd or MaitreExit)', async () => {
  const home = tmp('maitre-live-');
  writeRoom(home, 'ended', asRoom(FIXTURE_LINES, 'ended'));
  const killed = asRoom(FIXTURE_LINES.slice(0, -1), 'killed');
  killed.push(JSON.stringify({ v: 1, ts: Date.now(), room: 'killed', session: '', event: 'MaitreExit' }));
  writeRoom(home, 'killed', killed);
  writeRoom(home, 'alive', asRoom(FIXTURE_LINES.slice(0, -1), 'alive'));
  const d = await startDaemon(home);
  let c: SseClient | undefined;
  try {
    const state = JSON.parse((await call(d.server.port, '/api/state')).body) as { rooms: RoomState[] };
    assert.deepEqual(
      state.rooms.map((r) => r.room),
      ['alive'],
    );
    c = await sse(d.server.port);
    await waitFor(() => c!.events.length === 1);
    assert.deepEqual(
      (JSON.parse(c.events[0]!.data) as { rooms: RoomState[] }).rooms.map((r) => r.room),
      ['alive'],
    );
  } finally {
    c?.close();
    await d.stop();
  }
});

const REC = { room: 'r1', project: 'backend', kind: 'code', dir: '/w', branch: 'maitre/nf-bug', model: 'sonnet', taskType: 'bug', createdAt: 1 } as const;
const START = (room: string): HookLine => ({ v: 1, ts: 1, room, session: 's', event: 'SessionStart' });

test('LiveRooms: a registered room carries project and branch, and the registry model fills unknown', () => {
  const home = tmp('maitre-live-reg-');
  const env = { MAITRE_HOME: home };
  writeRoomRecord({ ...REC }, env);
  writeRoomRecord({ ...REC, room: 'plain' , project: undefined, branch: undefined, kind: 'scratch', model: 'opus' }, env);
  const rooms = new LiveRooms(env);
  const seen: RoomState[] = [];
  rooms.on((r) => seen.push(r));
  for (const room of ['r1', 'plain', 'none']) rooms.apply(START(room));
  const by = Object.fromEntries(rooms.snapshot().map((r) => [r.room, r]));
  assert.equal(by.r1?.project, 'backend');
  assert.equal(by.r1?.branch, 'maitre/nf-bug');
  assert.equal(by.r1?.model, 'sonnet');
  assert.equal(by.plain?.kind, 'scratch');
  assert.equal(by.plain?.project, undefined);
  assert.equal(by.plain?.model, 'opus');
  assert.equal(JSON.stringify(by.none), JSON.stringify(fold([JSON.stringify(START('none'))])), 'no registry: unchanged');
  assert.equal(seen.find((r) => r.room === 'r1')?.project, 'backend', 'SSE room events are enriched too');
});

test('LiveRooms: the reducer model wins over the registry once known', () => {
  const home = tmp('maitre-live-reg-');
  const env = { MAITRE_HOME: home };
  writeRoomRecord({ ...REC }, env);
  const rooms = new LiveRooms(env);
  rooms.apply({ ...START('r1'), model: 'claude-opus-4-7' });
  assert.equal(rooms.snapshot()[0]?.model, 'opus');
});

test('LiveRooms: a corrupt or odd room.json never breaks the snapshot', () => {
  const home = tmp('maitre-live-reg-');
  const env = { MAITRE_HOME: home };
  mkdirSync(roomDir('bad', env), { recursive: true });
  writeFileSync(join(roomDir('bad', env), 'room.json'), '{nope');
  mkdirSync(roomDir('odd', env), { recursive: true });
  writeFileSync(join(roomDir('odd', env), 'room.json'), JSON.stringify({ project: 5, branch: {}, model: [] }));
  const rooms = new LiveRooms(env);
  for (const room of ['bad', 'odd']) rooms.apply(START(room));
  const snap = rooms.snapshot();
  assert.deepEqual(snap.map((r) => [r.room, r.project, r.branch, r.model]), [['bad', undefined, undefined, 'unknown'], ['odd', undefined, undefined, 'unknown']]);
});

test('LiveRooms: a registry written after the room first appeared shows up on the next change', () => {
  const home = tmp('maitre-live-reg-');
  const env = { MAITRE_HOME: home };
  const rooms = new LiveRooms(env);
  rooms.apply(START('r1'));
  assert.equal(rooms.snapshot()[0]?.project, undefined);
  writeRoomRecord({ ...REC }, env);
  assert.equal(rooms.snapshot()[0]?.project, 'backend');
});
