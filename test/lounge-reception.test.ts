import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveRooms, liveRoutes } from '../src/live-api.js';
import {
  BusyError,
  ReceptionQueue,
  TimeoutError,
  displayEnv,
  receptionRoutes,
  terminalCommand,
  type ReceptionDeps,
  type TerminalCommand,
} from '../src/lounge-reception.js';
import { startLoungeServer, type LoungeServer } from '../src/lounge-server.js';
import { writeIndex, type Project } from '../src/projects.js';
import { closeRoom } from '../src/janitor.js';
import { openRoom } from '../src/room-open.js';
import { readRoom } from '../src/rooms.js';
import { claimLounge } from '../src/lounge-file.js';
import { QUEUE_HINT } from '../src/router.js';
import { herdrSandbox, type HerdrSandbox } from './herdr-sandbox.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FAKE_CLAUDE = join(ROOT, 'test', 'fixtures', 'fake-claude-router.mjs');
const TOKEN = 'b'.repeat(64);
const FAST = { trustTimeoutMs: 120_000, pollMs: 10 };
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const SCRATCH_ROUTE = { project: null, room: { kind: 'new', name: 'monads' }, taskType: 'simple', hasCode: false, confidence: 0.8 };
const CODE_ROUTE = { project: 'backend', room: { kind: 'new', name: 'NF Bug' }, taskType: 'build', hasCode: true, confidence: 0.9 };
const QUESTION_ROUTE = { ...SCRATCH_ROUTE, question: 'Which project: backend?' };

let sb: HerdrSandbox;
let claudeLog: string;
let server: LoungeServer | undefined;

