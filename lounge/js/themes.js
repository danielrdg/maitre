import { FLOOR } from './places.js';
import { mulberry32 } from './rng.js';

// A theme is the skin of a floor: wall, palette, lights and signature piece. The plan never changes.
// Painters draw on the context passed in; g / R point at it while they run.
let g = null;
const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
const vgrad = (x, y, w, h, a, b) => { for (let i = 0; i < h; i++) { const k = i / h;
  R(x, y + i, w, 1, `rgb(${a[0] + (b[0] - a[0]) * k | 0},${a[1] + (b[1] - a[1]) * k | 0},${a[2] + (b[2] - a[2]) * k | 0})`); } };

// Shades the mockup derives from the palette. The hall overrides them with the colours the lounge has always used.
const derived = th => ({
  panel: ['rgba(255,255,255,.06)', 'rgba(0,0,0,.3)'],
  seam: th.floor[2],
  stageEdge: [th.stage[0], th.stage[1], 'rgba(0,0,0,.4)'],
  sofaEdge: [th.sofa[1], 'rgba(0,0,0,.3)'],
  slotEdge: ['rgba(0,0,0,.35)', 'rgba(0,0,0,.4)', th.slot[2]],
  shelf: [th.counter[2], th.counter[1]],
  cabinet: ['rgba(0,0,0,.18)', 'rgba(0,0,0,0)'],
  stool: [th.chair[0], th.chair[1]],
  gold: th.trim,
  frame: th.counter[1],
  gate: ['rgba(0,0,0,.7)', 'rgba(0,0,0,.55)', th.trim, 'rgba(0,0,0,.4)', 'rgba(0,0,0,.5)'],
  dotFill: th.dots.map(c => `rgba(${c},.5)`),
  vipGlow: `rgba(${th.light},.18)`,
});
const theme = (id, palette, own = {}) => {
  const th = { id, ...palette };
  return Object.assign(th, derived(th), own, { paint: (ctx, w, h, x0 = 0, y0 = 0) => { g = ctx; WALLS[id](th, x0, y0, x0 + w, y0 + h); } });
};

