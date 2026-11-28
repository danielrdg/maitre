import { W, H } from './scene-static.js';
import { THEMES, lantern, stringLightsOn } from './themes.js';
import { buildSprite } from './sprites.js';
import { poseFor, npcPose } from './agents.js';
import { spriteOn, drawBadge, anc, liftDoors, isDim, glowOn } from './scene.js';
import { facadeLayout } from './building.js';
import { emitSmoke, drawParticles } from './particles.js';
import { mulberry32 } from './rng.js';

// The building seen from the street: one band of windows per open floor, the lobby behind glass, the roof
// terrace, the lift shaft on the left and the list of open floors on the right. Levels come from
// facadeLayout; the building scrolls, the sky and the list stay put.
let g = null;
const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
const vgrad = (x, y, w, h, a, b) => { for (let i = 0; i < h; i++) { const k = i / h;
  R(x, y + i, w, 1, `rgb(${a[0] + (b[0] - a[0]) * k | 0},${a[1] + (b[1] - a[1]) * k | 0},${a[2] + (b[2] - a[2]) * k | 0})`); } };
const clip = (x, y, w, h, fn) => { g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); fn(); g.restore(); };

export const FX = { shaft: 128, shaftW: 30, x0: 158, x1: 438 };
const LIST = { x: 450, y: 48, w: 118, top: 70, room: 220, swatch: 34 };
const WIN_W = 44, WIN_H = 28;
const winX = k => 168 + k * 54;
const SMOKER_X = [184, 214, 252, 300, 342, 392];
const QUEUE_X = [216, 196, 176, 156, 136, 116];
const ROPE = [232, 252, 272];
const DOORMAN = [278, 318];
const BELL_FITS = 2;

// ---------- scenery shared with the lobby ----------
export function stars(ctx, rnd, x0, y0, w, h, n) { g = ctx; for (let i = 0; i < n; i++) R(x0 + rnd() * w, y0 + rnd() * h, 1, 1, rnd() > .5 ? '#d4dcff' : '#8590c0'); }
export function moon(ctx, cx, cy, r) { g = ctx; for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r)
  R(cx + x, cy + y, 1, 1, (x + 2) * (x + 2) + (y - 1) * (y - 1) < r * r / 6 ? '#ffffff' : '#f3e7bd'); }
export function skyline(ctx, rnd, x0, x1, base, hMin, hMax, col = '#0e1324') {
  g = ctx;
  for (let x = x0; x < x1;) { const w = 10 + (rnd() * 14 | 0), h = hMin + rnd() * (hMax - hMin) | 0; R(x, base - h, w, h, col);
    for (let wy = base - h + 4; wy < base - 4; wy += 7) for (let wx = x + 2; wx < x + w - 2; wx += 4) if (rnd() > .55) R(wx, wy, 2, 3, rnd() > .3 ? '#e8b85a' : '#7aa0ff');
    x += w + (rnd() * 4 | 0); } }
export function lattice(ctx, x0, y0, x1, y1) {
  g = ctx;
  R(x0, y0, x1 - x0, y1 - y0, '#3a130f');
  for (let y = y0; y < y1; y += 16) for (let x = x0; x < x1; x += 16) {
    R(x, y, 16, 1, '#4a1a12'); R(x, y, 1, 16, '#4a1a12'); R(x + 7, y + 4, 2, 8, '#541d14'); R(x + 4, y + 7, 8, 2, '#541d14'); R(x + 7, y + 7, 2, 2, '#6e2c18'); }
}
export function rope(ctx, xs, y) { g = ctx; for (const px of xs) { R(px, y - 20, 2, 20, '#d9a441'); R(px - 1, y - 22, 4, 2, '#f0c050'); R(px - 2, y, 6, 2, '#8a6a20'); }
  for (let i = 0; i < xs.length - 1; i++) for (let x = xs[i] + 2; x < xs[i + 1]; x++) { const k = (x - xs[i] - 2) / (xs[i + 1] - xs[i] - 2);
    R(x, y - 18 + Math.round(Math.sin(k * Math.PI) * 4), 1, 2, '#b01c2a'); } }

