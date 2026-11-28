import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveRooms, liveRoutes } from '../src/live-api.js';
import { startLoungeServer, TicketStore, type LoungeAuth } from '../src/lounge-server.js';

const TOKEN = 'tok123';

function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

function send(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers ?? {} }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

const bases: string[] = [];
after(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'maitre-lounge-'));
  bases.push(base);
  await writeFile(join(base, 'secret.txt'), '{ "name": "maitre" }');
  const root = join(base, 'lounge');
  await mkdir(join(root, 'js'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>x</title>');
  await writeFile(join(root, 'js', 'main.js'), 'export {};');
  return root;
}

test('serves index with valid key', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    assert.equal(s.url, `http://127.0.0.1:${s.port}/?key=${TOKEN}`);
    const res = await fetch(s.url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(res.headers.get('set-cookie'), `maitre_key_${s.port}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  } finally {
    await s.close();
  }
});

test('accepts cookie on later requests', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/js/main.js`, {
      headers: { cookie: `maitre_key_${s.port}=${TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/javascript/);
  } finally {
    await s.close();
  }
});

test('rejects missing or wrong key', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/?key=nope`)).status, 403);
  } finally {
    await s.close();
  }
});

test('blocks traversal', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    const probes = ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/js/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt'];
    for (const p of probes) {
      const { status, body } = await raw(s.port, p, { cookie: `maitre_key_${s.port}=${TOKEN}` });
      assert.equal(status, 403, `${p} -> ${status}`);
      assert.ok(!body.includes('"name": "maitre"'), `${p} leaked sentinel`);
    }
  } finally {
    await s.close();
  }
});

test('binds loopback only', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    assert.equal(s.address.address, '127.0.0.1');
  } finally {
    await s.close();
  }
});

test('falls back when port busy', async () => {
  const blocker: Server = createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
  const p = (blocker.address() as AddressInfo).port;
  const s = await startLoungeServer({ root: await fixture(), port: p, token: TOKEN });
  try {
    assert.ok(s.port > p && s.port <= p + 20, `port ${s.port}`);
  } finally {
    await s.close();
    await new Promise((r) => blocker.close(r));
  }
});

test('rejects foreign Host', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    const r = await raw(s.port, `/?key=${TOKEN}`, { host: `evil.example:${s.port}` });
    assert.equal(r.status, 403);
  } finally {
    await s.close();
  }
});

test('accepts localhost and 127.0.0.1 hosts', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    for (const h of [`localhost:${s.port}`, `127.0.0.1:${s.port}`]) {
      assert.equal((await raw(s.port, `/?key=${TOKEN}`, { host: h })).status, 200, h);
    }
  } finally {
    await s.close();
  }
});

test('rejects cross-origin', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    assert.equal((await raw(s.port, `/?key=${TOKEN}`, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await raw(s.port, `/?key=${TOKEN}`, { origin: `http://localhost:${s.port}` })).status, 200);
    assert.equal((await raw(s.port, `/?key=${TOKEN}`, { origin: `http://127.0.0.1:${s.port}` })).status, 200);
  } finally {
    await s.close();
  }
});

test('port-scoped cookie', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    const res = await fetch(s.url);
    assert.ok((res.headers.get('set-cookie') ?? '').startsWith(`maitre_key_${s.port}=`));
    const other = await raw(s.port, '/', { cookie: `maitre_key_${s.port + 1}=${TOKEN}` });
    assert.equal(other.status, 403);
  } finally {
    await s.close();
  }
});

test('symlink cannot escape root', async () => {
  const root = await fixture();
  await symlink(join(root, '..', 'secret.txt'), join(root, 'leak.txt'));
  const s = await startLoungeServer({ root, port: 0, token: TOKEN });
  try {
    const r = await raw(s.port, '/leak.txt', { cookie: `maitre_key_${s.port}=${TOKEN}` });
    assert.equal(r.status, 403);
    assert.ok(!r.body.includes('"name": "maitre"'));
  } finally {
    await s.close();
  }
});

