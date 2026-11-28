import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewOf, defaultView, facadeLayout, createLift, callLift, stepLift, keepLift } from '../../lounge/js/building.js';
import { roomToAgents } from '../../lounge/js/live.js';

const room = (over = {}) => ({
  room: 'r1', session: 's-1', model: 'opus', state: 'work', since: 1_000_000, updatedAt: 1_000_000,
  task: 'Fix the flaky test', steps: [], subagents: [], project: 'webshop', kind: 'code', ...over,
});
const floor = (project, n, theme = 'casino') => ({ project, floor: n, theme, locked: false });
const FLOORS = [floor('webshop', 1), floor('api', 2, 'deco'), { project: 'scratch', floor: 3, theme: 'hall', locked: true }];

test('viewOf sends blocked to the lobby, smoke to the terrace, queue to the sidewalk, from any floor', () => {
  for (const project of ['webshop', 'api', undefined]) {
    assert.deepEqual(viewOf(roomToAgents(room({ project, state: 'blocked' })).main, FLOORS), { view: 'lobby' });
    assert.deepEqual(viewOf(roomToAgents(room({ project, state: 'smoke' })).main, FLOORS), { view: 'terrace' });
    assert.deepEqual(viewOf(roomToAgents(room({ project, state: 'queue' })).main, FLOORS), { view: 'sidewalk' });
  }
  assert.deepEqual(viewOf(roomToAgents(room({ state: 'blocked' })).main, []), { view: 'lobby' }, 'no floors needed');
  assert.deepEqual(viewOf(roomToAgents(room({ state: 'smoke' })).main, []), { view: 'terrace' });
  assert.deepEqual(viewOf(roomToAgents(room({ state: 'queue' })).main, []), { view: 'sidewalk' });
});

test('viewOf puts every other state on its project\'s floor', () => {
  for (const state of ['coffee', 'work', 'ready', 'whisky', 'exit', 'dance', 'couch', 'parked', 'something-new']) {
    assert.deepEqual(viewOf(roomToAgents(room({ state })).main, FLOORS), { view: 'floor', project: 'webshop' }, state);
    assert.deepEqual(viewOf(roomToAgents(room({ state, project: 'api' })).main, FLOORS), { view: 'floor', project: 'api' }, state);
  }
});

test('a room the server has not placed yet (no kind) waits in the lobby, even with the scratch floor open', () => {
  for (const state of ['coffee', 'work', 'ready']) {
    assert.deepEqual(viewOf(roomToAgents(room({ state, project: undefined, kind: undefined })).main, FLOORS), { view: 'lobby' }, state);
    assert.deepEqual(viewOf(roomToAgents(room({ state, kind: undefined })).main, FLOORS), { view: 'lobby' }, `${state}, a project but no kind`);
  }
  assert.deepEqual(viewOf(roomToAgents(room({ project: undefined, kind: 'scratch' })).main, FLOORS), { view: 'floor', project: 'scratch' });
  assert.deepEqual(viewOf(roomToAgents(room({ project: undefined, kind: 'code' })).main, FLOORS), { view: 'floor', project: 'scratch' }, 'a kind without a project: scratch, as on the server');
});

test('a parked agent stays on its floor, on the couch', () => {
  const a = roomToAgents(room({ state: 'parked', project: 'api' })).main;
  assert.equal(a.state, 'sleep');
  assert.equal(a.info.parked, true);
  assert.deepEqual(viewOf(a, FLOORS), { view: 'floor', project: 'api' });
  const dancing = roomToAgents(room({ state: 'dance', parked: true, project: 'api' })).main;
  assert.deepEqual(viewOf(dancing, FLOORS), { view: 'floor', project: 'api' });
});

