import { mulberry32 } from './rng.js';

export const W = 576, H = 324;
export const WIN = { x: 528, y: 20, w: 46, h: 176 };
export const SLOT_X = [300, 331];

const rectFn = g => (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };

// Background painted once. The fixed seed keeps the skyline and bottles identical every run.
export function drawStatic(g) {
  const R = rectFn(g);
  const rnd = mulberry32(11);
  // street
  for (let y = 0; y < 197; y++) { const t = y / 197; R(0, y, 86, 1, `rgb(${8 + t * 16 | 0},${11 + t * 20 | 0},${26 + t * 34 | 0})`); }
  for (let i = 0; i < 22; i++) R(rnd() * 84, rnd() * 90, 1, 1, rnd() > .5 ? '#d4dcff' : '#8590c0');
  for (const [x, y, w] of [[0, 104, 18], [18, 88, 14], [32, 116, 20], [52, 96, 16], [68, 124, 18]]) { R(x, y, w, 197 - y, '#0e1324');
    for (let wy = y + 5; wy < 192; wy += 8) for (let wx = x + 3; wx < x + w - 2; wx += 4) if (rnd() > .5) R(wx, wy, 2, 3, rnd() > .3 ? '#e8b85a' : '#7aa0ff'); }
  R(5, 150, 2, 150, '#2b2f3c'); R(2, 146, 10, 4, '#2b2f3c'); R(3, 150, 8, 2, '#ffe3a0');
  R(0, 197, 86, 127, '#23252e'); for (let x = 0; x < 86; x += 14) R(x, 197, 1, 127, '#1b1d25');
  for (let y = 212; y < 324; y += 16) R(0, y, 86, 1, '#1b1d25'); R(0, 318, 86, 6, '#14161c');
  R(8, 64, 68, 2, '#ff5fa2'); R(8, 94, 68, 2, '#ff5fa2'); R(8, 64, 2, 32, '#ff5fa2'); R(74, 64, 2, 32, '#ff5fa2');
  // lacquered wall
  R(86, 0, 490, 197, '#3a130f');
  for (let y = 0; y < 156; y += 16) for (let x = 86; x < 576; x += 16) {
    R(x, y, 16, 1, '#4a1a12'); R(x, y, 1, 16, '#4a1a12');
    R(x + 7, y + 4, 2, 8, '#541d14'); R(x + 4, y + 7, 8, 2, '#541d14'); R(x + 7, y + 7, 2, 2, '#6e2c18'); R(x + 5, y + 5, 1, 1, '#4f1b13'); }
  R(86, 156, 490, 41, '#24100b'); for (let x = 92; x < 576; x += 22) { R(x, 162, 17, 30, '#2c140d'); R(x, 162, 17, 1, '#3a1c12'); R(x, 191, 17, 1, '#1a0b07'); }
  R(86, 155, 490, 2, '#c89a3c'); R(86, 196, 490, 2, '#c89a3c');
  // floor
  for (let y = 198; y < 324; y += 8) { R(86, y, 490, 8, (y / 8) % 2 ? '#3a2216' : '#34200f');
    const off = (y / 8) % 3 * 17; for (let x = 86 + off; x < 576; x += 50) R(x, y, 1, 8, '#26150c'); R(86, y + 7, 490, 1, '#2a180d'); }
  // rug under the table
  R(158, 242, 156, 22, '#7a1c20'); R(158, 242, 156, 2, '#d9a441'); R(158, 262, 156, 2, '#d9a441'); R(158, 242, 2, 22, '#d9a441'); R(312, 242, 2, 22, '#d9a441');
  for (let x = 166; x < 308; x += 10) { R(x, 251, 3, 3, '#a8323a'); R(x + 1, 252, 1, 1, '#d9a441'); }
  // musician's stage
  R(110, 282, 70, 10, '#5a3320'); R(112, 280, 66, 3, '#8a5130'); R(110, 291, 70, 2, '#2a160b'); R(112, 280, 66, 1, '#d9a441');
  // door
  R(84, 96, 20, 210, '#7a1c16'); R(84, 96, 20, 3, '#d9a441'); R(84, 96, 2, 210, '#d9a441'); R(102, 96, 2, 210, '#d9a441');
  R(87, 101, 14, 200, '#2a120c'); R(87, 101, 7, 200, '#5a1a12'); R(93, 101, 1, 200, '#3a100c'); R(96, 101, 4, 200, '#c8803a'); R(97, 101, 2, 200, '#f0b060');
  // sofa (backrest)
  R(106, 160, 66, 24, '#8e2a3a'); for (let x = 110; x < 170; x += 8) { R(x, 165, 1, 1, '#5e1626'); R(x + 4, 172, 1, 1, '#5e1626'); R(x, 179, 1, 1, '#5e1626'); }
  R(106, 160, 66, 2, '#b04558');
  // lamp
  R(178, 168, 10, 2, '#5a3320'); R(182, 150, 2, 18, '#d9a441'); R(176, 140, 14, 10, '#e8c890'); R(176, 140, 14, 1, '#fff0c8');
  // slot machines (cabinets)
  for (const mx of SLOT_X) {
    R(mx, 146, 28, 66, '#a3221b'); R(mx + 2, 147, 2, 64, '#c8362c'); R(mx + 24, 147, 2, 64, '#7a1812');
    R(mx - 2, 136, 32, 11, '#d9a441'); R(mx, 138, 28, 7, '#7a1812');
    R(mx + 2, 154, 24, 18, '#140806'); R(mx + 2, 176, 24, 4, '#5a120e'); R(mx + 6, 190, 16, 8, '#7a1812'); R(mx + 7, 191, 14, 2, '#d9a441');
    R(mx + 1, 212, 26, 2, '#3a0d0a'); }
  // bar: shelves and mirror
  R(364, 60, 106, 88, '#1c0c08'); R(364, 60, 106, 2, '#c89a3c'); R(366, 64, 102, 82, '#24120c');
  for (const sy of [86, 112, 138]) R(364, sy, 106, 3, '#5a3320');
  const BOT = ['#c98a2a', '#3f8a4a', '#d9d2c0', '#8a2a2a', '#6a8ad0', '#e0b050', '#c0c8d0'];
  for (const sy of [86, 112, 138]) for (let x = 368; x < 466; x += 5 + (rnd() * 3 | 0)) {
    const hh = 9 + (rnd() * 9 | 0), c = BOT[rnd() * BOT.length | 0];
    R(x, sy - hh, 3, hh, c); R(x + 1, sy - hh - 3, 1, 3, c); R(x, sy - hh + 2, 1, hh - 4, 'rgba(255,255,255,.28)'); R(x, sy - 4, 3, 2, 'rgba(255,255,255,.35)'); }
  // moon gate (VIP)
  const cx = 496, cy = 146, r = 34;
  for (let y = -r - 3; y <= r + 3; y++) for (let x = -r - 3; x <= r + 3; x++) { const dd = Math.sqrt(x * x + y * y);
    if (cy + y > 196) continue;
    if (dd <= r) R(cx + x, cy + y, 1, 1, cy + y > 176 ? '#2a0e0a' : '#1c0807');
    else if (dd <= r + 3) R(cx + x, cy + y, 1, 1, dd > r + 2 ? '#8a6420' : '#d9a441'); }
  R(462, 178, 69, 19, '#2a0e0a');
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; R(cx + Math.cos(a) * 26, cy - 10 + Math.sin(a) * 6, 2, 2, '#6a2a18'); }
  R(482, 156, 28, 22, '#5e1428'); R(482, 156, 28, 2, '#8a2440'); R(486, 160, 20, 1, '#4a1020');
  // terrace
  for (let y = WIN.y; y < 197; y++) { const t = (y - WIN.y) / 176; R(WIN.x, y, WIN.w, 1, `rgb(${10 + t * 18 | 0},${18 + t * 22 | 0},${44 + t * 30 | 0})`); }
  for (let i = 0; i < 14; i++) R(WIN.x + 1 + rnd() * 44, WIN.y + 2 + rnd() * 70, 1, 1, '#d4dcff');
  const mx2 = 556, my2 = 40; for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) if (x * x + y * y <= 36) R(mx2 + x, my2 + y, 1, 1, (x + 2) * (x + 2) + (y - 1) * (y - 1) < 6 ? '#ffffff' : '#f3e7bd');
  for (const [x, y, w] of [[528, 120, 12], [540, 100, 10], [550, 128, 14], [564, 108, 10]]) { R(x, y, w, 197 - y, '#121a33');
    for (let wy = y + 4; wy < 192; wy += 7) for (let wx = x + 2; wx < x + w - 1; wx += 4) if (rnd() > .5) R(wx, wy, 2, 3, '#e8b85a'); }
  R(526, 18, 50, 3, '#5a3320'); R(526, 18, 3, 179, '#5a3320'); R(550, 21, 2, 176, '#5a3320');
  R(528, 168, 48, 3, '#7a4e2c'); for (let x = 531; x < 576; x += 6) R(x, 171, 2, 26, '#6a4024');
  // standing ashtray
  R(551, 214, 2, 22, '#8a8a92'); R(546, 212, 12, 3, '#6a6a72'); R(547, 236, 10, 2, '#6a6a72');
}
