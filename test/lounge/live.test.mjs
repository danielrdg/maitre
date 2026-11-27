import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomToAgents, diffRooms, lookFor, createLiveCast, LiveSource, createBell, titleFor } from '../../lounge/js/live.js';
import { STATE_KEYS, t } from '../../lounge/js/i18n.js';
import { MODEL } from '../../lounge/js/sprites.js';
import { panelModel, renderPanel } from '../../lounge/js/panel.js';
import { createWorld, stepWorld, makeRngs, STEP } from '../../lounge/js/sim.js';
import { createCast, SPOTS } from '../../lounge/js/agents.js';
import { mulberry32 } from '../../lounge/js/rng.js';
import { badgeFor, isDim } from '../../lounge/js/scene.js';

const room = (over = {}) => ({
  room: 'r1', session: 's-1', model: 'opus', state: 'work', since: 1_000_000, updatedAt: 1_000_000,
  task: 'Fix the flaky test', steps: ['Read a.ts', 'Ran the suite'], subagents: [], ...over,
});

const QUESTION = {
  kind: 'question', tool: 'AskUserQuestion', detail: 'Which database?',
  questions: [
    { question: 'Which database?', options: [{ label: 'Postgres', description: 'The usual one' }, { label: '<img src=x onerror=alert(1)>' }] },
    { question: 'Run the migration now?', options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Later' }, { label: 'Never', description: 'Skip it' }] },
  ],
};

// Just enough DOM for renderPanel.
function fakeDoc() {
  const made = [];
  const node = tag => {
    const n = {
      tag, children: [], attrs: {}, style: {}, className: '', textContent: '', title: '', placeholder: '',
      append(...c) { n.children.push(...c); },
      replaceChildren(...c) { n.children = c; },
      setAttribute(k, v) { n.attrs[k] = v; },
      addEventListener() {},
      remove() {},
    };
    made.push(n);
    return n;
  };
  const doc = { createElement: node, createTextNode: text => ({ tag: '#text', textContent: text, children: [] }), made };
  const root = node('div');
  root.ownerDocument = doc;
  return { doc, root };
}
const allText = n => (n.textContent || '') + (n.children || []).map(allText).join('');

const LIVE_STATES = ['coffee', 'work', 'smoke', 'blocked', 'ready', 'whisky', 'exit'];

test('roomToAgents keeps every live state as a lounge state', () => {
  for (const state of LIVE_STATES) {
    const { main } = roomToAgents(room({ state }));
    assert.equal(main.state, state);
    assert.ok(STATE_KEYS.includes(main.state), state);
  }
  assert.equal(roomToAgents(room({ state: 'dancing' })).main.state, 'work', 'an unknown state falls back to work');
});

test('roomToAgents maps models to sprite colors, unknown to the queued gray', () => {
  for (const m of ['haiku', 'sonnet', 'opus', 'fable']) assert.equal(roomToAgents(room({ model: m })).main.model, m);
  for (const m of ['unknown', 'gpt', undefined]) assert.equal(roomToAgents(room({ model: m })).main.model, 'queued');
  assert.equal(MODEL.queued[0], '#8f8b9c');
});

test('roomToAgents fills the panel info from the room', () => {
  const { main } = roomToAgents(room());
  assert.equal(main.id, 'r1');
  assert.equal(main.label, 'r1');
  assert.deepEqual(main.info, { task: 'Fix the flaky test', steps: ['Read a.ts', 'Ran the suite'], where: 'r1', since: 1_000_000, live: true });
});

test('subagents become slot agents labeled "<room> ↳ <type>" with their model color', () => {
  const { subagents } = roomToAgents(room({ subagents: [{ id: 'ag1', type: 'Explore', model: 'haiku' }, { id: 'ag2', type: 'general-purpose', model: 'unknown' }] }));
  assert.deepEqual(subagents.map(s => [s.id, s.label, s.model, s.state]), [
    ['r1/ag1', 'r1 ↳ Explore', 'haiku', 'slot'],
    ['r1/ag2', 'r1 ↳ general-purpose', 'queued', 'slot'],
  ]);
  assert.equal(subagents[0].info.where, 'r1');
  const untyped = roomToAgents(room({ subagents: [{ id: 'ag3', type: '', model: 'unknown' }] })).subagents[0];
  assert.equal(untyped.label, 'r1 ↳ subagent', 'no dangling arrow before SubagentStart names the type');
});

test('a blocked question room yields read-only options and no answer controls', () => {
  const { main } = roomToAgents(room({ state: 'blocked', block: QUESTION }));
  const m = panelModel({ ...main, look: { model: main.model } }, 'en', 1_000_000);
  assert.equal(m.block.readOnly, true);
  assert.equal(m.block.reason, null, 'the questions carry the text; detail is only a clipped copy of the first');
  assert.equal(m.block.note, "Answer in the room's terminal");
  assert.deepEqual(m.block.questions.map(q => q.text), ['Which database?', 'Run the migration now?']);
  assert.deepEqual(m.block.questions[0].options, [
    { key: 'A', text: 'Postgres', detail: 'The usual one' },
    { key: 'B', text: '<img src=x onerror=alert(1)>', detail: '' },
  ]);
  assert.deepEqual(m.block.questions[1].options.map(o => o.key), ['A', 'B', 'C', 'D']);

  const { doc, root } = fakeDoc();
  renderPanel(root, m, () => assert.fail('a live panel never answers'));
  assert.deepEqual(doc.made.filter(n => n.tag === 'button').map(n => n.className), ['x'], 'only the close button');
  assert.equal(doc.made.filter(n => n.tag === 'input').length, 0);
  const text = allText(root);
  for (const s of ['Which database?', 'Postgres', 'The usual one', '<img src=x onerror=alert(1)>', 'Run the migration now?', 'Never', "Answer in the room's terminal"]) {
    assert.ok(text.includes(s), s);
  }
  assert.equal(text.split('Which database?').length - 1, 1, 'the first question shows once');
});

test('a permission block shows the tool and the raw detail', () => {
  const { main } = roomToAgents(room({ state: 'blocked', block: { kind: 'permission', tool: 'Bash', detail: 'rm -rf `pwd`/build' } }));
  const m = panelModel({ ...main, look: { model: main.model } }, 'pt-BR', 1_000_000);
  assert.equal(m.block.intro, 'Pedindo permissão pra usar Bash');
  assert.equal(m.block.note, 'Responda no terminal da sala');
  const { root } = fakeDoc();
  renderPanel(root, m, () => {}, { lang: 'pt-BR' });
  assert.ok(allText(root).includes('rm -rf `pwd`/build'), 'backticks in a command stay as typed');
});

test('a live panel shows time in the current state instead of room age and tokens', () => {
  const { main } = roomToAgents(room({ since: 1_000_000 }));
  const m = panelModel({ ...main, look: { model: main.model } }, 'en', 1_000_000 + 3.5 * 60_000);
  assert.equal(m.usageLabel, 'IN THIS STATE FOR');
  assert.equal(m.usage, '3 min');
  const sub = roomToAgents(room({ subagents: [{ id: 'a', type: 'Explore', model: 'haiku' }] })).subagents[0];
  assert.equal(panelModel({ ...sub, look: { model: sub.model } }).usage, undefined);
});

test('the demo panel still renders answer buttons, free text and usage', () => {
  const a = createCast({ rng: mulberry32(1) }).find(x => x.id === 'db-migration');
  const { doc, root } = fakeDoc();
  renderPanel(root, panelModel(a), () => {});
  assert.deepEqual(doc.made.filter(n => n.tag === 'button').map(n => n.className), ['x', 'opt', 'opt', 'opt', 'send']);
  assert.equal(doc.made.filter(n => n.tag === 'input').length, 1);
  const text = allText(root);
  assert.ok(text.includes('IN THE ROOM FOR'));
  assert.ok(text.includes('22 min · 97k tokens'));
});

test('diffRooms splits ids into add, remove and keep', () => {
  assert.deepEqual(diffRooms(['a', 'c'], ['a', 'b']), { add: ['b'], remove: ['c'], keep: ['a'] });
  assert.deepEqual(diffRooms([], ['x']), { add: ['x'], remove: [], keep: [] });
  assert.deepEqual(diffRooms(['x'], []), { add: [], remove: ['x'], keep: [] });
});

test('a room keeps its look across reloads', () => {
  assert.deepEqual(lookFor('r1', 'opus'), lookFor('r1', 'opus'));
  assert.equal(lookFor('r1', 'sonnet').model, 'sonnet');
});

function liveWorld() {
  const { rng, fxRng } = makeRngs(7);
  const world = createWorld({ rng, fxRng });
  const dings = [];
  const hooks = { sfx: { ding: () => dings.push(1), noise() {}, thunk() {}, tick() {}, jackpot() {}, lose() {}, fanfare() {} } };
  return { world, hooks, dings, cast: createLiveCast(world, hooks) };
}
const run = (world, hooks, sec, t0 = 0) => { let t = t0; for (let i = 0; i < sec / STEP; i++) { t += STEP; stepWorld(world, STEP, t, hooks); } return t; };
const byId = (world, id) => world.agents.filter(a => a.liveId === id);

test('the first snapshot seats rooms in place; later ones walk in from the door', () => {
  const { world, cast } = liveWorld();
  cast.snapshot([room({ room: 'a' }), room({ room: 'c', state: 'ready' })]);
  const [a] = byId(world, 'a'), [c] = byId(world, 'c');
  assert.equal(a.walking, false);
  assert.equal(c.state, 'ready');
  assert.equal(a.label, 'a');

  cast.snapshot([room({ room: 'a' }), room({ room: 'b', state: 'smoke' })]);
  assert.equal(c.state, 'exit', 'c is missing from the snapshot, so it leaves');
  assert.equal(a.walking, false, 'a stays put');
  const [b] = byId(world, 'b');
  assert.equal(b.state, 'smoke');
  assert.ok(b.walking && b.x < 86, 'b walks in from the street');
  assert.deepEqual(cast.ids(), ['a', 'b']);
});

test('an update in the same state does not re-walk; a new state walks there', () => {
  const { world, cast } = liveWorld();
  cast.snapshot([room({ room: 'a' })]);
  const [a] = byId(world, 'a');
  cast.room(room({ room: 'a', steps: ['one more step'], model: 'sonnet' }));
  assert.equal(a.walking, false);
  assert.deepEqual(a.info.steps, ['one more step']);
  assert.equal(a.look.model, 'sonnet');
  cast.room(room({ room: 'a', state: 'whisky' }));
  assert.equal(a.state, 'whisky');
  assert.ok(a.walking);
});

test('the cast walks a blocked room to reception without touching the sound', () => {
  const { world, hooks, dings, cast } = liveWorld();
  cast.snapshot([room({ room: 'a' })]);
  cast.room(room({ room: 'a', state: 'blocked', block: QUESTION }));
  const [a] = byId(world, 'a');
  assert.equal(a.after, null, 'no ring on arrival: the bell follows room events, not walking');
  run(world, hooks, 10);
  assert.equal(a.walking, false);
  assert.equal(dings.length, 1, 'only the render loop scheduler, which the live bell shares');
});

function bellOn() {
  const rings = [];
  const bell = createBell({ ring: t => rings.push(t) });
  const ticks = (from, to) => { for (let t = from; t <= to; t++) bell.tick(t); };
  return { bell, rings, ticks };
}

test('the bell rings once on entering blocked and repeats every 22 s on its own clock', () => {
  const { bell, rings, ticks } = bellOn();
  bell.snapshot([room({ room: 'a' })], 0);
  ticks(1, 30);
  assert.deepEqual(rings, [], 'nothing blocked, nothing rings');
  bell.room(room({ room: 'a', state: 'blocked', block: QUESTION }), 30.5);
  assert.deepEqual(rings, [30.5], 'rings on the event itself, before any agent walks');
  bell.room(room({ room: 'a', state: 'blocked', block: QUESTION, steps: ['x'] }), 31);
  ticks(31, 75);
  assert.deepEqual(rings, [30.5, 53, 75], 'staying blocked is not a new transition; the repeat is every 22 s');
  bell.room(room({ room: 'a', state: 'work' }), 76);
  ticks(76, 200);
  assert.deepEqual(rings, [30.5, 53, 75], 'unblocked: silent');
  assert.equal(bell.count, 0);
});

test('a second room turning blocked rings at once; snapshots ring only for rooms newly blocked', () => {
  const { bell, rings, ticks } = bellOn();
  bell.snapshot([room({ room: 'a', state: 'blocked', block: QUESTION }), room({ room: 'b' })], 0);
  assert.deepEqual(rings, [0], 'opening the lounge on a blocked room rings');
  ticks(1, 10);
  bell.room(room({ room: 'b', state: 'blocked', block: QUESTION }), 10.5);
  assert.deepEqual(rings, [0, 10.5]);
  assert.equal(bell.count, 2);
  bell.snapshot([room({ room: 'a', state: 'blocked', block: QUESTION }), room({ room: 'b', state: 'blocked', block: QUESTION })], 12);
  assert.deepEqual(rings, [0, 10.5], 'a reconnect snapshot with the same blocked rooms stays quiet');
  bell.snapshot([room({ room: 'b', state: 'blocked', block: QUESTION })], 13);
  assert.equal(bell.count, 1, 'a room missing from the snapshot is no longer blocked');
  bell.room(room({ room: 'b', state: 'exit' }), 14);
  assert.equal(bell.count, 0);
});

test('the live bell shares the render scheduler, so a visible tab never rings twice', () => {
  const { world, hooks, dings, cast } = liveWorld();
  const bell = createBell({ ring: () => dings.push('bell'), ding: world.ding });
  const rooms = [room({ room: 'a' })];
  cast.snapshot(rooms); bell.snapshot(rooms, 0);
  const blocked = room({ room: 'a', state: 'blocked', block: QUESTION });
  cast.room(blocked); bell.room(blocked, 0.1);
  let t = 0.1;
  for (let i = 0; i < 25 / STEP; i++) { t += STEP; stepWorld(world, STEP, t, hooks); if (i % 30 === 0) bell.tick(t); }
  assert.equal(dings.length, 2, `one ring at the event and one repeat after 22 s: ${dings}`);
});

test('a dead stream stops the repeat until a snapshot arrives again', () => {
  const { bell, rings, ticks } = bellOn();
  bell.snapshot([room({ room: 'a', state: 'blocked', block: QUESTION })], 0);
  bell.disconnect();
  assert.equal(bell.disconnected, true);
  ticks(1, 100);
  assert.deepEqual(rings, [0], 'no repeat while disconnected');
  assert.equal(bell.count, 1, 'the cast and the count are kept');
  bell.snapshot([room({ room: 'a', state: 'blocked', block: QUESTION })], 101);
  assert.equal(bell.disconnected, false);
  ticks(102, 130);
  assert.deepEqual(rings, [0, 102, 124], 'the overdue repeat resumes on the next tick, then every 22 s');
});

test('a dead stream also silences the render loop that shares the scheduler', () => {
  const { world, hooks, dings, cast } = liveWorld();
  const bell = createBell({ ring: () => dings.push('bell'), ding: world.ding });
  const rooms = [room({ room: 'a', state: 'blocked', block: QUESTION })];
  cast.snapshot(rooms); bell.snapshot(rooms, 0);
  bell.disconnect();
  let t = 0;
  for (let i = 0; i < 60 / STEP; i++) { t += STEP; stepWorld(world, STEP, t, hooks); if (i % 30 === 0) bell.tick(t); }
  assert.deepEqual(dings, ['bell'], 'only the ring before the stream died');
});

test('the window title counts blocked rooms in both languages', () => {
  assert.equal(titleFor(0, 'en'), 'maître · lounge');
  assert.equal(titleFor(1, 'en'), '(1) needs you · maître');
  assert.equal(titleFor(2, 'en'), '(2) needs you · maître');
  assert.equal(titleFor(0, 'pt-BR'), 'maître · lounge');
  assert.equal(titleFor(1, 'pt-BR'), '(1) precisa de você · maître');
  assert.equal(titleFor(2, 'pt-BR'), '(2) precisam de você · maître');
  assert.equal(titleFor(2, 'en', { disconnected: true }), 'disconnected · maître');
  assert.equal(titleFor(0, 'pt-BR', { disconnected: true }), 'desconectado · maître');
  assert.match(t('live.disconnected', 'en'), /^Disconnected — reopen the lounge from the terminal$/);
  assert.notEqual(t('live.disconnected', 'pt-BR'), t('live.disconnected', 'en'));
});

test('exit walks the room and its subagents out; a reopened room walks in fresh', () => {
  const { world, hooks, cast } = liveWorld();
  cast.room(room({ room: 'ghost', state: 'exit' }));
  assert.equal(world.agents.length, 0, 'an exit for an unknown room is ignored');

  cast.snapshot([room({ room: 'a', subagents: [{ id: 's1', type: 'Explore', model: 'haiku' }] })]);
  assert.equal(world.agents.length, 2);
  cast.room(room({ room: 'a', state: 'exit', subagents: [{ id: 's1', type: 'Explore', model: 'haiku' }] }));
  assert.deepEqual(world.agents.map(x => x.state), ['exit', 'exit']);
  assert.deepEqual(cast.ids(), []);

  cast.room(room({ room: 'a', state: 'coffee' }));
  const live = byId(world, 'a').filter(x => x.state !== 'exit');
  assert.equal(live.length, 1, 'a fresh walker, not the one leaving');
  run(world, hooks, 30);
  assert.deepEqual(world.agents.map(x => [x.liveId, x.state]), [['a', 'coffee']]);
});

test('a freed spot re-seats an agent that was sharing one, so no blocked room stays hidden', () => {
  const { world, hooks, cast } = liveWorld();
  const b = name => room({ room: name, state: 'blocked', block: QUESTION });
  cast.snapshot([b('a'), b('b'), b('c')]);
  const spots = () => ['b', 'c'].map(id => byId(world, id)[0]).map(x => [x.x, x.y]);
  run(world, hooks, 1);
  assert.equal(byId(world, 'a')[0].spot, 0);
  assert.equal(byId(world, 'b')[0].spot, byId(world, 'c')[0].spot, 'three blocked rooms, two spots: b and c share one');
  assert.notEqual(spots()[0][0], spots()[1][0], 'the one sharing stands beside, not on top');
  cast.room(room({ room: 'a', state: 'work' }));
  run(world, hooks, 10, 1);
  const [pb, pc] = spots();
  assert.notDeepEqual(pb, pc, 'after a leaves reception, b and c stand apart');
  assert.ok(['b', 'c'].every(id => byId(world, id)[0].overflow === false));
  cast.room(room({ room: 'b', state: 'exit' }));
  cast.snapshot([b('c'), b('d'), b('e')]);
  run(world, hooks, 30, 11);
  const at = ['c', 'd', 'e'].map(id => byId(world, id)[0].spot);
  assert.equal(new Set(at).size, 2, 'still only two blocked spots for three rooms');
});

// Mirrors scene.js (an 18x34 box from round(x - 9), round(y - 31), drawn in feet-y order) and
// main.js hitAt (2 px inset, the last drawn box wins).
function hitAgent(agents, x, y) {
  const order = [...agents].sort((p, q) => p.y - q.y);
  for (let i = order.length - 1; i >= 0; i--) {
    const a = order[i], x0 = Math.round(a.x - 9), y0 = Math.round(a.y - 31);
    if (x >= x0 + 2 && x <= x0 + 16 && y >= y0 + 1 && y <= y0 + 32) return a;
  }
  return null;
}
const clickable = (agents, a) => {
  const x0 = Math.round(a.x - 9);
  for (let x = x0 + 2; x <= x0 + 16; x++) if (hitAgent(agents, x, a.y - 15) === a) return true;
  return false;
};
const settled = (world, hooks) => { let t = 0; while (world.agents.some(a => a.walking) && t < 60) t = run(world, hooks, 1, t); return t; };

test('more rooms than spots in one state stand side by side, each one clickable', () => {
  const { world, hooks, cast } = liveWorld();
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const rooms = names.map((n, i) => room({ room: n, state: i < 4 ? 'blocked' : 'ready', ...(i < 4 ? { block: QUESTION } : {}) }));
  for (const walkIn of [false, true]) {
    if (walkIn) cast.snapshot([]);
    cast.snapshot(rooms);
    settled(world, hooks);
    const live = world.agents.filter(a => a.state !== 'exit');
    assert.equal(live.length, 8);
    for (const state of ['blocked', 'ready']) {
      const xs = live.filter(a => a.state === state).map(a => a.x);
      assert.equal(new Set(xs).size, 4, `${state}${walkIn ? ' (walked in)' : ''}: ${xs}`);
    }
    for (const a of live) assert.ok(clickable(live, a), `${a.liveId} can be clicked`);
  }
  // Past two per spot a tier would reach the next spot over (22 px away, or to the left for whisky).
  for (const [state, n] of [['blocked', 6], ['whisky', 5], ['coffee', 6]]) {
    const w = liveWorld();
    w.cast.snapshot(Array.from({ length: n }, (_, i) => room({ room: `${state}${i}`, state, ...(state === 'blocked' ? { block: QUESTION } : {}) })));
    settled(w.world, w.hooks);
    for (const a of w.world.agents) assert.ok(clickable(w.world.agents, a), `${n} ${state}: ${a.liveId}@${a.x} can be clicked`);
  }
});

test('a room arriving after a sharer left does not land on the one still sharing', () => {
  const { world, hooks, cast } = liveWorld();
  const b = name => room({ room: name, state: 'blocked', block: QUESTION });
  cast.snapshot(['a', 'b', 'c', 'd', 'e'].map(b));
  settled(world, hooks);
  const sharers = ['c', 'd', 'e'].map(id => byId(world, id)[0]);
  const leaver = sharers.find(x => x.tier === 1);
  cast.room(room({ room: leaver.liveId, state: 'exit' }));
  cast.room(b('f'));
  settled(world, hooks);
  const live = world.agents.filter(a => a.state === 'blocked');
  assert.equal(live.length, 5);
  assert.equal(new Set(live.map(a => a.x)).size, 5, live.map(a => `${a.liveId}@${a.x}`).join(' '));
  for (const a of live) assert.ok(clickable(live, a), `${a.liveId} can be clicked`);
});

test('an agent re-seated on the spot it already holds sidesteps instead of walking out and back', () => {
  const { world, hooks, cast } = liveWorld();
  const b = name => room({ room: name, state: 'blocked', block: QUESTION });
  cast.snapshot([b('a'), b('b'), b('c')]);
  settled(world, hooks);
  const [c] = byId(world, 'c'), [bb] = byId(world, 'b');
  const spot = bb.spot, seat = [bb.x, bb.y];
  assert.equal(c.spot, spot);
  assert.equal(c.x, seat[0] + 9);
  cast.room(room({ room: 'b', state: 'work' }));
  assert.equal(c.spot, spot, 'c keeps the spot b left');
  assert.deepEqual(c.path, [seat], 'one step sideways, no aisle waypoint');
  settled(world, hooks);
  assert.deepEqual([c.x, c.y, c.overflow, c.tier], [...seat, false, 0]);
});

test('a subagent missing from the next room event leaves', () => {
  const { world, cast } = liveWorld();
  cast.snapshot([room({ room: 'a', subagents: [{ id: 's1', type: 'Explore', model: 'haiku' }, { id: 's2', type: 'Plan', model: 'opus' }] })]);
  cast.room(room({ room: 'a', subagents: [{ id: 's2', type: 'Plan', model: 'opus' }] }));
  assert.equal(byId(world, 'a/s1')[0].state, 'exit');
  assert.equal(byId(world, 'a/s2')[0].state, 'slot');
  assert.equal(byId(world, 'a/s2')[0].label, 'a ↳ Plan');
});

test('the room update returns the agents it touched so an open panel can refresh', () => {
  const { cast } = liveWorld();
  cast.snapshot([room({ room: 'a' })]);
  const touched = cast.room(room({ room: 'a', state: 'blocked', block: QUESTION }));
  assert.deepEqual(touched.map(x => x.liveId), ['a']);
  assert.equal(touched[0].info.block.kind, 'question');
});

class FakeEventSource {
  static last = null;
  constructor(url) { this.url = url; this.listeners = {}; this.closed = false; FakeEventSource.last = this; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data }); }
  close() { this.closed = true; }
}