beforeEach(() => {
  sb = herdrSandbox();
  claudeLog = join(sb.dir, 'claude.log');
  writeFileSync(join(sb.bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(join(sb.bin, 'claude'), 0o755);
  Object.assign(process.env, { FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_EXIT: '0', FAKE_CLAUDE_SLEEP_MS: '0' });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  sb.restore();
});

const envelope = (inner: unknown) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(inner) });
const routerSays = (route: unknown) => (process.env.FAKE_CLAUDE_STDOUT = envelope(route));
const claudeCalls = () => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').trim().split('\n').filter((l) => l !== '').length : 0);
const requestsDir = () => join(sb.home, 'reception', 'requests');
const requestFiles = () => (existsSync(requestsDir()) ? readdirSync(requestsDir()).sort() : []);
const routesDir = () => join(sb.home, 'reception', 'routes');
const herdrCalls = (a: string, b: string) => sb.calls().filter((c) => c[0] === a && c[1] === b);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function realProject(): Project {
  const remote = join(sb.dir, 'remote.git');
  const clone = join(sb.dir, 'clone');
  git(sb.dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(sb.dir, 'clone', '-q', remote, clone);
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(clone, 'push', '-q', 'origin', 'main');
  const p: Project = { name: 'backend', path: clone, base: 'main', branchPrefix: 'maitre/' };
  writeIndex([p]);
  return p;
}

// A fake on PATH that logs its argv and prints $FAKE_<NAME>_OUT.
function fakeBin(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${name}.log`);
  const v = `FAKE_${name.toUpperCase().replace(/-/g, '_')}_OUT`;
  writeFileSync(join(dir, name), `#!/bin/sh\necho "$@" >> '${log}'\nprintf '%s' "$${v}"\n`);
  chmodSync(join(dir, name), 0o755);
  return log;
}

interface Spawned {
  c: TerminalCommand;
  env: NodeJS.ProcessEnv;
}

async function start(
  opts: { env?: NodeJS.ProcessEnv; queue?: ReceptionQueue; deps?: ReceptionDeps; spawned?: Spawned[]; reception?: boolean } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const spawned = opts.spawned ?? [];
  const reception =
    opts.reception === false
      ? undefined
      : receptionRoutes({
          queue: opts.queue ?? new ReceptionQueue(),
          env,
          spawnTerminal: (c, e) => void spawned.push({ c, env: e }),
          ...(opts.deps ? { deps: opts.deps } : {}),
        });
  const root = join(sb.dir, 'www');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  server = await startLoungeServer({ root, port: 0, token: TOKEN, routes: liveRoutes(new LiveRooms(env), { reception }) });
  return server.port;
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json?: any;
}

function call(
  port: number,
  path: string,
  opts: { method?: string; body?: string | Buffer; headers?: Record<string, string>; auth?: 'header' | 'cookie' } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if ((opts.auth ?? 'header') === 'header') headers['x-maitre-token'] = TOKEN;
  else headers.cookie = `maitre_key_${port}=${TOKEN}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  Object.assign(headers, opts.headers ?? {});
  return new Promise((resolve, reject) => {
    // No keep-alive: a pooled socket to a port a closed test server used can be reset by the next one.
    const r = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

const post = (port: number, payload: unknown, extra: Parameters<typeof call>[2] = {}) =>
  call(port, '/api/reception', { body: typeof payload === 'string' ? payload : JSON.stringify(payload), ...extra });

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// --- ReceptionQueue

test('ReceptionQueue runs one job at a time, lets 3 wait and refuses the next with BusyError', async () => {
  const q = new ReceptionQueue({ timeoutMs: 10_000 });
  const g = gate();
  const order: string[] = [];
  const job = (name: string) => async () => {
    order.push(`start ${name}`);
    await g.wait;
    order.push(`end ${name}`);
    return name;
  };
  const runs = ['a', 'b', 'c', 'd'].map((n) => q.run(job(n)));
  await assert.rejects(q.run(job('e')), BusyError);
  await tick();
  assert.deepEqual(order, ['start a']);
  g.open();
  assert.deepEqual(await Promise.all(runs), ['a', 'b', 'c', 'd']);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c', 'start d', 'end d']);
  assert.equal(await q.run(async () => 'later'), 'later');
});

test('ReceptionQueue: a job that fails rejects its caller and frees the slot', async () => {
  const q = new ReceptionQueue({ timeoutMs: 10_000 });
  await assert.rejects(q.run(async () => Promise.reject(new Error('boom'))), /boom/);
  await assert.rejects(q.run(() => { throw new Error('sync boom'); }), /sync boom/);
  assert.equal(await q.run(async () => 1), 1);
});

test('ReceptionQueue: a timed-out job rejects with TimeoutError but keeps the slot until it settles', async () => {
  const q = new ReceptionQueue({ timeoutMs: 50 });
  const g = gate();
  const order: string[] = [];
  const a = q.run(async () => {
    order.push('start a');
    await g.wait;
    order.push('end a');
    throw new Error('late failure');
  });
  await assert.rejects(a, TimeoutError);
  const b = q.run(async () => {
    order.push('start b');
    return 'b';
  });
  await tick(30);
  assert.deepEqual(order, ['start a']);
  g.open();
  assert.equal(await b, 'b');
  assert.deepEqual(order, ['start a', 'end a', 'start b']);
});

test('ReceptionQueue: a waiting job whose ceiling passes is dropped, never run, and frees its waiting place', async () => {
  const q = new ReceptionQueue({ timeoutMs: 100 });
  const g = gate();
  const ran: string[] = [];
  const a = q.run(async () => {
    ran.push('a');
    await g.wait;
  });
  const b = q.run(async () => void ran.push('b'));
  await assert.rejects(a, TimeoutError);
  await assert.rejects(b, TimeoutError);
  const later = ['c', 'd', 'e'].map((n) => q.run(async () => void ran.push(n)));
  g.open();
  for (const r of await Promise.allSettled(later)) assert.equal(r.status, 'fulfilled');
  assert.deepEqual(ran, ['a', 'c', 'd', 'e']);
});

// --- /api/reception

test('reception: a request is stored verbatim, routed and dispatched to a new scratch room', async () => {
  writeIndex([]);
  routerSays(SCRATCH_ROUTE);
  const port = await start();
  const res = await post(port, { text: 'what is a monad?\n' });
  assert.equal(res.status, 200, res.body);
  assert.match(String(res.headers['content-type']), /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json, { kind: 'dispatched', id: '1', room: 'monads', lines: ['opened monads in scratch on haiku'], needsYou: false });
  assert.deepEqual(requestFiles(), ['1.md']);
  assert.equal(readFileSync(join(requestsDir(), '1.md'), 'utf8'), 'what is a monad?\n');
  assert.equal(readRoom('monads')?.kind, 'scratch');
  assert.equal(herdrCalls('workspace', 'create').length, 1);
});

test('reception: past capacity the new room is queued; with the lounge live there is no hint', async () => {
  writeIndex([]);
  writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ roots: [], projects: {}, capacity: 1 }));
  await openRoom({ name: 'busy', model: 'sonnet', taskType: 'change', brief: 'x' }, process.env, FAST);
  routerSays(SCRATCH_ROUTE);
  const port = await start();
  const res = await post(port, { text: 'what is a monad?' });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(res.json, {
    kind: 'dispatched',
    id: '1',
    room: 'monads',
    lines: ['queued: monads waits for a seat (position 1)', QUEUE_HINT],
    needsYou: false,
    queued: true,
  });
  claimLounge(port);
  const again = await post(port, { text: 'and functors?' });
  assert.deepEqual(again.json, { kind: 'dispatched', id: '2', room: 'monads', lines: ['queued: monads waits for a seat (position 1)'], needsYou: false, queued: true });
  assert.equal(herdrCalls('workspace', 'create').length, 1);
  assert.equal(readRoom('monads'), undefined);
});

test('reception: a router question comes back with the id, and the reply with answers routes both ids', async () => {
  writeIndex([]);
  routerSays(QUESTION_ROUTE);
  const port = await start();
  const q = await post(port, { text: 'fix the login' });
  assert.equal(q.status, 200, q.body);
  assert.deepEqual(q.json, { kind: 'question', id: '1', text: 'Which project: backend?' });
  assert.equal(herdrCalls('workspace', 'create').length, 0);

  routerSays(SCRATCH_ROUTE);
  const d = await post(port, { text: 'none, just explain it', answers: '1' });
  assert.equal(d.status, 200, d.body);
  assert.equal(d.json.kind, 'dispatched');
  assert.equal(d.json.id, '2');
  const stored = JSON.parse(readFileSync(join(routesDir(), '2.json'), 'utf8'));
  assert.deepEqual(stored.requestIds, ['1', '2']);
  assert.match(readFileSync(join(sb.home, 'state', 'rooms', 'monads', 'brief.md'), 'utf8'), /fix the login\n---\nnone, just explain it$/);
});

test('reception: a second router question keeps the whole conversation in the route', async () => {
  writeIndex([]);
  routerSays(QUESTION_ROUTE);
  const port = await start();
  assert.deepEqual((await post(port, { text: 'fix the login' })).json, { kind: 'question', id: '1', text: 'Which project: backend?' });
  const second = await post(port, { text: 'the web one', answers: '1' });
  assert.deepEqual(second.json, { kind: 'question', id: '2', text: 'Which project: backend?' });
  assert.deepEqual(JSON.parse(readFileSync(join(routesDir(), '2.json'), 'utf8')).requestIds, ['1', '2']);
  routerSays(SCRATCH_ROUTE);
  const done = await post(port, { text: 'no project, just explain', answers: '2' });
  assert.equal(done.status, 200, done.body);
  assert.equal(done.json.kind, 'dispatched');
  assert.equal(done.json.id, '3');
  assert.deepEqual(JSON.parse(readFileSync(join(routesDir(), '3.json'), 'utf8')).requestIds, ['1', '2', '3']);
  assert.match(readFileSync(join(sb.home, 'state', 'rooms', 'monads', 'brief.md'), 'utf8'), /fix the login\n---\nthe web one\n---\nno project, just explain$/);
});

test('reception: an answer to a request with no usable stored route falls back to [answers, new]', async () => {
  writeIndex([]);
  mkdirSync(requestsDir(), { recursive: true });
  writeFileSync(join(requestsDir(), '5.md'), 'typed in the terminal');
  mkdirSync(routesDir(), { recursive: true });
  writeFileSync(join(routesDir(), '5.json'), JSON.stringify({ route: {}, requestIds: ['../x', '5'] }));
  routerSays(QUESTION_ROUTE);
  const port = await start();
  const res = await post(port, { text: 'more', answers: '5' });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(readFileSync(join(routesDir(), `${res.json.id}.json`), 'utf8')).requestIds, ['5', res.json.id]);
});

test('reception: hostile or odd text is stored byte for byte and never reaches a shell', async () => {
  writeIndex([]);
  routerSays(QUESTION_ROUTE);
  const port = await start();
  const texts = ['$(rm -rf ~/.maitre-test-canary)', '`id` && echo pwned; x=\'y\'', 'line one\nline two\r\n\tindented', '--model opus', '  padded  '];
  for (const [i, text] of texts.entries()) {
    const res = await post(port, { text });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.id, String(i + 1));
    assert.equal(readFileSync(join(requestsDir(), `${i + 1}.md`), 'utf8'), text);
  }
});

test('reception: invalid input is refused with 400 (or 413 when too big) before anything is stored', async () => {
  writeIndex([]);
  routerSays(SCRATCH_ROUTE);
  const port = await start();
  const cases: [string, Parameters<typeof call>[2], number, RegExp][] = [
    ['whitespace only', { body: JSON.stringify({ text: ' \n\t ' }) }, 400, /empty/],
    ['not JSON', { body: 'text=hello' }, 400, /JSON/],
    ['a JSON array', { body: '["hello"]' }, 400, /text/],
    ['text a number', { body: JSON.stringify({ text: 42 }) }, 400, /text/],
    ['no text', { body: JSON.stringify({}) }, 400, /text/],
    ['NUL in text', { body: JSON.stringify({ text: 'a\u0000b' }) }, 400, /NUL/],
    ['answers not an id', { body: JSON.stringify({ text: 'x', answers: '../1' }) }, 400, /^invalid request id "\.\.\/1"$/],
    ['answers a number', { body: JSON.stringify({ text: 'x', answers: 1 }) }, 400, /^invalid request id 1$/],
    ['answers unknown', { body: JSON.stringify({ text: 'x', answers: '99' }) }, 400, /^request 99 not found$/],
    ['form body', { body: 'text=hello', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 400, /JSON/],
    ['text/plain body', { body: JSON.stringify({ text: 'hello' }), headers: { 'content-type': 'text/plain' } }, 400, /JSON/],
    ['16 KiB + 1', { body: JSON.stringify({ text: 'x'.repeat(16 * 1024 - 11 + 1) }) }, 413, /too long|16 KiB/],
  ];
  for (const [name, opts, status, message] of cases) {
    const res = await call(port, '/api/reception', opts);
    assert.equal(res.status, status, `${name}: ${res.body}`);
    assert.equal(res.json?.kind, 'error', name);
    assert.match(res.json?.message ?? '', message, name);
    assert.deepEqual(requestFiles(), [], name);
  }
  assert.equal(claudeCalls(), 0);
  assert.equal(existsSync(routesDir()), false);
});

test('reception: a body of exactly 16 KiB is accepted', async () => {
  writeIndex([]);
  routerSays(QUESTION_ROUTE);
  const port = await start();
  const body = JSON.stringify({ text: 'x'.repeat(16 * 1024 - 11) });
  assert.equal(Buffer.byteLength(body), 16 * 1024);
  const res = await call(port, '/api/reception', { body });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(requestFiles(), ['1.md']);
});

test('reception: router and dispatch failures answer 500 with the CLI wording', async () => {
  writeIndex([]);
  process.env.FAKE_CLAUDE_STDOUT = 'garbage';
  const port = await start();
  const res = await post(port, { text: 'do it' });
  assert.equal(res.status, 500);
  assert.equal(res.json.kind, 'error');
  assert.match(res.json.message, /^the router returned an unusable answer: /);
  assert.deepEqual(requestFiles(), ['1.md']);
});

test('reception: a new worktree room blocked on the trust question answers needsYou with the trust line', async () => {
  realProject();
  routerSays(CODE_ROUTE);
  process.env.FAKE_HERDR_ON_RUN = 'trust';
  const port = await start();
  const res = await post(port, { text: 'fix the NF bug' });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(res.json, {
    kind: 'dispatched',
    id: '1',
    room: 'nf-bug',
    lines: ['opened nf-bug in backend on opus — answer the folder-trust question in its tab'],
    needsYou: true,
  });
  assert.equal(herdrCalls('agent', 'send-keys').length, 0);
});

test('reception: reopening a worktree warns, and the warning alone sets needsYou', async () => {
  realProject();
  routerSays(CODE_ROUTE);
  const port = await start();
  const first = await post(port, { text: 'fix the NF bug' });
  assert.equal(first.json.needsYou, false, first.body);
  await closeRoom('nf-bug');
  const again = await post(port, { text: 'fix it again' });
  assert.equal(again.status, 200, again.body);
  assert.deepEqual(again.json.lines, ['opened nf-bug in backend on opus', 'warning: reopened existing worktree on maitre/nf-bug']);
  assert.equal(again.json.needsYou, true);
});

test('reception: an injected dispatch reply is passed through', async () => {
  writeIndex([]);
  const port = await start({
    deps: {
      route: async (ids) => ({ id: ids[ids.length - 1], route: { project: null, room: { kind: 'new', name: 'x' }, taskType: 'simple', model: 'haiku', hasCode: false, confidence: 1 } }),
      dispatch: async () => ({ room: 'x', lines: ['opened x in scratch on haiku', 'warning: something'], needsYou: true }),
    },
  });
  const res = await post(port, { text: 'go' });
  assert.equal(res.json.needsYou, true);
  assert.deepEqual(res.json.lines, ['opened x in scratch on haiku', 'warning: something']);
});

test('reception: with one running and 3 waiting, the next request gets 429 and is not stored', async () => {
  writeIndex([]);
  const g = gate();
  let routed = 0;
  const deps: ReceptionDeps = {
    route: async (ids) => {
      routed++;
      await g.wait;
      return { id: ids[ids.length - 1], route: { ...SCRATCH_ROUTE, model: 'haiku', question: 'which?' } as any };
    },
  };
  const queue = new ReceptionQueue({ timeoutMs: 10_000 });
  const port = await start({ deps, queue });
  const first = post(port, { text: 'r1' });
  for (let i = 0; routed === 0 && i < 400; i++) await tick(5);
  assert.equal(routed, 1);
  const waiting = [post(port, { text: 'r2' }), post(port, { text: 'r3' }), post(port, { text: 'r4' })];
  for (let i = 0; queue.waitingCount < 3 && i < 400; i++) await tick(5);
  assert.equal(queue.waitingCount, 3);
  const busy = await post(port, { text: 'r5' });
  assert.equal(busy.status, 429);
  assert.deepEqual(busy.json, { kind: 'error', message: 'the maître is busy, try again' });
  g.open();
  const done = await Promise.all([first, ...waiting]);
  assert.deepEqual(done.map((r) => r.status), [200, 200, 200, 200]);
  assert.deepEqual(requestFiles(), ['1.md', '2.md', '3.md', '4.md']);
});

test('reception: past the ceiling the caller gets 504, and the next request runs only after the slow one ends', async () => {
  writeIndex([]);
  const g = gate();
  const order: string[] = [];
  const deps: ReceptionDeps = {
    route: async (ids) => {
      const id = ids[ids.length - 1];
      order.push(`start ${id}`);
      if (id === '1') await g.wait;
      order.push(`end ${id}`);
      return { id, route: { ...SCRATCH_ROUTE, model: 'haiku', question: 'which?' } as any };
    },
  };
  const port = await start({ deps, queue: new ReceptionQueue({ timeoutMs: 300 }) });
  const slow = await post(port, { text: 'slow' });
  assert.equal(slow.status, 504);
  assert.equal(slow.json.kind, 'error');
  const next = post(port, { text: 'next' });
  await tick(50);
  assert.deepEqual(order, ['start 1']);
  g.open();
  // The next request's own ceiling runs while it waits, so it is released well inside it.
  const res = await next;
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('reception and terminal act on POST only: GET and HEAD get 405 with allow: POST and do nothing', async () => {
  writeIndex([]);
  routerSays(SCRATCH_ROUTE);
  const port = await start();
  for (const path of ['/api/reception', '/api/rooms/x/terminal']) {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const res = await call(port, path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.allow, 'POST', `${method} ${path}`);
    }
  }
  assert.deepEqual(requestFiles(), []);
  assert.equal(claudeCalls(), 0);
});

test('reception: a cookie POST without the same Origin or x-maitre-request is refused, nothing stored or routed', async () => {
  writeIndex([]);
  routerSays(SCRATCH_ROUTE);
  const port = await start();
  const self = `http://127.0.0.1:${port}`;
  const body = JSON.stringify({ text: 'hello' });
  const cases: Record<string, string>[] = [
    { 'x-maitre-request': '1' },
    { origin: 'http://evil.example', 'x-maitre-request': '1' },
    { origin: self },
    { origin: self, 'x-maitre-request': '0' },
    { 'content-type': 'text/plain' },
  ];
  for (const headers of cases) {
    const res = await call(port, '/api/reception', { auth: 'cookie', body, headers });
    assert.equal(res.status, 403, JSON.stringify(headers));
  }
  assert.deepEqual(requestFiles(), []);
  assert.equal(existsSync(routesDir()), false);
  assert.equal(claudeCalls(), 0);
  const ok = await call(port, '/api/reception', { auth: 'cookie', body, headers: { origin: self, 'x-maitre-request': '1' } });
  assert.equal(ok.status, 200, ok.body);
});