export const THEMES = {
  hall: theme('hall', { name: 'Chinese hall', music: 'jazz', light: '255,186,90', sil: '#1c0806',
    wall: '#3a130f', trim: '#c89a3c', wains: ['#24100b', '#2c140d'], floor: ['#3a2216', '#34200f', '#26150c'],
    rug: ['#7a1c20', '#d9a441', '#a8323a'], sofa: ['#8e2a3a', '#b04558', '#7a2230', '#6a1c28'], slot: ['#a3221b', '#c8362c', '#7a1812'],
    counter: ['#9a5f38', '#6b3a22', '#5a3020'], chair: ['#5e1428', '#8a2440', '#4a1020'], stage: ['#5a3320', '#8a5130'],
    dance: ['#5a1a3a', '#1a2a5a', '#5a4a10', '#1a4a2a', '#3a1a5a'], dots: ['255,95,162', '91,156,245', '255,212,92', '95,211,154'] }, {
    panel: ['#3a1c12', '#1a0b07'], seam: '#2a180d', stageEdge: ['#8a5130', '#d9a441', '#2a160b'], sofaEdge: ['#a8394c', '#5e1626'],
    slotEdge: ['#5a120e', '#3a0d0a', '#3a0d0a'], shelf: ['#24120c', '#5a3320'], cabinet: ['#5a3020', '#7a4a2a'], stool: ['#a3221b', '#d04a40'],
    gold: '#d9a441', frame: '#5a3320', gate: ['#1c0807', '#2a0e0a', '#d9a441', '#8a6420', '#2a0e0a'],
    dotFill: ['rgba(255,95,162,.55)', 'rgba(91,156,245,.5)', 'rgba(255,212,92,.55)', 'rgba(95,211,154,.45)'], vipGlow: 'rgba(255,190,80,.2)' }),
  casino: theme('casino', { name: 'Neon casino', music: 'house', light: '255,120,230', sil: '#0c0418',
    wall: '#1e0f2e', trim: '#ff5fa2', wains: ['#160a22', '#22102e'], floor: ['#3a1a5a', '#331650', '#28104a'],
    rug: ['#1f6b45', '#ffd45c', '#2f8f5e'], sofa: ['#5a1a8a', '#8a3ac0', '#4a1470', '#3a0e5a'], slot: ['#7a28c0', '#9a48e0', '#4a1480'],
    counter: ['#3a3a4a', '#26262e', '#1c1c24'], chair: ['#7a1450', '#b02a78', '#5a0e3a'], stage: ['#2a1a3a', '#4a2a6a'],
    dance: ['#6a0a5a', '#0a4a6a', '#3a0a6a', '#0a5a4a', '#6a2a0a'], dots: ['255,95,220', '80,230,255', '255,212,92', '160,90,255'] }),
  deco: theme('deco', { name: 'Art deco speakeasy', music: 'jazz', light: '255,210,140', sil: '#0e0804',
    wall: '#24160c', trim: '#d9b45a', wains: ['#160d06', '#1e120a'], floor: ['#1c1a1a', '#3a3430', '#141212'],
    rug: ['#1a2a3a', '#d9b45a', '#2a4058'], sofa: ['#1f4a3a', '#2f6a52', '#183a2e', '#12302a'], slot: ['#2a2a2a', '#4a4030', '#161616'],
    counter: ['#7a4a2a', '#4a2a16', '#3a1e0e'], chair: ['#5a1a1a', '#8a3a2a', '#3a1010'], stage: ['#2a1a10', '#d9b45a'],
    dance: ['#3a2a0a', '#141414', '#5a4a1a', '#1c1c1c', '#4a3a12'], dots: ['255,220,150', '255,240,200', '220,180,90', '255,210,140'] }),
  tiki: theme('tiki', { name: 'Tiki bar', music: 'jazz', light: '255,150,60', sil: '#1a0c02',
    wall: '#6a4a1e', trim: '#2fb8a0', wains: ['#3a2410', '#4a3018'], floor: ['#6a5228', '#5e4822', '#4a3818'],
    rug: ['#1a6a6a', '#ffb040', '#2a8a7a'], sofa: ['#c05a1a', '#e07a2a', '#9a4410', '#7a3408'], slot: ['#1a7a6a', '#2a9a8a', '#0e5a4a'],
    counter: ['#a07a38', '#7a5a26', '#5a4018'], chair: ['#2a7a5a', '#3a9a7a', '#1a5a40'], stage: ['#5a4018', '#a07a38'],
    dance: ['#7a3a0a', '#0a5a5a', '#7a5a0a', '#2a5a1a', '#7a1a2a'], dots: ['255,170,60', '60,220,200', '255,230,120', '255,90,90'] }),
  karaoke: theme('karaoke', { name: 'Tokyo karaoke', music: 'house', light: '120,170,255', sil: '#05081a',
    wall: '#12163a', trim: '#5b9cf5', wains: ['#0c0f28', '#141a40'], floor: ['#1a1c34', '#20223e', '#12142a'],
    rug: ['#3a1a4a', '#ff5fa2', '#5a2a6a'], sofa: ['#c02a6a', '#ff5fa2', '#9a1a50', '#7a1240'], slot: ['#2a4ab0', '#4a6ad0', '#1a2a80'],
    counter: ['#2a2e5a', '#1c2048', '#141838'], chair: ['#3a3a8a', '#5a5ab0', '#2a2a6a'], stage: ['#2a1a3a', '#ff5fa2'],
    dance: ['#6a0a3a', '#0a2a6a', '#4a0a6a', '#0a4a6a', '#6a0a5a'], dots: ['255,95,162', '91,156,245', '200,120,255', '120,220,255'] }),
  garden: theme('garden', { name: 'Rooftop garden', music: 'jazz', light: '255,230,160', sil: '#06120a',
    wall: '#0e1a3a', trim: '#7ab060', wains: ['#1a3a1e', '#224a26'], floor: ['#4a3420', '#42301c', '#33240f'],
    rug: ['#3a5a2a', '#e8d070', '#4a7a3a'], sofa: ['#e8dcc0', '#fff4dc', '#c8bc9e', '#a89c80'], slot: ['#3a6a3a', '#5a8a4a', '#24482a'],
    counter: ['#8a6a4a', '#6a4a30', '#4a3420'], chair: ['#c8bc9e', '#e8dcc0', '#8a7e64'], stage: ['#4a3420', '#7ab060'],
    dance: ['#3a4a1a', '#1a3a2a', '#5a4a1a', '#2a4a3a', '#4a3a1a'], dots: ['255,230,140', '200,255,160', '255,200,120', '255,255,210'] }),
};
export const THEME_IDS = Object.keys(THEMES);
export const nextTheme = id => THEME_IDS[(THEME_IDS.indexOf(id) + 1) % THEME_IDS.length];

