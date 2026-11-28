import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPOTS, AISLE_Y, takeSpot, planPath, poseFor, assignHabit, ambientSmoke, createCast,
  moveTo, hasFreeSpot, stateAfterAnswer, addAgent, stepAgents,
  changeView, walkTo, seat, walkIn, go, retarget, rehome,
} from '../../lounge/js/agents.js';
import { FLOOR, LOBBY } from '../../lounge/js/places.js';
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

// ---------- the building: agents changing view through the elevator doors ----------

const FLOORS = [
  { project: 'webshop', floor: 1, theme: 'casino', locked: false },
  { project: 'api', floor: 2, theme: 'deco', locked: false },
];

// Runs the walkers and records where each step left `a`: its place, x and y.
function trace(agents, a, maxSec = 60) {
  const out = [];
  let t = 0;
  for (let i = 0; i < maxSec * 30 && (a.walking || i === 0); i++) {
    t += 1 / 30;
    stepAgents(agents, 1 / 30, t);
    out.push({ place: a.place, x: a.x, y: a.y, walking: a.walking });
  }
  return out;
}
const visits = (tr, place, [x, y]) => tr.some(s => s.place === place && s.x === x && s.y === y);

function onFloor(project, state = 'work', id = 'r1') {
  const agents = [];
  const a = addAgent(agents, { id, state, look: {}, info: { project }, stacks: true }, () => 0.5);
  seat(agents, a, FLOORS);
  return { agents, a };
}

test('seat puts a room straight on its floor, at its spot, without walking', () => {
  const { a } = onFloor('webshop');
  assert.equal(a.place, 'floor:webshop');
  assert.equal(a.dest, 'floor:webshop');
  assert.deepEqual([a.x, a.y], SPOTS.work[0]);
  assert.equal(a.walking, false);
});

test('changeView floor → lobby: through the floor\'s elevator door, then the lobby\'s, to the bell', () => {
  const { agents, a } = onFloor('webshop');
  let arrived = 0;
  a.state = 'blocked';
  changeView(agents, a, { view: 'floor', project: 'webshop' }, { view: 'lobby' }, () => arrived++);
  assert.equal(a.dest, 'lobby', 'the bell spot is held from the start');
  const tr = trace(agents, a);
  assert.ok(visits(tr, 'floor:webshop', FLOOR.elevator.door), 'walks to the floor\'s elevator door');
  assert.ok(tr.some(s => s.place === null), 'hidden while it rides');
  assert.ok(visits(tr, 'lobby', LOBBY.lift), 'appears at the lobby\'s elevator door');
  assert.ok(tr.filter(s => s.place === 'floor:webshop').every(s => s.x >= FLOOR.elevator.door[0]), 'never out to the street');
  const firstLobby = tr.findIndex(s => s.place === 'lobby');
  assert.ok(tr.slice(0, firstLobby).every(s => s.place !== 'lobby'), 'one hop, floor first');
  assert.ok(tr.slice(0, -1).every(s => s.walking), 'walking all the way, so the bell waits for the arrival');
  assert.equal(a.place, 'lobby');
  assert.deepEqual([a.x, a.y], SPOTS.blocked[0]);
  assert.equal(arrived, 1, 'the caller hears the final arrival once');
});

test('walkTo blocked from a floor ends at the lobby bell; the answer sends it back through the doors to its table', () => {
  const { agents, a } = onFloor('api');
  const seat0 = [a.x, a.y];
  walkTo(agents, a, 'blocked', FLOORS);
  let tr = trace(agents, a);
  assert.ok(visits(tr, 'floor:api', FLOOR.elevator.door));
  assert.equal(a.place, 'lobby');
  assert.deepEqual([a.x, a.y], SPOTS.blocked[0]);

  assert.equal(stateAfterAnswer(agents, a, FLOORS), 'work');
  walkTo(agents, a, 'work', FLOORS);
  assert.equal(a.dest, 'floor:api');
  tr = trace(agents, a);
  assert.ok(visits(tr, 'lobby', LOBBY.lift), 'into the lobby lift');
  assert.ok(visits(tr, 'floor:api', FLOOR.elevator.door), 'out at its floor');
  assert.ok(tr.filter(s => s.place === 'lobby').every(s => s.x >= FLOOR.streetX), 'not through the street');
  assert.equal(a.place, 'floor:api');
  assert.deepEqual([a.x, a.y], seat0, 'back at the table');
});