test('a lounge without the reception routes (demo) never answers them', async () => {
  writeIndex([]);
  routerSays(SCRATCH_ROUTE);
  const port = await start({ reception: false });
  assert.equal((await post(port, { text: 'hello' })).status, 403);
  assert.equal((await call(port, '/api/rooms/x/terminal')).status, 403);
  assert.deepEqual(requestFiles(), []);
});

// --- terminal

function displayless(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  delete env.XAUTHORITY;
  return env;
}

test('terminal: an unknown, invalid or stopped room is refused before anything is focused or spawned', async () => {
  const spawned: Spawned[] = [];
  const port = await start({ env: { ...process.env, DISPLAY: ':0' }, spawned });
  const unknown = await call(port, '/api/rooms/ghost/terminal');
  assert.equal(unknown.status, 409);
  assert.deepEqual(unknown.json, { kind: 'error', message: 'ghost is not running' });
  for (const bad of ['a%2Fb', 'a/b', 'Bad', 'a%00b', '%zz', 'a_b']) {
    const res = await call(port, `/api/rooms/${bad}/terminal`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.json?.kind, 'error', bad);
  }
  // The URL parser folds dot segments, so these never name a room.
  for (const dots of ['..', '%2e%2e']) assert.notEqual((await call(port, `/api/rooms/${dots}/terminal`)).status, 200, dots);
  await openRoom({ name: 'gone', model: 'sonnet', taskType: 'simple', brief: 'x' }, process.env, FAST);
  const st = sb.state();
  st.workspaces = {};
  st.panes = {};
  sb.setState(st);
  const stopped = await call(port, '/api/rooms/gone/terminal');
  assert.equal(stopped.status, 409);
  assert.deepEqual(stopped.json, { kind: 'error', message: 'gone is not running' });
  await openRoom({ name: 'down', model: 'sonnet', taskType: 'simple', brief: 'x' }, process.env, FAST);
  process.env.FAKE_HERDR_FAIL_workspace_list = 'server_not_running';
  const down = await call(port, '/api/rooms/down/terminal');
  delete process.env.FAKE_HERDR_FAIL_workspace_list;
  assert.equal(down.status, 409);
  assert.deepEqual(down.json, { kind: 'error', message: 'down is not running' });
  assert.deepEqual(spawned, []);
  assert.deepEqual(herdrCalls('workspace', 'focus'), []);
});

