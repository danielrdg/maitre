import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPOTS, takeSpot, planPath, poseFor, assignHabit, ambientSmoke, createCast,
  moveTo, hasFreeSpot, stateAfterAnswer,
} from '../../lounge/js/agents.js';
import { mulberry32 } from '../../lounge/js/rng.js';

const agent = (state, extra = {}) => ({
  id: 'a', label: 'a', state, look: {}, info: {}, x: 0, y: 0, path: [], spot: -1,
  off: 3.3, walking: false, dir: 1, habit: 'none', ...extra,
});

const sample = (a, from, to, step) => {
  const out = [];
  for (let t = from; t < to; t += step) out.push(ambientSmoke(a, t));
  return out;
};

test('two agents asking for work get different spots', () => {
  const agents = [];
  const a = agent('work'); const pa = takeSpot(agents, a, 'work'); agents.push(a);
  const b = agent('work'); const pb = takeSpot(agents, b, 'work'); agents.push(b);
  assert.notDeepEqual(pa, pb);
  assert.notEqual(a.spot, b.spot);
});

test('a 7th queue agent gets the last queue spot without throwing', () => {
  const agents = [];
  for (let i = 0; i < 6; i++) { const a = agent('queue'); takeSpot(agents, a, 'queue'); agents.push(a); }
  const seventh = agent('queue');
  const pos = takeSpot(agents, seventh, 'queue');
  assert.deepEqual(pos, SPOTS.queue[SPOTS.queue.length - 1]);
});

test('planPath from the street enters through the door and ends at the target', () => {
  const path = planPath([20, 302], [186, 238], 'work');
  assert.deepEqual(path[0], [94, 302]);
  assert.deepEqual(path[path.length - 1], [186, 238]);
});

test('a terrace smoker brings the cigarette to the mouth between 1.2 and 2.6 s of its cycle', () => {
  const a = agent('smoke', { off: 0 });
  const { pose } = poseFor(a, 2, 0);
  assert.equal(pose.acc, 'cigMouth');
});

test('assignHabit follows the 0.35 / 0.4 / 0.25 weights', () => {
  assert.equal(assignHabit(() => 0.1), 'heavy');
  assert.equal(assignHabit(() => 0.5), 'light');
  assert.equal(assignHabit(() => 0.9), 'none');
  const rng = mulberry32(7); const n = 4000; const c = { heavy: 0, light: 0, none: 0 };
  for (let i = 0; i < n; i++) c[assignHabit(rng)]++;
  assert.ok(Math.abs(c.heavy / n - 0.35) < 0.03, JSON.stringify(c));
  assert.ok(Math.abs(c.light / n - 0.4) < 0.03, JSON.stringify(c));
});

test('a heavy card player smokes 25-55 % of the time, only with cigLip', () => {
  for (const off of [0.3, 1.7, 4.2, 6.6, 7.9, 9.5]) {
    const s = sample(agent('work', { habit: 'heavy', off }), 0, 600, 0.5);
    const on = s.filter(Boolean);
    const frac = on.length / s.length;
    assert.ok(frac >= 0.25 && frac <= 0.55, `off=${off} frac=${frac}`);
    assert.ok(on.every(v => v === 'cigLip'), `off=${off}`);
  }
});

test('sessions last 8 to 20 s', () => {
  for (const off of [0.3, 4.2, 9.5]) {
    const s = sample(agent('work', { habit: 'heavy', off }), 0, 900, 0.25);
    const runs = []; let run = 0;
    for (const v of s) { if (v) run++; else if (run) { runs.push(run * 0.25); run = 0; } }
    const inner = runs.slice(1);
    assert.ok(inner.length > 5, `off=${off}`);
    assert.ok(inner.every(r => r >= 7.75 && r <= 20.25), `off=${off} runs=${inner}`);
  }
});

