import { DEMO_CAST } from './demo.js';
import { FLOOR, LOBBY } from './places.js';
import { viewOf } from './building.js';

export const SPOTS = FLOOR.spots;
export const AISLE_Y = FLOOR.aisleY;
export const DOOR = FLOOR.door;
const WALK_SPEED = 46;
const STREET_X = FLOOR.streetX;

export function assignHabit(rng = Math.random) {
  const r = rng();
  return r < 0.35 ? 'heavy' : r < 0.75 ? 'light' : 'none';
}

// In the building an agent has `place`, where it stands now ('floor:<project>', 'lobby' with its sidewalk, or
// 'terrace'; null while it rides the lift), and `dest`, the place of its spot. Spots are counted per dest.
// The README capture's single-room lounge has neither, so all its agents share one set of spots.
const isFloor = p => typeof p === 'string' && p.startsWith('floor:');
export const placeOf = v => (typeof v === 'string' ? v : v.view === 'floor' ? `floor:${v.project}` : v.view === 'terrace' ? 'terrace' : 'lobby');

function spotsFor(dest, state) {
  if (dest === undefined || isFloor(dest) || state === 'exit') return SPOTS[state];
  if (dest === 'terrace') return LOBBY.spots.smoke;
  return LOBBY.spots[state] ?? LOBBY.spots.wait;
}

// Rooms waiting in the lobby for their floor share one set of seats, whatever their state.
const waits = (dest, state) => dest === 'lobby' && state !== 'exit' && !LOBBY.spots[state];
const sameSeats = (dest, state, b) => b.dest === dest && (waits(dest, state) ? waits(b.dest, b.state) : b.state === state);
const occupants = (agents, agent, state, i, dest) => agents.filter(b => b !== agent && b.spot === i && sameSeats(dest, state, b)).length;

export function hasFreeSpot(agents, agent, state, dest = agent.dest) {
  const list = spotsFor(dest, state);
  return !!list && list.some((_, i) => occupants(agents, agent, state, i, dest) === 0);
}

export const STACK_DX = 9;

// Takes the first free spot. When every spot is taken it shares the least crowded one
// (ties go to the last) and sets agent.overflow so the caller can tell. An agent with `stacks`
// set stands agent.tier * STACK_DX px to the right on a shared spot, at least STACK_DX px from
// every other agent in that state, so a later-drawn neighbour never covers its whole hitbox.
export function takeSpot(agents, agent, state) {
  const list = spotsFor(agent.dest, state);
  agent.overflow = false;
  if (agent.stacks) agent.tier = 0;
  if (!list) return [agent.x, agent.y];
  const counts = list.map((_, i) => occupants(agents, agent, state, i, agent.dest));
  let best = counts.indexOf(0);
  if (best < 0) {
    best = list.length - 1;
    for (let i = list.length - 2; i >= 0; i--) if (counts[i] < counts[best]) best = i;
    agent.overflow = true;
  }
  agent.spot = best;
  if (!agent.stacks) return list[best];
  const [x0, y0] = list[best];
  // Measured against where the others stand or are heading (tx), not a count: a place freed by a
  // leaver is reused, and a tier never lands on the next spot over.
  const taken = agent.overflow ? agents.filter(b => b !== agent && sameSeats(agent.dest, state, b)).map(b => b.tx ?? b.x) : [];
  let k = 0;
  while (taken.some(x => Math.abs(x0 + STACK_DX * k - x) < STACK_DX)) k++;
  agent.tier = k;
  agent.tx = x0 + STACK_DX * k;
  return [agent.tx, y0];
}

// A blocked agent goes back to the table, or waits at the bar when every seat is taken.
// In the building, the table is on its own floor.
export function stateAfterAnswer(agents, agent, floors) {
  const dest = floors ? placeOf(viewOf({ state: 'work', info: agent.info }, floors)) : agent.dest;
  return hasFreeSpot(agents, agent, 'work', dest) ? 'work' : 'ready';
}

export function planPath(from, to, state) {
  const outside = p => p[0] < STREET_X;
  if (outside(from) && !outside(to)) return [DOOR, [FLOOR.doorLead, AISLE_Y], [to[0], AISLE_Y], to];
  if (!outside(from) && state === 'exit') return [[from[0], AISLE_Y], [FLOOR.doorLead, AISLE_Y], DOOR, FLOOR.exit];
  if (outside(from) && outside(to)) return [to];
  return [[from[0], AISLE_Y], [to[0], AISLE_Y], to];
}

export function moveTo(agents, agent, state, after = null) {
  const from = [agent.x, agent.y];
  agent.state = state;
  const to = takeSpot(agents, agent, state);
  agent.path = planPath(from, to, state).map(p => [...p]);
  agent.walking = true;
  agent.after = after;
}

// ---------- the building: walks inside a place, and rides between places ----------

