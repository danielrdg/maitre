// The building: which view an agent belongs to, the facade's levels, and the elevator car.

export const SCRATCH = 'scratch';

const ELSEWHERE = { blocked: 'lobby', smoke: 'terrace', queue: 'sidewalk' };

// A room with no project yet (still starting), or whose floor is not open yet, waits in the lobby.
export function viewOf(agent, floors = []) {
  const away = ELSEWHERE[agent.state];
  if (away) return { view: away };
  const project = agent.info?.project;
  return project && floors.some(f => f.project === project) ? { view: 'floor', project } : { view: 'lobby' };
}

export function defaultView(floors) {
  if (floors.length >= 2) return { view: 'facade' };
  if (floors.length === 1) return { view: 'floor', project: floors[0].project };
  return { view: 'lobby' };
}

// The mockup's facade: lobby 234–290, floors of 42 px above it, the roof (40 px) on top.
const LOBBY = { y: 234, h: 56 };
const FLOOR_H = 42;
const ROOF_H = 40;
const FITS = 4;
const CAR_H = 32;

// The whole building scrolls: 0 shows the lobby, maxScroll the roof. Each level's y includes the scroll.
export function facadeLayout(floors, scroll = 0) {
  const sorted = [...floors].sort((a, b) => a.floor - b.floor);
  const maxScroll = Math.max(0, sorted.length - FITS) * FLOOR_H;
  const s = Math.min(maxScroll, Math.max(0, +scroll || 0));
  const at = (y, h) => ({ y: y + s, h, carY: y + s + h - CAR_H });
  const levels = [{ kind: 'lobby', key: 'lobby', ...at(LOBBY.y, LOBBY.h) }];
  let y = LOBBY.y;
  for (const f of sorted) {
    y -= FLOOR_H;
    levels.push({ kind: 'floor', key: f.floor, project: f.project, floor: f.floor, theme: f.theme, locked: f.locked, ...at(y, FLOOR_H) });
  }
  levels.push({ kind: 'roof', key: 'roof', ...at(y - ROOF_H, ROOF_H) });
  return { levels, maxScroll };
}

// The car's y is its top edge, from a level's carY. Give it the levels at scroll 0, so scrolling mid-ride
// doesn't move it. The mockup rides .45 s per level, at least .4 s, eased in and out.
const SEC_PER_PX = 0.45 / FLOOR_H;
const MIN_RIDE = 0.4;
const ease = k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

const levelOnly = level => {
  if (!Number.isFinite(level?.carY)) throw new TypeError('the lift takes a level from facadeLayout');
};

export function createLift(level) {
  levelOnly(level);
  return { at: level.key, to: level.key, y: level.carY, from: level.carY, toY: level.carY, t: 0, dur: 0, moving: false };
}

export function callLift(lift, level) {
  levelOnly(level);
  Object.assign(lift, {
    to: level.key, from: lift.y, toY: level.carY, t: 0,
    dur: Math.max(MIN_RIDE, Math.abs(level.carY - lift.y) * SEC_PER_PX), moving: true,
  });
  return lift;
}

export function stepLift(lift, dt) {
  if (!lift.moving) return { arrived: false };
  lift.t += dt;
  // Summed frame times fall a hair short of dur; don't spend a frame on it.
  const k = lift.t >= lift.dur - 1e-9 ? 1 : lift.t / lift.dur;
  lift.y = lift.from + (lift.toY - lift.from) * ease(k);
  if (k < 1) return { arrived: false };
  Object.assign(lift, { y: lift.toY, at: lift.to, moving: false });
  return { arrived: true };
}

// After the open floors change, `levels` from facadeLayout(newFloors, 0): the car keeps to its level by key.
// Parked, it is set down at that level's new height; riding, it is retargeted from where it is. A level that
// closed sends it to the lobby. Returns the lift to use from now on.
export function keepLift(lift, levels) {
  const key = lift.moving ? lift.to : lift.at;
  const level = levels.find(l => l.key === key) ?? levels[0];
  return lift.moving ? callLift(lift, level) : createLift(level);
}
