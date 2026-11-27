import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { panelModel, musicMenuModel, renderPanel } from '../../lounge/js/panel.js';
import { t } from '../../lounge/js/i18n.js';
import { createCast } from '../../lounge/js/agents.js';
import { mulberry32 } from '../../lounge/js/rng.js';

test('the blocked db-migration agent offers 3 options with exactly one recommended', () => {
  const a = createCast({ rng: mulberry32(1) }).find(x => x.id === 'db-migration');
  assert.ok(a, 'db-migration in the demo cast');
  const m = panelModel(a);
  assert.equal(m.title, 'db-migration');
  assert.ok(m.block, 'has a block');
  assert.ok(m.block.reason.length > 0);
  assert.equal(m.block.options.length, 3);
  assert.deepEqual(m.block.options.map(o => o.key), ['A', 'B', 'C']);
  assert.equal(m.block.options.filter(o => o.recommended).length, 1);
  assert.ok(m.block.options.every(o => o.text && o.detail));
});

test('a non-blocked agent has no block and lists its steps', () => {
  const a = createCast({ rng: mulberry32(1) }).find(x => x.id === 'nf-bug');
  const m = panelModel(a);
  assert.equal(m.block, undefined);
  assert.ok(m.steps.length > 0);
  assert.equal(m.state, 'Working');
});

test('no lounge module writes HTML from strings', () => {
  const dir = new URL('../../lounge/js/', import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 10, `only ${files.length} modules found`);
  const sinks = /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write(ln)?\b/;
  const hits = files.filter(f => sinks.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(hits, []);
});

test('the music menu offers Off, Jazz (calm) and House with the current one selected', () => {
  const m = musicMenuModel('jazz', 0.6);
  assert.deepEqual(m.options.map(o => o.label), ['Off', 'Jazz (calm)', 'House']);
  assert.deepEqual(m.options.filter(o => o.selected).map(o => o.key), ['jazz']);
  assert.equal(m.volume, 60);
  assert.equal(musicMenuModel('off', 2, 'pt-BR').options[0].label, 'Desligada');
  assert.equal(musicMenuModel('off', 2).volume, 100);
});

const liveAgent = (id, over = {}) => ({
  id, label: id, state: 'work', look: { model: 'opus' },
  info: { live: true, task: 'Fix it', steps: [], where: id, since: Date.now() }, ...over,
});

test('a live room offers its terminal, a subagent and a demo agent do not', () => {
  const m = panelModel(liveAgent('api'));
  assert.equal(m.terminal, true);
  assert.equal(m.room, 'api');
  assert.equal('terminal' in panelModel(liveAgent('api/s-1', { label: 'api ↳ Explore', state: 'slot' })), false);
  const demo = createCast({ rng: mulberry32(1) }).find(x => x.id === 'nf-bug');
  assert.equal('terminal' in panelModel(demo), false);
});

// Enough DOM to render a panel and click its buttons.
function clickDoc() {
  const node = tag => {
    const n = {
      tag, children: [], attrs: {}, style: {}, listeners: {}, className: '', textContent: '', title: '', placeholder: '', disabled: false,
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
const walkNodes = n => [n, ...(n.children || []).flatMap(walkNodes)];
const textOf = n => (n.textContent || '') + (n.children || []).map(textOf).join('');

test('the terminal button calls onTerminal and shows the error line when it fails', async () => {
  const root = clickDoc();
  let calls = 0, finish;
  const onTerminal = () => { calls++; return new Promise(r => { finish = r; }); };
  renderPanel(root, panelModel(liveAgent('api')), () => {}, { onTerminal });
  const btn = walkNodes(root).find(n => n.tag === 'button' && n.textContent === t('panel.openTerminal'));
  assert.ok(btn, 'the panel has an Open in terminal button');
  btn.listeners.click();
  assert.equal(calls, 1);
  assert.equal(btn.disabled, true, 'no second terminal while the first is opening');
  finish('<b>api is not running</b>');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(btn.disabled, false);
  assert.ok(textOf(root).includes(t('panel.terminalFailed', 'en', { message: '<b>api is not running</b>' })));
  assert.ok(walkNodes(root).every(n => n.tag !== 'b' || n.textContent !== 'api is not running'), 'the message stays text');
});

test('a successful terminal open shows no error line and a demo panel has no button', async () => {
  const root = clickDoc();
  renderPanel(root, panelModel(liveAgent('api')), () => {}, { onTerminal: async () => null, terminalError: 'old failure' });
  assert.ok(textOf(root).includes('old failure'), 'a remembered error survives a re-render');
  walkNodes(root).find(n => n.tag === 'button' && n.textContent === t('panel.openTerminal')).listeners.click();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(textOf(root).includes('old failure'), false);

  const demoRoot = clickDoc();
  renderPanel(demoRoot, panelModel(createCast({ rng: mulberry32(1) }).find(x => x.id === 'nf-bug')), () => {});
  assert.equal(walkNodes(demoRoot).some(n => n.textContent === t('panel.openTerminal')), false);
});

test('a blocked live room still shows the terminal button', () => {
  const root = clickDoc();
  const a = liveAgent('api', { state: 'blocked' });
  a.info.block = { kind: 'permission', tool: 'Bash', detail: 'rm -rf build' };
  renderPanel(root, panelModel(a), () => {}, { onTerminal: async () => null });
  assert.ok(walkNodes(root).some(n => n.tag === 'button' && n.textContent === t('panel.openTerminal')));
});

test('a queued live room has no terminal to open yet', () => {
  const m = panelModel(liveAgent('q', { state: 'queue', look: { model: 'queued' } }));
  assert.equal('terminal' in m, false);
  assert.equal(m.state, 'Queued, waiting for a seat');
  assert.equal(panelModel(liveAgent('c', { state: 'sleep' })).terminal, true, 'a couched room keeps running');
});

test('the queue and couch lines exist in both languages', () => {
  for (const lang of ['en', 'pt-BR']) {
    assert.match(t('panel.queued', lang, { n: 2 }), /2/);
    assert.match(t('panel.couch', lang, { reasons: 'r' }), /: r$/);
  }
});
