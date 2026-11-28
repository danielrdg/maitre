import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hudModel, renderHud, renderHelp, LEGEND, viewsModel, renderViews, chipModel, nextTheme, themeButtonModel, tagRise } from '../../lounge/js/hud.js';
import { THEME_IDS } from '../../lounge/js/themes.js';

// Just enough DOM for the HUD renderers.
function fakeDoc() {
  const made = [];
  const node = tag => {
    const n = {
      tag, children: [], attrs: {}, style: {}, className: '', textContent: '', title: '', type: '',
      append(...c) { n.children.push(...c); },
      replaceChildren(...c) { n.children = c; },
      setAttribute(k, v) { n.attrs[k] = v; },
      addEventListener() {},
    };
    made.push(n);
    return n;
  };
  const doc = { createElement: node, createTextNode: text => ({ tag: '#text', textContent: text }), made };
  const root = node('div');
  root.ownerDocument = doc;
  return { doc, root };
}

const buttonTexts = doc => doc.made.filter(n => n.tag === 'button').map(n => n.textContent);
const SIMULATE = ['Simulate blocked agent', 'Simulate merge', 'New room in queue'];

test('without demo the HUD has Sound, Names and ? only, and no simulate controls', () => {
  const m = hudModel({ demo: false });
  assert.deepEqual(m.buttons, ['sound', 'names', 'help']);
  assert.deepEqual(m.demoActions, []);
  const { doc, root } = fakeDoc();
  const els = renderHud(root, m);
  assert.deepEqual(Object.keys(els.actions), []);
  assert.equal(els.demo, undefined);
  for (const s of SIMULATE) assert.ok(!buttonTexts(doc).includes(s), s);
});

test('with demo=1 the simulate controls sit behind a demo menu button', () => {
  const m = hudModel({ demo: true });
  assert.deepEqual(m.buttons, ['sound', 'names', 'help', 'demo']);
  const { doc, root } = fakeDoc();
  const els = renderHud(root, m);
  assert.deepEqual(Object.keys(els.actions), ['block', 'merge', 'newRoom']);
  assert.equal(els.demo.textContent, 'demo');
  assert.deepEqual(els.demoMenu.children.map(c => c.textContent), SIMULATE);
  assert.ok(buttonTexts(doc).includes('?'));
});

test('the help overlay lists the model colors and the one-line hint', () => {
  assert.deepEqual(LEGEND.map(l => l.color), ['#5fd39a', '#5b9cf5', '#a77bf0', '#f2c03a', '#8f8b9c', '#24242e']);
  const { doc, root } = fakeDoc();
  renderHelp(root, { lang: 'en' });
  const texts = doc.made.map(n => n.textContent).concat(doc.made.flatMap(n => n.children).map(c => c.textContent));
  for (const s of ['Haiku', 'Sonnet', 'Opus', 'Fable', 'Queued', 'Staff (not agents)']) assert.ok(texts.includes(s), s);
  assert.ok(texts.includes('Click an agent for details · pull a slot lever · click the musician for music'));
});

