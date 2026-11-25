import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { panelModel, musicMenuModel } from '../../lounge/js/panel.js';
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