test('LiveSource hands snapshots and room events to its callbacks and ignores junk', () => {
  const snaps = [], rooms = [];
  let closed = 0;
  const src = new LiveSource('api/events', r => snaps.push(r), r => rooms.push(r), { EventSource: FakeEventSource, onClosed: () => closed++ });
  src.start();
  const es = FakeEventSource.last;
  assert.equal(es.url, 'api/events');
  es.emit('snapshot', JSON.stringify({ rooms: [room({ room: 'a' })] }));
  es.emit('room', JSON.stringify(room({ room: 'b' })));
  es.emit('room', '{not json');
  es.emit('room', JSON.stringify({ nope: 1 }));
  es.emit('snapshot', JSON.stringify({ rooms: 'x' }));
  es.readyState = 0;
  es.emit('error', undefined);
  assert.equal(closed, 0, 'a retrying stream is not dead');
  es.readyState = 2;
  es.emit('error', undefined);
  assert.equal(closed, 1, 'CLOSED means the browser gave up');
  assert.deepEqual(snaps.map(s => s.map(r => r.room)), [['a']]);
  assert.deepEqual(rooms.map(r => r.room), ['b']);
  src.stop();
  assert.ok(es.closed);
});

test('the empty-lounge hint points to the maître and the reception in both languages', () => {
  assert.equal(t('live.empty', 'en'), 'No rooms yet — click the maître at the desk, or run `maitre` in a terminal');
  assert.match(t('live.empty', 'pt-BR'), /maître.*`maitre`/);
  for (const lang of ['en', 'pt-BR']) assert.doesNotMatch(t('live.empty', lang), /room run/);
  assert.notEqual(t('live.empty', 'pt-BR'), t('live.empty', 'en'));
});

