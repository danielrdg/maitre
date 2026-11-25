import { W, H, SLOT_X } from './scene-static.js';
import { buildSprite } from './sprites.js';
import { poseFor, npcPose } from './agents.js';
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

function drawSlots(t, slots) {
  slots.forEach(s => {
    const x = s.x;
    for (let r = 0; r < 3; r++) { const rx = x + 3 + r * 8; R(rx, 156, 7, 14, '#f2ede2'); R(rx, 156, 7, 1, '#c9c2b2'); R(rx, 169, 7, 1, '#c9c2b2');
      const sy = SYMS[s.reels[r]], jit = s.spin[r] ? (Math.floor(t * 30) % 3) - 1 : 0;
      sy.m.forEach((row, yy) => [...row].forEach((ch, xx) => { if (ch !== '.') R(rx + 1 + xx, 160 + yy + jit, 1, 1, sy.c[ch]); })); }
    const flash = s.flash > t;
    for (let b = 0; b < 14; b++) { const on = flash ? (Math.floor(t * 16) % 2 === 0) : (Math.floor(t * 8) + b) % 4 === 0; R(x - 1 + b * 2 + 1, 137, 1, 1, on ? '#fff6b0' : '#8a6a20'); R(x - 1 + b * 2 + 1, 145, 1, 1, on ? '#8a6a20' : '#fff6b0'); }
    R(x + 4, 139, 20, 5, flash ? (Math.floor(t * 10) % 2 ? '#ffd45c' : '#ff5a5a') : '#3a0d0a');
    if (!flash) { R(x + 6, 141, 2, 1, '#ffd45c'); R(x + 10, 141, 2, 1, '#ffd45c'); R(x + 14, 141, 2, 1, '#ffd45c'); R(x + 18, 141, 2, 1, '#ffd45c'); }
    const pulled = (t - s.pulled) < .35;
    R(x + 28, 156, 2, 18, '#b9b9c0'); R(x + 28, 172, 3, 3, '#7a7a84');
    if (pulled) { R(x + 28, 168, 2, 8, '#d0d0d8'); R(x + 27, 175, 4, 4, '#ff3b2f'); }
    else { R(x + 27, 150, 4, 4, '#ff3b2f'); R(x + 28, 151, 1, 1, '#ff9a8a'); }
  });
}

export const LANTERNS = [[124, 16], [190, 26], [256, 18], [454, 22], [322, 30]];
function lantern(x, y, t, i) { const sw = Math.round(Math.sin(t * .9 + i * 1.7)); x += sw;
  R(x + 5 - sw, 0, 1, y, '#5a3320'); R(x + 2, y, 7, 2, '#d9a441'); R(x, y + 2, 11, 13, '#c8281e'); R(x + 1, y + 2, 2, 13, '#e8483a'); R(x + 8, y + 2, 2, 13, '#9a1c14');
  for (const k of [5, 9, 13]) R(x, y + k, 11, 1, '#9a1c14'); R(x + 4, y + 4, 3, 9, '#ffb060'); R(x + 5, y + 5, 1, 7, '#ffe0a0');
  R(x + 2, y + 15, 7, 2, '#d9a441'); R(x + 5, y + 17, 1, 5, '#d9a441'); R(x + 4, y + 22, 3, 1, '#c8281e'); }
const BULB = ['#ffd45c', '#ff7a5a', '#fff0b0', '#ff5fa2'];
function stringLights(t) { for (let seg = 0; seg < 6; seg++) { const x0 = 90 + seg * 80, x1 = x0 + 80;
    for (let x = x0; x < x1; x++) { const k = (x - x0) / 80, y = 44 + Math.round(Math.sin(k * Math.PI) * 10); R(x, y, 1, 1, '#2a160b');
      if ((x - x0) % 10 === 5) { const on = (Math.floor(t * 3) + x) % 5 !== 0; R(x - 1, y + 1, 3, 3, on ? BULB[(x / 10 | 0) % 4] : '#6a4a2a'); } } } }
