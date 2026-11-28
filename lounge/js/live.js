import { mulberry32 } from './rng.js';
import { addAgent, hasFreeSpot, go, walkIn, seat, retarget, placeOf, SPOTS } from './agents.js';
import { HAIR_STYLES, OUTFITS } from './sim.js';
import { DingScheduler } from './timing.js';
import { t } from './i18n.js';
import { SCRATCH, viewOf } from './building.js';

// Live mode: rooms streamed by the daemon over SSE become lounge agents.

const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const LIVE_STATES = ['coffee', 'work', 'smoke', 'blocked', 'ready', 'whisky', 'exit', 'queue', 'dance'];
const NOTICE_KINDS = ['ci', 'review', 'merged', 'closed'];
export const PR_LINK = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/;

const colorKey = model => (MODELS.includes(model) ? model : 'queued');
// A couched room has a loose end, a parked one gave up its Claude: both sit on the demo's couch.
const liveState = state => (state === 'couch' || state === 'parked' ? 'sleep' : LIVE_STATES.includes(state) ? state : 'work');

function noticeOf(n) {
  if (!n || typeof n !== 'object' || !NOTICE_KINDS.includes(n.kind) || typeof n.text !== 'string') return undefined;
  return { kind: n.kind, text: n.text, ...(typeof n.url === 'string' && PR_LINK.test(n.url) ? { url: n.url } : {}) };
}

const whereOf = (room, id) => {
  if (typeof room.project === 'string' && room.project) return typeof room.branch === 'string' && room.branch ? `${room.project} · ${room.branch}` : room.project;
  return room.kind === 'scratch' ? 'scratch' : id;
};

// The server's rule: a room sent without a kind is not placed yet (still starting) and has no floor; a scratch
// room, or one without a project, is on the scratch floor.
function projectOf(room) {
  if (room.kind !== 'code' && room.kind !== 'scratch') return undefined;
  return room.kind === 'code' && typeof room.project === 'string' && room.project ? room.project : SCRATCH;
}