test('a registered room shows "<project> · <branch>" in the panel Where line, scratch as scratch', () => {
  const where = over => {
    const { main } = roomToAgents(room(over));
    return panelModel({ ...main, look: { model: main.model } }, 'en', 1_000_000).where;
  };
  assert.equal(where({ project: 'backend', branch: 'maitre/nf-bug' }), 'backend · maitre/nf-bug');
  assert.equal(where({ project: 'backend' }), 'backend');
  assert.equal(where({ kind: 'scratch' }), 'scratch');
  assert.equal(where({}), 'r1', 'no registry: the room id, as before');
  const { subagents } = roomToAgents(room({ project: 'backend', branch: 'b', subagents: [{ id: 'a', type: 'Explore', model: 'haiku' }] }));
  assert.equal(subagents[0].info.where, 'backend · b');
});

test('registry text reaches the panel as text nodes, never markup', () => {
  const { main } = roomToAgents(room({ project: '<img src=x onerror=alert(1)>', branch: '<b>' }));
  const m = panelModel({ ...main, look: { model: main.model } }, 'en', 1_000_000);
  const { root } = fakeDoc();
  renderPanel(root, m, () => {});
  assert.ok(allText(root).includes('<img src=x onerror=alert(1)> · <b>'));
});

test('roomToAgents carries the last reply to the main agent only', () => {
  const { main, subagents } = roomToAgents(room({ reply: 'Done: 3 files', subagents: [{ id: 'a1', type: 'Explore', model: 'haiku' }] }));
  assert.equal(main.info.reply, 'Done: 3 files');
  assert.equal(subagents[0].info.reply, undefined);
  assert.equal(roomToAgents(room({ reply: 42 })).main.info.reply, undefined);
});

