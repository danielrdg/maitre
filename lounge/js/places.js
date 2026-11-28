export const FLOOR = {
  size: [576, 324],
  spots: {
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
  },
  aisleY: 266,
  door: [94, 302],
  streetX: 86,
  doorLead: 118,
  exit: [-30, 302],
  slotX: [300, 331],
  win: { x: 528, y: 20, w: 46, h: 176 },
  lanterns: [[124, 16], [190, 26], [256, 18], [454, 22], [322, 30]],
  neon: [42, 80],
  queueTag: [40, 262],
  // In front of the floor's lift doors (x 22–66, sill at 206), where a floor's paths start and end.
  elevator: { door: [44, 212] },
  npcs: {
    maitre: { x: 246, y: 284 },
    barman: { x: 416, y: 198 },
    dealer: { x: 235, y: 236 },
    sax: { x: 146, y: 286 },
    waiter: { x: 130, y: 266, dir: 1 },
    bouncer: { x: 76, y: 304 },
  },
};

// The lobby + terrace view. The sidewalk, the street door and the bell keep the floor's old places;
// the lift doors and the terrace are the building's.
export const LOBBY = {
  lift: [129, 206],
  terraceLift: [129, 108],
  terraceY: 108,
  spots: {
    blocked: FLOOR.spots.blocked,
    queue: FLOOR.spots.queue,
    smoke: [[196, 106], [232, 108], [270, 106], [372, 108], [410, 106], [448, 108], [490, 106], [526, 108]],
    // A room whose floor isn't open yet waits by the armchairs.
    wait: [[452, 282], [520, 282], [486, 300]],
  },
  neon: [42, 176],
  terraceNeon: [129, 43],
};