test('custom route runs after auth', async () => {
  const s = await startLoungeServer({
    root: await fixture(),
    port: 0,
    token: TOKEN,
    routes: (req, res, url) => {
      if (url.pathname !== '/api/echo') return false;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pong');
      return true;
    },
  });
  try {
    const ok = await raw(s.port, `/api/echo?key=${TOKEN}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'pong');
    assert.equal((await raw(s.port, '/api/echo')).status, 403);
  } finally {
    await s.close();
  }
});

test('routes see only origin-form paths; //host and absolute-form targets never match', async () => {
  const seen: string[] = [];
  const s = await startLoungeServer({
    root: await fixture(),
    port: 0,
    token: TOKEN,
    routes: (_req, res, url) => {
      seen.push(url.pathname);
      if (url.host !== `127.0.0.1:${s.port}` || url.pathname !== '/api/echo') return false;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pong');
      return true;
    },
  });
  try {
    const cookie = { cookie: `maitre_key_${s.port}=${TOKEN}` };
    for (const p of ['//evil.example/api/echo', '/\\evil.example/api/echo', `http://evil.example/api/echo?key=${TOKEN}`]) {
      const { status, body } = await raw(s.port, p, cookie);
      assert.notEqual(status, 200, p);
      assert.notEqual(body, 'pong', p);
    }
    assert.ok(!seen.includes('/api/echo'), `route saw ${JSON.stringify(seen)}`);
    assert.equal((await raw(s.port, '/api/echo', cookie)).body, 'pong');
  } finally {
    await s.close();
  }
});

test('GET /api/ping answers without a token, still behind the Host check', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    const ok = await send(s.port, '/api/ping');
    assert.equal(ok.status, 200);
    assert.match(String(ok.headers['content-type']), /application\/json/);
    assert.deepEqual(JSON.parse(ok.body), { app: 'maitre', pid: process.pid });
    assert.equal(ok.headers['set-cookie'], undefined);
    assert.equal((await send(s.port, '/api/ping', { headers: { host: `evil.example:${s.port}` } })).status, 403);
    for (const p of ['//evil.example/api/ping', '/api/ping/x', '/api/pingx']) {
      assert.equal((await send(s.port, p)).status, 403, p);
    }
    assert.equal((await send(s.port, '/api/ping', { method: 'POST' })).status, 403);
  } finally {
    await s.close();
  }
});

function stateRoute(seen: LoungeAuth[]) {
  return (_req: unknown, res: import('node:http').ServerResponse, url: URL, auth: LoungeAuth) => {
    if (url.pathname !== '/api/state') return false;
    seen.push(auth);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"rooms":[]}');
    return true;
  };
}

test('a valid x-maitre-token header grants the API; a wrong one is 403 even with a cookie', async () => {
  const seen: LoungeAuth[] = [];
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN, routes: stateRoute(seen) });
  try {
    const ok = await send(s.port, '/api/state', { headers: { 'x-maitre-token': TOKEN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, '{"rooms":[]}');
    assert.equal(ok.headers['set-cookie'], undefined);
    assert.deepEqual(seen, ['header']);
    assert.equal((await send(s.port, '/api/state', { headers: { 'x-maitre-token': 'nope' } })).status, 403);
    const both = await send(s.port, '/api/state', { headers: { 'x-maitre-token': 'nope', cookie: `maitre_key_${s.port}=${TOKEN}` } });
    assert.equal(both.status, 403);
    assert.equal((await send(s.port, '/', { headers: { 'x-maitre-token': TOKEN } })).status, 200);
    assert.deepEqual(seen, ['header']);
  } finally {
    await s.close();
  }
});

