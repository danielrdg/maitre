import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mascotGrid, OUTLINE } from '../../lounge/js/icon.js';
import { gridToSvg, mascotSvg } from '../../scripts/favicon.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the mascot is a 16x16 grid with the identity-sheet pixels', () => {
  const g = mascotGrid();
  assert.equal(g.length, 16);
  for (const row of g) assert.equal(row.length, 16);
  assert.equal(g[7][5], '#140b08');  // left eye
  assert.equal(g[7][10], '#140b08'); // right eye
  assert.equal(g[12][5], '#c0262a'); // bow tie
  assert.equal(g[12][7], '#8a1a1a'); // bow tie knot
  assert.equal(g[2][6], '#ffffff');  // hair shine
  assert.equal(g[15][2], '#24242e'); // tuxedo
  assert.equal(g[0][0], null);
});

test('the outline rings painted pixels using only the pre-outline shape', () => {
  const g = mascotGrid();
  assert.equal(g[1][4], OUTLINE);  // above the hair
  assert.equal(g[11][3], OUTLINE); // beside the face, above the shoulders
  assert.equal(g[0][4], null);     // two pixels away from the hair: no cascade
  assert.equal(g[15][1], OUTLINE);
  assert.equal(g[15][0], null);
});

test('gridToSvg emits one crisp rect per horizontal run', () => {
  const svg = gridToSvg([['#aaa', '#aaa', null], [null, '#bbb', '#aaa']]);
  assert.equal(svg,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width="3" height="2" shape-rendering="crispEdges">' +
    '<rect x="0" y="0" width="2" height="1" fill="#aaa"/>' +
    '<rect x="1" y="1" width="1" height="1" fill="#bbb"/>' +
    '<rect x="2" y="1" width="1" height="1" fill="#aaa"/>' +
    '</svg>\n');
});

test('the shipped favicon is the generated mascot', () => {
  const svg = mascotSvg();
  assert.match(svg, /viewBox="0 0 16 16"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.equal(readFileSync(join(ROOT, 'lounge', 'favicon.svg'), 'utf8'), svg);
});

test('index.html links the svg favicon', () => {
  const html = readFileSync(join(ROOT, 'lounge', 'index.html'), 'utf8');
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="favicon.svg">/);
});
