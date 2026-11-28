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

test('leaving a floor cancels a spin the user started there: no outcome, no coins, no sound', async () => {
  const { startSpin, isSpinning } = await import('../../lounge/js/slots.js');
  const floors = [{ project: 'scratch', floor: 1, theme: 'hall', locked: false }];
  const { rng, fxRng } = makeRngs(3);
  const world = createWorld({ demo: true, rng, fxRng, floors });
  world.here = 'floor:scratch';
  const heard = [], pops = [];
  const sfx = new Proxy({}, { get: (_, k) => () => heard.push(k) });
  const hooks = { sfx, popup: (...a) => pops.push(a) };
  let t = 0;
  const step = sec => { for (let i = 0; i < sec / STEP; i++) { t += STEP; stepWorld(world, STEP, t, hooks); } };
  step(0.1);
  startSpin(world.slots[0], t, true, () => 0);
  step(0.3);
  heard.length = 0;
  world.here = null;
  step(3);
  assert.equal(isSpinning(world.slots[0]), false, 'cancelled');
  assert.deepEqual(heard.filter(k => ['jackpot', 'lose', 'thunk', 'tick'].includes(k)), []);
  assert.deepEqual(pops, []);
  assert.equal(world.particles.parts.filter(p => p.k === 'coin').length, 0);
});

// ---------- the demo building ----------

const demoWorld = async (seed = 42) => {
  const demo = await import('../../lounge/js/demo.js');
  const { rng, fxRng } = makeRngs(seed);
  return { demo, world: createWorld({ demo: true, rng, fxRng, floors: demo.demoFloors() }) };
};

test('the demo cast spans four made-up projects and one scratch room, each on its own floor', async () => {
  const demo = await import('../../lounge/js/demo.js');
  assert.deepEqual(demo.demoFloors(), [
    { project: 'webshop', floor: 1, theme: 'hall', locked: false },
    { project: 'api', floor: 2, theme: 'casino', locked: false },
    { project: 'mobile', floor: 3, theme: 'deco', locked: false },
    { project: 'docs', floor: 4, theme: 'tiki', locked: false },
    { project: 'scratch', floor: 5, theme: 'hall', locked: true },
  ]);
  assert.notEqual(demo.demoFloors(), demo.demoFloors(), 'a fresh list each time');
  const projects = demo.DEMO_CAST.map(e => e[3].project);
  assert.deepEqual(projects.filter(p => !p), [], 'every entry names its project');
  assert.deepEqual([...new Set(projects)].sort(), ['api', 'docs', 'mobile', 'scratch', 'webshop']);
  assert.equal(projects.filter(p => p === 'scratch').length, 1, 'one scratch room');
  const { world } = await demoWorld();
  for (const f of demo.demoFloors()) assert.ok(world.agents.some(a => a.place === `floor:${f.project}`), `someone on ${f.project}`);
  const fable = world.agents.find(a => a.state === 'boss'), visitor = world.agents.find(a => a.state === 'visitor');
  assert.equal(fable.place, visitor.place, 'Fable and its visitor share a floor');
});

test('demo block sends a working agent through the lift to the lobby bell, from any view', async () => {
  const { LOBBY } = await import('../../lounge/js/places.js');
  const outcomes = [];
  for (const here of [null, 'floor:docs', 'lobby']) {
    const { world } = await demoWorld();
    world.here = here;
    const act = demoActions(world, { later: () => {} });
    let t = 0, rode = false;
    const before = new Set(world.agents.filter(a => a.state === 'blocked'));
    act.block(t);
    const a = world.agents.find(b => b.state === 'blocked' && !before.has(b));
    assert.ok(a, 'an agent got blocked');
    const from = a.place;
    assert.match(from, /^floor:(webshop|api|mobile|docs)$/);
    for (let i = 0; i < 30 / STEP; i++) { t += STEP; stepWorld(world, STEP, t); if (a.place === null) rode = true; }
    assert.ok(rode, 'it rode the lift');
    assert.equal(a.place, 'lobby');
    assert.equal(a.walking, false);
    assert.ok(LOBBY.spots.blocked.some(([x, y]) => x === a.x && y === a.y), `at the bell, not at ${a.x},${a.y}`);
    assert.ok(world.ringUntil > 0, 'the bell rang');
    outcomes.push({ id: a.id, from, x: a.x, y: a.y });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[2], outcomes[0]);
});

for (const here of [null, 'floor:docs', 'lobby']) test(`demo merge dances on the room's own floor; a new room arrives on the sidewalk and the front goes up (here: ${here})`, async () => {
  const { world } = await demoWorld();
  world.here = here;
  let timers = [], t = 0;
  const act = demoActions(world, { later: (fn, sec) => timers.push({ at: t + sec, fn }) });
  const step = sec => {
    for (let i = 0; i < sec / STEP; i++) {
      t += STEP;
      const due = timers.filter(x => x.at <= t); timers = timers.filter(x => x.at > t);
      due.forEach(x => x.fn());
      stepWorld(world, STEP, t);
    }
  };
  const w = world.agents.find(a => a.state === 'whisky');
  const home = w.place;
  act.merge(t);
  step(5);
  assert.equal(w.state, 'dance');
  assert.equal(w.place, home, 'it dances on its floor');
  assert.equal(w.walking, false);

  const front = world.agents.filter(a => a.state === 'queue').sort((p, q) => q.x - p.x)[0];
  act.newRoom(t);
  const nw = world.agents[world.agents.length - 1];
  assert.equal(nw.place, 'lobby', 'it walks in from the street');
  assert.ok(nw.info.project, 'a new room has a project');
  step(30);
  assert.equal(nw.state, 'queue');
  assert.equal(nw.place, 'lobby');
  assert.equal(front.state, 'coffee');
  assert.equal(front.place, `floor:${front.info.project}`, 'the front room went up to its floor');
});

test('with a seed, the demo building runs the same twice', async () => {
  const run = async () => {
    const { world } = await demoWorld(7);
    let timers = [], t = 0;
    const act = demoActions(world, { later: (fn, sec) => timers.push({ at: t + sec, fn }) });
    for (let i = 1; i <= 900; i++) {
      t = i * STEP;
      const due = timers.filter(x => x.at <= t); timers = timers.filter(x => x.at > t);
      due.forEach(x => x.fn());
      if (i === 60) act.block(t);
      if (i === 120) act.merge(t);
      if (i === 200) act.newRoom(t);
      if (i === 400) act.block(t);
      stepWorld(world, STEP, t);
    }
    return JSON.stringify(world.agents);
  };
  assert.equal(await run(), await run());
});