test('TicketStore: tickets are 32 random bytes hex, single use, valid 60 s', () => {
  let now = 1_000;
  const store = new TicketStore(undefined, () => now);
  const a = store.issue();
  const b = store.issue();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(store.consume(a), true);
  assert.equal(store.consume(a), false);
  assert.equal(store.consume('nope'), false);
  now += 60_000;
  assert.equal(store.consume(b), true);
  const c = store.issue();
  now += 60_001;
  assert.equal(store.consume(c), false);
});

test('a ticket opens the lounge once, sets the cookie, then is refused', async () => {
  const tickets = new TicketStore();
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN, tickets });
  try {
    const t = tickets.issue();
    const first = await send(s.port, `/?ticket=${t}`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.headers['set-cookie'], [`maitre_key_${s.port}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`]);
    assert.equal((await send(s.port, `/?ticket=${t}`)).status, 403);
    assert.equal((await send(s.port, '/?ticket=nope')).status, 403);
  } finally {
    await s.close();
  }
});

test('a ticket on an API path is accepted once and sets the cookie there too', async () => {
  const seen: LoungeAuth[] = [];
  const tickets = new TicketStore();
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN, tickets, routes: stateRoute(seen) });
  try {
    const t = tickets.issue();
    const first = await send(s.port, `/api/state?ticket=${t}`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.headers['set-cookie'], [`maitre_key_${s.port}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`]);
    assert.deepEqual(seen, ['ticket']);
    assert.equal((await send(s.port, `/api/state?ticket=${t}`)).status, 403);
  } finally {
    await s.close();
  }
});

test('an expired ticket is refused', async () => {
  let now = 5_000;
  const tickets = new TicketStore(60_000, () => now);
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN, tickets });
  try {
    const t = tickets.issue();
    now += 60_001;
    assert.equal((await send(s.port, `/?ticket=${t}`)).status, 403);
  } finally {
    await s.close();
  }
});

test('tickets are refused when the server has no ticket store', async () => {
  const tickets = new TicketStore();
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    assert.equal((await send(s.port, `/?ticket=${tickets.issue()}`)).status, 403);
  } finally {
    await s.close();
  }
});

// Never the real ~/.maitre: a snapshot reads the queue, and an open floor writes floors.json.
async function scratchHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'maitre-lounge-home-'));
  bases.push(home);
  return home;
}

async function ticketServer(): Promise<{ port: number; close(): Promise<void> }> {
  const tickets = new TicketStore();
  return startLoungeServer({ root: await fixture(), port: 0, token: TOKEN, tickets, routes: liveRoutes(new LiveRooms({ MAITRE_HOME: await scratchHome() }), { tickets }) });
}

test('POST /api/ticket with the token header returns a working ticket', async () => {
  const s = await ticketServer();
  try {
    const res = await send(s.port, '/api/ticket', { method: 'POST', headers: { 'x-maitre-token': TOKEN } });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    const { ticket } = JSON.parse(res.body) as { ticket: string };
    assert.match(ticket, /^[0-9a-f]{64}$/);
    assert.equal((await send(s.port, `/?ticket=${ticket}`)).status, 200);
    assert.equal((await send(s.port, `/?ticket=${ticket}`)).status, 403);
    const get = await send(s.port, '/api/ticket', { headers: { 'x-maitre-token': TOKEN } });
    assert.equal(get.status, 405);
  } finally {
    await s.close();
  }
});

test('POST /api/ticket refuses a cookie, even a same-origin one, and a wrong header', async () => {
  const s = await ticketServer();
  try {
    const csrf = { origin: `http://127.0.0.1:${s.port}`, 'x-maitre-request': '1', cookie: `maitre_key_${s.port}=${TOKEN}` };
    const cookie = await send(s.port, '/api/ticket', { method: 'POST', headers: csrf });
    assert.equal(cookie.status, 403);
    assert.ok(!cookie.body.includes('ticket'));
    assert.equal((await send(s.port, `/api/ticket?key=${TOKEN}`, { method: 'POST', headers: csrf })).status, 403);
    assert.equal((await send(s.port, '/api/ticket', { method: 'POST', headers: { ...csrf, 'x-maitre-token': 'nope' } })).status, 403);
  } finally {
    await s.close();
  }
});