const RIDE_SEC = 0.8;
const doorOf = p => (isFloor(p) ? FLOOR.elevator.door : p === 'terrace' ? LOBBY.terraceLift : LOBBY.lift);
const copy = path => path.map(p => (Array.isArray(p) ? [...p] : { ...p, to: [...p.to] }));

// A floor has no street: its paths keep to the aisle and the lift landing. The terrace has its own deck.
// The lobby is the old lounge's street side, so the door and the sidewalk work as they always did.
function routeIn(place, from, to) {
  const A = AISLE_Y;
  if (isFloor(place)) return [[from[0], A], [to[0], A], to];
  if (place === 'terrace') return [[from[0], LOBBY.terraceY], [to[0], LOBBY.terraceY], to];
  const out = p => p[0] < STREET_X;
  if (out(from) && out(to)) return [to];
  if (out(from)) return [DOOR, [FLOOR.doorLead, A], [to[0], A], to];
  if (out(to)) return [[from[0], A], [FLOOR.doorLead, A], DOOR, to];
  return [[from[0], A], [to[0], A], to];
}

// Walks to fromView's lift door, rides hidden, steps out at toView's and walks to its spot for agent.state.
// The spot is held from the start; `after` runs once, on the final arrival. An agent already riding
// (place null) just rides on to the new door.
export function changeView(agents, agent, fromView, toView, after = null) {
  const to = placeOf(toView), door = doorOf(to);
  const from = agent.place === null ? null : placeOf(fromView);
  agent.dest = to;
  const spot = takeSpot(agents, agent, agent.state);
  const out = from === null ? [] : routeIn(from, [agent.x, agent.y], doorOf(from));
  agent.path = copy([...out, { ride: RIDE_SEC, to: door, place: to }, ...routeIn(to, door, spot)]);
  agent.walking = true;
  agent.after = after;
}

// Leaving walks out of the place it is in: a lift door upstairs, the street door from the lobby. One riding
// just goes: stepAgents removes it on the next step and runs `after` then.
function leave(agent, after) {
  agent.after = after;
  if (agent.place === null) { agent.path = []; agent.walking = false; return; }
  agent.dest = agent.place;
  const to = agent.place === 'lobby' ? FLOOR.exit : doorOf(agent.place);
  agent.path = copy(routeIn(agent.place, [agent.x, agent.y], to));
  agent.walking = true;
}

// The building's moveTo: the state decides the place (viewOf), and a new place means a lift ride.
export function walkTo(agents, agent, state, floors, after = null) {
  agent.state = state;
  if (state === 'exit') { leave(agent, after); return; }
  const to = placeOf(viewOf(agent, floors));
  if (agent.place !== to) { changeView(agents, agent, agent.place ?? to, to, after); return; }
  agent.dest = to;
  const spot = takeSpot(agents, agent, state);
  agent.path = copy(routeIn(to, [agent.x, agent.y], spot));
  agent.walking = true;
  agent.after = after;
}

// Puts an agent straight at its spot in its place, as the first snapshot does.
export function seat(agents, agent, floors) {
  agent.place = agent.dest = placeOf(viewOf(agent, floors));
  const [x, y] = takeSpot(agents, agent, agent.state);
  Object.assign(agent, { x, y, path: [], walking: false, after: null });
  return agent;
}

// world: { agents, floors }. Without floors it is the README capture's single room.
export function go(world, agent, state, after = null) {
  if (world.floors) walkTo(world.agents, agent, state, world.floors, after);
  else moveTo(world.agents, agent, state, after);
}

// A new room comes in from the street.
export function walkIn(world, agent, state) {
  agent.x = FLOOR.exit[0]; agent.y = DOOR[1];
  if (world.floors) agent.place = agent.dest = 'lobby';
  go(world, agent, state);
}

// Points a walker at a new spot in the same state, keeping a lift ride it is on.
export function retarget(world, agent, to) {
  if (!world.floors) { agent.path = planPath([agent.x, agent.y], to, agent.state).map(p => [...p]); agent.walking = true; return; }
  const ride = agent.path.findIndex(p => !Array.isArray(p));
  agent.path = ride >= 0
    ? [...agent.path.slice(0, ride + 1), ...copy(routeIn(agent.dest, agent.path[ride].to, to))]
    : copy(routeIn(agent.place, [agent.x, agent.y], to));
  agent.walking = true;
}

// After the open floors change: everyone whose place moved (a floor opened or closed) walks there.
export function rehome(world) {
  const moved = [];
  for (const a of world.agents) {
    if (a.state === 'exit' || a.dest === undefined) continue;
    if (placeOf(viewOf(a, world.floors)) !== a.dest) { walkTo(world.agents, a, a.state, world.floors, a.after); moved.push(a); }
  }
  return moved;
}

