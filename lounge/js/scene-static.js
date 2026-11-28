import { FLOOR } from './places.js';
import { mulberry32 } from './rng.js';
import { THEMES, CASINO_SLOT_X } from './themes.js';

export const [W, H] = FLOOR.size;
export const WIN = FLOOR.win;
export const SLOT_X = FLOOR.slotX;
const S = FLOOR.streetX;

const rectFn = g => (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };

function slotBody(R, th, mx) {
  R(mx, 146, 28, 66, th.slot[0]); R(mx + 2, 147, 2, 64, th.slot[1]); R(mx + 24, 147, 2, 64, th.slot[2]);
  R(mx - 2, 136, 32, 11, '#d9a441'); R(mx, 138, 28, 7, th.slot[2]);
  R(mx + 2, 154, 24, 18, '#140806'); R(mx + 2, 176, 24, 4, th.slotEdge[0]); R(mx + 6, 190, 16, 8, th.slot[2]); R(mx + 7, 191, 14, 2, '#d9a441');
  R(mx + 1, 212, 26, 2, th.slotEdge[1]);
}

function paintFloor(R, th, x0 = S) {
  const w = 576 - x0;
  if (th === THEMES.hall) {
    for (let y = 198; y < 324; y += 8) { R(x0, y, w, 8, (y / 8) % 2 ? th.floor[0] : th.floor[1]);
      const off = (y / 8) % 3 * 17; for (let x = x0 + off; x < 576; x += 50) R(x, y, 1, 8, th.floor[2]); R(x0, y + 7, w, 1, th.seam); }
    return;
  }
  for (let y = 198; y < 324; y += 8) {
    const row = (y - 198) / 8;
    if (th === THEMES.deco) { for (let x = x0; x < 576; x += 12) R(x, y, 12, 8, ((x - x0) / 12 + row) % 2 ? th.floor[0] : th.floor[1]); continue; }
    R(x0, y, w, 8, row % 2 ? th.floor[0] : th.floor[1]);
    if (th === THEMES.karaoke) { for (let x = x0; x < 576; x += 16) R(x, y, 1, 8, '#2a3070'); R(x0, y + 7, w, 1, '#0e1030'); continue; }
    if (th === THEMES.casino) { for (let x = x0 + (row % 2) * 10; x < 576; x += 20) R(x + 4, y + 3, 2, 2, '#5a3a20'); continue; }
    const off = row % 3 * 17; for (let x = x0 + off; x < 576; x += 50) R(x, y, 1, 8, th.floor[2]); R(x0, y + 7, w, 1, th.seam);
  }
}

// A building floor: the room runs to the left edge, where the lift lands (its doors are drawn each frame).
function paintLanding(R, th) {
  R(10, 112, 68, 6, th.trim); R(14, 118, 60, 2, 'rgba(0,0,0,.4)'); R(12, 206, 64, 8, 'rgba(0,0,0,.3)'); R(16, 206, 56, 6, '#6a1c20'); R(16, 206, 56, 1, '#d9a441');
  R(76, 176, 5, 9, '#24242e'); R(77, 177, 3, 3, '#d9a441'); R(77, 181, 3, 3, '#5a5a64');
  R(84, 170, 12, 26, '#6b3a22'); for (let i = 0; i < 7; i++) R(82 + i * 2, 150 + (i % 3) * 4, 3, 22, i % 2 ? '#2a6a2a' : '#3a8a3a');
}

