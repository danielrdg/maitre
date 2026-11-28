import { defaultView, facadeLayout, createLift, callLift, stepLift, keepLift } from './building.js';
import { musicFor } from './themes.js';

// Which view is on screen, the facade's scroll and the lift: the navigation, without the DOM.
// A view is { view: 'facade' } | { view: 'floor', project } | { view: 'lobby' }. A level key is a floor number,
// 'lobby' or 'roof'. A ride is a token { key, id, then }; its arrival opens the view only while it is still
// the latest arrival, the facade is on screen and the car stands at its level.

export function createNav(floors = [], view = defaultView(floors)) {
  return {
    floors, view, lift: createLift(facadeLayout(floors, 0).levels[0]), ride: null, arrival: null, seq: 0,
    scroll: 0, focus: null, lastFloor: null, userMoved: false,
    // Until a non-empty floor list arrives, the first one still picks the default view.
    settled: floors.length > 0,
  };
}

const levelsOf = nav => facadeLayout(nav.floors, 0).levels;
export const floorOf = (nav, project) => nav.floors.find(f => f.project === project);
export const keyOfView = (nav, v = nav.view) => (v.view === 'floor' ? floorOf(nav, v.project)?.floor ?? null : v.view === 'lobby' ? 'lobby' : null);
export function viewOfKey(nav, key) {
  if (key === 'lobby' || key === 'roof') return { view: 'lobby' };
  const f = nav.floors.find(x => x.floor === key);
  return f ? { view: 'floor', project: f.project } : defaultView(nav.floors);
}
// Kept fractional, so small wheel deltas add up; the facade rounds it when it draws.
export const clampScroll = (nav, v) => Math.min(facadeLayout(nav.floors, 0).maxScroll, Math.max(0, +v || 0));
// The lift button to light: where the car is going, else the level on screen, else where it stands.
export const liftHere = nav => (nav.lift.moving ? nav.lift.to : keyOfView(nav) ?? nav.lift.at);

// The theme that sets the musician's default: a floor's own, the hall's in the lobby. The facade and the lift
// have none, so a ride keeps the music that is playing.
export function themeOfView(nav) {
  if (nav.view.view === 'floor') return floorOf(nav, nav.view.project)?.theme ?? 'hall';
  return nav.view.view === 'lobby' ? 'hall' : null;
}
export const musicOfView = nav => { const th = themeOfView(nav); return th ? musicFor(th) : null; };

export function show(nav, v) {
  nav.view = v;
  nav.arrival = null;
  if (v.view === 'floor') { nav.lastFloor = v.project; nav.focus = floorOf(nav, v.project)?.floor ?? nav.focus; }
}

// The user did something here (opened the reception, typed, clicked the canvas): the first floors no longer move them.
export function userActs(nav) { nav.userMoved = true; }

export function floorButton(nav) {
  const p = floorOf(nav, nav.lastFloor) ? nav.lastFloor : nav.floors[0]?.project;
  return p ? { view: 'floor', project: p } : null;
}

// Rides the car to a level on the facade. From another view the car starts at that view's level.
export function rideTo(nav, key, then = null) {
  const L = levelsOf(nav), target = L.find(l => l.key === key);
  if (!target) return false;
  nav.userMoved = true;
  if (nav.view.view !== 'facade') {
    const here = L.find(l => l.key === keyOfView(nav));
    if (here && !nav.lift.moving) nav.lift = createLift(here);
    show(nav, { view: 'facade' });
    nav.scroll = clampScroll(nav, 150 - nav.lift.y);
  }
  if (typeof key === 'number') nav.focus = key;
  callLift(nav.lift, target);
  nav.ride = { key, id: ++nav.seq, then };
  nav.arrival = null;
  return true;
}

// Steps the car. On arrival returns the ride it completed (null if the car was only re-seated).
export function stepNav(nav, dt) {
  if (!stepLift(nav.lift, dt).arrived) return { arrived: false, ride: null };
  const r = nav.ride;
  nav.ride = null;
  nav.arrival = r;
  return { arrived: true, ride: r };
}

// The view a ride opens when its doors have opened, or null when something moved on meanwhile.
export function landing(nav, token) {
  if (!token || nav.arrival !== token || nav.view.view !== 'facade' || nav.lift.moving || nav.lift.at !== token.key) return null;
  nav.arrival = null;
  return viewOfKey(nav, token.key);
}

// While the car rides on the facade, the facade follows it.
export function follow(nav) {
  if (!nav.lift.moving || nav.view.view !== 'facade') return;
  const y = nav.lift.y + nav.scroll;
  if (y < 40) nav.scroll = clampScroll(nav, 40 - nav.lift.y);
  else if (y > 250) nav.scroll = clampScroll(nav, 250 - nav.lift.y);
}

// A new floor list. The car keeps to its level by key; a ride or an arrival whose level closed is dropped.
// Returns the view to switch to: the default view when the floor on screen closed, or the first time floors
// appear (unless the user already moved, or `hold`: the reception box is open or its reply pending); else null.
const sameLevels = (a, b) => a.length === b.length && a.every((f, i) => f.project === b[i].project && f.floor === b[i].floor);

export function applyFloors(nav, floors, { hold = false } = {}) {
  // Only themes changed: the levels are the same, so the car, the ride and the scroll stay as they are.
  if (nav.settled && sameLevels(nav.floors, floors)) { nav.floors = floors; return null; }
  nav.floors = floors;
  const L = levelsOf(nav), open = key => L.some(l => l.key === key);
  nav.lift = keepLift(nav.lift, L);
  if (nav.ride && !open(nav.ride.key)) nav.ride = null;
  if (nav.arrival && !open(nav.arrival.key)) nav.arrival = null;
  nav.scroll = clampScroll(nav, nav.scroll);
  if (nav.view.view === 'floor' && !floorOf(nav, nav.view.project)) return defaultView(floors);
  if (!nav.settled && floors.length) {
    nav.settled = true;
    if (!nav.userMoved && !hold) return defaultView(floors);
  }
  return null;
}