test('the panel shows the last reply as text, in both languages', () => {
  const agent = { id: 'r1', label: 'r1', state: 'ready', look: { model: 'haiku' }, info: { live: true, task: 't', steps: [], reply: '<b>oi</b>' } };
  const model = panelModel(agent, 'pt-BR');
  assert.equal(model.reply, '<b>oi</b>');
  const { doc, root } = fakeDoc();
  renderPanel(root, model, () => {}, { lang: 'pt-BR' });
  assert.ok(allText(root).includes(t('panel.lastReply', 'pt-BR')));
  assert.ok(allText(root).includes('<b>oi</b>'));
  assert.ok(!doc.made.some(n => n.tag === 'b' && n.textContent === 'oi'));
  assert.equal(panelModel({ ...agent, info: { ...agent.info, reply: '' } }, 'en').reply, undefined);
});

test('a queued room stands on the sidewalk and a couched room sits on the couch', () => {
  const q = roomToAgents(room({ state: 'queue', model: 'unknown', queuePosition: 2, project: 'web', kind: 'code' })).main;
  assert.equal(q.state, 'queue');
  assert.equal(q.model, 'queued');
  assert.equal(q.info.queuePosition, 2);
  assert.equal(q.info.where, 'web');
  const c = roomToAgents(room({ state: 'couch', couchReasons: ['2 commits not pushed'] })).main;
  assert.equal(c.state, 'sleep');
  assert.deepEqual(c.info.couchReasons, ['2 commits not pushed']);
  assert.equal('queuePosition' in roomToAgents(room()).main.info, false, 'no extra keys on other rooms');
  assert.equal('couchReasons' in roomToAgents(room()).main.info, false);
});