// A small window seen from outside: the theme's wall, light and floor, with one of its lights hanging.
export function windowBack(ctx, th, x, y, w, h, t, k, sig) {
  g = ctx;
  clip(x, y, w, h, () => {
    if (th === THEMES.hall) { R(x, y, w, h, '#3a130f'); for (let yy = y; yy < y + h; yy += 6) for (let xx = x + 2; xx < x + w; xx += 6) R(xx, yy + 2, 2, 2, '#5a2014'); }
    else if (th === THEMES.garden) { vgrad(x, y, w, h, [14, 24, 56], [34, 46, 86]); R(x + 6 + k * 7 % 30, y + 3, 1, 1, '#d4dcff'); R(x + 20 + k * 3 % 20, y + 7, 1, 1, '#d4dcff');
      for (let xx = x; xx < x + w; xx += 2) R(xx, y + h - 8 - Math.round(Math.sin(xx * .3) * 2), 2, 8, '#16301c'); }
    else { R(x, y, w, h, th.wall);
      if (th === THEMES.casino) for (let xx = x + 3; xx < x + w; xx += 8) R(xx, y + 6 + (xx % 16 ? 0 : 6), 2, 2, '#3a1a5a');
      if (th === THEMES.deco) { for (let xx = x; xx < x + w; xx += 6) R(xx, y, 1, h, '#1a0f07'); R(x, y + 5, w, 1, '#8a6a2a'); }
      if (th === THEMES.tiki) { for (let xx = x; xx < x + w; xx += 4) R(xx, y, 3, h, (xx / 4) % 2 ? '#7a5a26' : '#8a6a30'); for (let xx = x; xx < x + w; xx += 2) R(xx, y, 2, 3 + (xx % 3), '#b08840'); }
      if (th === THEMES.karaoke) { for (let yy = y; yy < y + h; yy += 5) R(x, yy, w, 1, '#1a2050'); if ((Math.floor(t * 3) + k) % 7) { R(x, y + 9, w, 1, '#ff5fa2'); R(x, y + 15, w, 1, '#5b9cf5'); } } }
    R(x, y, w, h, `rgba(${th.light},.2)`); R(x + 4, y + 4, w - 8, h - 8, `rgba(${th.light},.08)`);
    R(x, y + h - 4, w, 4, th.floor[0]); R(x, y + h - 4, w, 1, th.floor[2]);
    const lx = x + (k % 2 ? 12 : w - 16);
    if (th === THEMES.hall) { R(lx + 2, y, 1, 3, '#5a3320'); R(lx, y + 3, 5, 6, '#c8281e'); R(lx + 1, y + 4, 3, 4, '#ffb060'); R(lx + 1, y + 3, 3, 1, '#d9a441'); }
    if (th === THEMES.casino) { R(lx + 2, y, 1, 3, '#3a3a44'); R(lx - 1, y + 3, 7, 2, '#1f7a4a'); R(lx, y + 5, 5, 1, '#fff6d0'); }
    if (th === THEMES.deco) { R(lx + 2, y, 1, 3, '#8a6a2a'); R(lx - 1, y + 3, 7, 1, '#d9b45a'); R(lx, y + 4, 1, 2, '#fff0c0'); R(lx + 2, y + 4, 1, 2, '#fff0c0'); R(lx + 4, y + 4, 1, 2, '#fff0c0'); }
    if (th === THEMES.tiki) { const f = Math.floor(t * 8 + k) % 2; R(lx + 2, y + 12, 1, 10, '#5a4018'); R(lx + 1, y + 9 + f, 3, 3, '#ff7a1a'); R(lx + 2, y + 8 + f, 1, 2, '#ffd45c'); }
    if (th === THEMES.karaoke) { R(lx + 2, y, 1, 2, '#3a3a5a'); R(lx, y + 2, 5, 6, '#f4ecd8'); R(lx, y + 4, 5, 1, '#d61f3a'); }
    if (th === THEMES.garden) for (let xx = x; xx < x + w; xx++) { const yy = y + 3 + Math.round(Math.sin((xx - x) / w * Math.PI) * 3); R(xx, yy, 1, 1, '#2a160b');
      if ((xx - x) % 6 === 3) R(xx, yy + 1, 1, 1, (Math.floor(t * 3) + xx) % 5 ? '#fff0b0' : '#6a4a2a'); }
    if (sig) sigMini(th, x, y, w, h, t);
  });
}

