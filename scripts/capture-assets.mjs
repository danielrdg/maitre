// Renders the README art from the lounge's own code: the banner, the demo GIF, the state
// sheet, one sprite per README feature, the favicon and the app icons.
// Needs Chrome or Chromium (CHROME_PATH overrides the lookup) and ffmpeg. Run `npm run assets`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOUNGE = join(ROOT, 'lounge');
const OUT = join(ROOT, 'docs', 'assets');
const GIF_FRAMES = 80, GIF_FPS = 12.5, GIF_WIDTH = 960, GIF_MAX_BYTES = 8 * 1024 * 1024, WARMUP_MS = 15000;

class CaptureError extends Error {}

function onPath(cmd) {
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : null;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    const p = join(dir, cmd);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

function findChrome() {
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    throw new CaptureError(`CHROME_PATH points to ${process.env.CHROME_PATH}, which does not exist.`);
  }
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const p = onPath(c);
    if (p) return p;
  }
  throw new CaptureError('Chrome or Chromium not found. Install google-chrome or chromium, or set CHROME_PATH.');
}

function checkFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) throw new CaptureError('ffmpeg not found on PATH. Install it (for example `sudo apt install ffmpeg`).');
}

async function loadServer() {
  const built = join(ROOT, 'dist', 'src', 'lounge-server.js');
  if (!existsSync(built)) throw new CaptureError('dist/ is missing. Run `npm run build` first.');
  return (await import(pathToFileURL(built).href)).startLoungeServer;
}

