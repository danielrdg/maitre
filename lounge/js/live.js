import { mulberry32 } from './rng.js';
import { addAgent, moveTo, hasFreeSpot, DOOR } from './agents.js';
import { HAIR_STYLES, OUTFITS } from './sim.js';
import { DingScheduler } from './timing.js';
import { t } from './i18n.js';

// Live mode: rooms streamed by the daemon over SSE become lounge agents.

const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const LIVE_STATES = ['coffee', 'work', 'smoke', 'blocked', 'ready', 'whisky', 'exit'];

const colorKey = model => (MODELS.includes(model) ? model : 'queued');
const liveState = state => (LIVE_STATES.includes(state) ? state : 'work');

export function roomToAgents(room) {
  const id = String(room.room);
  const info = { task: room.task, steps: [...(room.steps || [])], where: id, since: room.since, live: true };
  if (room.block) info.block = structuredClone(room.block);
  return {
    main: { id, label: id, model: colorKey(room.model), state: liveState(room.state), info },
    subagents: (room.subagents || []).map(s => {
      // A subagent seen only through its Agent tool result has no type yet.
      const type = s.type || 'subagent';
      return { id: `${id}/${s.id}`, label: `${id} ↳ ${type}`, model: colorKey(s.model), state: 'slot', info: { task: type, steps: [], where: id, live: true } };
    }),
  };
}

export function diffRooms(prevIds, nextIds) {
  const prev = new Set(prevIds), next = new Set(nextIds);
  return {
    add: [...next].filter(id => !prev.has(id)),
    remove: [...prev].filter(id => !next.has(id)),
    keep: [...next].filter(id => prev.has(id)),
  };
}

// Seeded by the id, so a room looks the same after a reload or a reconnect.
export function lookFor(id, model) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  const r = mulberry32(h);
  return { model, skin: r() * 5 | 0, hair: r() * 7 | 0, hs: HAIR_STYLES[r() * 5 | 0], outfit: OUTFITS[r() * 3 | 0] };
}

// Applies snapshots and room events to world.agents. Each call returns the agents it touched.
export function createLiveCast(world) {
  const { agents } = world;
  const mains = new Map();
  const subs = new Map();
  let seated = false;

  // takeSpot only runs on a state change, so an agent sharing a full spot stays off to its side
  // until a spot frees up. hasFreeSpot ignores the agent itself, so the freed spot can be its own:
  // then it only sidesteps onto it instead of walking out to the aisle and back.
  const resettle = (b, state) => {
    const spot = b.spot, walking = b.walking;
    moveTo(agents, b, state);
    if (walking || b.spot !== spot) return;
    const to = b.path[b.path.length - 1];
    b.path = to[0] === b.x && to[1] === b.y ? [] : [to];
    b.walking = b.path.length > 0;
  };
  const reseat = state => {
    for (const b of agents) if (b.state === state && b.overflow && hasFreeSpot(agents, b, state)) resettle(b, state);
  };
  const shift = (a, state) => { const from = a.state; moveTo(agents, a, state); reseat(from); };

  // An agent sent to the street leaves the maps at once, so a reopened room gets a fresh walker.
  const leave = a => { if (a.state !== 'exit') shift(a, 'exit'); return a; };

  function drop(id) {
    const gone = [...(mains.has(id) ? [mains.get(id)] : []), ...(subs.get(id)?.values() ?? [])].map(leave);
    mains.delete(id); subs.delete(id);
    return gone;
  }

  function place(spec, walkIn) {
    const a = addAgent(agents, { id: spec.id, label: spec.label, state: spec.state, look: lookFor(spec.id, spec.model), info: spec.info, stacks: true }, world.rng);
    a.liveId = spec.id;
    if (walkIn) { a.x = -30; a.y = DOOR[1]; moveTo(agents, a, spec.state); }
    return a;
  }

  function update(a, spec) {
    a.label = spec.label;
    a.info = structuredClone(spec.info);
    if (a.look.model !== spec.model) a.look = { ...a.look, model: spec.model };
    if (a.state !== spec.state) shift(a, spec.state);
    return a;
  }

  function apply(room, walkIn) {
    const { main, subagents } = roomToAgents(room);
    if (main.state === 'exit') return drop(main.id);
    const a = mains.has(main.id) ? update(mains.get(main.id), main) : place(main, walkIn);
    mains.set(main.id, a);
    const prev = subs.get(main.id) ?? new Map(), next = new Map();
    for (const s of subagents) {
      if (next.has(s.id)) continue;
      next.set(s.id, prev.has(s.id) ? update(prev.get(s.id), s) : place(s, walkIn));
    }
    const gone = [...prev].filter(([id]) => !next.has(id)).map(([, b]) => leave(b));
    subs.set(main.id, next);
    return [a, ...next.values(), ...gone];
  }

  return {
    // The first snapshot seats the rooms that were already there; after that, arrivals walk in.
    snapshot(rooms) {
      const walkIn = seated; seated = true;
      const open = rooms.filter(r => r.state !== 'exit');
      const { remove } = diffRooms([...mains.keys()], open.map(r => String(r.room)));
      return [...remove.flatMap(drop), ...open.flatMap(r => apply(r, walkIn))];
    },
    room: room => apply(room, true),
    ids: () => [...mains.keys()],
  };
}