function sigMini(th, x, y, w, h, t) {
  const cx = x + w - 13, by = y + h - 4;
  if (th === THEMES.hall) { for (let yy = -7; yy <= 7; yy++) for (let xx = -7; xx <= 7; xx++) { const d = Math.sqrt(xx * xx + yy * yy); if (d <= 7) R(cx + xx, by - 10 + yy, 1, 1, d > 5.5 ? '#8a6420' : '#d9a441'); }
    R(cx - 9, by - 19, 18, 2, '#a3221b'); R(cx - 9, by - 19, 2, 19, '#7a1c16'); R(cx + 7, by - 19, 2, 19, '#7a1c16'); }
  if (th === THEMES.casino) { R(cx - 6, by - 18, 12, 18, '#7a28c0'); R(cx - 7, by - 20, 14, 3, '#ffd45c'); R(cx - 4, by - 14, 8, 5, '#f2ede2'); R(cx - 3, by - 13, 1, 3, '#e0282e'); R(cx, by - 13, 1, 3, '#e0282e');
    R(cx + 2, by - 13, 1, 3, '#e0282e'); R(cx + 6, by - 15, 1, 6, '#b9b9c0'); R(cx + 5, by - 16, 3, 2, '#ff3b2f'); }
  if (th === THEMES.deco) { R(cx - 10, by - 9, 20, 6, '#0e0e12'); for (let i = 0; i < 9; i++) R(cx - 6 + i * 2, by - 10 - i, 2, 1, '#1a1a20'); R(cx - 10, by - 5, 9, 2, '#f2ede2');
    R(cx - 9, by - 3, 1, 3, '#0e0e12'); R(cx + 8, by - 3, 1, 3, '#0e0e12'); R(cx - 10, by - 9, 20, 1, '#d9b45a'); }
  if (th === THEMES.tiki) { R(cx - 4, by - 20, 8, 20, '#6a4018'); R(cx - 3, by - 17, 2, 2, '#ffd45c'); R(cx + 1, by - 17, 2, 2, '#ffd45c'); R(cx - 3, by - 12, 6, 2, '#3a1a08');
    R(cx - 3, by - 8, 2, 2, '#ffd45c'); R(cx + 1, by - 8, 2, 2, '#ffd45c'); R(cx - 5, by - 21, 10, 2, '#2fb8a0'); }
  if (th === THEMES.karaoke) { R(cx - 10, by - 2, 20, 2, '#ff5fa2'); R(cx - 4, by - 13, 1, 11, '#c9c9d0'); R(cx - 5, by - 15, 3, 3, '#20202a'); R(cx, by - 18, 10, 8, '#0a0a14'); R(cx + 1, by - 17, 8, 6, '#1a1a6a');
    R(cx + 2, by - 15, Math.round(6 * ((t * 1.5) % 1)), 1, '#ff5fa2'); R(cx + 2, by - 13, 5, 1, '#a0a0ff'); }
  if (th === THEMES.garden) { R(cx - 3, by - 5, 6, 5, '#b05a2a'); R(cx - 1, by - 10, 2, 5, '#5a3a1a');
    for (let yy = -6; yy <= 6; yy++) for (let xx = -8; xx <= 8; xx++) if (xx * xx / 64 + yy * yy / 36 <= 1) R(cx + xx, by - 16 + yy, 1, 1, (xx + yy) % 4 ? '#2a5a24' : '#3a7a2e'); }
}
export const windowGlass = (ctx, x, y, w, h) => { g = ctx; R(x + 3, y + 2, 1, h - 4, 'rgba(255,255,255,.07)'); R(x + 5, y + 2, 2, h - 4, 'rgba(255,255,255,.04)'); R(x + (w >> 1), y, 1, h, '#1a1214'); };