function discoBall(t) { const cx = 400, cy = 74; R(cx, 0, 1, cy - 7, '#8a8a92');
  for (let y = -7; y <= 7; y++) for (let x = -7; x <= 7; x++) if (x * x + y * y <= 49) { const glint = ((x + y + Math.floor(t * 6)) & 3) === 0;
    R(cx + x, cy + y, 1, 1, glint ? '#ffffff' : ((x ^ y) & 1 ? '#9aa0b0' : '#c8ccd8')); } }
function wallDots(t) { const cols = ['rgba(255,95,162,.55)', 'rgba(91,156,245,.5)', 'rgba(255,212,92,.55)', 'rgba(95,211,154,.45)'];
  for (let i = 0; i < 18; i++) { const an = t * .35 + i * 2.1, x = 400 + Math.cos(an) * (90 + (i % 5) * 26), y = 74 + Math.sin(an * 1.3) * (30 + (i % 3) * 20) + 30;
    if (x > 104 && x < 524 && y > 4 && y < 196) R(x, y, 2, 2, cols[i % 4]); } }
function danceFloor(t) { const C = ['#5a1a3a', '#1a2a5a', '#5a4a10', '#1a4a2a', '#3a1a5a'];
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 10; tx++) { const x = 330 + tx * 14, y = 274 + ty * 12;
    const on = ((tx + ty + Math.floor(t * 2)) % 5); R(x, y, 13, 11, C[on]); R(x, y, 13, 1, 'rgba(255,255,255,.12)'); } R(330, 272, 140, 2, '#d9a441'); }

function drawFurnitureFront(kind, t, world) {
  const { ringUntil } = world, { tableCards } = world.particles;
  if (kind === 'sofa') { R(106, 184, 66, 16, '#7a2230'); R(106, 184, 66, 2, '#a8394c'); R(102, 168, 7, 32, '#6a1c28'); R(169, 168, 7, 32, '#6a1c28');
    R(102, 168, 7, 2, '#a8394c'); R(169, 168, 7, 2, '#a8394c'); R(108, 200, 3, 4, '#24100b'); R(167, 200, 3, 4, '#24100b'); }
  if (kind === 'table') { R(166, 222, 140, 3, '#9a5f38'); R(168, 225, 136, 9, '#1f6b45'); R(170, 225, 132, 1, '#2f8f5e'); R(168, 233, 136, 1, '#17553a');
    for (const c of tableCards) { R(c.x, c.y, 3, 4, '#f2ede2'); R(c.x + 1, c.y + 1, 1, 1, c.red ? '#c0262a' : '#1a1a1a'); }
    [[176, '#c0262a'], [181, '#5b9cf5'], [292, '#ffd45c'], [297, '#5fd39a']].forEach(([cx, col], i) => { const hh = 2 + Math.round((Math.sin(t * .7 + i * 2) + 1) * 2);
      for (let k = 0; k < hh; k++) R(cx, 232 - k, 4, 1, k % 2 ? col : '#efe9dc'); });
    R(166, 234, 140, 6, '#5a3320'); R(166, 234, 140, 1, '#d9a441'); R(228, 240, 16, 16, '#3a2010'); R(218, 256, 36, 3, '#2a160b'); }
  if (kind === 'counter') { R(360, 178, 110, 4, '#9a5f38'); R(360, 182, 110, 30, '#6b3a22');
    for (let x = 366; x < 466; x += 18) { R(x, 186, 14, 22, '#5a3020'); R(x, 186, 14, 1, '#7a4a2a'); R(x + 6, 196, 2, 2, '#d9a441'); }
    R(360, 211, 110, 2, '#c89a3c');
    for (const sx of [388, 446]) { R(sx, 214, 11, 3, '#a3221b'); R(sx, 214, 11, 1, '#d04a40'); R(sx + 5, 217, 1, 18, '#b9b9c0'); R(sx + 2, 235, 7, 1, '#b9b9c0'); } }
  if (kind === 'armchair') { R(480, 172, 6, 22, '#5e1428'); R(506, 172, 6, 22, '#5e1428'); R(484, 180, 24, 14, '#4a1020'); R(480, 172, 6, 1, '#8a2440'); R(506, 172, 6, 1, '#8a2440'); }
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
  if (dim) g.globalAlpha = .82;
  if (flip) { g.save(); g.translate(x0 + 18, y0); g.scale(-1, 1); g.drawImage(spr, 0, 0); g.restore(); }
  else g.drawImage(spr, x0, y0);
  g.globalAlpha = 1;
  return [x0, y0];
}
export const anc = (o, a, flip) => [flip ? o[0] + 17 - a[0] : o[0] + a[0], o[1] + a[1]];