test('several couched or queued rooms each get their own clickable place', () => {
  for (const [state, n] of [['couch', 3], ['queue', 4]]) {
    const w = liveWorld();
    w.cast.snapshot(Array.from({ length: n }, (_, i) => room({ room: `${state}${i}`, state, ...(state === 'queue' ? { queuePosition: i + 1 } : { couchReasons: ['x'] }) })));
    settled(w.world, w.hooks);
    const live = w.world.agents.filter(a => a.liveId);
    assert.equal(live.length, n);
    assert.equal(new Set(live.map(a => `${a.x},${a.y}`)).size, n, `${state}: ${live.map(a => `${a.x},${a.y}`)}`);
    for (const a of live) assert.ok(clickable(live, a), `${n} ${state}: ${a.liveId}@${a.x} can be clicked`);
  }
});

test('a queued room that opens walks from the sidewalk to its table', () => {
  const { world, cast } = liveWorld();
  cast.snapshot([room({ room: 'q', state: 'queue', queuePosition: 1 })]);
  const [a] = byId(world, 'q');
  assert.equal(a.state, 'queue');
  cast.room(room({ room: 'q', state: 'coffee' }));
  assert.equal(a.state, 'coffee');
  assert.ok(a.walking, 'the same agent walks in');
});

test('the panel says where a queued room stands and why a room is on the couch, as text, in both languages', () => {
  const { doc, root } = fakeDoc();
  const queued = { id: 'q', label: 'q', state: 'queue', look: { model: 'queued' }, info: { live: true, task: '', steps: [], where: 'scratch', since: 1, queuePosition: 3 } };
  const couched = { id: 'c', label: 'c', state: 'sleep', look: { model: 'opus' }, info: { live: true, task: 'x', steps: [], where: 'web', since: 1, couchReasons: ['<b>2 commits</b> not pushed', 'an open PR'] } };
  assert.equal(panelModel(queued).wait, 'Waiting for a seat (position 3)');
  assert.equal(panelModel(queued, 'pt-BR').wait, 'Esperando vaga (posição 3)');
  assert.equal(panelModel(couched).wait, 'On the couch: <b>2 commits</b> not pushed; an open PR');
  assert.equal(panelModel(couched, 'pt-BR').wait, 'No sofá: <b>2 commits</b> not pushed; an open PR');
  assert.equal('wait' in panelModel({ ...couched, state: 'ready' }), false);
  renderPanel(root, panelModel(couched), () => {}, {});
  assert.ok(doc.made.some(n => n.className === 'wait' && n.textContent === 'On the couch: <b>2 commits</b> not pushed; an open PR'));
  assert.ok(!doc.made.some(n => n.tag === 'b' && n.textContent === '2 commits'), 'never parsed as markup');
});