test('hud.js never uses innerHTML', () => {
  const src = readFileSync(new URL('../../lounge/js/hud.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('innerHTML'));
});

const fl = (project, floor) => ({ project, floor, theme: 'hall', locked: false });

test('the view switcher offers the building, the floor and the lobby, and marks the open one', () => {
  const m = viewsModel([fl('webshop', 1), fl('api', 4)], { view: 'lobby' }, 'lobby');
  assert.deepEqual(m.views.map(v => [v.view, v.on]), [['facade', false], ['floor', false], ['lobby', true]]);
  assert.equal(viewsModel([], { view: 'lobby' }, 'lobby').views.find(v => v.view === 'floor').disabled, true, 'no floor to open');
});

test('the lift lists every open floor, top to bottom, between the roof and the lobby', () => {
  const floors = [9, 1, 3, 2, 4, 6, 7].map(n => fl(`p${n}`, n));
  const m = viewsModel(floors, { view: 'facade' }, 3);
  assert.deepEqual(m.lift.map(b => b.key), ['roof', 9, 7, 6, 4, 3, 2, 1, 'lobby']);
  assert.deepEqual(m.lift.map(b => b.label), ['R', '9', '7', '6', '4', '3', '2', '1', 'L']);
  assert.deepEqual(viewsModel(floors, { view: 'facade' }, 3, null, 'pt-BR').lift.map(b => b.label), ['T', '9', '7', '6', '4', '3', '2', '1', 'S'], 'terraço, saguão');
  assert.deepEqual(m.lift.filter(b => b.on).map(b => b.key), [3]);
  assert.equal(m.lift.find(b => b.key === 4).project, 'p4');
});

test('the chip names the first room that needs you, with its project, and counts the rest', () => {
  const agent = (label, state, project, walking = false) => ({ label, state, walking, info: { project } });
  assert.equal(chipModel([agent('a', 'work', 'api')]), null);
  const m = chipModel([agent('a', 'work', 'api'), agent('b', 'blocked', 'api', true), agent('c', 'blocked', 'web')]);
  assert.equal(m.agent.label, 'c', 'one already at the bell comes first');
  assert.equal(m.project, 'web');
  assert.equal(m.more, 1);
  assert.equal(chipModel([agent('s', 'blocked', 'scratch')]).project, 'scratch');
  assert.equal(chipModel([agent('s', 'blocked', undefined)]).project, null, 'a room not placed yet has no project to name');
});

test('with several rooms at the bell, the chip names the one waiting longest', () => {
  const agent = (label, since, walking = false) => ({ label, state: 'blocked', walking, info: { project: 'api', since } });
  const m = chipModel([agent('new', 300), agent('old', 100), agent('mid', 200), agent('walking', 50, true)]);
  assert.equal(m.agent.label, 'old', 'the oldest among those already at the bell');
  assert.equal(m.more, 3);
  assert.equal(chipModel([agent('w2', 90, true), agent('w1', 40, true)]).agent.label, 'w1', 'none at the bell yet: the oldest');
});

test('the theme button cycles through the six themes and wraps around', () => {
  assert.equal(nextTheme('garden'), 'hall');
  assert.equal(nextTheme('hall'), 'casino');
  const seen = [];
  for (let id = 'hall', i = 0; i < THEME_IDS.length; i++, id = nextTheme(id)) seen.push(id);
  assert.deepEqual(seen, THEME_IDS, 'one click per theme, in order');
});

const floorOf = (project, floor, theme, locked = false) => ({ project, floor, theme, locked });

test("the floor's theme button names the floor and its theme and offers the next one", () => {
  const m = themeButtonModel(floorOf('webshop', 2, 'casino'), {}, 'en');
  assert.equal(m.text, 'floor 2 theme: Neon casino ▸');
  assert.equal(m.next, 'deco');
  assert.equal(m.disabled, false);
  assert.equal(m.note, null);
  assert.equal(m.error, null);
  assert.equal(themeButtonModel(floorOf('webshop', 2, 'casino'), {}, 'pt-BR').text, 'andar 2 tema: Cassino neon ▸');
  assert.equal(themeButtonModel(undefined, {}, 'en'), null, 'no floor, no button');
});

test('a theme set in config shows the theme and "set in config", and the button is inert', () => {
  const m = themeButtonModel(floorOf('api', 3, 'tiki', true), {}, 'en');
  assert.equal(m.text, 'floor 3 theme: Tiki bar');
  assert.equal(m.note, 'set in config');
  assert.equal(m.disabled, true);
  assert.equal(m.next, null, 'nothing to cycle to');
  assert.equal(themeButtonModel(floorOf('api', 3, 'tiki', true), {}, 'pt-BR').note, 'definido no config');
});

test("the scratch floor keeps the maître's look; locked comes from the floor, not the name", () => {
  const m = themeButtonModel(floorOf('scratch', 1, 'hall', true), {}, 'en');
  assert.equal(m.disabled, true);
  assert.match(m.note, /scratch floor keeps maître's look/);
  assert.ok(themeButtonModel(floorOf('scratch', 1, 'hall', true), {}, 'pt-BR').note.length > 0);
  assert.notEqual(themeButtonModel(floorOf('scratch', 1, 'hall', true), {}, 'pt-BR').note, m.note);
  assert.equal(themeButtonModel(floorOf('scratch', 1, 'hall', false), {}, 'en').disabled, false, "the demo's open scratch floor still cycles");
});

test('while a save is in flight the button is disabled; an error shows only on its own floor', () => {
  const f = floorOf('webshop', 2, 'casino');
  assert.equal(themeButtonModel(f, { busy: 'webshop' }, 'en').disabled, true);
  assert.equal(themeButtonModel(f, { busy: 'api' }, 'en').disabled, false);
  const err = { project: 'webshop', message: 'boom' };
  assert.equal(themeButtonModel(f, { error: err }, 'en').error, 'Theme not saved: boom');
  assert.equal(themeButtonModel(floorOf('api', 3, 'deco'), { error: err }, 'en').error, null);
});

test('the views bar renders the theme button, its note and its error line on a floor only', () => {
  const { doc, root } = fakeDoc();
  const floors = [floorOf('api', 3, 'tiki', true)];
  const theme = themeButtonModel(floors[0], { error: { project: 'api', message: 'locked' } }, 'en');
  const out = renderViews(root, viewsModel(floors, { view: 'floor', project: 'api' }, 3, theme), 'en');
  assert.equal(out.theme.textContent, 'floor 3 theme: Tiki bar');
  assert.equal(out.theme.disabled, true);
  assert.equal(out.theme.attrs['aria-label'], 'floor 3 theme: Tiki bar · set in config');
  const texts = doc.made.map(n => n.textContent);
  assert.ok(texts.includes('set in config'));
  assert.ok(texts.includes('Theme not saved: locked'));
  const { root: r2 } = fakeDoc();
  assert.equal(renderViews(r2, viewsModel(floors, { view: 'facade' }, 'lobby', theme), 'en').theme, undefined, 'only on a floor view');
});

test('the two name tags at the lobby bell are staggered; the single room keeps its old tags', () => {
  const at = spot => ({ state: 'blocked', spot, walking: false });
  assert.ok(Math.abs(tagRise(at(0), true) - tagRise(at(1), true)) >= 8, 'lobby: one above the other');
  assert.equal(tagRise(at(0), false), 0, 'the single room (README art) is unchanged');
  assert.equal(tagRise(at(1), false), 0);
  assert.equal(tagRise({ state: 'smoke', spot: 0 }, true), 8, 'the terrace keeps its stagger');
  assert.equal(tagRise({ state: 'work', spot: 1 }, false), 9);
});
