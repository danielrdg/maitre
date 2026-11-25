import { DEMO_CAST } from './demo.js';

export const SPOTS = {
  queue: [[20, 302], [40, 302], [60, 302], [-6, 302], [-26, 302], [-46, 302]],
  work: [[186, 238], [210, 238], [260, 238], [284, 238], [162, 238]],
  smoke: [[538, 236], [566, 236]],
  blocked: [[300, 314], [322, 314]],
  visitor: [[470, 238]],
  boss: [[496, 192]],
  slot: [[314, 238], [345, 238]],
  coffee: [[378, 242], [400, 242]],
  whisky: [[454, 242], [432, 242]],
  ready: [[394, 219], [452, 219]],
  sleep: [[136, 199]],
  dance: [[364, 306], [402, 316], [440, 306]],
};

export const AISLE_Y = 266;
export const DOOR = [94, 302];
const WALK_SPEED = 46;
const STREET_X = 86;

export function assignHabit(rng = Math.random) {
  const r = rng();
  return r < 0.35 ? 'heavy' : r < 0.75 ? 'light' : 'none';
}

const occupants = (agents, agent, state, i) => agents.filter(b => b !== agent && b.state === state && b.spot === i).length;

export function hasFreeSpot(agents, agent, state) {
  const list = SPOTS[state];
  return !!list && list.some((_, i) => occupants(agents, agent, state, i) === 0);
}

// Takes the first free spot. When every spot is taken it shares the least crowded one
// (ties go to the last) and sets agent.overflow so the caller can tell.
export function takeSpot(agents, agent, state) {
  const list = SPOTS[state];
  agent.overflow = false;
  if (!list) return [agent.x, agent.y];
  const counts = list.map((_, i) => occupants(agents, agent, state, i));
  let best = counts.indexOf(0);
  if (best < 0) {
    best = list.length - 1;
    for (let i = list.length - 2; i >= 0; i--) if (counts[i] < counts[best]) best = i;
    agent.overflow = true;
  }
  agent.spot = best;
  return list[best];
}

// A blocked agent goes back to the table, or waits at the bar when every seat is taken.
export function stateAfterAnswer(agents, agent) {
  return hasFreeSpot(agents, agent, 'work') ? 'work' : 'ready';
}

export function planPath(from, to, state) {
  const outside = p => p[0] < STREET_X;
  if (outside(from) && !outside(to)) return [DOOR, [118, AISLE_Y], [to[0], AISLE_Y], to];
  if (!outside(from) && state === 'exit') return [[from[0], AISLE_Y], [118, AISLE_Y], DOOR, [-30, 302]];
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

// Advances walkers; removes agents that finished leaving and returns them.
export function stepAgents(agents, dt, t) {
  for (const a of agents) {
    if (!a.walking || !a.path.length) continue;
    const [tx, ty] = a.path[0];
    const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy), sp = WALK_SPEED * dt;
    if (Math.abs(dx) > 0.5) a.dir = dx > 0 ? 1 : -1;
    if (d <= sp) {
      a.x = tx; a.y = ty; a.path.shift();
      if (!a.path.length) {
        a.walking = false;
        if (a.after) { const f = a.after; a.after = null; f(a, t); }
      }
    } else { a.x += dx / d * sp; a.y += dy / d * sp; }
  }
  const gone = [];
  for (let i = agents.length - 1; i >= 0; i--) {
    if (agents[i].state === 'exit' && !agents[i].walking) gone.push(...agents.splice(i, 1));
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

export function addAgent(agents, { id, state, look, info, label }, rng = Math.random) {
  const uid = agents.reduce((m, b) => Math.max(m, b.uid), -1) + 1;
  const a = {
    uid, id, label: label || id, state,
    look: structuredClone(look), info: structuredClone(info || {}),
    x: 0, y: 0, path: [], spot: -1, off: rng() * 10, habit: assignHabit(rng), walking: false, dir: 1, after: null,
  };
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