const own = id => typeof id === 'string' && Object.hasOwn(THEMES, id);
export const themeOf = id => (own(id) ? THEMES[id] : THEMES.hall);
export const musicFor = id => (own(id) ? THEMES[id].music : 'jazz');

// The casino's extra row of slot machines, decor only: nobody plays them.
export const CASINO_SLOT_X = [198, 228, 258];

// ---------- walls ----------
const WALLS = {
  hall(th, x0, y0, x1, y1) {
    for (let y = y0; y < y1; y += 16) for (let x = x0; x < x1; x += 16) {
      R(x, y, 16, 1, '#4a1a12'); R(x, y, 1, 16, '#4a1a12');
      R(x + 7, y + 4, 2, 8, '#541d14'); R(x + 4, y + 7, 8, 2, '#541d14'); R(x + 7, y + 7, 2, 2, '#6e2c18'); R(x + 5, y + 5, 1, 1, '#4f1b13'); }
  },
  casino(th, x0, y0, x1, y1) {
    R(x0, y0, x1 - x0, y1 - y0, th.wall);
    for (let y = y0; y < y1; y += 12) for (let x = x0 + (((y - y0) / 12) % 2) * 8; x < x1; x += 16) {
      R(x + 7, y + 2, 2, 2, '#2c1644'); R(x + 5, y + 4, 6, 2, '#2c1644'); R(x + 7, y + 6, 2, 2, '#2c1644'); }
    for (let x = x0 + 30; x < x1; x += 96) R(x, y0, 2, y1 - y0, '#3a1a5a');
  },
  deco(th, x0, y0, x1, y1) {
    const h = y1 - y0;
    R(x0, y0, x1 - x0, h, th.wall);
    for (let x = x0; x < x1; x += 24) { R(x, y0, 1, h, '#1a0f07'); R(x + 1, y0, 1, h, '#33200f'); R(x + 11, y0 + 8, 2, h - 16, '#2c1b0d'); }
    for (let x = x0 + 12; x < x1; x += 48) for (let r = 0; r < 4; r++) { const ang = -Math.PI + (r + .5) / 4 * Math.PI;
      for (let k = 3; k < 14; k++) R(x + Math.cos(ang) * k, y0 + 18 + Math.sin(ang) * k, 1, 1, '#8a6a2a'); }
    R(x0, y0 + 20, x1 - x0, 1, '#8a6a2a'); R(x0, y0 + 22, x1 - x0, 1, '#5a4018');
  },
  tiki(th, x0, y0, x1, y1) {
    const h = y1 - y0;
    R(x0, y0, x1 - x0, h, th.wall);
    for (let x = x0; x < x1; x += 7) { const c = ((x - x0) / 7) % 2 ? '#7a5a26' : '#8a6a30';
      R(x, y0, 6, h, c); R(x + 1, y0, 1, h, 'rgba(255,230,160,.15)'); R(x + 6, y0, 1, h, '#4a3010');
      for (let y = y0 + ((x * 7) % 14); y < y1; y += 18) R(x, y, 6, 2, '#5a4018'); }
  },
  karaoke(th, x0, y0, x1, y1) {
    const w = x1 - x0, h = y1 - y0;
    R(x0, y0, w, h, th.wall);
    for (let y = y0; y < y1; y += 10) R(x0, y, w, 1, '#1a2050');
    for (let x = x0; x < x1; x += 10) R(x, y0, 1, h, '#1a2050');
    const POST = ['#ffb0d0', '#a0d0ff', '#ffe0a0', '#c0a0ff'];
    for (let i = 0; i < 6; i++) { const px = x0 + 30 + i * 90, py = y0 + 70 + (i % 2) * 14; if (px > x1 - 20) break;
      R(px, py, 14, 20, '#0a0c20'); R(px + 1, py + 1, 12, 18, POST[i % 4]);
      R(px + 3, py + 4, 8, 6, 'rgba(0,0,0,.25)'); R(px + 3, py + 13, 8, 1, 'rgba(0,0,0,.4)'); R(px + 3, py + 15, 5, 1, 'rgba(0,0,0,.4)'); }
  },
  garden(th, x0, y0, x1, y1) {
    const w = x1 - x0, h = y1 - y0, rnd = mulberry32(23);
    vgrad(x0, y0, w, h, [8, 14, 40], [30, 40, 78]);
    for (let i = 0, n = Math.round(w / 12); i < n; i++) R(x0 + rnd() * w, y0 + rnd() * h * .6, 1, 1, rnd() > .5 ? '#d4dcff' : '#8590c0');
    for (let x = x0; x < x1; x += 2) { const th2 = 18 + Math.sin(x * .07) * 6 + Math.sin(x * .23) * 3; R(x, y1 - th2, 2, th2, '#0c1a14'); }
    for (let x = x0 + 4; x < x1; x += 32) R(x, y0, 2, h, '#3a2a1a');
    R(x0, y0 + 4, w, 2, '#3a2a1a');
  },
};

