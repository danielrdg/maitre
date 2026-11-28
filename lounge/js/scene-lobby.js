import { W, H } from './scene-static.js';
import { THEMES, lantern, stringLightsOn } from './themes.js';
import { peopleItems, furnitureItem, liftDoors, vignette, glowOn } from './scene.js';
import { stars, moon, skyline, lattice, windowBack } from './scene-facade.js';
import { drawParticles } from './particles.js';
import { LOBBY } from './places.js';
import { mulberry32 } from './rng.js';

// The lobby with the terrace above it, in the maître's own theme (the Chinese hall). The street side, the door,
// the queue, the bell and the desk stand where the single-room lounge always had them.
let g = null;
const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
const vgrad = (x, y, w, h, a, b) => { for (let i = 0; i < h; i++) { const k = i / h;
  R(x, y + i, w, 1, `rgb(${a[0] + (b[0] - a[0]) * k | 0},${a[1] + (b[1] - a[1]) * k | 0},${a[2] + (b[2] - a[2]) * k | 0})`); } };

const LIFT_LANTERNS = [[168, 144], [312, 146], [446, 144]];
const STRIP = { x: 200, y: 119, room: 376 };
const BOARD = { x: 336, y: 146, row: 11, rows: 4 };

export function buildLobby(makeCanvas) {
  const c = makeCanvas(); c.width = W; c.height = H;
  const ctx = c.getContext('2d'), rnd = mulberry32(41);
  g = ctx;
  vgrad(0, 0, W, 112, [8, 11, 26], [30, 36, 66]); stars(ctx, rnd, 0, 0, W, 60, 40); moon(ctx, 540, 22, 8);
  skyline(ctx, rnd, 0, W, 104, 14, 46, '#0b1020'); skyline(ctx, rnd, 0, W, 104, 6, 26);
  g = ctx;
  for (let x = 160; x < W; x += 24) R(x, 84, 2, 20, '#3a2a1a'); R(160, 84, W - 160, 2, '#5a4030');
  for (let y = 104; y < 118; y += 4) R(0, y, W, 4, (y / 4) % 2 ? '#5a3a22' : '#4e321c'); R(0, 104, W, 1, '#7a5030');
  R(100, 30, 58, 74, '#3a2628'); R(100, 30, 58, 3, '#5a4038'); for (let y = 34; y < 104; y += 4) R(100, y, 58, 1, '#2e1e20');
  R(166, 100, 20, 6, '#8a3a2a'); for (let i = 0; i < 5; i++) R(167 + i * 4, 88 + (i % 2) * 3, 3, 12, '#2a6a2a');
  R(548, 100, 20, 6, '#8a3a2a'); for (let i = 0; i < 5; i++) R(549 + i * 4, 88 + (i % 2) * 3, 3, 12, '#3a8a3a');
  R(318, 96, 40, 4, '#6b3a22'); R(320, 100, 2, 6, '#4a2a16'); R(354, 100, 2, 6, '#4a2a16');
  R(0, 118, W, 16, '#2a2224'); for (let x = 0; x < W; x += 22) R(x, 118, 1, 16, '#221a1c'); R(0, 118, W, 1, '#3a3034'); R(0, 133, W, 1, '#1a1214');
  R(108, 118, 44, 16, '#0c1018'); R(129, 118, 1, 16, '#5a5a64');
  vgrad(0, 134, 86, 63, [12, 16, 34], [26, 34, 60]); skyline(ctx, rnd, 0, 86, 197, 20, 55);
  g = ctx;
  R(0, 197, 86, 127, '#23252e'); for (let x = 0; x < 86; x += 14) R(x, 197, 1, 127, '#1b1d25'); for (let y = 212; y < 324; y += 16) R(0, y, 86, 1, '#1b1d25');
  R(8, 162, 68, 2, '#ff5fa2'); R(8, 188, 68, 2, '#ff5fa2'); R(8, 162, 2, 28, '#ff5fa2'); R(74, 162, 2, 28, '#ff5fa2');
  lattice(ctx, 86, 134, W, 197);
  g = ctx;
  R(86, 172, 490, 25, '#24100b'); for (let x = 92; x < W; x += 22) { R(x, 176, 17, 18, '#2c140d'); R(x, 176, 17, 1, '#3a1c12'); }
  R(86, 171, 490, 2, '#c89a3c'); R(86, 196, 490, 2, '#c89a3c');
  for (let y = 198; y < 324; y += 8) { R(86, y, 490, 8, (y / 8) % 2 ? '#3a2216' : '#34200f'); const off = (y / 8) % 3 * 17;
    for (let x = 86 + off; x < W; x += 50) R(x, y, 1, 8, '#26150c'); R(86, y + 7, 490, 1, '#2a180d'); }
  R(150, 222, 172, 30, '#7a1c20'); R(150, 222, 172, 2, '#d9a441'); R(150, 250, 172, 2, '#d9a441'); R(150, 222, 2, 30, '#d9a441'); R(320, 222, 2, 30, '#d9a441');
  for (let x = 158; x < 316; x += 10) { R(x, 235, 3, 3, '#a8323a'); R(x + 1, 236, 1, 1, '#d9a441'); }
  // a corner to wait in: two armchairs, a low table, a lamp
  R(430, 262, 110, 26, '#5a1418'); R(430, 262, 110, 1, '#d9a441'); R(430, 287, 110, 1, '#d9a441');
  for (const ax of [440, 508]) { R(ax, 244, 22, 26, '#5e1428'); R(ax, 244, 22, 2, '#8a2440'); R(ax - 3, 254, 4, 16, '#4a1020'); R(ax + 21, 254, 4, 16, '#4a1020'); R(ax + 2, 258, 18, 8, '#7a1c30'); }
  R(470, 262, 28, 3, '#9a5f38'); R(472, 265, 24, 8, '#6b3a22'); R(474, 258, 4, 4, '#f2ede2'); R(476, 257, 1, 1, '#c0262a'); R(486, 256, 6, 6, '#3f8a4a'); R(487, 254, 4, 2, '#5fd39a');
  R(560, 230, 2, 42, '#d9a441'); R(554, 222, 14, 9, '#e8c890'); R(554, 222, 14, 1, '#fff0c8'); R(556, 272, 10, 2, '#5a3320');
  R(84, 140, 20, 166, '#7a1c16'); R(84, 140, 20, 3, '#d9a441'); R(84, 140, 2, 166, '#d9a441'); R(102, 140, 2, 166, '#d9a441');
  R(87, 145, 14, 156, '#2a120c'); R(87, 145, 7, 156, '#5a1a12'); R(96, 145, 4, 156, '#c8803a'); R(97, 145, 2, 156, '#f0b060');
  // pigeonholes behind the desk
  R(196, 140, 100, 52, '#5a3320'); R(196, 140, 100, 2, '#d9a441');
  for (let r = 0; r < 4; r++) for (let col = 0; col < 8; col++) { R(199 + col * 12, 144 + r * 12, 10, 10, '#2a160b'); if ((r * 8 + col) % 3 !== 1) R(201 + col * 12, 150 + r * 12, 6, 4, '#f2ede2'); }
  // floor directory
  R(330, 140, 104, 56, '#140b08'); R(332, 142, 100, 52, '#24100b'); R(332, 142, 100, 1, '#d9a441'); R(332, 193, 100, 1, '#d9a441');
  // waiting couch and plant
  R(470, 172, 70, 20, '#8e2a3a'); R(470, 172, 70, 2, '#b04558');
  R(548, 178, 14, 20, '#6b3a22'); for (let i = 0; i < 7; i++) R(546 + i * 2, 154 + (i % 3) * 4, 3, 26, i % 2 ? '#2a6a2a' : '#3a8a3a');
  return c;
}