// Advances walkers; removes agents that finished leaving and returns them. A ride step in the path hides
// the agent (place null) for its time, then sets it down at the next place's door; `lift` records the
// door it last used, so a scene can open it.
export function stepAgents(agents, dt, t) {
  const arrive = a => {
    a.walking = false;
    if (a.after) { const f = a.after; a.after = null; f(a, t); }
  };
  for (const a of agents) {
    if (!a.walking || !a.path.length) continue;
    const head = a.path[0];
    if (!Array.isArray(head)) {
      if (a.place !== null) { a.lift = { place: a.place, at: t }; a.place = null; a.ride = head.ride; }
      a.ride -= dt;
      if (a.ride > 1e-9) continue;
      [a.x, a.y] = head.to; a.place = head.place; a.lift = { place: head.place, at: t };
      a.path.shift();
      if (!a.path.length) arrive(a);
      continue;
    }
    const [tx, ty] = head;
    const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy), sp = WALK_SPEED * dt;
    if (Math.abs(dx) > 0.5) a.dir = dx > 0 ? 1 : -1;
    if (d <= sp) {
      a.x = tx; a.y = ty; a.path.shift();
      if (!a.path.length) arrive(a);
    } else { a.x += dx / d * sp; a.y += dy / d * sp; }
  }
  const gone = [];
  for (let i = agents.length - 1; i >= 0; i--) {
    const a = agents[i];
    if (a.state !== 'exit' || a.walking) continue;
    // Upstairs a leaver goes by the lift: its doors open behind it.
    if (a.place && a.place !== 'lobby') a.lift = { place: a.place, at: t };
    if (a.after) { const f = a.after; a.after = null; f(a, t); }
    gone.push(...agents.splice(i, 1));
  }
  return gone;
}

// --- ambient smoking (outside the terrace; never changes state or spot) ---

const AMBIENT = { work: 'seated', sleep: 'seated', queue: 'standing', coffee: 'standing', whisky: 'standing', visitor: 'standing', ready: 'standing' };
const DUTY = { heavy: 0.4, light: 0.15 };
const SESSION_MIN = 8, SESSION_MAX = 20;

