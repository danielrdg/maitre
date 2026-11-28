import { W, H, SLOT_X } from './scene-static.js';
import { buildSprite } from './sprites.js';
import { poseFor, npcPose } from './agents.js';
import { FLOOR } from './places.js';
import { THEMES, CASINO_SLOT_X, lantern, drawCeiling, drawWallFx, drawSignature, signatureY, themeGlows } from './themes.js';
import { emitSmoke, drawParticles, drawHaze, drawFireworks } from './particles.js';

// Dynamic layer, redrawn every simulation step on top of the static background.
// g / R point at the context of the frame being drawn.
let g = null;
const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };

const SYMS = [
  { m: ['rrrrr', '...rr', '..rr.', '.rr..', '.rr..'], c: { r: '#e0282e' } },
  { m: ['...g.', '..g.g', '.g..g', 'rr.rr', 'rr.rr'], c: { r: '#e0282e', g: '#3f9a4a' } },
  { m: ['..y..', '.yyy.', '.yyy.', 'yyyyy', '..o..'], c: { y: '#f0c040', o: '#8a5a10' } },
  { m: ['.yyy.', 'rrrrr', 'ryrrr', 'rrrrr', '.yyy.'], c: { y: '#f0c040', r: '#c8281e' } },
];

function drawSlots(t, slots, th) {
  slots.forEach(s => {
    const x = s.x;
    for (let r = 0; r < 3; r++) { const rx = x + 3 + r * 8; R(rx, 156, 7, 14, '#f2ede2'); R(rx, 156, 7, 1, '#c9c2b2'); R(rx, 169, 7, 1, '#c9c2b2');
      const sy = SYMS[s.reels[r]], jit = s.spin[r] ? (Math.floor(t * 30) % 3) - 1 : 0;
      sy.m.forEach((row, yy) => [...row].forEach((ch, xx) => { if (ch !== '.') R(rx + 1 + xx, 160 + yy + jit, 1, 1, sy.c[ch]); })); }
    const flash = s.flash > t;
    for (let b = 0; b < 14; b++) { const on = flash ? (Math.floor(t * 16) % 2 === 0) : (Math.floor(t * 8) + b) % 4 === 0; R(x - 1 + b * 2 + 1, 137, 1, 1, on ? '#fff6b0' : '#8a6a20'); R(x - 1 + b * 2 + 1, 145, 1, 1, on ? '#8a6a20' : '#fff6b0'); }
    R(x + 4, 139, 20, 5, flash ? (Math.floor(t * 10) % 2 ? '#ffd45c' : '#ff5a5a') : th.slotEdge[2]);
    if (!flash) { R(x + 6, 141, 2, 1, '#ffd45c'); R(x + 10, 141, 2, 1, '#ffd45c'); R(x + 14, 141, 2, 1, '#ffd45c'); R(x + 18, 141, 2, 1, '#ffd45c'); }
    const pulled = (t - s.pulled) < .35;
    R(x + 28, 156, 2, 18, '#b9b9c0'); R(x + 28, 172, 3, 3, '#7a7a84');
    if (pulled) { R(x + 28, 168, 2, 8, '#d0d0d8'); R(x + 27, 175, 4, 4, '#ff3b2f'); }
    else { R(x + 27, 150, 4, 4, '#ff3b2f'); R(x + 28, 151, 1, 1, '#ff9a8a'); }
  });
}

export const LANTERNS = FLOOR.lanterns;
function danceFloor(t, th) { const C = th.dance;
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 10; tx++) { const x = 330 + tx * 14, y = 274 + ty * 12;
    const on = ((tx + ty + Math.floor(t * 2)) % 5); R(x, y, 13, 11, C[on]); R(x, y, 13, 1, 'rgba(255,255,255,.12)'); } R(330, 272, 140, 2, th.gold); }

// The casino's decor slots spin on their own clock, as in the mockup.
const decorSlots = t => CASINO_SLOT_X.map((x, i) => {
  const T = t + .9, ph = (T + i * 1.4) % 2.8, spin = ph < .7, k = Math.floor((T + i * 1.4) / 2.8);
  const reels = [0, 1, 2].map(r => (spin ? (Math.floor(T * 30) + r) % 4 : (k + r * (i + 1)) % 4));
  return { x, reels, spin: [spin, spin, spin], flash: -1, pulled: ph < .35 ? t - ph : -1 };
});

