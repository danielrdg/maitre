export const MODEL = { haiku: ['#5fd39a', '#38946a'], sonnet: ['#5b9cf5', '#3a66b8'], opus: ['#a77bf0', '#6f4cb4'],
                       fable: ['#f2c03a', '#b07f18'], queued: ['#8f8b9c', '#64606f'], tux: ['#24242e', '#15151b'] };
export const SKIN = [['#f6cfa0', '#dca97a'], ['#e6b07a', '#c58c58'], ['#c68642', '#a2692f'], ['#8d5524', '#6c3f19'], ['#ffe0bd', '#e9bf98']];
export const HAIR = [['#24170f', '#140c08'], ['#5a341c', '#3c2010'], ['#d8b25a', '#a88438'], ['#b8b8c0', '#8a8a94'],
                     ['#a83a22', '#7a2614'], ['#2e3350', '#1c2036'], ['#e86aa0', '#b84a7a']];
export const SPRITE_W = 18, SPRITE_H = 34;
const cache = new Map();

// 16x32 figure drawn on an 18x34 canvas (1 px margin for the outline).
export function buildSprite(look, pose, makeCanvas = () => document.createElement('canvas')) {
  const key = JSON.stringify([look, pose]); let c = cache.get(key); if (c) return c;
  c = makeCanvas(); c.width = SPRITE_W; c.height = SPRITE_H; const x = c.getContext('2d');
  const P = (px, py, w, h, col) => { x.fillStyle = col; x.fillRect(px + 1, py + 1, w, h); };
  const CL = (px, py) => x.clearRect(px + 1, py + 1, 1, 1);
  const [m, M] = look.tux ? MODEL.tux : (MODEL[look.model] || MODEL.queued);
  const [s, S] = SKIN[look.skin]; const [h, Hh] = HAIR[look.hair];
  const acc = look.tux ? '#efeadf' : (look.accent || '#efe6d6');
  const pants = look.tux ? '#1a1a22' : '#2c2a3a', pantsS = '#1d1b28', shoe = '#140d0a';
  const dress = look.outfit === 'dress' || look.outfit === 'qipao';
  const L = pose.legs || 'stand';
  let lo = 0, ro = 0;
  if (L === 'walk1') { lo = -1; ro = 1; } if (L === 'walk2') { lo = 1; ro = -1; }
  if (L === 'dance1') { lo = -1; } if (L === 'dance2') { ro = 1; }
  // legs
  if (L === 'sit') {
    if (dress) { P(4, 22, 9, 4, m); P(4, 25, 9, 1, M); P(11, 26, 2, 4, s); P(11, 30, 3, 1, '#6a1020'); }
    else { P(5, 23, 9, 3, pants); P(5, 25, 9, 1, pantsS); P(11, 26, 3, 4, pants); P(11, 30, 4, 1, shoe); }
  } else if (dress) {
    P(6 + lo, 27, 1, 3, s); P(9 + ro, 27, 1, 3, S);
    P(5 + lo, 30, 3, 1, '#6a1020'); P(8 + ro, 30, 3, 1, '#6a1020');
  } else {
    P(5 + lo, 23, 3, 7, pants); P(7 + lo, 23, 1, 7, pantsS); P(8 + ro, 23, 3, 7, pants); P(10 + ro, 23, 1, 7, pantsS);
    P(4 + lo, 30, 4, 1, shoe); P(8 + ro, 30, 4, 1, shoe);
  }
  // torso
  P(3, 13, 10, 2, m); P(4, 15, 8, 7, m); P(11, 15, 1, 7, M); P(3, 14, 1, 1, M);
  if (dress) {
    if (L !== 'sit') { P(3, 22, 10, 1, m); P(2, 23, 12, 3, m); P(2, 26, 12, 1, M); P(12, 22, 2, 4, M); }
    if (look.outfit === 'qipao') { P(6, 12, 4, 1, m); P(8, 13, 1, 1, '#f0c050'); P(9, 14, 1, 1, '#f0c050'); P(10, 15, 1, 1, '#f0c050');
      P(10, 16, 1, 1, '#f0c050'); P(5, 18, 1, 1, '#f0c050'); P(6, 19, 1, 1, '#f0c050'); }
    else { P(6, 13, 4, 1, s); P(7, 14, 2, 1, s); }
  } else {
    P(4, 22, 8, 1, look.tux ? '#101016' : '#3a2414'); P(7, 22, 2, 1, '#c89a3c');
    if (look.outfit === 'jacket' || look.tux) { P(7, 13, 2, 5, acc); P(6, 13, 1, 3, M); P(9, 13, 1, 3, M);
      P(7, 13, 2, 1, look.tie || '#c0262a'); P(8, 19, 1, 1, '#d9a441'); P(8, 20, 1, 1, M); }
    else { P(6, 13, 4, 1, acc); P(7, 14, 2, 1, acc); P(8, 16, 1, 1, M); P(8, 18, 1, 1, M); }
  }
  // arms
  const la = pose.la || 'down', ra = pose.ra || 'down';
  if (la === 'down') { P(2, 14, 2, 8, m); P(2, 22, 2, 2, s); }
  if (la === 'hip') { P(2, 14, 2, 4, m); P(1, 18, 2, 3, m); P(3, 21, 2, 1, s); }
  if (la === 'cheer') { P(2, 7, 2, 7, m); P(2, 5, 2, 2, s); }
  if (la === 'forward') { P(2, 14, 2, 5, m); P(2, 19, 5, 2, M); P(6, 19, 2, 2, s); }
  if (ra === 'down') { P(12, 14, 2, 8, m); P(13, 14, 1, 8, M); P(12, 22, 2, 2, s); P(13, 22, 1, 2, S); }
  if (ra === 'mouth') { P(12, 14, 2, 4, m); P(13, 14, 1, 4, M); P(10, 12, 2, 6, M); P(9, 10, 2, 2, s); }
  if (ra === 'cheer') { P(12, 7, 2, 7, m); P(13, 7, 1, 7, M); P(12, 5, 2, 2, s); }
  if (ra === 'half') { P(12, 14, 3, 2, m); P(14, 10, 2, 5, M); P(14, 8, 2, 2, s); }
  if (ra === 'forward') { P(12, 14, 2, 5, m); P(13, 14, 1, 5, M); P(9, 19, 5, 2, M); P(8, 19, 2, 2, s); }
  // head
  P(4, 3, 8, 9, s); CL(4, 3); CL(11, 3); CL(4, 11); CL(11, 11);
  P(11, 4, 1, 7, S); P(5, 11, 6, 1, S); P(3, 7, 1, 2, s); P(12, 7, 1, 2, S); P(7, 12, 2, 1, S);
  // face
  const E = pose.eyes || 'open';
  if (E === 'closed') { P(5, 8, 2, 1, S); P(9, 8, 2, 1, S); }
  else if (E === 'blink') { P(5, 8, 2, 1, '#2a1810'); P(9, 8, 2, 1, '#2a1810'); }
  else { P(5, 7, 2, 2, '#ffffff'); P(9, 7, 2, 2, '#ffffff'); P(6, 7, 1, 2, '#1c120c'); P(10, 7, 1, 2, '#1c120c'); }
  P(5, 6, 2, 1, Hh); P(9, 6, 2, 1, Hh);
  P(5, 9, 1, 1, 'rgba(240,120,110,.45)'); P(10, 9, 1, 1, 'rgba(240,120,110,.45)');
  const mo = pose.mouth || 'neutral';
  if (look.beard) { P(5, 9, 6, 3, h); P(4, 8, 1, 2, h); P(11, 8, 1, 2, Hh); }
  if (mo === 'smile') { P(6, 9, 1, 1, '#8a3a30'); P(7, 10, 2, 1, '#8a3a30'); P(9, 9, 1, 1, '#8a3a30'); }
  else if (mo === 'o') { P(7, 10, 2, 1, '#5a1e18'); }
  else { P(7, 10, 2, 1, '#9a4a40'); }
  if (look.glasses) { P(4, 7, 3, 1, '#20202a'); P(9, 7, 3, 1, '#20202a'); P(7, 7, 2, 1, '#20202a'); }
  if (look.shades) { P(4, 7, 8, 2, '#08080c'); P(5, 7, 1, 1, '#50505e'); P(9, 7, 1, 1, '#50505e'); }
  // hair
  const hs = look.hs || 'short';
  if (hs === 'hat') { P(2, 4, 12, 1, '#1a1414'); P(4, 1, 8, 3, '#2a2222'); P(4, 3, 8, 1, '#a3221b'); P(5, 1, 6, 1, '#3a3030'); }
  else {
    P(4, 1, 8, 2, h); P(3, 2, 10, 2, h); P(3, 4, 2, 2, h); P(11, 4, 2, 2, h); P(4, 4, 5, 1, h);
    P(9, 1, 3, 2, Hh); P(11, 2, 2, 4, Hh); P(5, 1, 2, 1, 'rgba(255,255,255,.18)');
    if (hs === 'long') { P(2, 4, 2, 11, h); P(12, 4, 2, 11, Hh); P(3, 14, 1, 1, h); }
    if (hs === 'bob') { P(3, 4, 1, 7, h); P(12, 4, 1, 7, Hh); P(4, 4, 8, 1, h); P(3, 11, 2, 1, h); P(11, 11, 2, 1, Hh); }
    if (hs === 'bun') { P(6, 0, 4, 2, h); P(8, 0, 2, 1, Hh); P(7, 1, 2, 1, '#c0262a'); }
    if (hs === 'spiky') { P(4, 0, 1, 1, h); P(6, 0, 1, 1, h); P(8, 0, 1, 1, Hh); P(10, 0, 1, 1, Hh); }
  }
  // outline
  const img = x.getImageData(0, 0, 18, 34), d = img.data, o = new Uint8ClampedArray(d);
  const op = (a, b) => a >= 0 && b >= 0 && a < 18 && b < 34 && d[(b * 18 + a) * 4 + 3] > 80;
  for (let yy = 0; yy < 34; yy++) for (let xx = 0; xx < 18; xx++) { const i = (yy * 18 + xx) * 4;
    if (d[i + 3] > 80) continue;
    if (op(xx - 1, yy) || op(xx + 1, yy) || op(xx, yy - 1) || op(xx, yy + 1)) { o[i] = 22; o[i + 1] = 12; o[i + 2] = 9; o[i + 3] = 255; } }
  const out = x.createImageData(18, 34); out.data.set(o); x.putImageData(out, 0, 0);
  // accessories (no outline)
  drawAccessory(P, pose.acc);
  if (pose.cig) drawAccessory(P, pose.cig);
  cache.set(key, c); return c;
}