// The same figure as one flat colour: the people behind the windows.
const sils = new Map();
function silhouette(look, pose, col, makeCanvas) {
  const key = col + JSON.stringify([look, pose]);
  let c = sils.get(key);
  if (c) return c;
  c = makeCanvas(); c.width = 18; c.height = 34;
  const x = c.getContext('2d');
  x.drawImage(buildSprite(look, pose, makeCanvas), 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = col; x.fillRect(0, 0, 18, 34);
  if (sils.size > 400) sils.clear();
  sils.set(key, c);
  return c;
}

// ---------- the painted building ----------
// Built once per number of open floors. `sky` stays put; `body` is the building, the street and the skyline
// behind it, `maxScroll` px taller than the stage: draw it at y = scroll - maxScroll.
export function buildFacade(makeCanvas, floorCount) {
  const { levels, maxScroll } = facadeLayout(Array.from({ length: floorCount }, (_, i) => ({ project: `f${i}`, floor: i + 1, theme: 'hall' })));
  const rnd = mulberry32(7);
  const sky = makeCanvas(); sky.width = W; sky.height = H;
  g = sky.getContext('2d');
  vgrad(0, 0, W, H, [8, 11, 26], [28, 34, 62]); stars(g, rnd, 0, 0, W, 150, 60); moon(g, 64, 30, 9);
  const body = makeCanvas(); body.width = W; body.height = H + maxScroll;
  const bg = body.getContext('2d');
  bg.translate(0, maxScroll);
  g = bg;
  const lobby = levels[0], roof = levels.at(-1), top = roof.y + 36, x0 = FX.x0, x1 = FX.x1, bw = x1 - x0;
  skyline(bg, rnd, 0, 128, 300, 70, 170, '#0b1020'); skyline(bg, rnd, 438, 576, 300, 60, 160, '#0b1020');
  skyline(bg, rnd, -6, 128, 300, 30, 110); skyline(bg, rnd, 440, 580, 300, 30, 120);
  g = bg;
  R(0, 290, W, 28, '#2b2d36'); for (let x = 0; x < W; x += 18) R(x, 290, 1, 28, '#23252e'); R(0, 317, W, 2, '#4a4c56'); R(0, 319, W, 5, '#15161c');
  for (const lx of [24, 470, 552]) { R(lx, 238, 2, 52, '#2b2f3c'); R(lx - 3, 234, 8, 4, '#2b2f3c'); R(lx - 2, 238, 6, 2, '#ffe3a0'); }
  R(x0, top, bw, 290 - top, '#2a1a1c');
  for (let y = top; y < 290; y += 4) { R(x0, y, bw, 1, '#24161a'); for (let x = x0 + ((y / 4) % 2) * 6; x < x1; x += 12) R(x, y, 1, 4, '#24161a'); }
  R(x0, top, 4, 290 - top, '#3a2628'); R(x1 - 4, top, 4, 290 - top, '#3a2628');
  for (const l of levels) if (l.kind === 'floor') { R(x0 - 4, l.y, bw + 8, 3, '#4a3430'); R(x0 - 4, l.y, bw + 8, 1, '#6a4c44'); }
  for (const px of [170, 426]) { R(px, roof.y - 2, 2, 34, '#3a2a1a'); R(px - 1, roof.y - 4, 4, 2, '#5a4030'); }
  R(x0 - 4, lobby.y - 2, bw + 8, 4, '#c89a3c'); R(x0 - 4, lobby.y + 1, bw + 8, 1, '#8a6420');
  R(x0, lobby.y + 2, bw, 54, '#2e2224');
  for (const [gx, gw] of [[166, 114], [316, 114]]) R(gx - 2, lobby.y + 16, gw + 4, 40, '#c89a3c');
  R(282, lobby.y + 12, 32, 44, '#c89a3c'); R(284, lobby.y + 14, 28, 42, '#1a0c08');
  const sTop = roof.y - 8;
  R(FX.shaft - 2, sTop, FX.shaftW + 4, 290 - sTop, '#3a3a44'); R(FX.shaft, roof.y + 4, FX.shaftW, 286 - roof.y, '#0c1018');
  for (const l of levels) R(FX.shaft, l.y + l.h - 1, FX.shaftW, 1, '#1c2230');
  R(FX.shaft - 4, roof.y - 10, FX.shaftW + 8, 14, '#3a2628'); R(FX.shaft - 4, roof.y - 10, FX.shaftW + 8, 2, '#5a4038');
  R(FX.shaft + 4, roof.y + 6, 1, 282 - roof.y, 'rgba(160,190,255,.06)'); R(FX.shaft + 24, roof.y + 6, 1, 282 - roof.y, 'rgba(160,190,255,.05)');
  return { sky, body, maxScroll };
}

const parapet = (x0, x1, y) => { R(x0 - 4, y, x1 - x0 + 8, 10, '#3a2628'); R(x0 - 4, y, x1 - x0 + 8, 2, '#5a4038'); R(x0 - 4, y + 8, x1 - x0 + 8, 2, '#24161a'); };

// The pieces of the world the facade shows. `s`: { t, frame, floors, scroll, lift, agents, npcs, ringUntil, focus,
// particles, makeCanvas, tr }. Returns the hitboxes, the tags to place and where the neon goes.
export function drawFacade(ctx, bg, s) {
  g = ctx;
  const { t, frame, floors, lift, agents, tr, makeCanvas } = s;
  const scroll = Math.round(s.scroll);
  const { levels } = facadeLayout(floors, scroll);
  const glow = glowOn(ctx);
  const hit = [], tags = [];
  const blinkOn = (t % .9) < .6;
  const blocked = agents.filter(a => a.state === 'blocked');
  const projectOf = a => a.info?.project;
  const alertOn = new Set(blocked.map(projectOf));
  const onFloor = p => agents.filter(a => a.place === `floor:${p}`);
  const sprite = a => buildSprite(a.look, poseFor(a, t).pose, makeCanvas);

  g.drawImage(bg.sky, 0, 0);
  g.drawImage(bg.body, 0, scroll - bg.maxScroll);
  g = ctx;

  // floors: windows in the floor's theme with its rooms behind them
  for (const L of levels.filter(l => l.kind === 'floor')) {
    const th = THEMES[L.theme] ?? THEMES.hall, y = L.y + 6, rooms = onFloor(L.project), alert = alertOn.has(L.project);
    if (L.y > H || L.y + L.h < 0) continue;
    for (let k = 0; k < 5; k++) {
      const x = winX(k);
      windowBack(ctx, th, x, y, WIN_W, WIN_H, t, k + L.floor, k === 4);
      const mine = rooms.filter((_, i) => (k < 4 ? i % 4 === k : i === 8));
      clip(x, y, WIN_W, WIN_H, () => mine.slice(0, 2).forEach((a, j) => {
        const ps = poseFor(a, t), sx = x + (mine.length === 1 ? 22 : 12 + j * 20) + (k === 4 ? -10 : 0);
        spriteOn(ctx, silhouette(a.look, ps.pose, th.sil, makeCanvas), sx, y + WIN_H + 4, false, ps.bob, a.info?.parked ? .5 : .92, false);
      }));
      windowGlass(ctx, x, y, WIN_W, WIN_H);
      R(x - 2, y + WIN_H, 48, 2, '#5a4038'); R(x - 1, y - 1, 46, 1, '#140b08');
      if (alert && blinkOn) R(x, y, WIN_W, WIN_H, 'rgba(255,40,40,.32)');
    }
    R(FX.x0 - 4, L.y, 6, 3, th.trim); R(FX.x1 - 2, L.y, 6, 3, th.trim);
    if (alert && blinkOn) drawBadge(ctx, [FX.x1 - 4, L.y + 18], 'alert');
    if (s.focus === L.key) { g.strokeStyle = 'rgba(255,212,92,.7)'; g.lineWidth = 1; g.strokeRect(FX.x0 + 4.5, L.y + 3.5, FX.x1 - FX.x0 - 9, L.h - 4); }
    hit.push({ kind: 'level', key: L.key, x: FX.x0, y: L.y, w: FX.x1 - FX.x0, h: L.h });
    const mains = rooms.filter(a => !a.liveId?.includes('/')).length;
    tags.push({ key: `fl${L.key}`, x: FX.shaft - 6, y: L.y + L.h / 2, cls: 'r big' + (alert ? ' alert' : ''), text: tr('floor.title', { n: L.floor, project: L.project }),
      sub: [tr(`theme.${th.id}`), tr(mains === 1 ? 'facade.rooms.one' : 'facade.rooms.many', { n: mains }), ...(alert ? [tr('facade.needsYou')] : [])].join(' · ') });
  }

  // the roof: smokers stand behind the parapet
  const roof = levels.at(-1), smokers = agents.filter(a => a.place === 'terrace');
  stringLightsOn(ctx, t, 172, 426, roof.y - 2, 7, 4);
  g = ctx;
  smokers.forEach((a, i) => {
    const ps = poseFor(a, t), flip = i % 2 === 1, x = SMOKER_X[i % SMOKER_X.length] + Math.floor(i / SMOKER_X.length) * 8;
    const o = spriteOn(ctx, buildSprite(a.look, ps.pose, makeCanvas), x, roof.y + 36, flip, ps.bob, 0, false);
    hit.push({ kind: 'agent', ref: a, x: o[0], y: o[1], w: 18, h: 34 });
    if (ps.ember) { const [ex, ey] = anc(o, ps.ember, flip); R(ex, ey, 1, 1, '#ff7a1a'); if (frame % 12 === 0) emitSmoke(s.particles, ex, ey, 1, false); }
    if (ps.pose.mouth === 'o' && frame % 3 === 0) emitSmoke(s.particles, o[0] + 9, o[1] + 11, 2, true);
  });
  parapet(FX.x0, FX.x1, roof.y + 30);
  R(420, roof.y + 24, 1, 6, '#8a8a92'); R(417, roof.y + 23, 7, 2, '#6a6a72');
  hit.unshift({ kind: 'level', key: 'roof', x: FX.x0, y: roof.y - 8, w: FX.x1 - FX.x0, h: 48 });
  tags.push({ key: 'flR', x: FX.shaft - 6, y: roof.y + 18, cls: 'r', text: tr('facade.roof'), sub: tr('facade.roofSub', { n: smokers.length }) });

  // the lobby through the glass: the rooms at the bell, as many as the pane shows, then a count
  const lobby = levels[0], gy = lobby.y + 18, maitre = s.npcs.maitre, bell = blocked.filter(a => a.place === 'lobby');
  if (bell.length > BELL_FITS) tags.push({ key: 'bellMore', x: 432, y: gy + 20, cls: 'l alert', text: tr('chip.more', { n: bell.length - BELL_FITS }) });
  for (const [gx, gw] of [[166, 114], [316, 114]]) clip(gx, gy, gw, 38, () => {
    lattice(ctx, gx, gy, gx + gw, gy + 38); g = ctx; R(gx, gy + 28, gw, 10, '#3a2216'); R(gx, gy + 27, gw, 1, '#c89a3c');
    if (gx === 166) { lantern(ctx, 190, gy + 2, t, 1, gy); lantern(ctx, 246, gy + 4, t, 3, gy); liftDoors(ctx, 212, gy + 10, 20, 18, 0, '#c89a3c'); g = ctx; }
    else {
      lantern(ctx, 330, gy + 2, t, 2, gy); g = ctx;
      if (maitre) spriteOn(ctx, buildSprite(maitre.look, npcPose(maitre, t, s.ringUntil).pose, makeCanvas), 366, gy + 34, false, 0, 0, false);
      R(344, gy + 24, 46, 14, '#6b3a22'); R(344, gy + 24, 46, 1, '#d9a441');
      const bx = 382 + (s.ringUntil > t ? (Math.floor(t * 30) % 2 ? -1 : 0) : 0); R(bx, gy + 20, 6, 4, '#e8b84a'); R(bx + 2, gy + 19, 2, 1, '#fff3c0');
      bell.slice(0, BELL_FITS).forEach((a, i) => {
        const o = spriteOn(ctx, sprite(a), 404 + i * 14, gy + 38, false, 0, 0, false);
        if (blinkOn) drawBadge(ctx, o, 'alert');
        hit.push({ kind: 'agent', ref: a, x: o[0], y: o[1], w: 14, h: 34 });
      });
    }
    g = ctx; R(gx + 3, gy, 1, 38, 'rgba(255,255,255,.08)'); R(gx + gw / 2, gy, 1, 38, '#8a6420');
  });
  R(286, lobby.y + 16, 24, 40, 'rgba(255,190,110,.18)'); R(297, lobby.y + 16, 2, 40, '#c89a3c');
  hit.unshift({ kind: 'level', key: 'lobby', x: FX.x0, y: lobby.y + 2, w: FX.x1 - FX.x0, h: 54 });
  tags.push({ key: 'flL', x: FX.shaft - 6, y: lobby.y + 28, cls: 'r', text: tr('facade.lobby'), sub: tr('facade.lobbySub', { n: blocked.length }) });

  // the car and its call buttons
  const cy = Math.round(lift.y) + scroll, open = s.carOpen ?? 0;
  R(FX.shaft + 14, roof.y + 4, 1, Math.max(0, cy - roof.y - 4), '#5a5a64');
  R(FX.shaft + 2, cy, 26, 30, '#c89a3c'); R(FX.shaft + 3, cy + 1, 24, 28, '#3a2a1a'); R(FX.shaft + 4, cy + 2, 22, 26, open > 0 ? '#ffcf7a' : '#e0a050');
  if (maitre) spriteOn(ctx, silhouette(maitre.look, { la: 'down', ra: 'down', legs: 'stand', eyes: 'open', mouth: 'smile', acc: null }, '#5a3010', makeCanvas), FX.shaft + 15, cy + 31, false, 0, .55, false);
  R(FX.shaft + 2, cy + 28, 26, 2, '#8a6420');
  for (const L of levels) {
    const by = L.y + L.h - 18, on = lift.moving && lift.to === L.key;
    R(FX.shaft + FX.shaftW + 1, by, 4, 5, '#24161a'); R(FX.shaft + FX.shaftW + 2, by + 1, 2, 3, on ? '#ffd45c' : '#8a6a3a');
    hit.push({ kind: 'call', key: L.key, x: FX.shaft - 2, y: L.y, w: FX.shaftW + 10, h: L.h });
  }

  // the sidewalk: the queue, the rope and the doorman
  const street = 318 + scroll, line = agents.filter(a => a.state === 'queue' && a.place === 'lobby').sort((p, q) => q.x - p.x);
  const people = line.map((a, i) => ({ y: street, draw() {
    const ps = poseFor(a, t), x = QUEUE_X[i] ?? QUEUE_X.at(-1) - (i - QUEUE_X.length + 1) * 20;
    const o = spriteOn(ctx, buildSprite(a.look, ps.pose, makeCanvas), x, street, ps.flip, ps.bob, isDim(a) && .82);
    hit.push({ kind: 'agent', ref: a, x: o[0], y: o[1], w: 18, h: 34 });
  } }));
  people.push({ y: street + 1, draw: () => rope(ctx, ROPE, street) });
  if (s.npcs.bouncer) people.push({ y: street, draw() {
    const n = s.npcs.bouncer, o = spriteOn(ctx, buildSprite(n.look, npcPose(n, t).pose, makeCanvas), DOORMAN[0], street, false, 0);
    hit.push({ kind: 'npc', ref: n, x: o[0], y: o[1], w: 18, h: 34 });
  } });
  people.sort((a, b) => a.y - b.y).forEach(p => { g = ctx; p.draw(); });
  g = ctx;
  if (line.length) tags.push({ key: 'q', x: 164, y: street - 12, cls: 'r dim', text: tr(line.length === 1 ? 'queue.one' : 'queue.many', { n: line.length }) });

  drawParticles(ctx, s.particles);

  // the list of open floors, top floor first
  const list = [...floors].sort((a, b) => b.floor - a.floor), rowH = Math.min(37, Math.floor(LIST.room / Math.max(1, list.length)));
  const sw = Math.max(8, Math.min(24, rowH - 10));
  R(LIST.x, LIST.y, LIST.w, LIST.top - LIST.y + list.length * rowH, 'rgba(14,8,6,.82)');
  R(LIST.x, LIST.y, LIST.w, 1, '#d9a441'); R(LIST.x, LIST.top + list.length * rowH, LIST.w, 1, '#d9a441');
  tags.push({ key: 'lsh', x: LIST.x + LIST.w / 2, y: LIST.y + 11, cls: 'c gold', text: tr('floors.title') });
  list.forEach((f, i) => {
    const th = THEMES[f.theme] ?? THEMES.hall, y = LIST.top + i * rowH, x = LIST.x + 6, alert = alertOn.has(f.project);
    windowBack(ctx, th, x, y, LIST.swatch, sw, t, i, sw >= 20); windowGlass(ctx, x, y, LIST.swatch, sw);
    if (alert && blinkOn) R(x, y, LIST.swatch, sw, 'rgba(255,40,40,.45)');
    g.strokeStyle = s.focus === f.floor ? '#ffd45c' : '#5a4038'; g.lineWidth = 1; g.strokeRect(x - .5, y - .5, LIST.swatch + 1, sw + 1);
    hit.push({ kind: 'level', key: f.floor, x: LIST.x, y: y - 4, w: LIST.w, h: rowH });
    tags.push({ key: `ls${f.floor}`, x: x + LIST.swatch + 6, y: y + sw / 2, cls: 'l' + (alert ? ' alert' : ''), text: tr('floors.row', { n: f.floor, project: f.project }),
      sub: rowH >= 30 ? tr(`theme.${th.id}`) : null });
  });

  // light
  g.globalCompositeOperation = 'lighter';
  for (const L of levels) if (L.kind === 'floor' && L.y < H && L.y + L.h > 0) { const th = THEMES[L.theme] ?? THEMES.hall; for (let k = 0; k < 5; k++) glow(winX(k) + 22, L.y + 20, 30, `rgba(${th.light},.09)`); }
  glow(298, lobby.y + 10, 50, 'rgba(255,60,150,.2)'); glow(298, lobby.y + 36, 60, 'rgba(255,186,90,.12)'); glow(64, 30, 30, 'rgba(160,180,255,.14)');
  for (const lx of [24, 470, 552]) glow(lx + 1, 240 + scroll, 26, 'rgba(255,220,150,.18)');
  glow(FX.shaft + 15, cy + 14, 22, 'rgba(255,200,110,.2)');
  if (blinkOn) {
    for (const L of levels) if (L.kind === 'floor' && alertOn.has(L.project)) glow(FX.x1, L.y + 20, 40, 'rgba(255,40,40,.35)');
    if (blocked.some(a => a.place === 'lobby')) glow(410, lobby.y + 36, 26, 'rgba(255,40,40,.3)');
  }
  g.globalCompositeOperation = 'source-over';

  return { hitboxes: hit, tags: tags.filter(tg => tg.y > -8 && tg.y < H + 8), neon: [298, lobby.y + 8] };
}