function drawFurnitureFront(kind, t, world, th) {
  const { ringUntil } = world, { tableCards } = world.particles;
  if (kind === 'sofa') { R(106, 184, 66, 16, th.sofa[2]); R(106, 184, 66, 2, th.sofaEdge[0]); R(102, 168, 7, 32, th.sofa[3]); R(169, 168, 7, 32, th.sofa[3]);
    R(102, 168, 7, 2, th.sofaEdge[0]); R(169, 168, 7, 2, th.sofaEdge[0]); R(108, 200, 3, 4, '#24100b'); R(167, 200, 3, 4, '#24100b'); }
  if (kind === 'table') { R(166, 222, 140, 3, '#9a5f38'); R(168, 225, 136, 9, '#1f6b45'); R(170, 225, 132, 1, '#2f8f5e'); R(168, 233, 136, 1, '#17553a');
    for (const c of tableCards) { R(c.x, c.y, 3, 4, '#f2ede2'); R(c.x + 1, c.y + 1, 1, 1, c.red ? '#c0262a' : '#1a1a1a'); }
    [[176, '#c0262a'], [181, '#5b9cf5'], [292, '#ffd45c'], [297, '#5fd39a']].forEach(([cx, col], i) => { const hh = 2 + Math.round((Math.sin(t * .7 + i * 2) + 1) * 2);
      for (let k = 0; k < hh; k++) R(cx, 232 - k, 4, 1, k % 2 ? col : '#efe9dc'); });
    R(166, 234, 140, 6, '#5a3320'); R(166, 234, 140, 1, th.gold); R(228, 240, 16, 16, '#3a2010'); R(218, 256, 36, 3, '#2a160b'); }
  if (kind === 'counter') { R(360, 178, 110, 4, th.counter[0]); R(360, 182, 110, 30, th.counter[1]);
    if (th === THEMES.tiki) for (let x = 360; x < 470; x += 5) R(x, 182, 4, 30, (x / 5) % 2 ? '#8a6a30' : '#7a5a26');
    for (let x = 366; x < 466; x += 18) { R(x, 186, 14, 22, th.cabinet[0]); R(x, 186, 14, 1, th.cabinet[1]); R(x + 6, 196, 2, 2, th.gold); }
    R(360, 211, 110, 2, th.trim);
    if (th === THEMES.tiki) for (const ux of [372, 420, 462]) { R(ux, 172, 3, 6, '#ff9a3c'); R(ux - 2, 168, 7, 2, ['#ff5fa2', '#2fb8a0', '#ffd45c'][ux % 3]); R(ux + 1, 170, 1, 2, '#f2ede2'); }
    for (const sx of [388, 446]) { R(sx, 214, 11, 3, th.stool[0]); R(sx, 214, 11, 1, th.stool[1]); R(sx + 5, 217, 1, 18, '#b9b9c0'); R(sx + 2, 235, 7, 1, '#b9b9c0'); } }
  if (kind === 'armchair') { R(480, 172, 6, 22, th.chair[0]); R(506, 172, 6, 22, th.chair[0]); R(484, 180, 24, 14, th.chair[2]); R(480, 172, 6, 1, th.chair[1]); R(506, 172, 6, 1, th.chair[1]); }
  if (kind === 'desk') { R(204, 268, 84, 4, '#9a5f38'); R(206, 272, 80, 30, '#6b3a22'); R(206, 272, 80, 1, '#d9a441');
    for (let x = 210; x < 282; x += 18) { R(x, 276, 14, 22, '#5a3020'); R(x + 6, 285, 2, 2, '#d9a441'); }
    const ring = ringUntil > t; const bx = 270 + (ring ? (Math.floor(t * 30) % 2 ? -1 : 0) : 0);
    R(bx, 263, 8, 5, '#e8b84a'); R(bx + 2, 262, 4, 1, '#e8b84a'); R(bx + 3, 261, 2, 1, '#fff3c0'); R(bx - 1, 267, 10, 1, '#8a6a20');
    if (ring) { R(bx - 4, 259, 1, 3, '#fff3c0'); R(bx + 11, 259, 1, 3, '#fff3c0'); R(bx - 3, 256, 1, 1, '#fff3c0'); R(bx + 10, 256, 1, 1, '#fff3c0'); }
    R(214, 262, 10, 6, '#3a3a44'); R(215, 263, 8, 3, '#5fd39a'); }
  if (kind === 'rope') { for (const px of [8, 30, 52, 74]) { R(px, 284, 2, 20, '#d9a441'); R(px - 1, 282, 4, 2, '#f0c050'); R(px - 2, 304, 6, 2, '#8a6a20'); }
    for (let x = 10; x < 74; x++) { const k = (x - 8) % 22; if (k < 2) continue; R(x, 286 + Math.round(Math.sin((k - 2) / 20 * Math.PI) * 4), 1, 2, '#b01c2a'); } }
}