test('the sidewalk line follows the queue: position 1 at the front by the rope, the rest move up when it opens', () => {
  const frontFirst = [...SPOTS.queue].sort((p, q) => q[0] - p[0]);
  const q = (name, queuePosition) => room({ room: name, state: 'queue', model: 'unknown', queuePosition });
  for (const walkIn of [false, true]) {
    const { world, hooks, cast } = liveWorld();
    if (walkIn) cast.snapshot([]);
    // Names out of order on purpose: the snapshot comes sorted by name.
    cast.snapshot([q('a', 3), q('b', 1), q('c', 4), q('d', 2)]);
    if (!walkIn) assert.ok(world.agents.every(a => !a.walking), 'the first snapshot seats the line in place');
    settled(world, hooks);
    const at = id => { const [a] = byId(world, id); return [a.x, a.y]; };
    assert.deepEqual(['b', 'd', 'a', 'c'].map(at), frontFirst.slice(0, 4), walkIn ? 'walked in' : 'seated');
    cast.room(room({ room: 'b', state: 'coffee' }));
    for (const [id, p] of [['d', 1], ['a', 2], ['c', 3]]) cast.room(q(id, p));
    settled(world, hooks);
    assert.deepEqual(['d', 'a', 'c'].map(at), frontFirst.slice(0, 3));
  }
});

