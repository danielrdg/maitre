import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNav, rideTo, stepNav, landing, applyFloors, show, keyOfView, floorButton, liftHere, themeOfView, musicOfView, userActs } from '../../lounge/js/views.js';
import { facadeLayout } from '../../lounge/js/building.js';
import { MusicController } from '../../lounge/js/music.js';
import { createWorld } from '../../lounge/js/sim.js';
import { rehome } from '../../lounge/js/agents.js';
import { mulberry32 } from '../../lounge/js/rng.js';
import { demoFloors } from '../../lounge/js/demo.js';

const fl = (project, floor, theme = 'hall') => ({ project, floor, theme, locked: false });
const F = [fl('webshop', 1), fl('api', 2), fl('docs', 3)];
const ride = (nav, max = 400) => { for (let i = 0; i < max; i++) { const r = stepNav(nav, 1 / 30); if (r.arrived) return r; } return null; };

test('a ride from a floor view starts at that floor, on the facade, and opens the floor it reached', () => {
  const nav = createNav(F, { view: 'floor', project: 'api' });
  assert.equal(keyOfView(nav), 2);
  assert.equal(rideTo(nav, 3), true);
  assert.deepEqual(nav.view, { view: 'facade' });
  assert.equal(nav.lift.from, nav.lift.y, 'from the floor the user was on');
  assert.equal(nav.focus, 3);
  assert.equal(liftHere(nav), 3, 'the button of the level ridden to is lit');
  const r = ride(nav);
  assert.equal(r.ride.key, 3);
  assert.deepEqual(landing(nav, r.ride), { view: 'floor', project: 'docs' });
  assert.equal(landing(nav, r.ride), null, 'opens once');
  assert.equal(rideTo(nav, 99), false, 'no such level');
});

test('a ride that arrives before an earlier arrival opens its view does not let the earlier one open', () => {
  const nav = createNav(F, { view: 'facade' });
  rideTo(nav, 1);
  const first = ride(nav).ride;
  rideTo(nav, 3);
  assert.equal(landing(nav, first), null, 'superseded while riding');
  const second = ride(nav).ride;
  assert.equal(landing(nav, first), null, 'the first timer fires late: still nothing');
  assert.deepEqual(landing(nav, second), { view: 'floor', project: 'docs' });
});

test('an arrival opens nothing once the user left the facade or the car moved on', () => {
  const nav = createNav(F, { view: 'facade' });
  rideTo(nav, 2);
  const r = ride(nav).ride;
  show(nav, { view: 'lobby' });
  assert.equal(landing(nav, r), null);
  const nav2 = createNav(F, { view: 'facade' });
  rideTo(nav2, 2);
  const r2 = ride(nav2).ride;
  nav2.lift.at = 1;
  assert.equal(landing(nav2, r2), null, 'the car is no longer at that level');
});

test('the lobby and the roof both open the lobby + terrace view', () => {
  const nav = createNav(F, { view: 'facade' });
  rideTo(nav, 'roof');
  assert.deepEqual(landing(nav, ride(nav).ride), { view: 'lobby' });
  rideTo(nav, 'lobby');
  assert.deepEqual(landing(nav, ride(nav).ride), { view: 'lobby' });
});

test('an empty first floor list keeps the lobby; the first non-empty one picks the default view', () => {
  const nav = createNav([], { view: 'lobby' });
  assert.equal(applyFloors(nav, []), null);
  assert.deepEqual(applyFloors(nav, [fl('api', 1)]), { view: 'floor', project: 'api' });
  assert.equal(applyFloors(nav, [fl('api', 1), fl('web', 2)]), null, 'only the first time');
});

test('the first floors leave the view alone once the user has navigated', () => {
  const nav = createNav([], { view: 'lobby' });
  nav.userMoved = true;
  assert.equal(applyFloors(nav, [fl('api', 1), fl('web', 2)]), null);
});