function drawBubble(o, kind) {
  const bx = o[0] + 5, by = o[1] - 12;
  R(bx, by, 9, 10, '#160c09'); R(bx + 3, by + 10, 2, 1, '#160c09');
  if (kind === 'alert') {
    R(bx + 1, by + 1, 7, 8, '#ffffff'); R(bx + 4, by + 2, 1, 4, '#d61f1f'); R(bx + 4, by + 7, 1, 1, '#d61f1f');
  } else {
    R(bx + 1, by + 1, 7, 8, '#3fbf7a');
    R(bx + 2, by + 4, 1, 2, '#ffffff'); R(bx + 3, by + 5, 1, 2, '#ffffff'); R(bx + 4, by + 4, 1, 2, '#ffffff');
    R(bx + 5, by + 3, 1, 2, '#ffffff'); R(bx + 6, by + 2, 1, 2, '#ffffff');
  }
}

const glowAt = (x, y, r, c) => {
  const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
};

// Draws one frame and refreshes world.hitboxes. Returns whether the neon is lit.
export function renderFrame(ctx, bg, world, t) {
  g = ctx;
  const { agents, npcs, slots, particles: ps, frame, fxRng, cheerUntil, ringUntil, fireworksUntil, beat = null } = world;
  const hitboxes = world.hitboxes = [];
  const sprite = (look, pose) => buildSprite(look, pose);
  g.drawImage(bg, 0, 0);
  drawParticles(g, ps);
  drawFireworks(g, ps);
  R(550, 21, 2, 147, '#5a3320');
  danceFloor(t); wallDots(t); drawSlots(t, slots);
  const neonOn = !(Math.sin(t * 3.1) > .97 || (t % 7 > 6.85));

  // drawables sorted by depth (feet y)
  const items = [];
  for (const a of agents) { const ps2 = poseFor(a, t, cheerUntil); items.push({ y: a.y, draw() {
    const spr = sprite(a.look, ps2.pose);
    const o = drawSprite(spr, a.x, a.y, ps2.flip, ps2.bob, a.state === 'queue', !(a.state === 'ready' && !a.walking));
    hitboxes.push({ kind: 'agent', ref: a, x: o[0], y: o[1], w: 18, h: 34 });
    if (ps2.ember) { const [ex, ey] = anc(o, ps2.ember, ps2.flip); R(ex, ey, 1, 1, (t * 3 + a.off) % 1 < .5 ? '#ff7a1a' : '#ffd04a');
      if (frame % (a.state === 'boss' ? 16 : 10) === 0) emitSmoke(ps, ex + .5, ey, 1, false); }
    if (ps2.steam && frame % 12 === 0) { const [sx, sy] = anc(o, ps2.steam, ps2.flip); ps.parts.push({ k: 'steam', x: sx, y: sy, vx: .02, vy: -.18, life: 0, max: 60 }); }
    if (a.state === 'smoke' && ps2.pose.mouth === 'o' && frame % 2 === 0) emitSmoke(ps, o[0] + 9, o[1] + 11, 3, true);
    if (a.state === 'boss' && frame % 170 === 85) ps.parts.push({ k: 'ring', x: o[0] + 12, y: o[1] + 9, vx: .06, vy: -.15, life: 0, max: 130 });
    if (a.state === 'sleep' && frame % 70 === 0) ps.parts.push({ k: 'zz', x: o[0] + 13, y: o[1] + 4, life: 0, max: 80 });
    if (a.state === 'blocked' && !a.walking && (t % .9) < .6) drawBubble(o, 'alert');
    if (a.state === 'ready' && !a.walking) drawBubble(o, 'check');
  } }); }
  for (const n of npcs) { const ps2 = npcPose(n, t, ringUntil, beat); items.push({ y: n.y, draw() {
    const o = drawSprite(sprite(n.look, ps2.pose), n.x, n.y, ps2.flip, ps2.bob);
    hitboxes.push({ kind: 'npc', ref: n, x: o[0], y: o[1], w: 18, h: 34 });
    if (n.kind === 'sax') {
      // With music on, one note every two beats, so the rate follows the bpm.
      const k = beat === null ? null : Math.floor(beat / 2);
      if (k === null ? frame % 26 === 0 : k !== n.noteAt) ps.parts.push({ k: 'note', x: o[0] + 14, y: o[1] + 18, life: 0, max: 90 });
      n.noteAt = k;
    }
    if (n.kind === 'barman') { const gx = o[0] + 8 + Math.round(Math.sin(t * 4) * 2); R(gx, o[1] + 17, 3, 4, '#dfe8ee'); R(gx, o[1] + 17, 3, 1, '#ffffff'); }
  } }); }
  for (const [kind, y] of [['sofa', 199.5], ['table', 240], ['counter', 213], ['armchair', 196], ['desk', 303], ['rope', 306]]) {
    items.push({ y, draw: () => drawFurnitureFront(kind, t, world) });
  }
  items.sort((a, b) => a.y - b.y).forEach(it => it.draw());

  LANTERNS.forEach(([x, y], i) => lantern(x, y, t, i)); stringLights(t); discoBall(t);
  drawHaze(g, ps); drawParticles(g, ps);

  // light
  g.globalCompositeOperation = 'lighter';
  const glow = glowAt;
  LANTERNS.forEach(([x, y], i) => { const f = .9 + Math.sin(t * 6 + i * 2.3) * .05 + fxRng() * .04; glow(x + 5, y + 9, 72, `rgba(255,186,90,${.3 * f})`); });
  glow(183, 145, 34, 'rgba(255,220,150,.25)'); glow(97, 200, 40, 'rgba(255,170,80,.25)');
  if (neonOn) glow(42, 80, 46, 'rgba(255,60,150,.22)');
  SLOT_X.forEach((x, i) => glow(x + 14, 165, 26, slots[i].flash > t ? 'rgba(255,220,90,.45)' : 'rgba(255,90,70,.16)'));
  glow(246, 266, 38, 'rgba(255,200,110,.18)'); glow(496, 160, 40, 'rgba(255,190,80,.2)'); glow(556, 40, 30, 'rgba(160,180,255,.14)');
  for (let i = 0; i < 3; i++) { const an = t * .8 + i * 2.1, tx = 400 + Math.cos(an) * 55, ty = 296 + Math.sin(an * 1.4) * 14;
    const cols = ['rgba(255,95,162,.16)', 'rgba(91,156,245,.16)', 'rgba(255,212,92,.16)'];
    g.fillStyle = cols[i]; g.beginPath(); g.moveTo(400 - 2, 80); g.lineTo(400 + 2, 80); g.lineTo(tx + 18, ty); g.lineTo(tx - 18, ty); g.closePath(); g.fill(); glow(tx, ty, 18, cols[i]); }
  if ((t % .9) < .6) agents.filter(a => a.state === 'blocked' && !a.walking).forEach(a => glow(a.x, a.y - 30, 18, 'rgba(255,40,40,.35)'));
  if (fireworksUntil > t) glow(551, 70, 50, 'rgba(255,200,140,.12)');
  g.globalCompositeOperation = 'source-over';
  const vg = g.createRadialGradient(W / 2, H / 2, 110, W / 2, H / 2, 360); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(10,4,2,.62)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  return neonOn;
}

// Standalone pieces for the README art (banner, state sheet).
export function drawLantern(ctx, x, y, t = 0, i = 0) { g = ctx; lantern(x, y, t, i); }
export function drawBadge(ctx, o, kind) { g = ctx; drawBubble(o, kind); }

// Standalone figure for the panel portrait.
export function portrait(agent, makeCanvas) {
  const c = makeCanvas(); c.width = 18; c.height = 34;
  const pose = { la: 'down', ra: 'down', legs: 'stand', eyes: 'open', mouth: agent.state === 'blocked' ? 'o' : 'smile', acc: null };
  c.getContext('2d').drawImage(buildSprite(agent.look, pose, makeCanvas), 0, 0);
  return c;
}
