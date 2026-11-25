import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, demoActions, makeRngs, STEP } from '../../lounge/js/sim.js';
import { renderFrame } from '../../lounge/js/scene.js';

// Just enough of a 2D canvas for renderFrame and the sprite builder to run in Node.
function fakeCanvas() {
  const ctx = new Proxy({
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop() {} }),
  }, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { width: 0, height: 0, getContext: () => ctx };
}
globalThis.document ??= { createElement: () => fakeCanvas() };

function simulate(rendersAfterStep) {
  const { rng, fxRng } = makeRngs(42);
  const world = createWorld({ demo: true, rng, fxRng });
  let timers = [];
  const hooks = { later: (fn, sec) => timers.push({ at: t + sec, fn }) };
  const act = demoActions(world, hooks);
  const ctx = fakeCanvas().getContext('2d'), bg = fakeCanvas();
  let t = 0;
  for (let i = 1; i <= 900; i++) {
    t = i * STEP;
    const due = timers.filter(x => x.at <= t); timers = timers.filter(x => x.at > t);
    due.forEach(x => x.fn());
    if (i === 60) act.block(t);
    if (i === 120) act.merge(t);
    if (i === 200) act.newRoom(t);
    if (i === 400) act.block(t);
    stepWorld(world, STEP, t, hooks);
    for (let k = 0; k < rendersAfterStep(i); k++) renderFrame(ctx, bg, world, t);
  }
  return JSON.stringify({ agents: world.agents, slots: world.slots });
}

test('with a seed, the simulation does not depend on how many frames are drawn', () => {
  const none = simulate(() => 0);
  assert.equal(simulate(() => 1), none);
  assert.equal(simulate(i => (i * 7) % 4), none);
});

test('makeRngs gives separate, reproducible streams for a seed', () => {
  const a = makeRngs(42), b = makeRngs('42');
  const draw = r => [r(), r(), r()];
  assert.deepEqual(draw(a.rng), draw(b.rng));
  assert.deepEqual(draw(a.fxRng), draw(b.fxRng));
  assert.notDeepEqual(draw(makeRngs(42).rng), draw(makeRngs(42).fxRng));
  assert.equal(makeRngs(null).rng, Math.random);
  assert.equal(makeRngs('abc').rng, Math.random);
});
