import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoungeServer } from '../src/lounge-server.js';

const TOKEN = 'tok123';

async function fixture(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'maitre-lounge-'));
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
    assert.equal(res.headers.get('set-cookie'), `maitre_key=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  } finally {
    await s.close();
  }
});

test('accepts cookie on later requests', async () => {
  const s = await startLoungeServer({ root: await fixture(), port: 0, token: TOKEN });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/js/main.js`, {
      headers: { cookie: `maitre_key=${TOKEN}` },
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
    const { request } = await import('node:http');
    const probes = ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/js/..%2f..%2fsecret.txt'];
    for (const p of probes) {
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port: s.port, path: p, headers: { cookie: `maitre_key=${TOKEN}` } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        r.on('error', reject);
        r.end();
      });
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