// --- parked, dancing and noticed rooms

const PR = 'https://github.com/example/repo/pull/7';

test('a parked room sits on the couch, dimmed; a merged room dances; neither is a new lounge state', () => {
  const p = roomToAgents(room({ state: 'parked' })).main;
  assert.equal(p.state, 'sleep');
  assert.equal(p.info.parked, true);
  const d = roomToAgents(room({ state: 'dance' })).main;
  assert.equal(d.state, 'dance');
  assert.equal('parked' in d.info, false);
  assert.equal('parked' in roomToAgents(room({ state: 'couch' })).main.info, false);
  assert.equal(STATE_KEYS.length, 13);
  const { world, cast, hooks } = liveWorld();
  cast.snapshot([room({ room: 'p', state: 'parked' }), room({ room: 'c', state: 'couch' }), room({ room: 'd', state: 'dance' })]);
  settled(world, hooks);
  const [pa] = byId(world, 'p'), [ca] = byId(world, 'c'), [da] = byId(world, 'd');
  assert.equal(isDim(pa), true);
  assert.equal(isDim(ca), false);
  assert.ok(SPOTS.dance.some(([x, y]) => Math.abs(da.x - x) < 30 && da.y === y), `${da.x},${da.y}`);
});

test('a notice rides on the agent as an orange badge, never as the bell; a link only when it is a GitHub PR', () => {
  const n = roomToAgents(room({ state: 'ready', notice: { kind: 'ci', text: 'CI failed: build', url: PR } })).main;
  assert.deepEqual(n.info.notice, { kind: 'ci', text: 'CI failed: build', url: PR });
  const odd = roomToAgents(room({ notice: { kind: 'ci', text: 'x', url: 'javascript:alert(1)' } })).main;
  assert.deepEqual(odd.info.notice, { kind: 'ci', text: 'x' });
  assert.equal('notice' in roomToAgents(room({ notice: 'junk' })).main.info, false);
  assert.equal(badgeFor({ state: 'work', walking: false, info: n.info }, 0), 'notice');
  assert.equal(badgeFor({ state: 'ready', walking: false, info: n.info }, 0), 'notice', 'a notice wins over the ready check');
  assert.equal(badgeFor({ state: 'ready', walking: false, info: {} }, 0), 'check');
  assert.equal(badgeFor({ state: 'blocked', walking: false, info: n.info }, 0), 'alert');
  assert.equal(badgeFor({ state: 'work', walking: true, info: n.info }, 0), null);
  assert.equal(badgeFor({ state: 'work', walking: false, info: {} }, 0), null);
  let rang = 0;
  const bell = createBell({ ring: () => rang++ });
  bell.snapshot([room({ state: 'ready', notice: { kind: 'review', text: 'x', url: PR } })], 0);
  bell.room(room({ state: 'work', notice: { kind: 'ci', text: 'y', url: PR } }), 1);
  assert.equal(rang, 0);
  assert.equal(bell.count, 0);
});

test('the panel of a parked room offers Wake instead of the terminal, in both languages', () => {
  const parked = { id: 'p', label: 'p', state: 'sleep', look: { model: 'opus' }, info: { live: true, task: 'x', steps: [], where: 'web', since: 1, parked: true } };
  const m = panelModel(parked);
  assert.equal(m.wake, true);
  assert.equal(m.room, 'p');
  assert.equal('terminal' in m, false);
  assert.equal(m.state, t('state.parked'));
  assert.equal(m.wait, t('panel.parked'));
  assert.notEqual(t('state.parked', 'pt-BR'), t('state.parked'));
  for (const key of ['state.parked', 'panel.parked', 'panel.wake', 'panel.waking', 'panel.wakeFailed', 'panel.notice', 'panel.prLink', 'notice.ci', 'notice.review', 'notice.merged', 'notice.closed']) {
    for (const lang of ['en', 'pt-BR']) assert.ok(typeof t(key, lang) === 'string' && t(key, lang) !== key, `${lang} ${key}`);
  }
  assert.equal('wake' in panelModel({ ...parked, info: { ...parked.info, parked: undefined } }), false);
});