// Background painted once. The fixed seed keeps the skyline and bottles identical every run.
// `landing` paints a building floor: no street or door on the left, the lift landing instead.
export function drawStatic(g, th = THEMES.hall, { landing = false } = {}) {
  const R = rectFn(g);
  const rnd = mulberry32(11);
  const x0 = landing ? 0 : S;
  if (!landing) {
    // street
    for (let y = 0; y < 197; y++) { const t = y / 197; R(0, y, S, 1, `rgb(${8 + t * 16 | 0},${11 + t * 20 | 0},${26 + t * 34 | 0})`); }
    for (let i = 0; i < 22; i++) R(rnd() * 84, rnd() * 90, 1, 1, rnd() > .5 ? '#d4dcff' : '#8590c0');
    for (const [x, y, w] of [[0, 104, 18], [18, 88, 14], [32, 116, 20], [52, 96, 16], [68, 124, 18]]) { R(x, y, w, 197 - y, '#0e1324');
      for (let wy = y + 5; wy < 192; wy += 8) for (let wx = x + 3; wx < x + w - 2; wx += 4) if (rnd() > .5) R(wx, wy, 2, 3, rnd() > .3 ? '#e8b85a' : '#7aa0ff'); }
    R(5, 150, 2, 150, '#2b2f3c'); R(2, 146, 10, 4, '#2b2f3c'); R(3, 150, 8, 2, '#ffe3a0');
    R(0, 197, S, 127, '#23252e'); for (let x = 0; x < S; x += 14) R(x, 197, 1, 127, '#1b1d25');
    for (let y = 212; y < 324; y += 16) R(0, y, S, 1, '#1b1d25'); R(0, 318, S, 6, '#14161c');
    R(8, 64, 68, 2, '#ff5fa2'); R(8, 94, 68, 2, '#ff5fa2'); R(8, 64, 2, 32, '#ff5fa2'); R(74, 64, 2, 32, '#ff5fa2');
  }
  // lacquered wall
  const ww = 576 - x0;
  R(x0, 0, ww, 197, th.wall);
  th.paint(g, ww, 156, x0, 0);
  R(x0, 156, ww, 41, th.wains[0]); for (let x = landing ? 6 : 92; x < 576; x += 22) { R(x, 162, 17, 30, th.wains[1]); R(x, 162, 17, 1, th.panel[0]); R(x, 191, 17, 1, th.panel[1]); }
  if (th === THEMES.garden) { for (let x = x0; x < 576; x += 4) R(x, 156 - (x * 7 % 5), 4, 6, '#2a5a24');
    for (let x = x0 + 3; x < 576; x += 11) R(x, 158, 2, 2, ['#ff7aa0', '#ffd45c', '#f2ede2'][x % 3]); }
  R(x0, 155, ww, 2, th.trim); R(x0, 196, ww, 2, th.trim);
  paintFloor(R, th, x0);
  // rug under the table
  R(158, 242, 156, 22, th.rug[0]); R(158, 242, 156, 2, th.rug[1]); R(158, 262, 156, 2, th.rug[1]); R(158, 242, 2, 22, th.rug[1]); R(312, 242, 2, 22, th.rug[1]);
  for (let x = 166; x < 308; x += 10) { R(x, 251, 3, 3, th.rug[2]); R(x + 1, 252, 1, 1, th.rug[1]); }
  // musician's stage
  R(110, 282, 70, 10, th.stage[0]); R(112, 280, 66, 3, th.stageEdge[0]); R(110, 291, 70, 2, th.stageEdge[2]); R(112, 280, 66, 1, th.stageEdge[1]);
  if (landing) paintLanding(R, th);
  else {
    // door
    R(84, 96, 20, 210, '#7a1c16'); R(84, 96, 20, 3, '#d9a441'); R(84, 96, 2, 210, '#d9a441'); R(102, 96, 2, 210, '#d9a441');
    R(87, 101, 14, 200, '#2a120c'); R(87, 101, 7, 200, '#5a1a12'); R(93, 101, 1, 200, '#3a100c'); R(96, 101, 4, 200, '#c8803a'); R(97, 101, 2, 200, '#f0b060');
  }
  // sofa (backrest)
  R(106, 160, 66, 24, th.sofa[0]); for (let x = 110; x < 170; x += 8) { R(x, 165, 1, 1, th.sofaEdge[1]); R(x + 4, 172, 1, 1, th.sofaEdge[1]); R(x, 179, 1, 1, th.sofaEdge[1]); }
  R(106, 160, 66, 2, th.sofa[1]);
  // lamp
  R(178, 168, 10, 2, '#5a3320'); R(182, 150, 2, 18, th.gold); R(176, 140, 14, 10, '#e8c890'); R(176, 140, 14, 1, '#fff0c8');
  // slot machines (cabinets)
  for (const mx of SLOT_X) slotBody(R, th, mx);
  if (th === THEMES.casino) for (const mx of CASINO_SLOT_X) slotBody(R, th, mx);
  // bar: shelves and mirror
  R(364, 60, 106, 88, '#1c0c08'); R(364, 60, 106, 2, th.trim); R(366, 64, 102, 82, th.shelf[0]);
  for (const sy of [86, 112, 138]) R(364, sy, 106, 3, th.shelf[1]);
  const BOT = ['#c98a2a', '#3f8a4a', '#d9d2c0', '#8a2a2a', '#6a8ad0', '#e0b050', '#c0c8d0'];
  for (const sy of [86, 112, 138]) for (let x = 368; x < 466; x += 5 + (rnd() * 3 | 0)) {
    const hh = 9 + (rnd() * 9 | 0), c = BOT[rnd() * BOT.length | 0];
    R(x, sy - hh, 3, hh, c); R(x + 1, sy - hh - 3, 1, 3, c); R(x, sy - hh + 2, 1, hh - 4, 'rgba(255,255,255,.28)'); R(x, sy - 4, 3, 2, 'rgba(255,255,255,.35)'); }
  // VIP: the moon gate in the hall, an arch elsewhere
  const cx = 496, cy = 146, r = 34, hall = th === THEMES.hall;
  for (let y = -r - 3; y <= r + 3; y++) for (let x = -r - 3; x <= r + 3; x++) { const dd = hall || y < 0 ? Math.sqrt(x * x + y * y) : Math.abs(x);
    if (cy + y > 196) continue;
    if (dd <= r) R(cx + x, cy + y, 1, 1, cy + y > 176 ? th.gate[1] : th.gate[0]);
    else if (dd <= r + 3) R(cx + x, cy + y, 1, 1, dd > r + 2 ? th.gate[3] : th.gate[2]); }
  R(462, 178, 69, 19, th.gate[4]);
  if (hall) for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; R(cx + Math.cos(a) * 26, cy - 10 + Math.sin(a) * 6, 2, 2, '#6a2a18'); }
  R(482, 156, 28, 22, th.chair[0]); R(482, 156, 28, 2, th.chair[1]); R(486, 160, 20, 1, th.chair[2]);
  // terrace
  for (let y = WIN.y; y < 197; y++) { const t = (y - WIN.y) / 176; R(WIN.x, y, WIN.w, 1, `rgb(${10 + t * 18 | 0},${18 + t * 22 | 0},${44 + t * 30 | 0})`); }
  for (let i = 0; i < 14; i++) R(WIN.x + 1 + rnd() * 44, WIN.y + 2 + rnd() * 70, 1, 1, '#d4dcff');
  const mx2 = 556, my2 = 40; for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) if (x * x + y * y <= 36) R(mx2 + x, my2 + y, 1, 1, (x + 2) * (x + 2) + (y - 1) * (y - 1) < 6 ? '#ffffff' : '#f3e7bd');
  for (const [x, y, w] of [[528, 120, 12], [540, 100, 10], [550, 128, 14], [564, 108, 10]]) { R(x, y, w, 197 - y, '#121a33');
    for (let wy = y + 4; wy < 192; wy += 7) for (let wx = x + 2; wx < x + w - 1; wx += 4) if (rnd() > .5) R(wx, wy, 2, 3, '#e8b85a'); }
  R(526, 18, 50, 3, th.frame); R(526, 18, 3, 179, th.frame); R(550, 21, 2, 176, th.frame);
  R(528, 168, 48, 3, '#7a4e2c'); for (let x = 531; x < 576; x += 6) R(x, 171, 2, 26, '#6a4024');
  // standing ashtray
  R(551, 214, 2, 22, '#8a8a92'); R(546, 212, 12, 3, '#6a6a72'); R(547, 236, 10, 2, '#6a6a72');
}