export function drawSprite(spr, cx, fy, flip, bob, dim, shadow = true) {
  const x0 = Math.round(cx - 9), y0 = Math.round(fy - 31 + (bob || 0));
  if (shadow) { R(cx - 6, fy, 12, 1, 'rgba(0,0,0,.35)'); R(cx - 4, fy + 1, 8, 1, 'rgba(0,0,0,.22)'); }
  if (dim) g.globalAlpha = typeof dim === 'number' ? dim : .82;
  if (flip) { g.save(); g.translate(x0 + 18, y0); g.scale(-1, 1); g.drawImage(spr, 0, 0); g.restore(); }
  else g.drawImage(spr, x0, y0);
  g.globalAlpha = 1;
  return [x0, y0];
}
export function spriteOn(ctx, spr, cx, fy, flip, bob, dim, shadow = true) { g = ctx; return drawSprite(spr, cx, fy, flip, bob, dim, shadow); }
export const anc = (o, a, flip) => [flip ? o[0] + 17 - a[0] : o[0] + a[0], o[1] + a[1]];

function drawBubble(o, kind) {
  const bx = o[0] + 5, by = o[1] - 12;
  R(bx, by, 9, 10, '#160c09'); R(bx + 3, by + 10, 2, 1, '#160c09');
  if (kind === 'notice') {
    R(bx + 1, by + 1, 7, 8, '#ff9a3c'); R(bx + 1, by + 1, 7, 1, '#ffc27a');
    R(bx + 2, by + 5, 1, 1, '#ffffff'); R(bx + 4, by + 5, 1, 1, '#ffffff'); R(bx + 6, by + 5, 1, 1, '#ffffff');
  } else if (kind === 'alert') {
    R(bx + 1, by + 1, 7, 8, '#ffffff'); R(bx + 4, by + 2, 1, 4, '#d61f1f'); R(bx + 4, by + 7, 1, 1, '#d61f1f');
  } else {
    R(bx + 1, by + 1, 7, 8, '#3fbf7a');
    R(bx + 2, by + 4, 1, 2, '#ffffff'); R(bx + 3, by + 5, 1, 2, '#ffffff'); R(bx + 4, by + 4, 1, 2, '#ffffff');
    R(bx + 5, by + 3, 1, 2, '#ffffff'); R(bx + 6, by + 2, 1, 2, '#ffffff');
  }
}

// The balloon over an agent: a blocked one blinks its alert, a PR notice is orange (over a ready room's
// check too: a failed CI matters more), a ready one shows its check. Walkers show none.
export function badgeFor(a, t) {
  if (a.walking) return null;
  if (a.state === 'blocked') return (t % .9) < .6 ? 'alert' : null;
  if (a.info?.notice) return 'notice';
  return a.state === 'ready' ? 'check' : null;
}

// Queued rooms are dimmed a little; a parked room, whose Claude stopped, more.
export const isDim = a => a.state === 'queue' || a.info?.parked === true;
const dimAlpha = a => (a.info?.parked === true ? .55 : .82);

const glowAt = (x, y, r, c) => {
  const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
};

// One agent or staff member as a depth-sorted drawable, with its ember, smoke, steam and balloon.
function agentItem(a, t, world, hitboxes) {
  const { particles: ps, frame, cheerUntil } = world;
  const ps2 = poseFor(a, t, cheerUntil);
  return { y: a.y, draw() {
    const spr = buildSprite(a.look, ps2.pose);
    const o = drawSprite(spr, a.x, a.y, ps2.flip, ps2.bob, isDim(a) && dimAlpha(a), !(a.state === 'ready' && !a.walking));
    hitboxes.push({ kind: 'agent', ref: a, x: o[0], y: o[1], w: 18, h: 34 });
    if (ps2.ember) { const [ex, ey] = anc(o, ps2.ember, ps2.flip); R(ex, ey, 1, 1, (t * 3 + a.off) % 1 < .5 ? '#ff7a1a' : '#ffd04a');
      if (frame % (a.state === 'boss' ? 16 : 10) === 0) emitSmoke(ps, ex + .5, ey, 1, false); }
    if (ps2.steam && frame % 12 === 0) { const [sx, sy] = anc(o, ps2.steam, ps2.flip); ps.parts.push({ k: 'steam', x: sx, y: sy, vx: .02, vy: -.18, life: 0, max: 60 }); }
    if (a.state === 'smoke' && ps2.pose.mouth === 'o' && frame % 2 === 0) emitSmoke(ps, o[0] + 9, o[1] + 11, 3, true);
    if (a.state === 'boss' && frame % 170 === 85) ps.parts.push({ k: 'ring', x: o[0] + 12, y: o[1] + 9, vx: .06, vy: -.15, life: 0, max: 130 });
    if (a.state === 'sleep' && frame % 70 === 0) ps.parts.push({ k: 'zz', x: o[0] + 13, y: o[1] + 4, life: 0, max: 80 });
    const badge = badgeFor(a, t);
    if (badge) drawBubble(o, badge);
  } };
}