test('standing agents cycle cigHold and cigMouth', () => {
  const s = sample(agent('queue', { habit: 'heavy', off: 2.2 }), 0, 600, 0.25).filter(Boolean);
  assert.ok(s.includes('cigHold') && s.includes('cigMouth'));
  assert.ok(s.every(v => v === 'cigHold' || v === 'cigMouth'));
});

test('a non-smoker never smokes; blocked, dancing, boss and walking agents never smoke', () => {
  assert.ok(sample(agent('work', { habit: 'none' }), 0, 600, 0.5).every(v => v === null));
  for (const state of ['blocked', 'dance', 'boss']) {
    assert.ok(sample(agent(state, { habit: 'heavy' }), 0, 600, 0.5).every(v => v === null), state);
  }
  assert.ok(sample(agent('work', { habit: 'heavy', walking: true }), 0, 600, 0.5).every(v => v === null));
});

test('a light smoker smokes noticeably less than a heavy one', () => {
  let heavy = 0, light = 0, total = 0;
  for (const off of [0.5, 2.5, 4.5, 6.5, 8.5]) {
    const h = sample(agent('queue', { habit: 'heavy', off }), 0, 1200, 0.5);
    const l = sample(agent('queue', { habit: 'light', off }), 0, 1200, 0.5);
    heavy += h.filter(Boolean).length; light += l.filter(Boolean).length; total += h.length;
  }
  assert.ok(light / total > 0.05 && light / total < 0.28, `light=${light / total}`);
  assert.ok(heavy > light * 1.8);
});

test('terrace agents always carry a cigarette, whatever the habit', () => {
  for (const habit of ['none', 'light', 'heavy']) {
    const a = agent('smoke', { habit });
    for (let t = 0; t < 60; t += 0.1) {
      const { pose } = poseFor(a, t, 0);
      assert.ok(['cigHold', 'cigMouth'].includes(pose.acc), `${habit} t=${t}`);
    }
  }
});

test('poseFor never changes the agent state or spot', () => {
  const cast = createCast({ rng: mulberry32(3) });
  const before = cast.map(a => [a.state, a.spot, a.x, a.y]);
  for (let t = 0; t < 300; t += 0.7) for (const a of cast) poseFor(a, t, t % 10 < 2 ? t + 1 : 0);
  assert.deepEqual(cast.map(a => [a.state, a.spot, a.x, a.y]), before);
});

test('createCast is deterministic for a seeded rng and includes a ready agent', () => {
  const a = JSON.stringify(createCast({ rng: mulberry32(42) }));
  const b = JSON.stringify(createCast({ rng: mulberry32(42) }));
  assert.equal(a, b);
  const cast = createCast({ rng: mulberry32(42) });
  assert.ok(cast.some(x => x.state === 'ready'));
  assert.equal(new Set(cast.map(x => x.id)).size, cast.length);
});

test('answering the blocked db-migration seats it where no other work agent sits', () => {
  const cast = createCast({ rng: mulberry32(42) });
  const db = cast.find(a => a.id === 'db-migration');
  assert.equal(stateAfterAnswer(cast, db), 'work');
  moveTo(cast, db, 'work');
  const target = db.path[db.path.length - 1];
  const others = cast.filter(a => a !== db && a.state === 'work');
  assert.ok(others.every(a => a.spot !== db.spot), `spot ${db.spot} is taken`);
  assert.ok(others.every(a => a.x !== target[0] || a.y !== target[1]), `seat ${target} is taken`);
  assert.equal(db.overflow, false);
});

test('a full table is detectable: no free seat, overflow flagged, answer sends the agent to ready', () => {
  const agents = [];
  for (let i = 0; i < SPOTS.work.length; i++) {
    const a = agent('work'); takeSpot(agents, a, 'work'); agents.push(a);
  }
  const late = agent('blocked');
  agents.push(late);
  assert.equal(hasFreeSpot(agents, late, 'work'), false);
  assert.equal(stateAfterAnswer(agents, late), 'ready');
  takeSpot(agents, late, 'work');
  assert.equal(late.overflow, true);
});