// ---------- ceiling ----------
export function lantern(ctx, x, y, t, i, top = 0) { g = ctx; const sw = Math.round(Math.sin(t * .9 + i * 1.7)); x += sw;
  R(x + 5 - sw, top, 1, y - top, '#5a3320'); R(x + 2, y, 7, 2, '#d9a441'); R(x, y + 2, 11, 13, '#c8281e'); R(x + 1, y + 2, 2, 13, '#e8483a'); R(x + 8, y + 2, 2, 13, '#9a1c14');
  for (const k of [5, 9, 13]) R(x, y + k, 11, 1, '#9a1c14'); R(x + 4, y + 4, 3, 9, '#ffb060'); R(x + 5, y + 5, 1, 7, '#ffe0a0');
  R(x + 2, y + 15, 7, 2, '#d9a441'); R(x + 5, y + 17, 1, 5, '#d9a441'); R(x + 4, y + 22, 3, 1, '#c8281e'); }
const BULB = ['#ffd45c', '#ff7a5a', '#fff0b0', '#ff5fa2'];
export function stringLightsOn(ctx, ...args) { g = ctx; stringLights(...args); }
function stringLights(t, x0 = 90, x1 = 570, y = 44, sag = 10, segs = 6, cols = BULB) { const sw = (x1 - x0) / segs;
  for (let s = 0; s < segs; s++) { const a = x0 + s * sw;
    for (let x = a; x < a + sw; x++) { const k = (x - a) / sw, yy = y + Math.round(Math.sin(k * Math.PI) * sag); R(x, yy, 1, 1, '#2a160b');
      if ((x - a) % 10 === 5) { const on = (Math.floor(t * 3) + x) % 5 !== 0; R(x - 1, yy + 1, 3, 3, on ? cols[(x / 10 | 0) % cols.length] : '#6a4a2a'); } } } }
function discoBall(t) { const cx = 400, cy = 74; R(cx, 0, 1, cy - 7, '#8a8a92');
  for (let y = -7; y <= 7; y++) for (let x = -7; x <= 7; x++) if (x * x + y * y <= 49) { const glint = ((x + y + Math.floor(t * 6)) & 3) === 0;
    R(cx + x, cy + y, 1, 1, glint ? '#ffffff' : ((x ^ y) & 1 ? '#9aa0b0' : '#c8ccd8')); } }
function torch(x, y, t) { R(x, y, 3, 36, '#5a4018'); R(x - 1, y, 5, 4, '#3a2410');
  const f = Math.floor(t * 10 + x) % 3; R(x - 1, y - 5 + f % 2, 5, 5, '#ff7a1a'); R(x, y - 8 + f, 3, 5, '#ffb040'); R(x + 1, y - 9 + f, 1, 3, '#fff0a0'); }