test('a parked room that dances still offers Wake, never the terminal', () => {
  const a = roomToAgents(room({ state: 'dance', parked: true })).main;
  assert.equal(a.state, 'dance');
  assert.equal(a.info.parked, true);
  const m = panelModel({ ...a, look: { model: 'opus' } });
  assert.equal(m.wake, true);
  assert.equal('terminal' in m, false);
  assert.equal('parked' in roomToAgents(room({ state: 'dance', parked: 'yes' })).main.info, false);
});

// Enough DOM to render a panel, click its buttons and read its links.
function clickDoc() {
  const node = tag => {
    const n = {
      tag, children: [], attrs: {}, style: {}, listeners: {}, className: '', textContent: '', title: '', placeholder: '', disabled: false, href: '',
      append(...c) { n.children.push(...c); },
      replaceChildren(...c) { n.children = c; },
      setAttribute(k, v) { n.attrs[k] = v; },
      addEventListener(type, fn) { n.listeners[type] = fn; },
      remove() {},
    };
    return n;
  };
  const doc = { createElement: node, createTextNode: text => ({ tag: '#text', textContent: text, children: [] }) };
  const root = node('div');
  root.ownerDocument = doc;
  return root;
}
const walk = n => [n, ...(n.children || []).flatMap(walk)];

test('the panel shows the notice as text with its PR link, in both languages', () => {
  for (const lang of ['en', 'pt-BR']) {
    const root = clickDoc();
    const a = { id: 'r', label: 'r', state: 'work', look: { model: 'opus' }, info: { live: true, task: 'x', steps: [], where: 'web', since: 1, notice: { kind: 'review', text: '<b>New comment</b> from rev', url: PR } } };
    renderPanel(root, panelModel(a, lang), () => {}, { lang });
    const nodes = walk(root);
    assert.ok(nodes.some(n => n.textContent === t('notice.review', lang)), lang);
    assert.ok(nodes.some(n => n.textContent === '<b>New comment</b> from rev'), 'the notice is text');
    assert.ok(!nodes.some(n => n.tag === 'b' && n.textContent === 'New comment'));
    const link = nodes.find(n => n.tag === 'a');
    assert.equal(link.href, PR);
    assert.equal(link.textContent, t('panel.prLink', lang));
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  }
  const root = clickDoc();
  renderPanel(root, panelModel({ id: 'r', label: 'r', state: 'work', look: { model: 'opus' }, info: { live: true, task: 'x', steps: [], where: 'w', since: 1, notice: { kind: 'ci', text: 'x', url: 'javascript:alert(1)' } } }), () => {}, {});
  assert.equal(walk(root).some(n => n.tag === 'a'), false, 'no link that is not a GitHub PR');
});

test('the Wake button calls onWake once at a time and shows its lines or its error', async () => {
  const parked = { id: 'p', label: 'p', state: 'sleep', look: { model: 'opus' }, info: { live: true, task: 'x', steps: [], where: 'web', since: 1, parked: true } };
  const root = clickDoc();
  let calls = 0, finish;
  const onWake = () => { calls++; return new Promise(r => { finish = r; }); };
  renderPanel(root, panelModel(parked), () => {}, { onWake, onTerminal: async () => null });
  assert.equal(walk(root).some(n => n.tag === 'button' && n.textContent === t('panel.openTerminal')), false);
  const btn = walk(root).find(n => n.tag === 'button' && n.textContent === t('panel.wake'));
  assert.ok(btn);
  btn.listeners.click();
  btn.listeners.click();
  assert.equal(calls, 1);
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, t('panel.waking'));
  finish({ ok: false, message: '<i>p is closing</i>' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(btn.disabled, false);
  const text = walk(root).map(n => n.textContent).join('|');
  assert.ok(text.includes(t('panel.wakeFailed', 'en', { message: '<i>p is closing</i>' })), text);

  const again = clickDoc();
  renderPanel(again, panelModel(parked), () => {}, { onWake: async () => ({ ok: true, lines: ['woke p: resumed its session'] }), wakeResult: { ok: true, lines: ['earlier'] } });
  assert.ok(walk(again).some(n => n.textContent === 'earlier'), 'a remembered result survives a re-render');
  walk(again).find(n => n.tag === 'button' && n.textContent === t('panel.wake')).listeners.click();
  await new Promise(r => setTimeout(r, 0));
  assert.ok(walk(again).some(n => n.textContent === 'woke p: resumed its session'));
});

test('a wake result is shown even when the room already left the couch before it arrived', () => {
  const ready = { id: 'p', label: 'p', state: 'ready', look: { model: 'opus' }, info: { live: true, task: 'x', steps: [], where: 'web', since: 1 } };
  for (const [result, text] of [
    [{ ok: true, lines: ['woke p — it is asking something in its tab: answer it there'] }, 'woke p — it is asking something in its tab: answer it there'],
    [{ ok: false, message: 'p is closing' }, t('panel.wakeFailed', 'en', { message: 'p is closing' })],
  ]) {
    const root = clickDoc();
    renderPanel(root, panelModel(ready), () => {}, { onWake: async () => null, onTerminal: async () => null, wakeResult: result });
    assert.ok(walk(root).some(n => n.textContent === text), text);
    assert.equal(walk(root).some(n => n.tag === 'button' && n.textContent === t('panel.wake')), false, 'no Wake button: it is awake');
  }
});
