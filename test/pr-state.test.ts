import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roomDir } from '../src/paths.js';
import { patchPr, readPr, roomPr, writePr, type PrState } from '../src/pr-state.js';

function withHome(fn: (env: NodeJS.ProcessEnv) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'maitre-pr-'));
  try {
    fn({ MAITRE_HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const pr: PrState = {
  url: 'https://github.com/o/r/pull/7',
  number: 7,
  state: 'OPEN',
  headRefName: 'feat/x',
  seenAt: 100,
  failing: ['lint'],
  lastFeedbackAt: '2026-11-27T10:00:00Z',
  reviewDecision: 'APPROVED',
  notice: { kind: 'ci', text: 'lint failed', url: 'https://github.com/o/r/pull/7', since: 90 },
  dance: { until: 500 },
};

test('pr.json round-trips, 0600, no temp file left behind', () => {
  withHome((env) => {
    writePr('r1', pr, env);
    assert.deepEqual(readPr('r1', env), pr);
    const dir = roomDir('r1', env);
    assert.equal(statSync(join(dir, 'pr.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['pr.json']);
    writePr('r1', { ...pr, state: 'MERGED' }, env);
    assert.equal(readPr('r1', env)?.state, 'MERGED');
  });
});

test('readPr: missing, corrupt or malformed is undefined', () => {
  withHome((env) => {
    assert.equal(readPr('r1', env), undefined);
    const dir = roomDir('r1', env);
    mkdirSync(dir, { recursive: true });
    for (const body of ['{not json', '[]', 'null', '"x"', JSON.stringify({ ...pr, state: 'DRAFT' }), JSON.stringify({ ...pr, number: '7' }), JSON.stringify({ ...pr, failing: 'x' })]) {
      writeFileSync(join(dir, 'pr.json'), body);
      assert.equal(readPr('r1', env), undefined, body);
    }
  });
});

test('readPr: a bad optional field is dropped, the rest kept', () => {
  withHome((env) => {
    const dir = roomDir('r1', env);
    mkdirSync(dir, { recursive: true });
    const base = { url: pr.url, number: 7, state: 'OPEN', headRefName: 'feat/x', seenAt: 100, failing: ['lint'] };
    const cases: [Record<string, unknown>, PrState][] = [
      [{ ...base, notice: { ...pr.notice, kind: 'bell' } }, { ...base, state: 'OPEN' }],
      [{ ...base, notice: { ...pr.notice, text: 5 } }, { ...base, state: 'OPEN' }],
      [{ ...base, notice: { ...pr.notice, url: null } }, { ...base, state: 'OPEN' }],
      [{ ...base, notice: { ...pr.notice, since: '90' } }, { ...base, state: 'OPEN' }],
      [{ ...base, notice: 'x' }, { ...base, state: 'OPEN' }],
      [{ ...base, dance: { until: 'soon' } }, { ...base, state: 'OPEN' }],
      [{ ...base, dance: 5 }, { ...base, state: 'OPEN' }],
      [{ ...base, failing: ['lint', 3, null, 'test'] }, { ...base, state: 'OPEN', failing: ['lint', 'test'] }],
      [{ ...base, lastFeedbackAt: 12, reviewDecision: false }, { ...base, state: 'OPEN' }],
      [{ ...base, extra: 'dropped', notice: pr.notice, dance: pr.dance }, { ...base, state: 'OPEN', notice: pr.notice!, dance: pr.dance! }],
    ];
    for (const [body, want] of cases) {
      writeFileSync(join(dir, 'pr.json'), JSON.stringify(body));
      assert.deepEqual(readPr('r1', env), want, JSON.stringify(body));
    }
  });
});

test('patchPr applies over the file as it is now; no write when gone or declined', () => {
  withHome((env) => {
    assert.equal(patchPr('r1', (p) => p, env), undefined);
    assert.equal(readPr('r1', env), undefined);
    const { notice: _, ...plain } = pr;
    writePr('r1', plain, env);
    const stale = readPr('r1', env)!;
    writePr('r1', { ...stale, notice: pr.notice! }, env); // written meanwhile by someone else
    const out = patchPr('r1', (p) => ({ ...p, state: 'MERGED', dance: { until: 900 } }), env);
    assert.deepEqual(readPr('r1', env), { ...plain, state: 'MERGED', dance: { until: 900 }, notice: pr.notice });
    assert.deepEqual(out, readPr('r1', env));
    const before = readPr('r1', env);
    assert.equal(patchPr('r1', () => undefined, env), undefined);
    assert.deepEqual(readPr('r1', env), before);
  });
});

test("roomPr: only this opening's PR — another branch, or one last seen before the room opened, is none", () => {
  withHome((env) => {
    writePr('r1', pr, env);
    assert.deepEqual(roomPr({ room: 'r1', branch: 'feat/x', createdAt: 100 }, env), pr);
    assert.equal(roomPr({ room: 'r1', branch: 'feat/y', createdAt: 100 }, env), undefined);
    assert.equal(roomPr({ room: 'r1', branch: 'feat/x', createdAt: 101 }, env), undefined);
    assert.equal(roomPr({ room: 'r2', branch: 'feat/x', createdAt: 0 }, env), undefined);
  });
});