const save = (file, dataUrl) => {
  writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  console.log(`  ${file.slice(ROOT.length + 1)}  ${statSync(file).size} bytes`);
};
const pngSize = file => { const b = readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

// Runs in the page. Sets window.__art with the canvas renderers; every module comes from the lounge.
async function installArt() {
  const imp = p => import(new URL(p, location.href).href);
  const [{ buildSprite }, { poseFor, npcPose }, { DEMO_CAST, NPCS }, { drawBadge }, { STATE_KEYS }, { mascotGrid }] = await Promise.all([
    imp('js/sprites.js'), imp('js/agents.js'), imp('js/demo.js'), imp('js/scene.js'), imp('js/i18n.js'), imp('js/icon.js'),
  ]);
  const castLook = state => DEMO_CAST.find(e => e[1] === state)[2];
  const npc = kind => NPCS.find(n => n.kind === kind);
  // Times picked so each state shows its signature pose (no blink, the drink or cigarette visible).
  const STATE_T = { queue: 3, coffee: 3, work: 1, slot: 0.3, smoke: 1.5, visitor: 0.5, boss: 0.5, blocked: 0.5, ready: 3, whisky: 3, dance: 0.3, sleep: 0.5 };
  const agentPose = (state, t = STATE_T[state]) => poseFor({ state, off: 0, habit: 'none', walking: false, dir: 1 }, t);
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  // Draws one figure with its feet at (cx, feet): sprite, then what the scene adds around it.
  function figure(g, look, p, cx, feet, extra = {}) {
    const R = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w, h); };
    const x0 = Math.round(cx - 9), y0 = feet - 31 + (p.bob || 0), o = [x0, y0];
    if (extra.shadow !== false) { R(cx - 6, feet, 12, 1, 'rgba(0,0,0,.35)'); R(cx - 4, feet + 1, 8, 1, 'rgba(0,0,0,.22)'); }
    if (p.pose.legs === 'sit' && extra.stool !== false) {
      R(x0 + 3, y0 + 27, 10, 2, '#a3221b'); R(x0 + 3, y0 + 27, 10, 1, '#d04a40'); R(x0 + 4, y0 + 29, 1, 3, '#5a3320'); R(x0 + 11, y0 + 29, 1, 3, '#5a3320');
    }
    g.drawImage(buildSprite(look, p.pose), x0, y0);
    if (p.ember) R(x0 + p.ember[0], y0 + p.ember[1], 1, 1, '#ff7a1a');
    if (extra.smoke && p.ember) {
      const [ex, ey] = [x0 + p.ember[0], y0 + p.ember[1]];
      for (let i = 0; i < 9; i++) { const k = i / 9; g.fillStyle = `rgba(228,222,212,${(0.55 - k * 0.45).toFixed(2)})`;
        g.fillRect(Math.round(ex + Math.sin(i * 1.3) * 1.5 + k * 3), Math.round(ey - 2 - i * 1.6), 1 + (i > 5), 1 + (i > 5)); }
    }
    if (p.steam) {
      const [sx, sy] = [x0 + p.steam[0], y0 + p.steam[1]];
      for (let i = 0; i < 4; i++) { g.fillStyle = `rgba(228,222,212,${(0.4 - i * 0.08).toFixed(2)})`; g.fillRect(sx + (i % 2), sy - 2 - i * 2, 1, 1); }
    }
    if (extra.zz) { g.fillStyle = '#f4e4b0'; const x = x0 + 13, y = y0 + 1;
      g.fillRect(x, y, 4, 1); g.fillRect(x + 2, y + 1, 1, 1); g.fillRect(x + 1, y + 2, 1, 1); g.fillRect(x, y + 3, 4, 1); }
    if (extra.badge) drawBadge(g, o, extra.badge);
    return o;
  }
  const EXTRA = { smoke: { smoke: true }, boss: { smoke: true }, blocked: { badge: 'alert' }, ready: { badge: 'check' }, sleep: { zz: true } };

  // Pixel text: drawn on its own layer, then thresholded so no edge is anti-aliased.
  function pixelText(g, text, cx, y, color) {
    const layer = canvas(g.canvas.width, 16), lg = layer.getContext('2d');
    lg.font = '8px Silkscreen'; lg.textBaseline = 'top'; lg.fillStyle = color;
    // whole-pixel origin: a half-pixel offset would threshold into double-width strokes
    lg.fillText(text, Math.round(cx - lg.measureText(text).width / 2), 2);
    const img = lg.getImageData(0, 0, layer.width, layer.height), d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 110 ? 255 : 0;
    lg.putImageData(img, 0, 0);
    g.drawImage(layer, 0, y - 2);
  }

  const scaled = (src, s) => {
    const c = canvas(src.width * s, src.height * s), g = c.getContext('2d');
    g.imageSmoothingEnabled = false; g.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  };

  window.__art = {
    states(labels) {
      const keys = STATE_KEYS.filter(k => k !== 'exit');
      const TW = 48, TH = 64, GAP = 2, COLS = 6, rows = Math.ceil(keys.length / COLS);
      const c = canvas(COLS * TW + (COLS + 1) * GAP, rows * TH + (rows + 1) * GAP), g = c.getContext('2d');
      g.fillStyle = '#140b08'; g.fillRect(0, 0, c.width, c.height);
      keys.forEach((state, i) => {
        const x = GAP + (i % COLS) * (TW + GAP), y = GAP + Math.floor(i / COLS) * (TH + GAP);
        g.fillStyle = '#8a6420'; g.fillRect(x, y, TW, TH);
        g.fillStyle = '#3a130f'; g.fillRect(x + 1, y + 1, TW - 2, TH - 2);
        g.fillStyle = '#24100b'; g.fillRect(x + 1, y + 44, TW - 2, TH - 45);
        g.fillStyle = '#c89a3c'; g.fillRect(x + 1, y + 44, TW - 2, 1);
        // long hair is drawn over raised arms, so the dancer gets a bun here to show the dance
        const look = state === 'dance' ? { ...castLook(state), hs: 'bun' } : castLook(state);
        figure(g, look, agentPose(state), x + TW / 2, y + 47, EXTRA[state] || {});
        pixelText(g, labels[state], x + TW / 2, y + 54, '#ffd45c');
      });
      return { png: scaled(c, 4), count: keys.length };
    },
    sprite(spec) {
      const extra = spec.npc ? {} : EXTRA[spec.state] || {};
      const head = extra.badge || extra.zz ? 12 : 0;
      const c = canvas(18, 34 + head), g = c.getContext('2d');
      const p = spec.npc ? npcPose({ ...npc(spec.npc), dir: 1 }, 0.5, spec.ring ? 1 : 0, null) : agentPose(spec.state);
      const look = spec.npc ? npc(spec.npc).look : castLook(spec.state);
      figure(g, look, p, 9, 31 + head, { ...extra, shadow: false });
      return scaled(c, 4);
    },
    icon(size) {
      const grid = mascotGrid(), s = size / grid.length, c = canvas(size, size), g = c.getContext('2d');
      grid.forEach((row, y) => row.forEach((col, x) => { if (col) { g.fillStyle = col; g.fillRect(x * s, y * s, s, s); } }));
      return c.toDataURL('image/png');
    },
  };
}

const STATE_LABELS = {
  queue: 'queued', coffee: 'coffee', work: 'cards', slot: 'slots', smoke: 'smoking', visitor: 'visitor',
  boss: 'advisor', blocked: 'the bell', ready: 'ready', whisky: 'whisky', dance: 'dancing', sleep: 'napping',
};

// One sprite per row of the README Features table, in the same order.
const FEATURE_SPRITES = [
  ['cards', { state: 'work' }],
  ['slots', { state: 'slot' }],
  ['musician', { npc: 'sax' }],
  ['bell', { state: 'blocked' }],
  ['ready', { state: 'ready' }],
  ['reception', { npc: 'maitre', ring: true }],
  ['routing', { state: 'boss' }],
  ['doorman', { npc: 'bouncer' }],
  ['janitor', { npc: 'waiter' }],
  ['building', { npc: 'barman' }],
  ['answer', { state: 'coffee' }],
];

