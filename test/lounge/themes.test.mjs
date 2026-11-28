import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEME_IDS, THEMES, musicFor, themeOf, nextTheme } from '../../lounge/js/themes.js';
import { drawStatic } from '../../lounge/js/scene-static.js';
import { renderFrame } from '../../lounge/js/scene.js';
import { createWorld, stepWorld, makeRngs, STEP } from '../../lounge/js/sim.js';

// Records the rectangles painted, so each theme can be told apart from the hall.
function fakeCanvas() {
  const calls = [];
  const ctx = new Proxy({
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect: (...a) => calls.push([ctx.fillStyle, ...a].join()),
  }, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { width: 0, height: 0, getContext: () => ctx, calls };
}
globalThis.document ??= { createElement: () => fakeCanvas() };

const shape = th => Object.fromEntries(Object.entries(th).map(([k, v]) => [k, Array.isArray(v) ? `array:${v.length}` : typeof v]));

test('THEME_IDS lists the six themes in order', () => {
  assert.deepEqual(THEME_IDS, ['hall', 'casino', 'deco', 'tiki', 'karaoke', 'garden']);
  assert.deepEqual(Object.keys(THEMES), THEME_IDS);
});

test('every theme has the same palette keys as hall, with the same array lengths', () => {
  const hall = shape(THEMES.hall);
  for (const id of THEME_IDS) {
    assert.equal(THEMES[id].id, id);
    assert.deepEqual(shape(THEMES[id]), hall, id);
  }
});

test('musicFor: casino and karaoke play house, the rest jazz', () => {
  assert.equal(musicFor('casino'), 'house');
  assert.equal(musicFor('karaoke'), 'house');
  for (const id of ['hall', 'deco', 'tiki', 'garden']) assert.equal(musicFor(id), 'jazz', id);
  for (const id of THEME_IDS) assert.equal(THEMES[id].music, musicFor(id), id);
});

test('musicFor of an unknown id is jazz', () => {
  assert.equal(musicFor('nope'), 'jazz');
  assert.equal(musicFor(undefined), 'jazz');
  assert.equal(musicFor('constructor'), 'jazz');
});

test('themeOf: a known id gives its theme, anything else the hall', () => {
  for (const id of THEME_IDS) assert.equal(themeOf(id), THEMES[id]);
  for (const bad of ['nope', '', null, undefined, 'toString', '__proto__']) assert.equal(themeOf(bad), THEMES.hall, String(bad));
});

test('every theme paints its own floor and draws frames, and the hall is the default', () => {
  const paint = th => { const c = fakeCanvas(); th ? drawStatic(c.getContext('2d'), th) : drawStatic(c.getContext('2d')); return c.calls.join('|'); };
  const frames = th => {
    const { rng, fxRng } = makeRngs(7), world = createWorld({ demo: true, rng, fxRng }), c = fakeCanvas(), bg = fakeCanvas();
    for (let i = 1; i <= 120; i++) { stepWorld(world, STEP, i * STEP, { later() {} }); th ? renderFrame(c.getContext('2d'), bg, world, i * STEP, th) : renderFrame(c.getContext('2d'), bg, world, i * STEP); }
    return c.calls.join('|');
  };
  assert.equal(paint(), paint(THEMES.hall));
  assert.equal(frames(), frames(THEMES.hall));
  const seen = new Set([paint(THEMES.hall)]), seenFrames = new Set([frames(THEMES.hall)]);
  for (const id of THEME_IDS.slice(1)) {
    seen.add(paint(THEMES[id])); seenFrames.add(frames(THEMES[id]));
  }
  assert.equal(seen.size, THEME_IDS.length);
  assert.equal(seenFrames.size, THEME_IDS.length);
});

test('nextTheme lives next to THEME_IDS and hud.js re-exports the same function', async () => {
  assert.equal(nextTheme('garden'), 'hall');
  assert.equal(nextTheme('hall'), 'casino');
  const hud = await import('../../lounge/js/hud.js');
  assert.equal(hud.nextTheme, nextTheme);
});
