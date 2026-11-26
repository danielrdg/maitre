import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimLounge,
  liveLounge,
  loungeFile,
  loungeToken,
  probeLounge,
  readLoungeInfo,
  releaseLounge,
  type LoungeInfo,
} from '../src/lounge-file.js';

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function home(): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), 'maitre-lounge-file-'));
  made.push(d);
  return { MAITRE_HOME: d };
}

const TOKEN = 'ab'.repeat(32);
// The probe first checks that the recorded pid is a live process of ours.
const PID = process.pid;

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

async function fakeServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; seen: IncomingMessage[]; close(): Promise<void> }> {
  const seen: IncomingMessage[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

function assertNoToken(seen: IncomingMessage[]): void {
  assert.ok(seen.length > 0, 'the probe reached the server');
  for (const req of seen) {
    assert.ok(!(req.url ?? '').includes(TOKEN), `token in ${req.url}`);
    for (const v of Object.values(req.headers)) assert.ok(!String(v).includes(TOKEN), 'token in a header');
  }
}

test('loungeToken persists one token in a 0600 file and returns it again', () => {
  const env = home();
  const first = loungeToken(env);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(loungeToken(env), first);
  assert.equal(statSync(loungeFile(env)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(loungeFile(env), 'utf8')), { port: 0, token: first, pid: process.pid });
  assert.equal(loungeFile(env), join(env.MAITRE_HOME!, 'lounge.json'));
});

test('readLoungeInfo is undefined for a missing, corrupt or malformed file', () => {
  const env = home();
  assert.equal(readLoungeInfo(env), undefined);
  writeFileSync(loungeFile(env), '{ not json');
  assert.equal(readLoungeInfo(env), undefined);
  for (const bad of [
    { port: 8737, token: 'short', pid: 1 },
    { port: -1, token: TOKEN, pid: 1 },
    { port: 8737, token: TOKEN, pid: -1 },
    { port: '8737', token: TOKEN, pid: 1 },
    [8737, TOKEN, 1],
  ]) {
    writeFileSync(loungeFile(env), JSON.stringify(bad));
    assert.equal(readLoungeInfo(env), undefined, JSON.stringify(bad));
  }
  writeFileSync(loungeFile(env), JSON.stringify({ port: 8737, token: TOKEN, pid: 42 }));
  assert.deepEqual(readLoungeInfo(env), { port: 8737, token: TOKEN, pid: 42 });
});

test('loungeToken replaces a corrupt file with a new token', () => {
  const env = home();
  writeFileSync(loungeFile(env), '{ not json');
  const t = loungeToken(env);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(readLoungeInfo(env)?.token, t);
});

test('claimLounge keeps the token, records the port and our pid; releaseLounge keeps the token with pid 0', async () => {
  const env = home();
  writeFileSync(loungeFile(env), JSON.stringify({ port: 9999, token: TOKEN, pid: deadPid() }));
  claimLounge(8740, env);
  assert.deepEqual(readLoungeInfo(env), { port: 8740, token: TOKEN, pid: process.pid });
  assert.equal(statSync(loungeFile(env)).mode & 0o777, 0o600);
  releaseLounge(env);
  assert.deepEqual(readLoungeInfo(env), { port: 8740, token: TOKEN, pid: 0 });
  assert.equal(statSync(loungeFile(env)).mode & 0o777, 0o600);
  assert.equal(await liveLounge(env), undefined);
  assert.equal(loungeToken(env), TOKEN);
  releaseLounge(env);
  assert.deepEqual(readLoungeInfo(env), { port: 8740, token: TOKEN, pid: 0 });
});

test('releaseLounge keeps a file whose pid is not ours', () => {
  const env = home();
  const other = { port: 8737, token: TOKEN, pid: process.pid + 1 };
  writeFileSync(loungeFile(env), JSON.stringify(other));
  releaseLounge(env);
  assert.deepEqual(readLoungeInfo(env), other);
});

test('probeLounge is true for a maitre ping with the recorded pid', async () => {
  const s = await fakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'maitre', pid: PID }));
  });
  try {
    assert.equal(await probeLounge({ port: s.port, token: TOKEN, pid: PID }), true);
    assert.equal(s.seen[0]?.url, '/api/ping');
    assert.equal(s.seen[0]?.headers.host, `127.0.0.1:${s.port}`);
    assertNoToken(s.seen);
  } finally {
    await s.close();
  }
});