function hash01(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// One session of 8-20 s per cycle, at a hashed offset; cycle length sets the duty.
export function ambientSmoke(agent, t) {
  const kind = AMBIENT[agent.state];
  const duty = DUTY[agent.habit];
  if (agent.walking || !kind || !duty) return null;
  const cycle = (SESSION_MIN + SESSION_MAX) / 2 / duty;
  const seed = Math.floor(agent.off * 1e6);
  const tt = t + agent.off * cycle;
  const k = Math.floor(tt / cycle), local = tt - k * cycle;
  const len = SESSION_MIN + (SESSION_MAX - SESSION_MIN) * hash01(seed, k * 2);
  const start = hash01(seed, k * 2 + 1) * (cycle - len);
  if (local < start || local >= start + len) return null;
  if (kind === 'seated') return 'cigLip';
  const c = (local - start) % 5.4;
  return c > 1.2 && c < 2.6 ? 'cigMouth' : 'cigHold';
}

const EMBER = { cigHold: [17, 23], cigMouth: [14, 11], cigLip: [13, 11] };

export function poseFor(a, t, cheerUntil = 0) {
  const blink = ((t * 0.37 + a.off) % 3.7) < 0.1;
  const pose = { la: 'down', ra: 'down', legs: 'stand', eyes: blink ? 'blink' : 'open', mouth: 'neutral', acc: null, cig: null };
  let bob = 0, flip = false, ember = null, steam = null;
  if (a.walking) {
    const f = Math.floor(t * 8 + a.off) % 4;
    pose.legs = f === 1 ? 'walk1' : f === 3 ? 'walk2' : 'stand'; bob = f % 2 ? -1 : 0; flip = a.dir < 0;
    if (a.state === 'blocked') pose.mouth = 'o';
    return { pose, bob, flip, ember, steam };
  }
  switch (a.state) {
    case 'queue': pose.la = 'hip'; if (((t + a.off) % 7) < 1.5) pose.eyes = 'blink'; break;
    case 'work': pose.legs = 'sit'; pose.la = 'forward'; pose.ra = 'forward'; pose.acc = 'cards'; if (((t + a.off) % 4) < 0.4) pose.mouth = 'smile'; break;
    case 'sleep': pose.legs = 'sit'; pose.eyes = 'closed'; break;
    case 'smoke': {
      const c = (t + a.off * 5) % 5.4; pose.la = 'hip';
      if (c > 1.2 && c < 2.6) { pose.ra = 'mouth'; pose.acc = 'cigMouth'; ember = EMBER.cigMouth; }
      else { pose.acc = 'cigHold'; ember = EMBER.cigHold; if (c > 2.6 && c < 3.5) pose.mouth = 'o'; }
      break;
    }
    case 'blocked': pose.ra = (Math.floor(t * 2.5) % 2) ? 'cheer' : 'half'; pose.mouth = 'o'; break;
    case 'boss': pose.legs = 'sit'; pose.acc = 'cigar'; ember = [13, 11]; pose.mouth = 'smile'; break;
    case 'visitor': pose.la = 'hip'; flip = false; break;
    case 'slot': pose.ra = (((t + a.off) % 2.8) < 0.35) ? 'half' : 'down'; break;
    case 'coffee': { const c = (t + a.off * 3) % 6; if (c < 1.3) { pose.ra = 'mouth'; pose.acc = 'cupMouth'; } else { pose.acc = 'cupHold'; steam = [16, 20]; } break; }
    case 'whisky': { const c = (t + a.off * 3) % 6; if (c < 1.4) { pose.ra = 'cheer'; pose.acc = 'glassCheer'; pose.mouth = 'smile'; } else pose.acc = 'glassHold'; break; }
    case 'ready': { const c = (t + a.off * 3) % 7; pose.legs = 'sit'; pose.mouth = 'smile';
      if (c < 1.2) { pose.ra = 'mouth'; pose.acc = 'drinkMouth'; } else pose.acc = 'drinkHold'; break; }
    case 'dance': {
      const f = Math.floor(t * 4 + a.off * 4) % 4; pose.la = f < 2 ? 'cheer' : 'down'; pose.ra = f < 2 ? 'down' : 'cheer';
      pose.legs = f % 2 ? 'dance1' : 'dance2'; pose.mouth = 'smile'; bob = f % 2 ? -1 : 0; break;
    }
  }
  const cig = ambientSmoke(a, t);
  if (cig) {
    pose.cig = cig; ember = EMBER[cig];
    // the right hand takes the cigarette, so a held drink is set down for the session
    if (cig !== 'cigLip') { pose.acc = null; steam = null; pose.ra = cig === 'cigMouth' ? 'mouth' : 'down'; }
  }
  if (cheerUntil > t && !['work', 'sleep', 'boss', 'blocked'].includes(a.state)) {
    pose.la = 'cheer'; pose.ra = 'cheer'; pose.mouth = 'smile'; pose.acc = null; pose.cig = null; ember = null; steam = null;
  }
  return { pose, bob, flip, ember, steam };
}

// `beat` is the music position in beats (null when silent); the musician bobs on it.
export function npcPose(n, t, ringUntil = 0, beat = null) {
  const blink = ((t * 0.37 + n.x) % 3.7) < 0.1;
  const pose = { la: 'down', ra: 'down', legs: 'stand', eyes: blink ? 'blink' : 'open', mouth: 'neutral', acc: null };
  let bob = 0, flip = false;
  if (n.kind === 'maitre') { pose.mouth = 'smile'; if (ringUntil > t) pose.ra = 'forward'; }
  if (n.kind === 'barman') { pose.ra = 'forward'; pose.la = 'forward'; }
  if (n.kind === 'dealer') { pose.la = 'forward'; pose.ra = (Math.floor(t * 1.6) % 2) ? 'forward' : 'half'; }
  if (n.kind === 'sax') { pose.acc = 'sax'; pose.ra = 'forward'; pose.la = 'forward'; pose.eyes = 'closed';
    bob = beat === null ? (Math.floor(t * 2) % 2 ? -1 : 0) : (beat - Math.floor(beat) < 0.5 ? -1 : 0); }
  if (n.kind === 'waiter') {
    const f = Math.floor(t * 8) % 4; pose.legs = f === 1 ? 'walk1' : f === 3 ? 'walk2' : 'stand';
    pose.ra = 'half'; pose.acc = 'tray'; flip = n.dir < 0; bob = f % 2 ? -1 : 0;
  }
  if (n.kind === 'bouncer') { pose.la = 'forward'; pose.ra = 'forward'; }
  return { pose, bob, flip };
}

export function addAgent(agents, { id, state, look, info, label, stacks }, rng = Math.random) {
  const uid = agents.reduce((m, b) => Math.max(m, b.uid), -1) + 1;
  const a = {
    uid, id, label: label || id, state,
    look: structuredClone(look), info: structuredClone(info || {}),
    x: 0, y: 0, path: [], spot: -1, off: rng() * 10, habit: assignHabit(rng), walking: false, dir: 1, after: null,
  };
  if (stacks) a.stacks = true;
  const [x, y] = takeSpot(agents, a, state);
  a.x = x; a.y = y;
  agents.push(a);
  return a;
}

export function createCast({ rng = Math.random, entries = DEMO_CAST } = {}) {
  const agents = [];
  for (const [id, state, look, info, label] of entries) addAgent(agents, { id, state, look, info, label }, rng);
  return agents;
}