async function fontsReady(page) {
  await page.evaluate(async () => {
    await Promise.all([document.fonts.load('700 16px "Pixelify Sans"'), document.fonts.load('8px Silkscreen')]);
    await document.fonts.ready;
  });
}

async function captureBanner(page, base) {
  await page.setViewport({ width: 1280, height: 320, deviceScaleFactor: 1 });
  await page.goto(`${base}banner.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 15000 });
  await fontsReady(page);
  const file = join(OUT, 'banner.png');
  await (await page.$('#banner')).screenshot({ path: file });
  const [w, h] = pngSize(file);
  if (w !== 1280 || h !== 320) throw new CaptureError(`banner.png is ${w}x${h}, expected 1280x320`);
  console.log(`  docs/assets/banner.png  ${statSync(file).size} bytes`);
}

async function captureArt(page) {
  await page.evaluate(installArt);
  await fontsReady(page);
  const states = await page.evaluate(labels => window.__art.states(labels), STATE_LABELS);
  if (states.count !== 12) throw new CaptureError(`states.png has ${states.count} states, expected 12`);
  save(join(OUT, 'states.png'), states.png);
  mkdirSync(join(OUT, 'sprites'), { recursive: true });
  for (const [name, spec] of FEATURE_SPRITES) save(join(OUT, 'sprites', `${name}.png`), await page.evaluate(s => window.__art.sprite(s), spec));
  for (const size of [192, 512]) save(join(OUT, `icon-${size}.png`), await page.evaluate(s => window.__art.icon(s), size));
}

async function captureGif(page, base, tmp) {
  await page.setViewport({ width: 960, height: 540, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(() => { window.__maitreManualClock = true; });
  await page.goto(`${base}?demo=1&capture=1&seed=42`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__maitreCapture, { timeout: 15000 });
  await fontsReady(page);
  await page.evaluate(ms => window.__maitreCapture.advance(ms), WARMUP_MS);
  const stage = await page.$('#stage');
  const script = { 2: c => c.spin(0), 10: c => c.act('merge'), 34: c => c.act('block'), 50: c => c.act('newRoom') };
  for (let i = 0; i < GIF_FRAMES; i++) {
    if (script[i]) await page.evaluate(`(${script[i]})(window.__maitreCapture)`);
    await stage.screenshot({ path: join(tmp, `f${String(i).padStart(3, '0')}.png`) });
    await page.evaluate(ms => window.__maitreCapture.advance(ms), 1000 / GIF_FPS);
  }
  const file = join(OUT, 'lounge.gif');
  const vf = `scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(GIF_FPS), '-i', join(tmp, 'f%03d.png'), '-vf', vf, '-loop', '0', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new CaptureError(`ffmpeg failed: ${r.stderr || r.error}`);
  const bytes = statSync(file).size, width = readFileSync(file).readUInt16LE(6);
  if (width !== GIF_WIDTH) throw new CaptureError(`lounge.gif is ${width} px wide, expected ${GIF_WIDTH}`);
  if (bytes > GIF_MAX_BYTES) throw new CaptureError(`lounge.gif is ${bytes} bytes, over the 8 MB budget`);
  console.log(`  docs/assets/lounge.gif  ${bytes} bytes, ${GIF_FRAMES} frames @ ${GIF_FPS} fps`);
}

async function main() {
  const chrome = findChrome();
  checkFfmpeg();
  const startLoungeServer = await loadServer();
  const { default: puppeteer } = await import('puppeteer-core');
  const { mascotSvg } = await import('./favicon.mjs');

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(LOUNGE, 'favicon.svg'), mascotSvg());
  console.log('  lounge/favicon.svg');

  const tmp = mkdtempSync(join(tmpdir(), 'maitre-capture-'));
  let server = null, browser = null;
  try {
    server = await startLoungeServer({ root: LOUNGE, port: 0, token: randomBytes(16).toString('hex') });
    const origin = new URL(server.url).origin;
    const base = `${origin}/`;
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--mute-audio'] });
    const page = await browser.newPage();
    const strays = [];
    page.on('request', req => { const u = req.url(); if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) strays.push(u); });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    const checkErrors = () => { if (errors.length) throw new CaptureError(`page error: ${errors.join('; ')}`); };
    await page.goto(server.url, { waitUntil: 'load' }); // sets the access cookie

    await captureBanner(page, base); checkErrors();
    await captureArt(page); checkErrors();
    await captureGif(page, base, tmp); checkErrors();
    if (strays.length) throw new CaptureError(`the pages requested non-local URLs: ${strays.join(', ')}`);
  } finally {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(`capture-assets: ${err instanceof CaptureError ? err.message : err.stack || err}`);
  process.exit(1);
});