test('probeLounge is false for a server answering 403, and sends no token', async () => {
  const s = await fakeServer((_req, res) => {
    res.writeHead(403);
    res.end(JSON.stringify({ app: 'maitre', pid: PID }));
  });
  try {
    assert.equal(await probeLounge({ port: s.port, token: TOKEN, pid: PID }), false);
    assertNoToken(s.seen);
  } finally {
    await s.close();
  }
});

test('probeLounge is false for a maitre ping with another pid', async () => {
  const s = await fakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'maitre', pid: PID + 1 }));
  });
  try {
    assert.equal(await probeLounge({ port: s.port, token: TOKEN, pid: PID }), false);
    assertNoToken(s.seen);
  } finally {
    await s.close();
  }
});

test('probeLounge is false for a non-JSON or foreign answer', async () => {
  for (const body of ['<html>hi</html>', JSON.stringify({ app: 'other', pid: PID }), 'null']) {
    const s = await fakeServer((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    try {
      assert.equal(await probeLounge({ port: s.port, token: TOKEN, pid: PID }), false, body);
    } finally {
      await s.close();
    }
  }
});

test('probeLounge is false for a slow server', async () => {
  const s = await fakeServer((_req, res) => {
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'maitre', pid: PID }));
    }, 1000);
  });
  try {
    const t0 = Date.now();
    assert.equal(await probeLounge({ port: s.port, token: TOKEN, pid: PID }, 150), false);
    assert.ok(Date.now() - t0 < 900, 'the probe gave up at its timeout');
    assertNoToken(s.seen);
  } finally {
    await s.close();
  }
});

test('probeLounge is false for a slow body after fast headers', async () => {
  const s = await fakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"app":"maitre",');
    setTimeout(() => {
      if (!res.destroyed) res.end(`"pid":${PID}}`);
    }, 1000);
  });
  try {
    assert.equal(await probeLounge({ port: s.port, token: TOKEN, pid: PID }, 150), false);
  } finally {
    await s.close();
  }
});

test('probeLounge is false for a closed port and for port 0', async () => {
  const s = await fakeServer(() => {});
  const port = s.port;
  await s.close();
  assert.equal(await probeLounge({ port, token: TOKEN, pid: PID }), false);
  assert.equal(await probeLounge({ port: 0, token: TOKEN, pid: PID }), false);
});

test('probeLounge is false for a released file (pid 0) without contacting the port', async () => {
  const s = await fakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'maitre', pid: 0 }));
  });
  try {
    assert.equal(await probeLounge({ port: s.port, token: TOKEN, pid: 0 }), false);
    assert.equal(s.seen.length, 0);
  } finally {
    await s.close();
  }
});

test('probeLounge never contacts the port of a dead pid or of another user\'s process', async () => {
  const s = await fakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'maitre', pid: 1 }));
  });
  try {
    const dead = deadPid();
    assert.equal(await probeLounge({ port: s.port, token: TOKEN, pid: dead }), false);
    if (process.getuid?.() !== 0) assert.equal(await probeLounge({ port: s.port, token: TOKEN, pid: 1 }), false, 'EPERM: not ours');
    assert.equal(s.seen.length, 0);
  } finally {
    await s.close();
  }
});

test('liveLounge returns the file only when its lounge answers the ping', async () => {
  const env = home();
  assert.equal(await liveLounge(env), undefined);
  const s = await fakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'maitre', pid: PID }));
  });
  try {
    const info: LoungeInfo = { port: s.port, token: TOKEN, pid: PID };
    writeFileSync(loungeFile(env), JSON.stringify(info));
    assert.deepEqual(await liveLounge(env), info);
    writeFileSync(loungeFile(env), JSON.stringify({ ...info, pid: process.ppid }));
    assert.equal(await liveLounge(env), undefined);
    assertNoToken(s.seen);
  } finally {
    await s.close();
  }
});