const HANG = {
  casino(x, y) { R(x + 5, 0, 1, y + 4, '#3a3a44'); R(x + 1, y + 4, 9, 2, '#1a5a3a'); R(x - 1, y + 6, 13, 4, '#1f7a4a'); R(x - 1, y + 6, 13, 1, '#3ab070');
    R(x + 2, y + 10, 7, 1, '#fff6d0'); },
  deco(x, y, t, i) { const sw = Math.round(Math.sin(t * .7 + i)); R(x + 5, 0, 1, y, '#8a6a2a'); R(x - 2 + sw, y, 15, 2, '#d9b45a'); R(x + 1 + sw, y + 2, 9, 2, '#b8943a');
    R(x + 4 + sw, y + 4, 3, 5, '#d9b45a'); for (const bx of [-2, 2, 6, 10, 13]) R(x + bx + sw, y - 2, 1, 2, '#fff0c0');
    for (let k = 0; k < 5; k++) R(x - 1 + k * 3 + sw, y + 3 + (k % 2), 1, 3, '#f0e0b0'); },
  tiki(x, y, t, i) { R(x + 5, 0, 1, y, '#5a4018'); const c = ['#ff9a3c', '#2fb8a0', '#ffd45c'][i % 3];
    for (let yy = 0; yy < 10; yy++) for (let xx = 0; xx < 10; xx++) { const dx = xx - 4.5, dy = yy - 4.5; if (dx * dx + dy * dy < 22) R(x + xx, y + yy, 1, 1, (xx + yy) % 3 ? c : '#3a2410'); }
    R(x + 3, y + 2, 2, 2, 'rgba(255,255,255,.5)'); },
  karaoke(x, y, t, i) { const sw = Math.round(Math.sin(t * .9 + i * 1.7)); R(x + 5, 0, 1, y, '#3a3a5a');
    R(x + 1 + sw, y, 9, 2, '#20202a'); R(x + sw, y + 2, 11, 12, '#f4ecd8'); R(x + sw, y + 6, 11, 3, '#d61f3a'); for (const k of [4, 10, 12]) R(x + sw, y + 2 + k, 11, 1, '#d8cfb8');
    R(x + 1 + sw, y + 14, 9, 2, '#20202a'); },
};

export function drawCeiling(ctx, th, t) {
  g = ctx;
  const id = th.id;
  if (id === 'garden') { stringLights(t, 90, 570, 10, 16, 5, ['#fff0b0', '#ffd45c', '#ffe8c0']); stringLights(t, 120, 540, 34, 10, 4, ['#fff0b0', '#ffd45c']); return; }
  FLOOR.lanterns.forEach(([x, y], i) => (id === 'hall' ? lantern(ctx, x, y, t, i) : HANG[id](x, y, t, i)));
  if (id === 'hall') stringLights(t);
  if (id === 'tiki') { for (let x = FLOOR.streetX; x < 576; x += 3) R(x, 0, 3, 6 + ((x * 7) % 5), (x / 3) % 2 ? '#b08840' : '#9a7430');
    stringLights(t, 90, 570, 40, 8, 6, ['#ff9a3c', '#2fb8a0', '#ffd45c']); }
  if (id === 'hall' || id === 'casino' || id === 'karaoke') discoBall(t);
}

// ---------- wall effects, every frame ----------
function neonSign(x, y, rows, c) { rows.forEach((r, yy) => [...r].forEach((ch, xx) => { if (ch === '#') R(x + xx * 2, y + yy * 2, 2, 2, c); })); }

