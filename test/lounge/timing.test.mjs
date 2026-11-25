import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DingScheduler, clampDt } from '../../lounge/js/timing.js';

test('ding rings at most once per interval and only while someone is blocked', () => {
  const d = new DingScheduler();
  assert.equal(d.shouldRing(0, 1), true);
  assert.equal(d.shouldRing(5, 1), false);
  // tab hidden for 300 s: no frames, then the first frame back
  assert.equal(d.shouldRing(305, 1), true);
  assert.equal(d.shouldRing(305.1, 1), false);
  assert.equal(d.shouldRing(400, 0), false);
});

test('a forced ring restarts the interval', () => {
  const d = new DingScheduler(22);
  d.markRung(10);
  assert.equal(d.shouldRing(20, 1), false);
  assert.equal(d.shouldRing(32, 1), true);
});

test('clampDt caps long frames at 50 ms and rejects garbage', () => {
  assert.equal(clampDt(3), 0.05);
  assert.equal(clampDt(0.016), 0.016);
  assert.equal(clampDt(-1), 0);
  assert.equal(clampDt(NaN), 0);
});