test('POST /api/ticket is not served without a ticket store', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN, routes: liveRoutes(new LiveRooms({ MAITRE_HOME: await scratchHome() })) });
  try {
    assert.equal((await send(s.port, '/api/ticket', { method: 'POST', headers: { 'x-maitre-token': TOKEN } })).status, 403);
  } finally {
    await s.close();
  }
});

test('CSRF: a non-GET authenticated by cookie, key or ticket needs Origin and x-maitre-request', async () => {
  const hits: { method: string; auth: LoungeAuth }[] = [];
  const tickets = new TicketStore();
  const s = await startLoungeServer({
    root: await fixture(),
    port: 0,
    token: TOKEN,
    tickets,
    routes: (req, res, url, auth) => {
      if (url.pathname !== '/api/do') return false;
      hits.push({ method: req.method ?? '', auth });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('done');
      return true;
    },
  });
  try {
    const cookie = `maitre_key_${s.port}=${TOKEN}`;
    const self = `http://127.0.0.1:${s.port}`;
    const refused: [string, { method?: string; headers: Record<string, string>; body?: string }][] = [
      ['cookie, no Origin', { headers: { cookie, 'x-maitre-request': '1' } }],
      ['cookie, foreign Origin', { headers: { cookie, origin: 'http://evil.example', 'x-maitre-request': '1' } }],
      ['cookie, other port', { headers: { cookie, origin: `http://127.0.0.1:${s.port + 1}`, 'x-maitre-request': '1' } }],
      ['cookie, no x-maitre-request', { headers: { cookie, origin: self } }],
      ['cookie, x-maitre-request 0', { headers: { cookie, origin: self, 'x-maitre-request': '0' } }],
      ['cookie, text/plain form', { headers: { cookie, 'content-type': 'text/plain' }, body: 'text=hi' }],
      ['cookie, DELETE', { method: 'DELETE', headers: { cookie } }],
      ['key, no headers', { headers: {} }],
      ['ticket, no headers', { headers: {} }],
    ];
    for (const [name, o] of refused) {
      let path = '/api/do';
      if (name.startsWith('key')) path += `?key=${TOKEN}`;
      if (name.startsWith('ticket')) path += `?ticket=${tickets.issue()}`;
      const res = await send(s.port, path, { method: o.method ?? 'POST', headers: o.headers, body: o.body });
      assert.equal(res.status, 403, name);
      assert.notEqual(res.body, 'done', name);
    }
    assert.deepEqual(hits, []);

    for (const origin of [self, `http://localhost:${s.port}`]) {
      assert.equal((await send(s.port, '/api/do', { method: 'POST', headers: { cookie, origin, 'x-maitre-request': '1' } })).status, 200, origin);
    }
    const t = tickets.issue();
    assert.equal((await send(s.port, `/api/do?ticket=${t}`, { method: 'POST', headers: { origin: self, 'x-maitre-request': '1' } })).status, 200);
    assert.equal((await send(s.port, '/api/do', { method: 'POST', headers: { 'x-maitre-token': TOKEN } })).status, 200);
    assert.equal((await send(s.port, '/api/do', { method: 'DELETE', headers: { 'x-maitre-token': TOKEN } })).status, 200);
    assert.equal((await send(s.port, '/api/do', { headers: { cookie } })).status, 200);
    assert.deepEqual(hits, [
      { method: 'POST', auth: 'cookie' },
      { method: 'POST', auth: 'cookie' },
      { method: 'POST', auth: 'ticket' },
      { method: 'POST', auth: 'header' },
      { method: 'DELETE', auth: 'header' },
      { method: 'GET', auth: 'cookie' },
    ]);
  } finally {
    await s.close();
  }
});