test('terminal: a running room gets its workspace focused and a terminal attached to the session', async () => {
  const term = join(sb.dir, 'term');
  fakeBin(term, 'x-terminal-emulator');
  const rec = await openRoom({ name: 'work', model: 'sonnet', taskType: 'simple', brief: 'x' }, process.env, FAST);
  const spawned: Spawned[] = [];
  const env = { ...process.env, DISPLAY: ':0', PATH: `${term}${delimiter}${process.env.PATH}`, CLAUDECODE: '1' };
  const port = await start({ env, spawned });
  const res = await call(port, '/api/rooms/work/terminal');
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(res.json, { kind: 'ok' });
  assert.deepEqual(herdrCalls('workspace', 'focus'), [['workspace', 'focus', rec.herdr!.workspaceId]]);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].c.cmd, join(term, 'x-terminal-emulator'));
  assert.deepEqual(spawned[0].c.args, ['-e', join(sb.bin, 'herdr'), '--session', 'maitre-test']);
  assert.equal(spawned[0].env.DISPLAY, ':0');
  assert.equal(spawned[0].env.CLAUDECODE, undefined);
});

test('terminal: a room blocked on the trust question can be opened', async () => {
  realProject();
  process.env.FAKE_HERDR_ON_RUN = 'trust';
  const term = join(sb.dir, 'term');
  fakeBin(term, 'gnome-terminal');
  const rec = await openRoom({ name: 'nf-bug', project: 'backend', model: 'opus', taskType: 'build', brief: 'x' }, process.env, FAST);
  assert.equal(rec.needsTrust, true);
  const spawned: Spawned[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, WAYLAND_DISPLAY: 'wayland-0', PATH: [term, sb.bin].join(delimiter) };
  delete env.DISPLAY;
  const port = await start({ env, spawned });
  const res = await call(port, '/api/rooms/nf-bug/terminal');
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(spawned[0].c.args, ['--', join(sb.bin, 'herdr'), '--session', 'maitre-test']);
});