export function roomToAgents(room) {
  const id = String(room.room);
  const where = whereOf(room, id);
  const project = projectOf(room);
  const home = project ? { project, kind: room.kind } : {};
  const info = { task: room.task, steps: [...(room.steps || [])], where, since: room.since, live: true, ...home };
  if (typeof room.reply === 'string' && room.reply) info.reply = room.reply;
  if (room.block) info.block = structuredClone(room.block);
  if (Number.isInteger(room.queuePosition)) info.queuePosition = room.queuePosition;
  if (Array.isArray(room.couchReasons)) info.couchReasons = room.couchReasons.filter(r => typeof r === 'string');
  if (room.state === 'parked' || room.parked === true) info.parked = true;
  const notice = noticeOf(room.notice);
  if (notice) info.notice = notice;
  return {
    main: { id, label: id, model: colorKey(room.model), state: liveState(room.state), info },
    subagents: (room.subagents || []).map(s => {
      // A subagent seen only through its Agent tool result has no type yet.
      const type = s.type || 'subagent';
      return { id: `${id}/${s.id}`, label: `${id} ↳ ${type}`, model: colorKey(s.model), state: 'slot', info: { task: type, steps: [], where, live: true, ...home } };
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
    go(world, b, state);
    if (walking || b.spot !== spot) return;
    const to = b.path[b.path.length - 1];
    b.path = to[0] === b.x && to[1] === b.y ? [] : [to];
    b.walking = b.path.length > 0;
  };
  const reseat = state => {
    for (const b of agents) if (b.state === state && b.overflow && hasFreeSpot(agents, b, state)) resettle(b, state);
  };
  const shift = (a, state) => { const from = a.state; go(world, a, state); reseat(from); };

  // An agent sent to the street leaves the maps at once, so a reopened room gets a fresh walker.
  const leave = a => { if (a.state !== 'exit') shift(a, 'exit'); return a; };

  function drop(id) {
    const gone = [...(mains.has(id) ? [mains.get(id)] : []), ...(subs.get(id)?.values() ?? [])].map(leave);
    mains.delete(id); subs.delete(id);
    return gone;
  }

  // world.floors set means the building: a seated room goes straight to its place.
  function place(spec, arriving) {
    const a = addAgent(agents, { id: spec.id, label: spec.label, state: spec.state, look: lookFor(spec.id, spec.model), info: spec.info, stacks: true }, world.rng);
    a.liveId = spec.id;
    if (arriving) walkIn(world, a, spec.state);
    else if (world.floors) seat(agents, a, world.floors);
    return a;
  }

  function update(a, spec) {
    a.label = spec.label;
    a.info = structuredClone(spec.info);
    if (a.look.model !== spec.model) a.look = { ...a.look, model: spec.model };
    if (a.state !== spec.state) shift(a, spec.state);
    // A room's project can arrive after its first events (room.json is written later): same state, new floor.
    else if (world.floors && a.state !== 'exit' && placeOf(viewOf(a, world.floors)) !== a.dest) go(world, a, a.state);
    return a;
  }

  // The sidewalk line follows queuePosition: 1 stands at the front, by the rope (the largest x).
  const frontFirst = SPOTS.queue.map((_, i) => i).sort((i, j) => SPOTS.queue[j][0] - SPOTS.queue[i][0]);
  function lineUp(seat) {
    const line = [...mains.values()].filter(a => a.state === 'queue')
      .sort((p, q) => (p.info.queuePosition ?? Infinity) - (q.info.queuePosition ?? Infinity));
    line.forEach((a, k) => {
      // Past the last spot, a room shares one the usual way.
      if (k >= frontFirst.length) { if (!a.overflow) go(world, a, 'queue'); return; }
      const i = frontFirst[k];
      if (a.spot === i && !a.overflow) return;
      const to = SPOTS.queue[i];
      Object.assign(a, { spot: i, overflow: false, tier: 0, tx: to[0] });
      // The first snapshot seats everyone in place, as for the other states.
      if (seat && !a.walking) { a.x = to[0]; a.y = to[1]; a.path = []; return; }
      retarget(world, a, to);
    });
  }

  function apply(room, arriving) {
    const { main, subagents } = roomToAgents(room);
    if (main.state === 'exit') return drop(main.id);
    const a = mains.has(main.id) ? update(mains.get(main.id), main) : place(main, arriving);
    mains.set(main.id, a);
    const prev = subs.get(main.id) ?? new Map(), next = new Map();
    for (const s of subagents) {
      if (next.has(s.id)) continue;
      next.set(s.id, prev.has(s.id) ? update(prev.get(s.id), s) : place(s, arriving));
    }
    const gone = [...prev].filter(([id]) => !next.has(id)).map(([, b]) => leave(b));
    subs.set(main.id, next);
    return [a, ...next.values(), ...gone];
  }

  return {
    // The first snapshot seats the rooms that were already there; after that, arrivals walk in.
    snapshot(rooms) {
      const arriving = seated; seated = true;
      const open = rooms.filter(r => r.state !== 'exit');
      const { remove } = diffRooms([...mains.keys()], open.map(r => String(r.room)));
      const touched = [...remove.flatMap(drop), ...open.flatMap(r => apply(r, arriving))];
      lineUp(!arriving);
      return touched;
    },
    room: room => { const touched = apply(room, true); lineUp(false); return touched; },
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
const isFloor = f => !!f && typeof f === 'object' && typeof f.project === 'string' && f.project !== ''
  && Number.isInteger(f.floor) && f.floor > 0 && typeof f.theme === 'string';
const floorsOf = list => list.filter(isFloor).map(f => ({ project: f.project, floor: f.floor, theme: f.theme, locked: f.locked === true }));

// On error the browser's EventSource retries by itself and the cast stays until the next snapshot.
// A CLOSED source (e.g. 403 after the lounge restarted with a new token) never comes back.
// `floors` holds the latest open floors; onFloors hears each new list.
export class LiveSource {
  constructor(url, onSnapshot, onRoom, { EventSource = globalThis.EventSource, onClosed = () => {}, onFloors = () => {} } = {}) {
    this.url = url; this.onSnapshot = onSnapshot; this.onRoom = onRoom; this.onClosed = onClosed; this.onFloors = onFloors;
    this.ES = EventSource; this.es = null; this.floors = [];
  }

  #setFloors(list) {
    if (!Array.isArray(list)) return;
    this.floors = floorsOf(list);
    this.onFloors([...this.floors]);
  }

  start() {
    if (this.es || !this.ES) return;
    const es = this.es = new this.ES(this.url);
    es.addEventListener('snapshot', e => {
      const d = parse(e.data);
      if (!d || !Array.isArray(d.rooms)) return;
      // Floors first, so the rooms land on floors that exist.
      this.#setFloors(d.floors);
      this.onSnapshot(d.rooms.filter(isRoom));
    });
    es.addEventListener('floors', e => this.#setFloors(parse(e.data)));
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
