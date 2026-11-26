import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoungeServer } from '../src/lounge-server.js';

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
      if (url.pathname !== '/api/ping') return false;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pong');
      return true;
    },
  });
  try {
    const ok = await raw(s.port, `/api/ping?key=${TOKEN}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'pong');
    assert.equal((await raw(s.port, '/api/ping')).status, 403);
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
      if (url.host !== `127.0.0.1:${s.port}` || url.pathname !== '/api/ping') return false;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pong');
      return true;
    },
  });
  try {
    const cookie = { cookie: `maitre_key_${s.port}=${TOKEN}` };
    for (const p of ['//evil.example/api/ping', '/\\evil.example/api/ping', `http://evil.example/api/ping?key=${TOKEN}`]) {
      const { status, body } = await raw(s.port, p, cookie);
      assert.notEqual(status, 200, p);
      assert.notEqual(body, 'pong', p);
    }
    assert.ok(!seen.includes('/api/ping'), `route saw ${JSON.stringify(seen)}`);
    assert.equal((await raw(s.port, '/api/ping', cookie)).body, 'pong');
  } finally {
    await s.close();
  }
});