function npcItem(n, t, world, hitboxes) {
  const { particles: ps, frame, ringUntil, beat = null } = world;
  const ps2 = npcPose(n, t, ringUntil, beat);
  return { y: n.y, draw() {
    const o = drawSprite(buildSprite(n.look, ps2.pose), n.x, n.y, ps2.flip, ps2.bob);
    hitboxes.push({ kind: 'npc', ref: n, x: o[0], y: o[1], w: 18, h: 34 });
    if (n.kind === 'sax') {
      // With music on, one note every two beats, so the rate follows the bpm.
      const k = beat === null ? null : Math.floor(beat / 2);
      if (k === null ? frame % 26 === 0 : k !== n.noteAt) ps.parts.push({ k: 'note', x: o[0] + 14, y: o[1] + 18, life: 0, max: 90 });
      n.noteAt = k;
    }
    if (n.kind === 'barman') { const gx = o[0] + 8 + Math.round(Math.sin(t * 4) * 2); R(gx, o[1] + 17, 3, 4, '#dfe8ee'); R(gx, o[1] + 17, 3, 1, '#ffffff'); }
  } };
}

// Drawables for another scene (the lobby) on ctx: these people, and the desk and rope in the hall's colours.
export function peopleItems(ctx, world, t, agents, npcs, hitboxes) {
  g = ctx;
  return [...agents.map(a => agentItem(a, t, world, hitboxes)), ...npcs.map(n => npcItem(n, t, world, hitboxes))];
}
export function furnitureItem(ctx, kind, y, t, world) { g = ctx; return { y, draw: () => drawFurnitureFront(kind, t, world, THEMES.hall) }; }

// Lift doors on a wall, open 0..1, with the trim around them.
export function liftDoors(ctx, x, y, w, h, open, trim) {
  g = ctx;
  R(x - 3, y - 3, w + 6, h + 3, trim); R(x - 2, y - 2, w + 4, h + 2, '#2a2620'); R(x, y, w, h, '#1a1410');
  const half = w / 2, gap = Math.round(open * (half - 2));
  if (open > 0) { R(x + 2, y + 2, w - 4, h - 2, '#ffcf7a'); R(x + 2, y + 2, w - 4, 3, '#fff0c0'); }
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  for (const [dx, dir] of [[0, -1], [half, 1]]) { const px = x + dx + dir * gap;
    R(px, y, half, h, '#9a8a70'); R(px + 1, y + 1, half - 2, h - 2, '#b8a888'); R(px + (dir < 0 ? half - 2 : 1), y, 1, h, '#6a5a44');
    R(px + 3, y + 4, half - 6, h - 8, 'rgba(255,255,255,.08)'); }
  g.restore();
}
// How far lift doors stand open, `since` seconds after they opened (closed again after 1.6 s).
export const doorOpen = since => { const k = since / 1.6; return k < 0 || k > 1 ? 0 : Math.min(1, Math.sin(k * Math.PI) * 1.6); };

// The hall's floor in the building has a gong where the single-room lounge has the reception desk.
const HALL_GONG_Y = 304;

