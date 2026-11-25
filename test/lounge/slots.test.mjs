import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlot, startSpin, stepSlot } from '../../lounge/js/slots.js';

const run = (s, from, to, step = 1 / 60) => {
  const out = [];
  for (let t = from; t <= to + 1e-9; t += step) out.push(stepSlot(s, t));
  return out;
};

test('a winning user spin yields exactly one jackpot', () => {
  const s = createSlot(300);
  startSpin(s, 0, true, () => 0.1);
  const out = run(s, 0, 2);
  assert.equal(out.filter(o => o === 'jackpot').length, 1);
  assert.equal(out.filter(o => o === 'lose').length, 0);
  assert.equal(out[out.length - 1], 'idle');
  assert.ok(s.reels.every(r => r === s.reels[0]));
});

test('a losing user spin stops on reels that are not all equal', () => {
  const s = createSlot(300);
  startSpin(s, 0, true, () => 0.9);
  const out = run(s, 0, 2);
  assert.equal(out.filter(o => o === 'lose').length, 1);
  assert.equal(out.filter(o => o === 'jackpot').length, 0);
  assert.ok(!(s.reels[0] === s.reels[1] && s.reels[1] === s.reels[2]), JSON.stringify(s.reels));
});

test('an idle slot reports idle; an automatic spin never reports an outcome', () => {
  const s = createSlot(331);
  assert.equal(stepSlot(s, 0), 'idle');
  startSpin(s, 0, false, () => 0.1);
  const out = run(s, 0, 2);
  assert.ok(out.every(o => o === 'spinning' || o === 'idle'));
  assert.ok(out.includes('spinning'));
});