test('terminal: with no display in the env or the user manager, 503 and nothing is focused or spawned', async () => {
  await openRoom({ name: 'work', model: 'sonnet', taskType: 'simple', brief: 'x' }, process.env, FAST);
  const term = join(sb.dir, 'term');
  fakeBin(term, 'x-terminal-emulator');
  const systemctlLog = fakeBin(sb.bin, 'systemctl');
  const spawned: Spawned[] = [];
  const env = { ...displayless(), PATH: `${term}${delimiter}${process.env.PATH}`, FAKE_SYSTEMCTL_OUT: 'HOME=/home/x\nLANG=C.UTF-8\nPATH=/usr/bin\n' };
  const port = await start({ env, spawned });
  const res = await call(port, '/api/rooms/work/terminal');
  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { kind: 'error', message: 'no display; run maitre in a terminal' });
  assert.equal(readFileSync(systemctlLog, 'utf8'), '--user show-environment\n');
  assert.deepEqual(spawned, []);
  assert.deepEqual(herdrCalls('workspace', 'focus'), []);
});

test('terminal: display variables missing from the service env come from systemctl --user show-environment', async () => {
  await openRoom({ name: 'work', model: 'sonnet', taskType: 'simple', brief: 'x' }, process.env, FAST);
  const term = join(sb.dir, 'term');
  fakeBin(term, 'x-terminal-emulator');
  const systemctlLog = fakeBin(sb.bin, 'systemctl');
  const spawned: Spawned[] = [];
  const out = 'DISPLAY=:1\nXAUTHORITY=/run/user/1000/gdm/Xauthority\nPATH=/elsewhere\nODD=$\'a\\nb\'\n';
  const env = { ...displayless(), PATH: `${term}${delimiter}${process.env.PATH}`, FAKE_SYSTEMCTL_OUT: out };
  const port = await start({ env, spawned });
  const res = await call(port, '/api/rooms/work/terminal');
  assert.equal(res.status, 200, res.body);
  assert.equal(readFileSync(systemctlLog, 'utf8'), '--user show-environment\n');
  assert.equal(spawned[0].env.DISPLAY, ':1');
  assert.equal(spawned[0].env.XAUTHORITY, '/run/user/1000/gdm/Xauthority');
  assert.equal(spawned[0].env.PATH, env.PATH);
  assert.equal(spawned[0].env.ODD, undefined);
});