// Draws one frame and refreshes world.hitboxes. Returns whether the neon is lit.
// `floor` makes it a floor of the building: only those agents and staff, the lift landing on the left
// (doors open `floor.open`, 0..1) instead of the street, and the theme's signature piece instead of the desk.
export function renderFrame(ctx, bg, world, t, th = THEMES.hall, floor = null) {
  g = ctx;
  const { slots, particles: ps, fxRng, fireworksUntil } = world;
  const agents = floor ? floor.agents : world.agents, npcs = floor ? floor.npcs : world.npcs;
  const hitboxes = world.hitboxes = [];
  g.drawImage(bg, 0, 0);
  drawParticles(g, ps);
  drawFireworks(g, ps);
  R(550, 21, 2, 147, th.frame);
  danceFloor(t, th); drawWallFx(g, th, t); drawSlots(t, slots, th);
  if (th === THEMES.casino) drawSlots(t, decorSlots(t), th);
  if (floor) {
    liftDoors(g, 22, 128, 44, 78, floor.open, th.trim);
    R(36, 120, 16, 6, '#140b08'); R(38, 121, 3, 4, floor.open > 0 ? '#ffd45c' : '#5a4a2a'); R(47, 121, 3, 4, '#5a4a2a');
  }
  const neonOn = !(Math.sin(t * 3.1) > .97 || (t % 7 > 6.85));

  // drawables sorted by depth (feet y)
  const items = [];
  for (const a of agents) items.push(agentItem(a, t, world, hitboxes));
  for (const n of npcs) items.push(npcItem(n, t, world, hitboxes));
  const sigY = signatureY(th) ?? (floor ? HALL_GONG_Y : null), sig = sigY !== null;
  for (const [kind, y] of [['sofa', 199.5], ['table', 240], ['counter', 213], ['armchair', 196], ['desk', 303], ['rope', 306]]) {
    if (kind === 'desk' && sig) continue;
    if (kind === 'rope' && floor) continue;
    items.push({ y, draw: () => drawFurnitureFront(kind, t, world, th) });
  }
  if (sig) items.push({ y: sigY, draw: () => drawSignature(g, th, t) });
  items.sort((a, b) => a.y - b.y).forEach(it => it.draw());

  drawCeiling(g, th, t);
  drawHaze(g, ps); drawParticles(g, ps);

  // light
  g.globalCompositeOperation = 'lighter';
  const glow = glowAt;
  LANTERNS.forEach(([x, y], i) => { const f = .9 + Math.sin(t * 6 + i * 2.3) * .05 + fxRng() * .04;
    if (th !== THEMES.garden) glow(x + 5, y + 9, 72, `rgba(${th.light},${.3 * f})`); });
  if (th === THEMES.garden) for (let i = 0; i < 6; i++) glow(110 + i * 85, 22, 50, `rgba(${th.light},.12)`);
  glow(183, 145, 34, 'rgba(255,220,150,.25)');
  if (floor) glow(44, 170, 40, `rgba(${th.light},.14)`);
  else { glow(97, 200, 40, 'rgba(255,170,80,.25)'); if (neonOn) glow(FLOOR.neon[0], FLOOR.neon[1], 46, 'rgba(255,60,150,.22)'); }
  SLOT_X.forEach((x, i) => glow(x + 14, 165, 26, slots[i].flash > t ? 'rgba(255,220,90,.45)' : 'rgba(255,90,70,.16)'));
  if (!sig) glow(246, 266, 38, 'rgba(255,200,110,.18)');
  if (floor && th === THEMES.hall) glow(246, 280, 30, 'rgba(255,200,110,.16)');
  glow(496, 160, 40, th.vipGlow); glow(556, 40, 30, 'rgba(160,180,255,.14)');
  themeGlows(th, glow);
  for (let i = 0; i < 3; i++) { const an = t * .8 + i * 2.1, tx = 400 + Math.cos(an) * 55, ty = 296 + Math.sin(an * 1.4) * 14;
    const cols = th.dots.map(c => `rgba(${c},.16)`);
    g.fillStyle = cols[i]; g.beginPath(); g.moveTo(400 - 2, 80); g.lineTo(400 + 2, 80); g.lineTo(tx + 18, ty); g.lineTo(tx - 18, ty); g.closePath(); g.fill(); glow(tx, ty, 18, cols[i]); }
  if ((t % .9) < .6) agents.filter(a => a.state === 'blocked' && !a.walking).forEach(a => glow(a.x, a.y - 30, 18, 'rgba(255,40,40,.35)'));
  if (fireworksUntil > t) glow(551, 70, 50, 'rgba(255,200,140,.12)');
  g.globalCompositeOperation = 'source-over';
  vignette(W, H);
  return neonOn;
}

export function vignette(w = W, h = H, edge = .62, ctx = g) {
  const vg = ctx.createRadialGradient(w / 2, h / 2, 110, w / 2, h / 2, 360); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(10,4,2,${edge})`);
  ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
}
export function glowOn(ctx) { return (x, y, r, c) => { g = ctx; glowAt(x, y, r, c); }; }

// Standalone pieces for the README art (banner, state sheet).
export function drawLantern(ctx, x, y, t = 0, i = 0) { lantern(ctx, x, y, t, i); }
export function drawBadge(ctx, o, kind) { g = ctx; drawBubble(o, kind); }

// Standalone figure for the panel portrait.
export function portrait(agent, makeCanvas) {
  const c = makeCanvas(); c.width = 18; c.height = 34;
  const pose = { la: 'down', ra: 'down', legs: 'stand', eyes: 'open', mouth: agent.state === 'blocked' ? 'o' : 'smile', acc: null };
  c.getContext('2d').drawImage(buildSprite(agent.look, pose, makeCanvas), 0, 0);
  return c;
}
