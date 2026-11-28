import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFacade, drawFacade } from '../../lounge/js/scene-facade.js';
import { createWorld, makeRngs } from '../../lounge/js/sim.js';
import { addAgent, seat } from '../../lounge/js/agents.js';
import { createLift, facadeLayout } from '../../lounge/js/building.js';
import { t } from '../../lounge/js/i18n.js';
import { lookFor } from '../../lounge/js/live.js';

function fakeCanvas() {
  const ctx = new Proxy({
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop() {} }),
  }, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  return { width: 0, height: 0, getContext: () => ctx };
}
globalThis.document ??= { createElement: () => fakeCanvas() };

test('the facade shows at most two rooms at the lobby bell behind the glass, then a "+N", and only those are clickable', () => {
  const floors = [{ project: 'api', floor: 1, theme: 'deco', locked: false }];
  const { rng, fxRng } = makeRngs(1);
  const world = createWorld({ rng, fxRng, floors });
  for (let i = 0; i < 5; i++) seat(world.agents, addAgent(world.agents, { id: `b${i}`, state: 'blocked', look: lookFor(`b${i}`, 'opus'), info: { project: 'api' }, stacks: true }, rng), floors);
  const r = drawFacade(fakeCanvas().getContext('2d'), buildFacade(fakeCanvas, 1), {
    t: 0.1, frame: 1, floors, scroll: 0, lift: createLift(facadeLayout(floors).levels[0]), agents: world.agents, tr: (k, v) => t(k, 'en', v),
    makeCanvas: fakeCanvas, npcs: {}, ringUntil: 0, focus: null, particles: world.particles,
  });
  const lobbyY = facadeLayout(floors).levels[0].y;
  const atBell = r.hitboxes.filter(h => h.kind === 'agent' && h.y > lobbyY);
  assert.equal(atBell.length, 2);
  assert.ok(atBell.every(h => h.x + h.w <= 430), 'inside the glass');
  const more = r.tags.find(tg => tg.text === '+3');
  assert.ok(more, 'the rest are counted');
  // A left-anchored tag starts at its x; a centred one spreads about 6 px either way.
  const left = more.cls.split(' ').includes('l') ? more.x : more.x - 6;
  assert.ok(atBell.every(h => left >= h.x + h.w + 2), `"+3" at ${more.x} (${more.cls}) clear of the sprites ending at ${atBell.map(h => h.x + h.w)}`);
});