function ashtray(x, y, butts) { R(x, y - 22, 2, 22, '#8a8a92'); R(x - 5, y - 24, 12, 3, '#6a6a72'); R(x - 4, y, 10, 2, '#6a6a72');
  for (let i = 0; i < butts; i++) R(x - 4 + (i * 3) % 10, y - 25 - (i / 4 | 0), 2, 1, i % 3 ? '#f2ede2' : '#d8a070'); }

// s: { t, world, floors, agents (those in the lobby or on the terrace), npcs, doors: { lobby, terrace } (0..1), tr }.
// Returns the hitboxes, the tags to place and where the two neons go.
export function drawLobby(ctx, bg, s) {
  g = ctx;
  const { t, world, floors, agents, tr } = s;
  const glow = glowOn(ctx);
  const hit = [], tags = [];
  const blinkOn = (t % .9) < .6;
  const alertOn = new Set(world.agents.filter(a => a.state === 'blocked').map(a => a.info?.project));
  g.drawImage(bg, 0, 0);

  // the terrace
  stringLightsOn(ctx, t, 160, 576, 40, 12, 4); lantern(ctx, 220, 44, t, 0, 40); lantern(ctx, 470, 46, t, 2, 40);
  liftDoors(ctx, 114, 62, 30, 42, s.doors.terrace, '#c89a3c');
  g = ctx; R(122, 55, 14, 5, '#140b08'); R(124, 56, 10, 3, '#ffd45c');
  hit.push({ kind: 'view', view: 'facade', x: 112, y: 58, w: 34, h: 48 });
  const up = agents.filter(a => a.place === 'terrace'), down = agents.filter(a => a.place !== 'terrace');
  const terrace = peopleItems(ctx, world, t, up, [], hit);
  terrace.push({ y: 105, draw: () => { g = ctx; ashtray(338, 105, 6 + Math.min(20, up.length * 3 + Math.floor(t / 8) % 6)); } });
  terrace.sort((a, b) => a.y - b.y).forEach(it => it.draw());
  g = ctx;

  // every open floor in one line, between the terrace and the lobby
  const sorted = [...floors].sort((a, b) => a.floor - b.floor), per = Math.min(86, Math.floor(STRIP.room / Math.max(1, sorted.length)));
  const ww = Math.max(10, per - 20);
  sorted.forEach((f, i) => {
    const th = THEMES[f.theme] ?? THEMES.hall, x = STRIP.x + i * per;
    R(x, 121, ww, 10, '#140b08'); windowBack(ctx, th, x + 1, 122, ww - 2, 8, t, i, false); g = ctx;
    if (alertOn.has(f.project) && blinkOn) R(x + 1, 122, ww - 2, 8, 'rgba(255,40,40,.45)');
    hit.push({ kind: 'level', key: f.floor, x, y: 117, w: ww, h: 16 });
    tags.push({ key: `mini${f.floor}`, x: x + ww / 2, y: 118, cls: 'c', text: per >= 60 ? tr('floor.title', { n: f.floor, project: f.project }) : String(f.floor) });
  });
  tags.push({ key: 'lb', x: 129, y: 125, cls: 'c gold', text: tr('facade.lobby') });

  // the lobby: lanterns, the lift and the floor directory
  LIFT_LANTERNS.forEach(([x, y], i) => lantern(ctx, x, y, t, i, 134));
  liftDoors(ctx, 112, 146, 34, 50, s.doors.lobby, '#c89a3c');
  g = ctx; R(121, 137, 16, 6, '#140b08'); R(123, 138, 12, 4, '#ffd45c');
  hit.push({ kind: 'view', view: 'facade', x: 110, y: 136, w: 38, h: 62 });
  const board = [...floors].sort((a, b) => b.floor - a.floor), shown = board.length > BOARD.rows ? board.slice(0, BOARD.rows - 1) : board;
  shown.forEach((f, i) => {
    const y = BOARD.y + i * BOARD.row, th = THEMES[f.theme] ?? THEMES.hall, alert = alertOn.has(f.project);
    R(BOARD.x, y, 8, 7, th.trim); R(BOARD.x + 1, y + 1, 6, 5, th.wall);
    if (alert && blinkOn) R(BOARD.x, y, 8, 7, '#ff4040');
    hit.push({ kind: 'level', key: f.floor, x: BOARD.x - 2, y: y - 2, w: 96, h: BOARD.row });
    tags.push({ key: `dir${f.floor}`, x: BOARD.x + 12, y: y + 4, cls: 'l' + (alert ? ' alert' : ''), text: `${f.floor} ${f.project}${alert ? ' !' : ''}` });
  });
  if (shown.length < board.length) tags.push({ key: 'dirmore', x: BOARD.x + 12, y: BOARD.y + shown.length * BOARD.row + 4, cls: 'l dim', text: tr('chip.more', { n: board.length - shown.length }) });
  tags.push({ key: 'dirh', x: 382, y: 138, cls: 'c gold', text: tr('floors.title') });
  R(470, 188, 70, 12, '#7a2230'); R(470, 188, 70, 2, '#a8394c'); R(466, 176, 6, 24, '#6a1c28'); R(538, 176, 6, 24, '#6a1c28');

  const items = [...peopleItems(ctx, world, t, down, s.npcs, hit), furnitureItem(ctx, 'desk', 303, t, world), furnitureItem(ctx, 'rope', 306, t, world)];
  items.sort((a, b) => a.y - b.y).forEach(it => it.draw());
  g = ctx;
  drawParticles(ctx, world.particles);

  g.globalCompositeOperation = 'lighter';
  [[220, 44], [470, 46], ...LIFT_LANTERNS].forEach(([x, y], i) => glow(x + 5, y + 9, 56, `rgba(255,186,90,${.26 + Math.sin(t * 6 + i) * .02})`));
  glow(42, 176, 46, 'rgba(255,60,150,.22)'); glow(129, 170, 30, 'rgba(255,200,110,.16)'); glow(540, 22, 26, 'rgba(160,180,255,.14)');
  glow(246, 266, 38, 'rgba(255,200,110,.18)'); glow(382, 168, 40, 'rgba(255,186,90,.1)'); glow(561, 228, 34, 'rgba(255,220,150,.22)');
  if (blinkOn) agents.filter(a => a.state === 'blocked' && !a.walking).forEach(a => glow(a.x, a.y - 30, 20, 'rgba(255,40,40,.38)'));
  g.globalCompositeOperation = 'source-over';
  vignette(W, H, .55, ctx);
  return { hitboxes: hit, tags, neon: LOBBY.neon, terraceNeon: LOBBY.terraceNeon };
}