test('a subagent follows its parent\'s project, scratch included', () => {
  const sub = roomToAgents(room({ project: 'api', subagents: [{ id: 'a', type: 'Explore', model: 'haiku' }] })).subagents[0];
  assert.equal(sub.state, 'slot');
  assert.deepEqual(viewOf(sub, FLOORS), { view: 'floor', project: 'api' });
  const blockedParent = roomToAgents(room({ project: 'api', state: 'blocked', subagents: [{ id: 'a', type: 'Explore', model: 'haiku' }] })).subagents[0];
  assert.deepEqual(viewOf(blockedParent, FLOORS), { view: 'floor', project: 'api' }, 'the slot stays on the floor');
  const scratchSub = roomToAgents(room({ project: undefined, kind: 'scratch', subagents: [{ id: 'a', type: 'Explore', model: 'haiku' }] })).subagents[0];
  assert.deepEqual(viewOf(scratchSub, FLOORS), { view: 'floor', project: 'scratch' });
});

test('a room placed without a project, or a scratch room, is on the scratch floor', () => {
  assert.deepEqual(viewOf(roomToAgents(room({ project: undefined, kind: 'scratch' })).main, FLOORS), { view: 'floor', project: 'scratch' });
  assert.deepEqual(viewOf(roomToAgents(room({ project: 'webshop', kind: 'scratch' })).main, FLOORS), { view: 'floor', project: 'scratch' });
});

test('a room whose project has no floor yet waits in the lobby until its floor exists', () => {
  const opening = roomToAgents(room({ project: 'mobile', state: 'coffee' })).main;
  assert.deepEqual(viewOf(opening, FLOORS), { view: 'lobby' });
  assert.deepEqual(viewOf(opening, [...FLOORS, floor('mobile', 4, 'tiki')]), { view: 'floor', project: 'mobile' });
  assert.deepEqual(viewOf(roomToAgents(room({ project: undefined })).main, [floor('webshop', 1)]), { view: 'lobby' }, 'scratch needs its floor too');
  assert.deepEqual(viewOf(opening, []), { view: 'lobby' });
  assert.deepEqual(viewOf(opening), { view: 'lobby' }, 'no floors known yet');
});

test('defaultView: lobby with no floor, straight onto a lone floor, the facade from two', () => {
  assert.deepEqual(defaultView([]), { view: 'lobby' });
  assert.deepEqual(defaultView([floor('api', 2)]), { view: 'floor', project: 'api' });
  assert.deepEqual(defaultView([floor('webshop', 1), floor('api', 2)]), { view: 'facade' });
});

const floorsOnly = levels => levels.filter(l => l.kind === 'floor');

test('facadeLayout with 3 floors: the mockup geometry, stacked from the lobby, no scroll', () => {
  const floors = [floor('api', 5, 'deco'), floor('webshop', 1), floor('docs', 2, 'tiki')];
  const before = JSON.stringify(floors);
  const { levels, maxScroll } = facadeLayout(floors);
  assert.equal(JSON.stringify(floors), before, 'the input is not reordered');
  assert.equal(maxScroll, 0);
  assert.deepEqual(levels.map(l => l.key), ['lobby', 1, 2, 5, 'roof']);
  assert.deepEqual(levels.map(l => l.kind), ['lobby', 'floor', 'floor', 'floor', 'roof']);
  assert.deepEqual(levels[0], { kind: 'lobby', key: 'lobby', y: 234, h: 56, carY: 258 });
  assert.deepEqual(levels[1], { kind: 'floor', key: 1, project: 'webshop', floor: 1, theme: 'casino', locked: false, y: 192, h: 42, carY: 202 });
  assert.deepEqual(floorsOnly(levels).map(l => [l.project, l.y]), [['webshop', 192], ['docs', 150], ['api', 108]]);
  assert.deepEqual(levels[4], { kind: 'roof', key: 'roof', y: 68, h: 40, carY: 76 });
});

test('facadeLayout with 4 floors matches the mockup\'s levels exactly', () => {
  const { levels, maxScroll } = facadeLayout([1, 2, 3, 4].map(n => floor(`p${n}`, n)));
  assert.equal(maxScroll, 0);
  // The mockup's LEVELS: lobby 234–290, floors 192, 150, 108, 66 (42 px each), roof 26–66.
  assert.deepEqual(levels.map(l => [l.y, l.y + l.h]), [[234, 290], [192, 234], [150, 192], [108, 150], [66, 108], [26, 66]]);
  // The mockup's carY: (y1 - 32) per level.
  assert.deepEqual(levels.map(l => l.carY), [258, 202, 160, 118, 76, 34]);
});