function drawAccessory(P, A) {
  if (A === 'cigHold') P(14, 22, 2, 1, '#f2ede2');
  if (A === 'cigMouth') P(11, 10, 2, 1, '#f2ede2');
  if (A === 'cigar') { P(9, 10, 3, 1, '#6b3a22'); P(11, 10, 1, 1, '#8a5a3a'); }
  if (A === 'cupHold') { P(14, 20, 2, 3, '#f2ede2'); P(16, 21, 1, 1, '#f2ede2'); P(14, 20, 2, 1, '#6b3a22'); }
  if (A === 'cupMouth') { P(10, 8, 2, 3, '#f2ede2'); P(10, 8, 2, 1, '#6b3a22'); }
  if (A === 'glassHold') { P(14, 20, 2, 3, '#d8902a'); P(14, 20, 2, 1, '#f4d58a'); }
  if (A === 'glassCheer') { P(12, 2, 2, 3, '#d8902a'); P(12, 2, 2, 1, '#f4d58a'); }
  if (A === 'cards') { P(6, 17, 2, 3, '#f2ede2'); P(6, 18, 1, 1, '#c0262a'); P(8, 17, 2, 3, '#f2ede2'); }
  if (A === 'sax') { const gd = '#f0c040', gs = '#b8871e'; P(8, 11, 1, 1, '#333'); P(9, 12, 1, 3, gd); P(10, 15, 1, 4, gd); P(10, 19, 3, 2, gd); P(12, 18, 2, 1, gs); P(11, 21, 2, 1, gs); P(9, 16, 1, 1, gs); }
  if (A === 'tray') { P(12, 7, 6, 1, '#c9c9d0'); P(13, 5, 1, 2, '#d8902a'); P(15, 5, 1, 2, '#f2ede2'); P(16, 4, 1, 3, '#c0262a'); }
  if (A === 'cigLip') P(10, 10, 2, 1, '#f2ede2');
  if (A === 'drinkHold') { P(14, 19, 2, 3, '#ff5fa2'); P(14, 19, 2, 1, '#ffd0e6'); P(16, 17, 1, 3, '#5fd39a'); P(15, 22, 1, 1, '#f2ede2'); }
  if (A === 'drinkMouth') { P(10, 8, 2, 3, '#ff5fa2'); P(10, 8, 2, 1, '#ffd0e6'); P(12, 6, 1, 3, '#5fd39a'); }
}