test('the first floor leaves the user in the lobby once they opened the reception, typed or clicked the canvas', () => {
  const nav = createNav([], { view: 'lobby' });
  userActs(nav);
  assert.equal(applyFloors(nav, [fl('api', 1)]), null);
  assert.deepEqual(nav.view, { view: 'lobby' });
  assert.equal(applyFloors(nav, [fl('api', 1), fl('web', 2)]), null, 'nor later');
});

test('no first-floor switch while the reception box is open or its reply is pending, and none afterwards', () => {
  const nav = createNav([], { view: 'lobby' });
  assert.equal(applyFloors(nav, [fl('api', 1)], { hold: true }), null);
  assert.deepEqual(nav.view, { view: 'lobby' });
  assert.equal(nav.settled, true, 'the first floors were seen');
  assert.equal(applyFloors(nav, [fl('api', 1), fl('web', 2)]), null, 'the reply came: still no yank');
});

test('an unsettled navigation still picks the default view when the list it gets equals the one it holds', () => {
  const nav = createNav([], { view: 'lobby' });
  nav.floors = [fl('api', 1)];
  assert.deepEqual(applyFloors(nav, [fl('api', 1)]), { view: 'floor', project: 'api' });
});

test('a floor opening or closing below the ride\'s level mid-ride re-seats the car on that level\'s new place', () => {
  for (const next of [[fl('webshop', 1), fl('api', 2), fl('docs', 3)], [fl('docs', 3)]]) {
    const nav = createNav([fl('webshop', 1), fl('docs', 3)], { view: 'facade' });
    rideTo(nav, 3);
    for (let i = 0; i < 5; i++) stepNav(nav, 1 / 30);
    assert.equal(applyFloors(nav, next), null);
    const want = facadeLayout(next, 0).levels.find(l => l.key === 3).carY;
    assert.equal(nav.lift.toY, want, `${next.length} floors: heading for floor 3's new place`);
    const r = ride(nav);
    assert.equal(r.ride.key, 3);
    assert.equal(nav.lift.y, want);
    assert.deepEqual(landing(nav, r.ride), { view: 'floor', project: 'docs' });
  }
});

test('a floor that closes under the user gives way to the default view; a ride to it is dropped', () => {
  const nav = createNav(F, { view: 'floor', project: 'docs' });
  assert.deepEqual(applyFloors(nav, [fl('webshop', 1), fl('api', 2)]), { view: 'facade' });
  const nav2 = createNav(F, { view: 'facade' });
  rideTo(nav2, 3);
  stepNav(nav2, 0.1);
  applyFloors(nav2, [fl('webshop', 1), fl('api', 2)]);
  assert.equal(nav2.ride, null);
  assert.equal(nav2.lift.to, 'lobby', 'the car goes back down');
  const r = ride(nav2);
  assert.equal(r.ride, null, 'an arrival with no ride opens nothing');
});

test('the floor button opens the last floor shown, or the first one', () => {
  const nav = createNav(F, { view: 'lobby' });
  assert.deepEqual(floorButton(nav), { view: 'floor', project: 'webshop' });
  show(nav, { view: 'floor', project: 'docs' });
  show(nav, { view: 'lobby' });
  assert.deepEqual(floorButton(nav), { view: 'floor', project: 'docs' });
  applyFloors(nav, [fl('webshop', 1)]);
  assert.deepEqual(floorButton(nav), { view: 'floor', project: 'webshop' }, 'its floor closed');
  assert.equal(floorButton(createNav([], { view: 'lobby' })), null);
});

test('leaving the facade and coming back before the doors open drops the old arrival', () => {
  const nav = createNav(F, { view: 'facade' });
  rideTo(nav, 2);
  const r = ride(nav).ride;
  show(nav, { view: 'floor', project: 'docs' });
  show(nav, { view: 'facade' });
  assert.equal(landing(nav, r), null, 'the user moved on: the old ride opens nothing');
  assert.deepEqual(nav.view, { view: 'facade' });
});