export function drawWallFx(ctx, th, t) {
  g = ctx;
  const id = th.id, cols = th.dotFill;
  if (id !== 'deco' && id !== 'garden') for (let i = 0; i < 18; i++) { const an = t * .35 + i * 2.1, x = 400 + Math.cos(an) * (90 + (i % 5) * 26), y = 74 + Math.sin(an * 1.3) * (30 + (i % 3) * 20) + 30;
    if (x > 104 && x < 524 && y > 4 && y < 196) R(x, y, 2, 2, cols[i % 4]); }
  if (id === 'casino') { const on = Math.floor(t * 2) % 6 !== 0;
    neonSign(150, 70, ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'], on ? '#ff5fa2' : '#5a2040');
    neonSign(232, 64, ['#####', '....#', '...#.', '..#..', '.#...', '.#...'], on ? '#ffd45c' : '#5a4a20');
    neonSign(262, 76, ['..#..', '.###.', '#####', '#####', '..#..', '.###.'], (Math.floor(t * 2) + 3) % 6 ? '#5ae0ff' : '#1a4050'); }
  if (id === 'karaoke') { g.globalAlpha = Math.floor(t * 3) % 7 ? 1 : .3; R(96, 52, 260, 2, '#ff5fa2'); R(96, 140, 160, 2, '#5b9cf5'); R(250, 120, 90, 2, '#ff5fa2'); g.globalAlpha = 1; }
  if (id === 'tiki') for (const tx of [110, 300]) torch(tx, 120, t);
  if (id === 'garden') for (let i = 0; i < 12; i++) { const x = 100 + ((i * 97 + t * 6 * (i % 3 + 1)) % 460), y = 120 + Math.sin(t * 1.3 + i) * 20 + (i % 4) * 14;
    if ((t * 2 + i) % 3 < 2) R(x, y, 1, 1, '#d8ff8a'); }
}

// ---------- signature piece, where the hall has the reception desk ----------
const GONG = { x: 214, y: 254, w: 76, h: 52 };
let gongSprite;
function paintGong() { R(220, 258, 4, 46, '#7a1c16'); R(268, 258, 4, 46, '#7a1c16'); R(216, 254, 60, 5, '#a3221b'); R(216, 254, 60, 1, '#d9a441');
  R(214, 302, 12, 3, '#3a1a10'); R(266, 302, 12, 3, '#3a1a10'); R(245, 259, 1, 5, '#d9a441');
  for (let y = -15; y <= 15; y++) for (let x = -15; x <= 15; x++) { const d = Math.sqrt(x * x + y * y); if (d <= 15) R(246 + x, 280 + y, 1, 1, d > 13 ? '#8a6420' : d < 5 ? '#f0c860' : (d | 0) % 4 ? '#d9a441' : '#b8862a'); }
  R(240, 273, 3, 2, '#fff3c0'); R(276, 286, 10, 2, '#5a3320'); R(285, 284, 4, 5, '#c0262a'); }
const SIGNATURE = {
  // The hall's gong only stands on a building floor; the single-room lounge keeps the desk there.
  // About 700 pixels, so it is painted once and then copied.
  hall() {
    if (gongSprite === undefined) {
      const c = globalThis.document?.createElement('canvas') ?? null;
      if (c) { c.width = GONG.w; c.height = GONG.h; const prev = g; g = c.getContext('2d'); g.translate(-GONG.x, -GONG.y); paintGong(); g = prev; }
      gongSprite = c;
    }
    if (gongSprite) g.drawImage(gongSprite, GONG.x, GONG.y); else paintGong();
  },
  casino(t) { R(202, 284, 92, 14, '#0e3a24'); R(204, 282, 88, 14, '#1f6b45'); R(204, 282, 88, 1, '#2f8f5e'); R(202, 296, 92, 3, '#4a2a10'); R(210, 299, 3, 6, '#2a160b'); R(284, 299, 3, 6, '#2a160b');
    for (let i = 0; i < 16; i++) { const an = t * 3 + i / 16 * Math.PI * 2; R(232 + Math.cos(an) * 10, 288 + Math.sin(an) * 4, 2, 1, i % 2 ? '#c0262a' : '#140b08'); }
    R(230, 287, 4, 2, '#d9a441'); R(232 + Math.cos(-t * 5) * 7, 288 + Math.sin(-t * 5) * 3, 1, 1, '#ffffff');
    for (let i = 0; i < 5; i++) R(254 + i * 6, 285, 4, 2 + (i % 3), ['#c0262a', '#5b9cf5', '#ffd45c', '#5fd39a', '#f2ede2'][i]); },
  deco() { R(206, 276, 84, 14, '#0e0e12'); R(206, 276, 84, 1, '#3a3a44'); R(212, 290, 3, 14, '#0e0e12'); R(282, 290, 3, 14, '#0e0e12'); R(250, 290, 3, 12, '#0e0e12');
    for (let i = 0; i < 26; i++) R(236 + i * 2, 272 - i, 2, 1, '#1a1a20'); R(236, 272, 52, 1, '#d9b45a'); R(288, 246, 1, 30, '#8a6a2a');
    R(206, 286, 30, 4, '#f2ede2'); for (let k = 0; k < 15; k++) if (k % 7 !== 2 && k % 7 !== 6) R(207 + k * 2, 286, 1, 2, '#141418');
    R(206, 290, 84, 1, '#d9b45a'); R(218, 300, 18, 4, '#2a1a10'); },
  tiki(t) { R(236, 254, 22, 50, '#6a4018'); R(236, 254, 3, 50, '#8a5a28'); R(255, 254, 3, 50, '#4a2a10');
    for (const fy of [258, 276, 292]) { R(239, fy, 6, 4, '#ffd45c'); R(249, fy, 6, 4, '#ffd45c'); R(241, fy + 1, 2, 2, '#140b08'); R(251, fy + 1, 2, 2, '#140b08');
      R(240, fy + 7, 14, 3, '#3a1a08'); R(242, fy + 8, 10, 1, '#f2ede2'); }
    R(232, 252, 30, 3, '#2fb8a0'); torch(214, 268, t); torch(278, 268, t); },
  karaoke(t) { R(198, 296, 96, 8, '#2a1a3a'); R(198, 296, 96, 1, '#ff5fa2'); R(198, 303, 96, 1, '#5b9cf5');
    R(246, 268, 1, 28, '#c9c9d0'); R(242, 295, 9, 1, '#c9c9d0'); R(244, 265, 5, 4, '#20202a'); R(245, 265, 3, 2, '#5a5a6a');
    R(262, 256, 28, 20, '#0a0a14'); R(264, 258, 24, 15, '#1a1a6a'); const k = (t * 1.5) % 1;
    R(266, 262, 20, 2, '#a0a0ff'); R(266, 262, Math.round(20 * k), 2, '#ff5fa2'); R(266, 267, 14, 2, '#a0a0ff'); R(274, 276, 4, 20, '#20202a');
    R(206, 290, 14, 6, '#20202a'); R(207, 291, 12, 3, '#3a3a4a'); },
  garden(t) { R(234, 290, 24, 14, '#b05a2a'); R(232, 288, 28, 3, '#d07a3a'); R(244, 270, 4, 20, '#5a3a1a');
    for (let y = -16; y <= 12; y++) for (let x = -20; x <= 20; x++) if (x * x / 400 + y * y / 256 <= 1) R(246 + x, 262 + y, 1, 1, (x * 3 + y * 5) % 7 === 0 ? '#5a9a3a' : (x + y) % 5 ? '#2a5a24' : '#3a7a2e');
    for (let i = 0; i < 9; i++) { const x = 232 + (i * 11) % 30, y = 252 + (i * 7) % 20; if ((Math.floor(t * 2) + i) % 3) R(x, y, 1, 1, '#fff0b0'); }
    for (const px of [206, 282]) { R(px, 294, 14, 10, '#6a4a30'); for (let i = 0; i < 6; i++) R(px + 1 + i * 2, 288 + (i % 2) * 2, 2, 6, '#3a7a2e'); R(px + 3, 289, 2, 2, '#ff7aa0'); R(px + 9, 288, 2, 2, '#ffd45c'); } },
};
// The hall keeps the reception desk in that spot, so it has no signature here. The tall pieces sort behind the
// maître (feet at y 284) so he stays visible and clickable; the low ones sort in front, like the desk.
const SIGNATURE_Y = { casino: 304, deco: 304, tiki: 283, karaoke: 304, garden: 283 };
export const signatureY = th => SIGNATURE_Y[th.id] ?? null;
export function drawSignature(ctx, th, t) { g = ctx; SIGNATURE[th.id]?.(t); }

// Theme lights, added with 'lighter' by the caller's glow(x, y, r, colour).
export function themeGlows(th, glow) {
  if (th.id === 'casino') { CASINO_SLOT_X.forEach(x => glow(x + 14, 165, 26, 'rgba(200,90,255,.16)')); glow(160, 76, 40, 'rgba(255,95,162,.25)'); glow(270, 80, 36, 'rgba(90,224,255,.2)'); }
  if (th.id === 'tiki') for (const tx of [110, 300, 216, 280]) glow(tx + 1, tx > 200 && tx < 290 ? 262 : 114, 30, 'rgba(255,140,40,.3)');
  if (th.id === 'karaoke') { glow(220, 53, 60, 'rgba(255,95,162,.18)'); glow(170, 141, 50, 'rgba(91,156,245,.18)'); glow(276, 266, 30, 'rgba(120,120,255,.25)'); }
}