test('facadeLayout with 7 floors scrolls: all 7 present, stacked in floor order with no gaps', () => {
  const floors = [7, 3, 1, 9, 2, 4, 6].map(n => floor(`p${n}`, n));
  const { levels, maxScroll } = facadeLayout(floors);
  assert.equal(maxScroll, 3 * 42);
  const fl = floorsOnly(levels);
  assert.deepEqual(fl.map(l => l.floor), [1, 2, 3, 4, 6, 7, 9]);
  assert.deepEqual(levels.map(l => l.kind), ['lobby', ...fl.map(() => 'floor'), 'roof']);
  for (let i = 1; i < levels.length; i++) assert.equal(levels[i].y + levels[i].h, levels[i - 1].y, `level ${i} sits on level ${i - 1}`);
  assert.ok(fl.every(l => l.h === 42));
  assert.equal(levels[0].y, 234, 'scroll 0 shows the lobby where the mockup has it');

  const top = facadeLayout(floors, maxScroll).levels;
  assert.equal(top.at(-1).y, 26, 'scrolled all the way, the roof is where the mockup has it');
  assert.ok(top.every((l, i) => l.y === levels[i].y + maxScroll && l.carY === levels[i].carY + maxScroll), 'the whole building scrolls');
  assert.deepEqual(facadeLayout(floors, 9999).levels, top, 'scroll is clamped');
  assert.deepEqual(facadeLayout(floors, -5).levels, levels);
  assert.deepEqual(facadeLayout([floor('a', 1)], 50).levels, facadeLayout([floor('a', 1)]).levels, 'no scroll when it all fits');
});

test('facadeLayout with no floor is the lobby under the roof', () => {
  const { levels, maxScroll } = facadeLayout([]);
  assert.equal(maxScroll, 0);
  assert.deepEqual(levels.map(l => [l.key, l.y, l.h]), [['lobby', 234, 56], ['roof', 194, 40]]);
});

const ride = (lift, dt = 1 / 60, max = 600) => {
  const ys = [];
  let arrivals = 0, steps = 0;
  while (steps < max) {
    steps++;
    const { arrived } = stepLift(lift, dt);
    ys.push(lift.y);
    if (arrived) arrivals++;
    if (!lift.moving) break;
  }
  return { ys, arrivals, steps };
};

test('stepLift rides to the called level with the mockup\'s timing and arrives once', () => {
  const { levels } = facadeLayout([1, 2, 3, 4].map(n => floor(`p${n}`, n)));
  const at = key => levels.find(l => l.key === key);
  const lift = createLift(at(1));
  assert.equal(lift.y, 202);
  assert.equal(lift.at, 1);
  assert.equal(lift.moving, false);
  assert.deepEqual(stepLift(lift, 0.1), { arrived: false }, 'idle');

  callLift(lift, at(4));
  assert.equal(lift.moving, true);
  assert.equal(lift.to, 4);
  // 3 levels at .45 s each, as in the mockup.
  const r = ride(lift, 0.045);
  assert.equal(r.arrivals, 1);
  assert.equal(r.steps, 30);
  assert.equal(lift.y, 76);
  assert.equal(lift.at, 4);
  assert.equal(lift.moving, false);
  for (let i = 1; i < r.ys.length; i++) assert.ok(r.ys[i] <= r.ys[i - 1], 'going up only');
  // The mockup's ease-in-out: slow at both ends, fast in the middle.
  const first = 202 - r.ys[0], mid = r.ys[14] - r.ys[15], last = r.ys.at(-2) - r.ys.at(-1);
  assert.ok(mid > first * 5 && mid > last * 5, `eased: ${first} ${mid} ${last}`);
  assert.ok(Math.abs(r.ys[14] - (202 + 76) / 2) < 1, 'halfway at half time');
  assert.deepEqual(stepLift(lift, 0.05), { arrived: false }, 'arrives only once');
});

test('calling the level the lift is on still rides the shortest trip, so the view opens on arrival', () => {
  const { levels } = facadeLayout([floor('a', 1)]);
  const lift = createLift(levels[0]);
  callLift(lift, levels[0]);
  assert.equal(lift.moving, true);
  const r = ride(lift, 0.1);
  assert.equal(r.arrivals, 1);
  assert.equal(r.steps, 4, 'the mockup\'s .4 s minimum');
  assert.equal(lift.at, 'lobby');
  assert.equal(lift.y, 258);
});