// Follows room events, not the render loop: a hidden tab pauses requestAnimationFrame, and a
// blocked room must still ring. The caller ticks it from a wall-clock timer.
export function createBell({ ring, ding = new DingScheduler(22) }) {
  let blocked = new Set();
  const ringAt = tNow => { ding.markRung(tNow); ring(tNow); };
  return {
    snapshot(rooms, tNow) {
      ding.muted = false;
      const next = new Set(rooms.filter(r => r.state === 'blocked').map(r => r.room));
      const fresh = [...next].some(id => !blocked.has(id));
      blocked = next;
      if (fresh) ringAt(tNow);
    },
    room(r, tNow) {
      const was = blocked.has(r.room);
      if (r.state === 'blocked') blocked.add(r.room); else blocked.delete(r.room);
      if (!was && r.state === 'blocked') ringAt(tNow);
    },
    tick(tNow) { if (ding.shouldRing(tNow, blocked.size)) ring(tNow); },
    // The stream is gone for good: nothing would ever clear the block, so stop repeating. Muting the
    // scheduler also silences the render loop when it shares it.
    disconnect() { ding.muted = true; },
    get disconnected() { return ding.muted; },
    get count() { return blocked.size; },
  };
}

export function titleFor(blocked, lang = 'en', { disconnected = false } = {}) {
  if (disconnected) return t('title.disconnected', lang);
  if (blocked > 0) return t(blocked === 1 ? 'title.blocked.one' : 'title.blocked.many', lang, { n: blocked });
  return t('page.title', lang);
}

const parse = data => { try { return JSON.parse(data); } catch { return null; } };
const isRoom = r => !!r && typeof r === 'object' && typeof r.room === 'string' && typeof r.state === 'string';

// On error the browser's EventSource retries by itself and the cast stays until the next snapshot.
// A CLOSED source (e.g. 403 after the lounge restarted with a new token) never comes back.
export class LiveSource {
  constructor(url, onSnapshot, onRoom, { EventSource = globalThis.EventSource, onClosed = () => {} } = {}) {
    this.url = url; this.onSnapshot = onSnapshot; this.onRoom = onRoom; this.onClosed = onClosed; this.ES = EventSource; this.es = null;
  }

  start() {
    if (this.es || !this.ES) return;
    const es = this.es = new this.ES(this.url);
    es.addEventListener('snapshot', e => {
      const d = parse(e.data);
      if (d && Array.isArray(d.rooms)) this.onSnapshot(d.rooms.filter(isRoom));
    });
    es.addEventListener('room', e => {
      const r = parse(e.data);
      if (isRoom(r)) this.onRoom(r);
    });
    es.addEventListener('error', () => { if (es.readyState === 2) this.onClosed(); });
  }

  stop() {
    this.es?.close();
    this.es = null;
  }
}
