import { mulberry32 } from './rng.js';
import { SLOT_X } from './scene-static.js';
import { createCast, addAgent, moveTo, stepAgents } from './agents.js';
import { createSlot, stepSlot, maybeAutoSpin } from './slots.js';
import { createParticles, stepParticles, emitFirework } from './particles.js';
import { DingScheduler } from './timing.js';
import { BLOCKS, NEW_ROOM_NAMES, NEW_ROOM_INFO, STEPS, createNpcs } from './demo.js';

export const STEP = 1 / 30;
export const HAIR_STYLES = ['short', 'bob', 'long', 'spiky', 'bun'];
export const OUTFITS = ['shirt', 'jacket', 'dress'];

const QUIET = { ding() {}, noise() {}, thunk() {}, tick() {}, jackpot() {}, lose() {}, fanfare() {} };

export function makeRngs(seed) {
  if (seed === null || seed === undefined || seed === '' || !Number.isFinite(Number(seed))) return { rng: Math.random, fxRng: Math.random };
  const s = Number(seed) | 0;
  return { rng: mulberry32(s), fxRng: mulberry32(s ^ 0x5bd1e995) };
}

// `rng` drives the simulation (agents, slots, demo actions); `fxRng` only cosmetics
// (particles, flicker, sound), so drawing more or fewer frames never shifts the simulation.
export function createWorld({ demo = false, rng = Math.random, fxRng = Math.random } = {}) {
  return {
    agents: demo ? createCast({ rng }) : [],
    npcs: createNpcs(),
    slots: SLOT_X.map((x, i) => createSlot(x, i)),
    particles: createParticles(fxRng),
    hitboxes: [], frame: 0, rng, fxRng,
    ding: new DingScheduler(22),
    cheerUntil: 0, ringUntil: 0, fireworksUntil: 0, lastCard: 0,
  };
}

export function ringNow(world, tNow, sfx = QUIET) {
  world.ding.markRung(tNow); world.ringUntil = tNow + 1; sfx.ding();
}

// One fixed simulation step. hooks: { sfx, popup(x, y, key, small), onGone(agent) }.
export function stepWorld(world, dt, tNow, hooks = {}) {
  const { agents, rng, fxRng } = world;
  const sfx = hooks.sfx || QUIET;
  world.frame++;
  for (const a of stepAgents(agents, dt, tNow)) hooks.onGone?.(a);
  const w = world.npcs.find(n => n.kind === 'waiter');
  w.x += w.dir * 22 * dt; if (w.x > 520) w.dir = -1; if (w.x < 120) w.dir = 1;
  if (tNow - world.lastCard > 0.9) {
    world.lastCard = tNow;
    const ws = agents.filter(a => a.state === 'work' && !a.walking);
    if (ws.length) {
      const a = ws[fxRng() * ws.length | 0];
      world.particles.parts.push({ k: 'card', x0: a.x, y0: a.y - 14, x1: 176 + fxRng() * 118, y1: 226 + fxRng() * 4, x: a.x, y: a.y - 14, life: 0, max: 99 });
    }
  }
  const blocked = agents.filter(a => a.state === 'blocked' && !a.walking).length;
  if (world.ding.shouldRing(tNow, blocked)) { world.ringUntil = tNow + 1; sfx.ding(); }
  if (world.fireworksUntil > tNow && fxRng() < 0.07) { emitFirework(world.particles); sfx.noise(0.2, 0.04); }
  world.slots.forEach((s, i) => {
    const occupied = agents.some(a => a.state === 'slot' && a.spot === i && !a.walking);
    maybeAutoSpin(s, tNow, occupied, rng);
    const outcome = stepSlot(s, tNow);
    for (const ev of s.events) { if (ev === 'stop') sfx.thunk(); else if (fxRng() < 0.5) sfx.tick(); }
    s.events.length = 0;
    if (outcome === 'jackpot') {
      sfx.jackpot(); hooks.popup?.(s.x + 14, 150, 'pop.jackpot');
      for (let k = 0; k < 40; k++) world.particles.parts.push({ k: 'coin', x: s.x + 14, y: 192, vx: (fxRng() - 0.5) * 3, vy: -1.5 - fxRng() * 2.5, life: 0, max: 160, floor: 236 + fxRng() * 6 });
    } else if (outcome === 'lose') { sfx.lose(); hooks.popup?.(s.x + 14, 150, 'pop.lose', true); }
  });
  stepParticles(world.particles);
}

// The demo menu. hooks: { sfx, popup, later(fn, seconds) }.
export function demoActions(world, hooks = {}) {
  const { agents, rng } = world;
  const sfx = hooks.sfx || QUIET;
  const later = hooks.later || ((fn, sec) => setTimeout(fn, sec * 1000));
  let blockIndex = 0, newIndex = 0;
  return {
    block() {
      const ws = agents.filter(a => a.state === 'work' && !a.walking);
      if (!ws.length || agents.filter(a => a.state === 'blocked').length >= 2) { hooks.popup?.(246, 240, 'pop.receptionFull', true); return; }
      const a = ws[rng() * ws.length | 0];
      a.info.block = structuredClone(BLOCKS[blockIndex++ % BLOCKS.length]);
      a.info.steps = [...(a.info.steps || []), STEPS.blocked];
      moveTo(agents, a, 'blocked', (ag, tArrive) => ringNow(world, tArrive, sfx));
    },
    merge(tNow) {
      const w = agents.find(a => a.state === 'whisky' && !a.walking);
      world.fireworksUntil = tNow + 6; world.cheerUntil = tNow + 2.5;
      sfx.fanfare(); hooks.popup?.(400, 120, 'pop.merge');
      if (w) {
        w.info.steps = [...(w.info.steps || []), STEPS.merged];
        moveTo(agents, w, 'dance', ag => later(() => moveTo(agents, ag, 'exit'), 9));
      }
      const old = agents.find(a => a.state === 'dance' && a !== w && !a.walking);
      if (old) moveTo(agents, old, 'exit');
    },
    newRoom() {
      const name = NEW_ROOM_NAMES[newIndex++ % NEW_ROOM_NAMES.length];
      const front = agents.filter(a => a.state === 'queue' && !a.walking).sort((p, q) => q.x - p.x)[0];
      const look = { model: 'queued', skin: rng() * 5 | 0, hair: rng() * 7 | 0, hs: HAIR_STYLES[rng() * 5 | 0], outfit: OUTFITS[rng() * 3 | 0] };
      const nw = addAgent(agents, { id: name, state: 'queue', look, info: NEW_ROOM_INFO() }, rng);
      nw.x = -30; moveTo(agents, nw, 'queue');
      if (front && agents.filter(a => a.state === 'coffee').length < 2) {
        later(() => {
          front.look = { ...front.look, model: rng() < 0.5 ? 'sonnet' : 'opus' };
          front.info.steps = [...(front.info.steps || []), STEPS.admitted];
          moveTo(agents, front, 'coffee');
          later(() => agents.filter(a => a.state === 'queue' && !a.walking).forEach(a => moveTo(agents, a, 'queue')), 0.6);
        }, 1.2);
      }
    },
  };
}