test('spots are per floor: a full table on one floor leaves the other floor\'s table free', () => {
  const agents = [];
  for (let i = 0; i < SPOTS.work.length + 1; i++) seat(agents, addAgent(agents, { id: `w${i}`, state: 'work', look: {}, info: { project: 'webshop' }, stacks: true }, () => 0.5), FLOORS);
  const b = addAgent(agents, { id: 'b', state: 'work', look: {}, info: { project: 'api' }, stacks: true }, () => 0.5);
  seat(agents, b, FLOORS);
  assert.equal(b.spot, 0);
  assert.equal(b.overflow, false);
  assert.deepEqual([b.x, b.y], SPOTS.work[0]);
  const blocked = addAgent(agents, { id: 'x', state: 'blocked', look: {}, info: { project: 'api' }, stacks: true }, () => 0.5);
  seat(agents, blocked, FLOORS);
  assert.equal(stateAfterAnswer(agents, blocked, FLOORS), 'work', 'a seat is free on its own floor');
  const full = addAgent(agents, { id: 'y', state: 'blocked', look: {}, info: { project: 'webshop' }, stacks: true }, () => 0.5);
  seat(agents, full, FLOORS);
  assert.equal(stateAfterAnswer(agents, full, FLOORS), 'ready', 'its own floor\'s table is full');
});

test('the terrace and the sidewalk are in the lobby view; smokers stand on the terrace without going down to the aisle', () => {
  const { agents, a } = onFloor('webshop');
  walkTo(agents, a, 'smoke', FLOORS);
  const tr = trace(agents, a);
  assert.ok(visits(tr, 'terrace', LOBBY.terraceLift));
  assert.ok(tr.filter(s => s.place === 'terrace').every(s => s.y < 150), 'stays up on the terrace');
  assert.deepEqual([a.x, a.y], LOBBY.spots.smoke[0]);
  const q = onFloor('webshop', 'queue', 'q').a;
  assert.equal(q.place, 'lobby');
  assert.deepEqual([q.x, q.y], SPOTS.queue[0], 'the sidewalk keeps its spots');
});

test('a room whose floor is not open yet waits in the lobby, then rides up when its floor opens', () => {
  const agents = [];
  const a = addAgent(agents, { id: 'm', state: 'coffee', look: {}, info: { project: 'mobile' }, stacks: true }, () => 0.5);
  seat(agents, a, FLOORS);
  assert.equal(a.place, 'lobby');
  assert.ok(LOBBY.spots.wait.some(([x, y]) => x === a.x && y === a.y), 'on a lobby seat');
  const more = [...FLOORS, { project: 'mobile', floor: 3, theme: 'tiki', locked: false }];
  walkTo(agents, a, a.state, more);
  trace(agents, a);
  assert.equal(a.place, 'floor:mobile');
  assert.deepEqual([a.x, a.y], SPOTS.coffee[0]);
});

test('a new state mid-ride re-routes from where the agent is, not from where it was going', () => {
  const { agents, a } = onFloor('webshop');
  walkTo(agents, a, 'blocked', FLOORS);
  for (let i = 0; i < 20; i++) stepAgents(agents, 1 / 30, i / 30);
  assert.equal(a.place, 'floor:webshop', 'still walking to the lift');
  walkTo(agents, a, 'work', FLOORS);
  const tr = trace(agents, a);
  assert.ok(tr.every(s => s.place === 'floor:webshop'), 'answered before the lift: it stays on its floor');
  assert.deepEqual([a.x, a.y], SPOTS.work[0]);

  walkTo(agents, a, 'blocked', FLOORS);
  let steps = 0;
  while (a.place !== null && steps++ < 2000) stepAgents(agents, 1 / 30, steps / 30);
  assert.equal(a.place, null, 'inside the lift');
  walkTo(agents, a, 'work', FLOORS);
  const back = trace(agents, a);
  assert.ok(!back.some(s => s.place === 'lobby'), 'rides back up without stepping out');
  assert.ok(visits(back, 'floor:webshop', FLOOR.elevator.door));
  assert.equal(a.place, 'floor:webshop');
});

test('a room leaving walks out of the view it is in: the lift on a floor, the street door from the lobby', () => {
  const { agents, a } = onFloor('webshop');
  walkTo(agents, a, 'exit', FLOORS);
  let tr = trace(agents, a);
  assert.ok(tr.every(s => s.place === 'floor:webshop'));
  assert.deepEqual(tr.at(-1) && [tr.at(-1).x, tr.at(-1).y], FLOOR.elevator.door);
  assert.ok(!agents.includes(a), 'gone at the lift');

  const b = onFloor('webshop', 'blocked', 'b');
  walkTo(b.agents, b.a, 'exit', FLOORS);
  tr = trace(b.agents, b.a);
  assert.ok(visits(tr, 'lobby', FLOOR.door), 'out through the street door');
  assert.deepEqual([b.a.x, b.a.y], FLOOR.exit);
  assert.ok(!b.agents.includes(b.a));
});

