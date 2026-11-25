import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hudModel, renderHud, renderHelp, LEGEND } from '../../lounge/js/hud.js';

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
