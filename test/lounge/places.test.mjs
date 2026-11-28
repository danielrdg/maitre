import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLOOR } from '../../lounge/js/places.js';
import { SPOTS, DOOR, AISLE_Y, planPath } from '../../lounge/js/agents.js';
import { W, H, WIN, SLOT_X } from '../../lounge/js/scene-static.js';
import { LANTERNS } from '../../lounge/js/scene.js';
import { NPCS } from '../../lounge/js/demo.js';

test('FLOOR.spots keeps every spot of the lounge', () => {
  assert.deepEqual(FLOOR.spots, {
    queue: [[20, 302], [40, 302], [60, 302], [-6, 302], [-26, 302], [-46, 302]],
    work: [[186, 238], [210, 238], [260, 238], [284, 238], [162, 238]],
    smoke: [[538, 236], [566, 236]],
    blocked: [[300, 314], [322, 314]],
    visitor: [[470, 238]],
    boss: [[496, 192]],
    slot: [[314, 238], [345, 238]],
    coffee: [[378, 242], [400, 242]],
    whisky: [[454, 242], [432, 242]],
    ready: [[394, 219], [452, 219]],
    sleep: [[136, 199]],
    dance: [[364, 306], [402, 316], [440, 306]],
  });
});

test('the old exports are aliases of the registry', () => {
  assert.equal(SPOTS, FLOOR.spots);
  assert.equal(DOOR, FLOOR.door);
  assert.equal(AISLE_Y, FLOOR.aisleY);
  assert.equal(WIN, FLOOR.win);
  assert.equal(SLOT_X, FLOOR.slotX);
  assert.equal(LANTERNS, FLOOR.lanterns);
  assert.deepEqual([W, H], FLOOR.size);
});

test('door, street, neon, queue tag and window keep their values', () => {
  assert.deepEqual(FLOOR.door, [94, 302]);
  assert.equal(FLOOR.aisleY, 266);
  assert.equal(FLOOR.streetX, 86);
  assert.deepEqual(FLOOR.slotX, [300, 331]);
  assert.deepEqual(FLOOR.win, { x: 528, y: 20, w: 46, h: 176 });
  assert.deepEqual(FLOOR.neon, [42, 80]);
  assert.deepEqual(FLOOR.queueTag, [40, 262]);
  assert.deepEqual(FLOOR.lanterns, [[124, 16], [190, 26], [256, 18], [454, 22], [322, 30]]);
});

test('the elevator door is a point inside the canvas', () => {
  const [x, y] = FLOOR.elevator.door;
  assert.ok(x >= 0 && x < FLOOR.size[0] && y >= 0 && y < FLOOR.size[1]);
});

test('the door lead-in and the exit point keep their values', () => {
  assert.equal(FLOOR.doorLead, 118);
  assert.deepEqual(FLOOR.exit, [-30, 302]);
  assert.deepEqual(planPath([300, 238], [0, 0], 'exit'), [[300, 266], [118, 266], [94, 302], [-30, 302]]);
  assert.deepEqual(planPath([20, 302], [200, 238], 'work'), [[94, 302], [118, 266], [200, 266], [200, 238]]);
});

test('NPCS stand where they always stood', () => {
  const want = {
    maitre: [246, 284], barman: [416, 198], dealer: [235, 236],
    sax: [146, 286], waiter: [130, 266], bouncer: [76, 304],
  };
  assert.equal(NPCS.length, 6);
  for (const n of NPCS) {
    assert.deepEqual([n.x, n.y], want[n.kind]);
  }
  assert.equal(NPCS.find(n => n.kind === 'waiter').dir, 1);
});
