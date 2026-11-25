import { WIN } from './scene-static.js';

// Particle physics is per simulation step (the loop runs it at a fixed 30 Hz).

export function createParticles(rng = Math.random) {
  const haze = [];
  for (let i = 0; i < 90; i++) {
    haze.push({ x: 90 + rng() * 480, y: 6 + rng() * 60, w: 12 + rng() * 26, h: 3 + rng() * 6, vx: (rng() - 0.5) * 0.08, a: 0.02 + rng() * 0.045 });
  }
  return { rng, parts: [], haze, tableCards: [] };
}

export function emitSmoke(ps, x, y, n, burst) {
  const { rng } = ps;
  for (let i = 0; i < n; i++) {
    ps.parts.push({ k: 'smoke', x: x + (rng() - 0.5) * (burst ? 3 : 0.6), y,
      vx: (rng() - 0.3) * (burst ? 0.35 : 0.08) + 0.04, vy: -(0.14 + rng() * (burst ? 0.25 : 0.12)), life: 0, max: 200 + rng() * 180 });
  }
}

export function emitFirework(ps) {
  const { rng } = ps;
  const x = WIN.x + 8 + rng() * 30, y = WIN.y + 14 + rng() * 60;
  const cols = ['#ff5fa2', '#ffd45c', '#5fd39a', '#5b9cf5', '#ffffff'];
  const c = cols[rng() * cols.length | 0];
  for (let i = 0; i < 26; i++) {
    const an = rng() * Math.PI * 2, sp = 0.4 + rng() * 0.9;
    ps.parts.push({ k: 'spark', x, y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, life: 0, max: 50 + rng() * 30, c });
  }
}

export function stepParticles(ps) {
  const { parts, rng, tableCards } = ps;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.life++;
    if (p.k === 'smoke' || p.k === 'ring' || p.k === 'steam') {
      p.x += p.vx + Math.sin((p.life + p.y) / 18) * 0.06; p.y += p.vy;
      if (p.y < 50) { p.vy *= 0.97; p.vx += (rng() - 0.5) * 0.04; }
    } else if (p.k === 'note') { p.x += Math.sin(p.life / 10) * 0.3 + 0.15; p.y -= 0.35; }
    else if (p.k === 'zz') { p.x += 0.12; p.y -= 0.22; }
    else if (p.k === 'coin' || p.k === 'spark') {
      p.vy += p.k === 'coin' ? 0.12 : 0.02; p.x += p.vx; p.y += p.vy;
      if (p.k === 'coin' && p.y > p.floor) { p.y = p.floor; p.vy *= -0.45; p.vx *= 0.7; }
    } else if (p.k === 'card') {
      const k = Math.min(1, p.life / 12);
      p.x = p.x0 + (p.x1 - p.x0) * k; p.y = p.y0 + (p.y1 - p.y0) * k - Math.sin(k * Math.PI) * 5;
      if (k >= 1) {
        tableCards.push({ x: p.x1, y: p.y1, red: rng() > 0.5 });
        if (tableCards.length > 14) tableCards.splice(0, 5);
        parts.splice(i, 1); continue;
      }
    }
    if (p.life > p.max) parts.splice(i, 1);
  }
  for (const h of ps.haze) { h.x += h.vx; if (h.x < 88) h.vx = Math.abs(h.vx); if (h.x > 570) h.vx = -Math.abs(h.vx); }
}

const NOTE = ['.##', '.#.', '.#.', '##.', '##.'];
const inWin = p => p.x >= WIN.x && p.x < WIN.x + WIN.w && p.y >= WIN.y && p.y < 168;

export function drawHaze(g, ps) {
  for (const h of ps.haze) {
    g.fillStyle = `rgba(214,206,192,${h.a})`;
    g.fillRect(Math.round(h.x), Math.round(h.y), Math.round(h.w), Math.round(h.h));
  }
}

export function drawParticles(g, ps) {
  for (const p of ps.parts) {
    const t = p.life / p.max;
    if (p.k === 'smoke' || p.k === 'steam') {
      const a = (t < 0.08 ? t / 0.08 : 1 - t) * (p.k === 'steam' ? 0.35 : 0.45); const sz = 1 + Math.floor(t * (p.k === 'steam' ? 2 : 4));
      g.fillStyle = `rgba(228,222,212,${a.toFixed(3)})`; g.fillRect(Math.round(p.x - sz / 2), Math.round(p.y - sz / 2), sz, sz);
    } else if (p.k === 'ring') {
      const a = (1 - t) * 0.6, r = 1 + Math.floor(t * 5), cx = Math.round(p.x), cy = Math.round(p.y); g.fillStyle = `rgba(228,222,212,${a})`;
      for (let k = 0; k < 12; k++) { const an = k / 12 * Math.PI * 2; g.fillRect(Math.round(cx + Math.cos(an) * r), Math.round(cy + Math.sin(an) * r * 0.6), 1, 1); }
    } else if (p.k === 'note') {
      g.fillStyle = `rgba(255,212,92,${1 - t})`;
      NOTE.forEach((row, ry) => [...row].forEach((ch, rx) => { if (ch === '#') g.fillRect(Math.round(p.x) + rx, Math.round(p.y) + ry, 1, 1); }));
    } else if (p.k === 'zz') {
      g.fillStyle = `rgba(244,228,176,${1 - t})`; const x = Math.round(p.x), y = Math.round(p.y);
      g.fillRect(x, y, 4, 1); g.fillRect(x + 2, y + 1, 1, 1); g.fillRect(x + 1, y + 2, 1, 1); g.fillRect(x, y + 3, 4, 1);
    } else if (p.k === 'coin') { g.fillStyle = p.life % 6 < 3 ? '#ffd45c' : '#c8961e'; g.fillRect(Math.round(p.x), Math.round(p.y), 2, 2); }
    else if (p.k === 'spark') { if (!inWin(p)) continue; g.fillStyle = p.c; g.globalAlpha = 1 - t; g.fillRect(Math.round(p.x), Math.round(p.y), 1, 1); g.globalAlpha = 1; }
    else if (p.k === 'card') {
      g.fillStyle = '#f2ede2'; g.fillRect(Math.round(p.x), Math.round(p.y), 3, 4);
      g.fillStyle = '#ffffff'; g.fillRect(Math.round(p.x), Math.round(p.y), 3, 1);
    }
  }
}

// Sparks drawn behind the terrace window frame, clipped to the glass.
export function drawFireworks(g, ps) {
  g.save(); g.beginPath(); g.rect(WIN.x, WIN.y, WIN.w, 148); g.clip();
  for (const p of ps.parts) {
    if (p.k !== 'spark') continue;
    g.globalAlpha = 1 - p.life / p.max; g.fillStyle = p.c; g.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
  }
  g.globalAlpha = 1; g.restore();
}