test('the theme of the view: a floor wears its own, the lobby the hall, the facade none', () => {
  const nav = createNav([fl('webshop', 1, 'casino'), fl('api', 2, 'deco')], { view: 'floor', project: 'webshop' });
  assert.equal(themeOfView(nav), 'casino');
  assert.equal(musicOfView(nav), 'house');
  show(nav, { view: 'floor', project: 'api' });
  assert.equal(themeOfView(nav), 'deco');
  show(nav, { view: 'lobby' });
  assert.equal(themeOfView(nav), 'hall');
  assert.equal(musicOfView(nav), 'jazz');
  show(nav, { view: 'facade' });
  assert.equal(themeOfView(nav), null, 'the facade and the lift keep the music that is playing');
  assert.equal(musicOfView(nav), null);
});

test('a ride between two house floors through the facade never passes through jazz', () => {
  const nav = createNav([fl('webshop', 1, 'casino'), fl('api', 2, 'deco'), fl('docs', 3, 'karaoke')], { view: 'floor', project: 'webshop' });
  const m = new MusicController(() => null, { timers: { setInterval: () => ({}), clearInterval() {}, setTimeout() {} } });
  m.setDefault(musicOfView(nav));
  m.pick('house');
  assert.equal(m.picked, false, 'following the theme');
  const heard = [m.style];
  rideTo(nav, 3);
  m.setDefault(musicOfView(nav)); heard.push(m.style);
  let r;
  for (let i = 0; i < 400 && !(r = stepNav(nav, 1 / 30)).arrived; i++) { m.setDefault(musicOfView(nav)); heard.push(m.style); }
  show(nav, landing(nav, r.ride));
  m.setDefault(musicOfView(nav)); heard.push(m.style);
  assert.deepEqual(nav.view, { view: 'floor', project: 'docs' });
  assert.ok(heard.every(st => st === 'house'), `heard ${[...new Set(heard)]}`);
  show(nav, { view: 'lobby' });
  m.setDefault(musicOfView(nav));
  assert.equal(m.style, 'jazz', 'the lobby still sets the hall');
});

test('a theme-only floor list leaves the view, the riding car and the agents alone', () => {
  const floors = [fl('webshop', 1, 'casino'), fl('api', 2, 'deco'), fl('docs', 3, 'karaoke')];
  const nav = createNav(floors, { view: 'facade' });
  rideTo(nav, 3);
  for (let i = 0; i < 5; i++) stepNav(nav, 1 / 30);
  const lift = { ...nav.lift }, ride = nav.ride, scroll = nav.scroll;
  const rethemed = floors.map(f => (f.project === 'api' ? { ...f, theme: 'tiki' } : f));
  assert.equal(applyFloors(nav, rethemed), null);
  assert.deepEqual(nav.view, { view: 'facade' });
  assert.deepEqual(nav.lift, lift, 'the car keeps riding, not restarted');
  assert.equal(nav.ride, ride);
  assert.equal(nav.scroll, scroll);
  assert.equal(nav.floors, rethemed);

  // The demo's own floor list, re-themed as the demo's button does.
  const world = createWorld({ demo: true, rng: mulberry32(4), fxRng: mulberry32(5), floors: demoFloors() });
  const before = world.agents.map(a => ({ uid: a.uid, x: a.x, y: a.y, place: a.place, dest: a.dest, state: a.state, walking: a.walking }));
  assert.ok(before.some(a => a.place === 'floor:api'));
  world.floors = demoFloors().map(f => (f.project === 'api' ? { ...f, theme: 'tiki' } : f));
  assert.deepEqual(rehome(world), [], 'nobody moves');
  assert.deepEqual(world.agents.map(a => ({ uid: a.uid, x: a.x, y: a.y, place: a.place, dest: a.dest, state: a.state, walking: a.walking })), before);
});