test('terminal: no terminal emulator on PATH answers 503 and spawns nothing', async () => {
  await openRoom({ name: 'work', model: 'sonnet', taskType: 'simple', brief: 'x' }, process.env, FAST);
  const spawned: Spawned[] = [];
  const port = await start({ env: { ...process.env, DISPLAY: ':0', PATH: [sb.bin, '/nonexistent'].join(delimiter) }, spawned });
  const res = await call(port, '/api/rooms/work/terminal');
  assert.equal(res.status, 503);
  assert.match(res.json.message, /terminal/);
  assert.deepEqual(spawned, []);
});

test('terminalCommand prefers x-terminal-emulator, falls back to gnome-terminal, else undefined; absolute PATH entries only', () => {
  const a = join(sb.dir, 'a');
  const b = join(sb.dir, 'b');
  fakeBin(a, 'x-terminal-emulator');
  fakeBin(b, 'gnome-terminal');
  fakeBin(b, 'herdr');
  const env = (path: string[]) => ({ PATH: path.join(delimiter), MAITRE_HERDR_SESSION: 's1' });
  assert.deepEqual(terminalCommand(env([a, b])), { cmd: join(a, 'x-terminal-emulator'), args: ['-e', join(b, 'herdr'), '--session', 's1'] });
  assert.deepEqual(terminalCommand(env([b])), { cmd: join(b, 'gnome-terminal'), args: ['--', join(b, 'herdr'), '--session', 's1'] });
  assert.equal(terminalCommand(env(['/nonexistent'])), undefined);
  assert.equal(terminalCommand({ PATH: '' }), undefined);
  const cwd = process.cwd();
  try {
    process.chdir(b);
    assert.equal(terminalCommand(env(['.', ''])), undefined);
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(terminalCommand({ PATH: a })?.args, ['-e', 'herdr', '--session', 'maitre']);
});

test('displayEnv keeps an env that has a display and asks the user manager only when it has none', async () => {
  const log = fakeBin(sb.bin, 'systemctl');
  const own = { PATH: sb.bin, DISPLAY: ':5', FAKE_SYSTEMCTL_OUT: 'DISPLAY=:1\n' };
  assert.equal((await displayEnv(own))?.DISPLAY, ':5');
  assert.equal(existsSync(log), false);
  assert.equal((await displayEnv({ PATH: sb.bin, FAKE_SYSTEMCTL_OUT: 'WAYLAND_DISPLAY=wayland-0\n' }))?.WAYLAND_DISPLAY, 'wayland-0');
  assert.equal(await displayEnv({ PATH: sb.bin, FAKE_SYSTEMCTL_OUT: 'DISPLAY=\n' }), undefined);
  assert.equal(await displayEnv({ PATH: join(sb.dir, 'nothing-here') }), undefined);
});