test('a call while moving retargets from where the car is', () => {
  const { levels } = facadeLayout([1, 2, 3, 4].map(n => floor(`p${n}`, n)));
  const at = key => levels.find(l => l.key === key);
  const lift = createLift(at('lobby'));
  callLift(lift, at('roof'));
  for (let i = 0; i < 10; i++) assert.deepEqual(stepLift(lift, 0.1), { arrived: false });
  const mid = lift.y;
  assert.ok(mid < 258 && mid > 34, `between: ${mid}`);
  callLift(lift, at(1));
  assert.equal(lift.to, 1);
  assert.equal(lift.y, mid, 'no jump');
  const first = stepLift(lift, 0.01);
  assert.equal(first.arrived, false);
  assert.ok(lift.y > mid && lift.y - mid < 1, 'turns around smoothly from where it was');
  const r = ride(lift, 0.01);
  assert.equal(r.arrivals, 1);
  assert.equal(lift.y, 202);
  assert.equal(lift.at, 1);
  // From mid to floor 1 at .45 s per 42 px, never under .4 s.
  assert.equal(r.steps + 1, Math.round(Math.max(0.4, (202 - mid) / 42 * 0.45) / 0.01));
});

test('createLift and callLift refuse a level that does not come from facadeLayout', () => {
  const { levels } = facadeLayout([floor('a', 1)]);
  for (const bad of [undefined, null, 1, 'lobby', { key: 1 }, { key: 1, carY: NaN }]) {
    assert.throws(() => createLift(bad), TypeError, String(bad));
    const lift = createLift(levels[0]);
    assert.throws(() => callLift(lift, bad), TypeError, String(bad));
    assert.equal(lift.moving, false, 'a refused call leaves the car alone');
    assert.equal(lift.y, 258);
  }
});

test('facadeLayout treats a NaN or negative scroll as 0', () => {
  const floors = [1, 2, 3, 4, 5, 6].map(n => floor(`p${n}`, n));
  const base = facadeLayout(floors).levels;
  for (const s of [NaN, -3, undefined, null, 'x']) {
    const { levels } = facadeLayout(floors, s);
    assert.deepEqual(levels, base, String(s));
    assert.ok(levels.every(l => Number.isFinite(l.y) && Number.isFinite(l.carY)));
  }
});

test('keepLift: when the floors change the car stays at its level by key, never between levels', () => {
  const before = facadeLayout([floor('a', 2), floor('b', 5)]).levels;
  const after = facadeLayout([floor('z', 1), floor('a', 2), floor('b', 5)]).levels;
  const level = (ls, key) => ls.find(l => l.key === key);

  const parked = keepLift(createLift(level(before, 5)), after);
  assert.equal(parked.at, 5);
  assert.equal(parked.y, level(after, 5).carY, 'floor 5 moved up a level: the car moved with it');
  assert.equal(parked.moving, false);

  const gone = keepLift(createLift(level(before, 2)), facadeLayout([floor('b', 5)]).levels);
  assert.equal(gone.at, 'lobby', 'its floor closed: the car waits at the lobby');
  assert.equal(gone.y, 258);

  const riding = createLift(level(before, 'lobby'));
  callLift(riding, level(before, 5));
  stepLift(riding, 0.2);
  const y = riding.y;
  keepLift(riding, after);
  assert.equal(riding.moving, true);
  assert.equal(riding.to, 5);
  assert.equal(riding.y, y, 'no jump mid-ride');
  while (riding.moving) stepLift(riding, 0.05);
  assert.equal(riding.y, level(after, 5).carY, 'it arrives where floor 5 is now');

  const lost = createLift(level(before, 'lobby'));
  callLift(lost, level(before, 2));
  stepLift(lost, 0.1);
  keepLift(lost, facadeLayout([floor('b', 5)]).levels);
  assert.equal(lost.to, 'lobby', 'the floor it rode to closed: back to the lobby');
});