test('walkIn brings a new room in from the street, through the lobby lift to its floor', () => {
  const agents = [];
  const a = addAgent(agents, { id: 'n', state: 'coffee', look: {}, info: { project: 'webshop' }, stacks: true }, () => 0.5);
  walkIn({ agents, floors: FLOORS }, a, 'coffee');
  assert.equal(a.place, 'lobby');
  assert.ok(a.x < FLOOR.streetX);
  const tr = trace(agents, a);
  assert.ok(visits(tr, 'lobby', FLOOR.door));
  assert.ok(visits(tr, 'lobby', LOBBY.lift));
  assert.equal(a.place, 'floor:webshop');
  assert.deepEqual([a.x, a.y], SPOTS.coffee[0]);
});

test('go keeps the classic single-room lounge when the world has no floors', () => {
  const cast = createCast({ rng: mulberry32(42) });
  const db = cast.find(x => x.id === 'db-migration');
  go({ agents: cast }, db, 'work');
  assert.equal(db.place, undefined);
  assert.ok(db.path.every(Array.isArray), 'plain points: no lift ride');
  assert.deepEqual(db.path[0], [db.x, AISLE_Y]);
});

const intoTheLift = (agents, a) => { let n = 0; while (a.place !== null && n++ < 3000) stepAgents(agents, 1 / 30, n / 30); };

test('retarget during a ride keeps the ride and re-aims the walk after it', () => {
  const { agents, a } = onFloor('webshop');
  walkTo(agents, a, 'queue', FLOORS);
  intoTheLift(agents, a);
  assert.equal(a.place, null);
  retarget({ agents, floors: FLOORS }, a, SPOTS.queue[2]);
  assert.ok(!Array.isArray(a.path[0]), 'still riding');
  const tr = trace(agents, a);
  assert.ok(visits(tr, 'lobby', LOBBY.lift), 'steps out at the lobby lift');
  assert.deepEqual([a.x, a.y], SPOTS.queue[2]);
});

test('an exit during a ride: no teleport, `after` once, and the agent is gone', () => {
  const { agents, a } = onFloor('webshop');
  walkTo(agents, a, 'blocked', FLOORS);
  intoTheLift(agents, a);
  const at = [a.x, a.y];
  let calls = 0;
  walkTo(agents, a, 'exit', FLOORS, () => calls++);
  assert.deepEqual([a.x, a.y], at, 'not set down at any door');
  stepAgents(agents, 1 / 30, 99);
  assert.deepEqual([a.x, a.y], at);
  assert.equal(calls, 1, 'the caller hears it leave');
  assert.ok(!agents.includes(a));
});

test('an exit on a floor opens its lift door as it leaves', () => {
  const { agents, a } = onFloor('webshop');
  walkTo(agents, a, 'exit', FLOORS);
  let gone = [], t = 0;
  while (!gone.length && t < 60) { t += 1 / 30; gone = stepAgents(agents, 1 / 30, t); }
  assert.deepEqual(gone, [a]);
  assert.deepEqual(a.lift, { place: 'floor:webshop', at: t });
});

test('rehome leaves a room that is leaving alone', () => {
  const { agents, a } = onFloor('webshop');
  walkTo(agents, a, 'exit', FLOORS);
  const path = JSON.stringify(a.path);
  assert.deepEqual(rehome({ agents, floors: [FLOORS[1]] }), []);
  assert.equal(JSON.stringify(a.path), path);
  assert.equal(a.dest, 'floor:webshop');
});

test('the lobby\'s waiting seats are one pool, whatever state the waiting rooms are in', () => {
  const agents = [];
  const states = ['coffee', 'work', 'ready'];
  const seated = states.map((state, i) => seat(agents, addAgent(agents, { id: `m${i}`, state, look: {}, info: { project: 'mobile' }, stacks: true }, () => 0.5), FLOORS));
  assert.deepEqual(seated.map(a => [a.x, a.y]), LOBBY.spots.wait, 'three rooms, three different seats');
  assert.ok(seated.every(a => !a.overflow));
});
