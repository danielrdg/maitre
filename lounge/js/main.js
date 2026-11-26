import { t, normalizeLang } from './i18n.js';
import { clampDt } from './timing.js';
import { W, H, drawStatic } from './scene-static.js';
import { renderFrame, portrait } from './scene.js';
import { moveTo, stateAfterAnswer, STACK_DX } from './agents.js';
import { startSpin, isSpinning } from './slots.js';
import { createSfx } from './sfx.js';
import { panelModel, renderPanel, musicMenuModel, renderMusicMenu, appendMarked } from './panel.js';
import { MusicController } from './music.js';
import { hudModel, renderHud, renderHelp } from './hud.js';
import { STEPS } from './demo.js';
import { STEP, makeRngs, createWorld, stepWorld, ringNow, demoActions } from './sim.js';
import { createLiveCast, createBell, titleFor, LiveSource } from './live.js';
import { receptionSession, openTerminal, loungePlacement } from './reception.js';

// ?capture=1 is for README art: no overlays, no sound, and a clock that counts
// simulation steps instead of wall time. A script that sets window.__maitreManualClock
// before boot drives it frame by frame through window.__maitreCapture.
export function boot(doc = document) {
  const win = doc.defaultView;
  const params = new URLSearchParams(win.location.search);
  const lang = normalizeLang(params.get('lang') || 'en');
  const demo = params.get('demo') === '1';
  const capture = params.get('capture') === '1';
  const live = !demo && !capture;
  const manualClock = capture && win.__maitreManualClock === true;
  const { rng, fxRng } = makeRngs(params.get('seed'));
  const tr = (key, vars) => t(key, lang, vars);
  let simTime = 0;
  const nowSec = () => capture ? simTime : win.performance.now() / 1000;
  let timers = [];
  const later = (fn, sec) => { if (capture) timers.push({ at: simTime + sec, fn }); else win.setTimeout(fn, sec * 1000); };

  doc.documentElement.lang = lang;
  doc.title = tr('page.title');
  if (!capture) {
    try {
      const place = loungePlacement(win, win.screen);
      if (place) { win.resizeTo(place.w, place.h); win.moveTo(place.x, place.y); }
    } catch { /* an unplaced window still works */ }
  }
  for (const el of doc.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);

  const $ = id => doc.getElementById(id);
  const cv = $('lounge'), ctx = cv.getContext('2d');
  const stage = $('stage'), tip = $('tip'), panel = $('panel'), hint = $('hint'), neon = $('neon'), musicMenu = $('music');
  stage.classList.toggle('capture', capture);
  const makeCanvas = () => doc.createElement('canvas');
  const bg = makeCanvas(); bg.width = W; bg.height = H; drawStatic(bg.getContext('2d'));
  const pct = (v, total) => `${v / total * 100}%`;
  neon.style.left = pct(42, W); neon.style.top = pct(80, H);

  const world = createWorld({ demo, rng, fxRng });
  const { agents } = world;
  let audioCtx = null;
  const AC = win.AudioContext || win.webkitAudioContext;
  const makeAudio = () => (audioCtx ??= AC ? new AC() : null);
  const sfx = createSfx({ rng: fxRng, makeCtx: makeAudio });
  if (capture) sfx.setOn(false);
  const music = new MusicController(makeAudio);

  // ---------- HTML overlays ----------
  let showNames = true;
  const tags = new Map();
  const tagFor = a => {
    let el = tags.get(a.uid);
    if (!el) { el = doc.createElement('div'); el.className = 'tag'; stage.appendChild(el); tags.set(a.uid, el); }
    return el;
  };
  const queueTag = doc.createElement('div'); queueTag.className = 'tag dim'; stage.appendChild(queueTag);

  function placeTags() {
    let q = 0;
    for (const a of agents) {
      const el = tagFor(a);
      if (a.state === 'queue' && !a.walking) { el.className = 'tag hide'; q++; continue; }
      if (!showNames || a.state === 'exit') { el.className = 'tag hide'; continue; }
      const alert = a.state === 'blocked' && !a.walking;
      el.className = 'tag' + (alert ? ' alert' : a.state === 'boss' ? ' gold' : '');
      el.textContent = alert ? tr('tag.needsYou', { name: a.label }) : a.label;
      const stag = (a.state === 'work' && (a.spot % 2 || a.spot === 4)) || (a.state === 'smoke' && a.spot === 1) || (a.state === 'coffee' && a.spot === 1) || (a.state === 'dance' && a.spot === 1) || (a.state === 'ready' && !a.walking) ? 9 : 0;
      el.style.left = pct(a.x, W); el.style.top = pct(a.y - 33 - stag - STACK_DX * (a.tier || 0), H);
    }
    queueTag.textContent = tr(q === 1 ? 'queue.one' : 'queue.many', { n: q });
    queueTag.style.left = pct(40, W); queueTag.style.top = pct(262, H);
    queueTag.style.display = q && showNames ? '' : 'none';
  }

  // In capture mode the pop animation is scrubbed to simulation time instead of playing.
  // A held popup is a balloon that stays until the returned function removes it.
  const pops = new Set();
  function popup(x, y, text, small, hold = false) {
    const el = doc.createElement('div'); el.className = 'pop' + (small ? ' small' : '') + (hold ? ' say' : ''); el.textContent = text;
    el.style.left = pct(x, W); el.style.top = pct(y, H);
    stage.appendChild(el);
    if (hold) return () => el.remove();
    if (capture) { el.style.animationPlayState = 'paused'; el.dataset.born = String(simTime); pops.add(el); }
    later(() => { el.remove(); pops.delete(el); }, 1.9);
  }
  const scrubPops = () => { for (const el of pops) el.style.animationDelay = `${-(simTime - Number(el.dataset.born))}s`; };

  // ---------- simulation ----------
  const hooks = {
    sfx, later,
    popup: (x, y, key, small) => popup(x, y, tr(key), small),
    onGone: a => { tags.get(a.uid)?.remove(); tags.delete(a.uid); if (panelFor === a) closePanel(); },
  };
  const actions = demoActions(world, hooks);

  function draw(tNow) {
    const neonOn = renderFrame(ctx, bg, world, tNow);
    neon.style.opacity = neonOn ? 1 : 0.25;
    placeTags();
  }

  let last = null, acc = 0;
  function loop(ms) {
    const tNow = ms / 1000;
    let ticks = 0;
    if (last === null) ticks = 1;
    else {
      acc += clampDt(tNow - last);
      while (acc >= STEP && ticks < 2) { acc -= STEP; ticks++; }
      if (acc >= STEP) acc = 0;
    }
    last = tNow;
    world.beat = music.beatPos();
    for (let i = 0; i < ticks; i++) stepWorld(world, STEP, tNow, hooks);
    if (ticks) draw(tNow);
    win.requestAnimationFrame(loop);
  }

  // Capture clock: one step, one drawn frame, so frame-gated emitters never skip.
  function captureTick() {
    simTime += STEP;
    const due = timers.filter(x => x.at <= simTime); timers = timers.filter(x => x.at > simTime);
    due.forEach(x => x.fn());
    world.beat = null;
    stepWorld(world, STEP, simTime, hooks);
    draw(simTime);
    scrubPops();
  }
  let pending = 0;
  function advance(sec) {
    pending += sec;
    while (pending >= STEP - 1e-9) { pending -= STEP; captureTick(); }
  }
  let lastWall = null;
  function captureLoop(ms) {
    advance(lastWall === null ? STEP : clampDt(ms / 1000 - lastWall));
    lastWall = ms / 1000;
    win.requestAnimationFrame(captureLoop);
  }

  // ---------- reception: in a live lounge the maître takes requests ----------
  function receptionBox(npc) {
    const box = doc.createElement('div'); box.className = 'ask'; box.style.display = 'none';
    box.style.left = pct(npc.x, W); box.style.top = pct(npc.y - 38, H);
    const input = doc.createElement('input');
    input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = tr('reception.placeholder');
    input.setAttribute('aria-label', tr('npc.maitre'));
    box.append(input);
    stage.appendChild(box);
    const session = receptionSession({ lang });
    let balloon = null, closeTimer = null;
    const say = text => { balloon?.(); balloon = popup(npc.x, npc.y - 64, text, true, true); };
    const stopTimer = () => { win.clearTimeout(closeTimer); closeTimer = null; };
    const open = () => { stopTimer(); box.style.display = ''; input.focus(); };
    // A request in flight keeps its question id: the reply reopens the box.
    const close = () => {
      stopTimer(); box.style.display = 'none'; balloon?.(); balloon = null;
      if (!session.busy) session.reset();
    };
    input.addEventListener('keydown', async e => {
      stopTimer();
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (session.busy || !input.value.trim()) return;
      input.disabled = true;
      sfx.send();
      say(tr('reception.thinking'));
      const done = await session.submit(input.value);
      input.disabled = false;
      if (!done) return;
      if (done.kind !== 'error') input.value = '';
      box.style.display = '';
      say(done.view.balloon);
      if (done.view.closeAfterMs) closeTimer = win.setTimeout(close, done.view.closeAfterMs);
      else input.focus();
    });
    return { open, close };
  }
  const desk = world.npcs.find(n => n.kind === 'maitre');
  const reception = live && desk ? receptionBox(desk) : null;

  // ---------- interaction ----------
  const toCanvas = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
  function hitAt(x, y) {
    for (const s of world.slots) if (x >= s.x + 24 && x <= s.x + 34 && y >= 146 && y <= 180) return { kind: 'lever', ref: s };
    const hb = world.hitboxes;
    for (let i = hb.length - 1; i >= 0; i--) {
      const h = hb[i];
      if (x >= h.x + 2 && x <= h.x + h.w - 2 && y >= h.y + 1 && y <= h.y + h.h - 2) return h;
    }
    return null;
  }

  function arm() {
    if (capture) return;
    music.onGesture();
    if (!sfx.arm()) return;
    hint.style.display = 'none';
    if (agents.some(a => a.state === 'blocked')) ringNow(world, nowSec(), sfx);
  }

  cv.addEventListener('mousemove', e => {
    const [x, y] = toCanvas(e); const h = hitAt(x, y);
    cv.style.cursor = h ? 'pointer' : 'default';
    if (!h) { tip.style.display = 'none'; return; }
    tip.style.display = 'block';
    tip.textContent = h.kind === 'lever' ? tr('tip.lever')
      : h.kind === 'npc' ? tr(h.ref.kind === 'sax' ? 'tip.sax' : `npc.${h.ref.kind}`)
      : tr('tip.agent', { name: h.ref.label, state: tr(`state.${h.ref.state}`) });
    tip.style.left = pct(x, W); tip.style.top = pct(y - 6, H);
  });
  cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  cv.addEventListener('click', e => {
    arm();
    const [x, y] = toCanvas(e); const h = hitAt(x, y);
    if (!h) return;
    if (h.kind === 'lever') { if (!isSpinning(h.ref)) { startSpin(h.ref, nowSec(), true, rng); sfx.thunk(); } return; }
    sfx.pop();
    if (h.kind === 'npc' && h.ref.kind === 'sax') { openMusic(); return; }
    if (h.kind === 'npc' && h.ref.kind === 'maitre' && reception) { reception.open(); return; }
    if (h.kind === 'npc') { popup(h.ref.x, h.ref.y - 40, tr(`quip.${h.ref.kind}`), true); return; }
    openPanel(h.ref);
  });
  stage.addEventListener('click', arm);

  let panelFor = null;
  // Kept here, not in the panel DOM: a room event re-renders the panel and re-enables its button.
  let termError = null, termBusy = false;
  function closePanel() { panel.style.display = 'none'; panelFor = null; termError = null; }
  async function terminalFor(a) {
    if (termBusy) return termError?.agent === a ? termError.message : null;
    termBusy = true;
    let r;
    try { r = await openTerminal(a.id, undefined, lang); } finally { termBusy = false; }
    termError = r.ok ? null : { agent: a, message: r.message };
    if (termError && panelFor === a) openPanel(a);
    return r.ok ? null : r.message;
  }
  function openPanel(a) {
    panelFor = a;
    renderPanel(panel, panelModel(a, lang), ({ text }) => answer(a, text), {
      lang, portrait: portrait(a, makeCanvas), onClose: closePanel,
      ...(live ? { onTerminal: () => terminalFor(a), terminalError: termError?.agent === a ? termError.message : null } : {}),
    });
    panel.style.display = 'block';
  }
  function answer(a, text) {
    sfx.send();
    delete a.info.block;
    a.info.steps = [...(a.info.steps || []), STEPS.answered(text)];
    moveTo(agents, a, stateAfterAnswer(agents, a));
  }
  panel.addEventListener('click', e => e.stopPropagation());

  function closeMusic() { musicMenu.style.display = 'none'; }
  function openMusic() {
    renderMusicMenu(musicMenu, musicMenuModel(music.style, music.volume, lang), {
      onStyle: style => { music.setStyle(style); openMusic(); },
      onVolume: v => music.setVolume(v),
      onClose: closeMusic,
    });
    musicMenu.style.display = 'block';
  }
  musicMenu.addEventListener('click', e => { e.stopPropagation(); arm(); });

  // ---------- live rooms ----------
  function startLive() {
    const cast = createLiveCast(world);
    // Shares world.ding with the render loop, so a visible tab never rings twice.
    const bell = createBell({ ding: world.ding, ring: () => { world.ringUntil = nowSec() + 1; sfx.ding(); } });
    win.setInterval(() => bell.tick(nowSec()), 1000);
    const empty = doc.createElement('div'); empty.className = 'empty'; empty.style.display = 'none';
    appendMarked(doc, empty, tr('live.empty'));
    stage.appendChild(empty);
    const offline = doc.createElement('div'); offline.className = 'notice'; offline.style.display = 'none';
    offline.textContent = tr('live.disconnected');
    stage.appendChild(offline);
    const refresh = touched => {
      empty.style.display = cast.ids().length || bell.disconnected ? 'none' : '';
      offline.style.display = bell.disconnected ? '' : 'none';
      doc.title = titleFor(bell.count, lang, { disconnected: bell.disconnected });
      if (panelFor && touched.includes(panelFor)) openPanel(panelFor);
    };
    new LiveSource('api/events',
      rooms => { bell.snapshot(rooms, nowSec()); refresh(cast.snapshot(rooms)); },
      room => { bell.room(room, nowSec()); refresh(cast.room(room)); },
      { onClosed: () => { bell.disconnect(); refresh([]); } }).start();
  }

  // ---------- corner controls ----------
  const hud = renderHud($('hud'), hudModel({ demo }), lang);
  const helpEl = $('help');
  const closeHelp = () => { helpEl.style.display = 'none'; };
  hud.help.addEventListener('click', () => {
    if (helpEl.style.display === 'block') { closeHelp(); return; }
    renderHelp(helpEl, { lang, onClose: closeHelp });
    helpEl.style.display = 'block';
  });
  const setDemoMenu = open => {
    if (!hud.demo) return;
    hud.demoMenu.classList.toggle('open', open);
    hud.demo.setAttribute('aria-expanded', String(open));
  };
  if (hud.demo) hud.demo.addEventListener('click', () => setDemoMenu(!hud.demoMenu.classList.contains('open')));
  for (const b of Object.values(hud.actions)) b.addEventListener('click', () => setDemoMenu(false));
  doc.addEventListener('click', e => {
    if (hud.demo && !hud.demo.parentNode.contains(e.target)) setDemoMenu(false);
    if (!helpEl.contains(e.target) && !hud.help.contains(e.target)) closeHelp();
  });
  doc.addEventListener('keydown', e => { if (e.key === 'Escape') { setDemoMenu(false); closeHelp(); closeMusic(); reception?.close(); } });

  const bSound = hud.sound;
  const soundLabel = () => { bSound.textContent = tr(sfx.on ? 'btn.sound.on' : 'btn.sound.off'); bSound.classList.toggle('off', !sfx.on); };
  soundLabel();
  bSound.addEventListener('click', () => { arm(); sfx.setOn(!sfx.on); soundLabel(); });

  const bNames = hud.names;
  const namesLabel = () => { bNames.textContent = tr(showNames ? 'btn.names.always' : 'btn.names.hover'); };
  namesLabel();
  bNames.addEventListener('click', () => { showNames = !showNames; namesLabel(); });

  if (capture) {
    win.__maitreCapture = {
      advance: ms => advance(ms / 1000),
      act: name => { if (demo) actions[name](nowSec()); },
      spin: i => { const s = world.slots[i]; if (s && !isSpinning(s)) startSpin(s, nowSec(), true, rng); },
    };
    if (manualClock) captureTick(); else win.requestAnimationFrame(captureLoop);
  } else win.requestAnimationFrame(loop);
  if (live) startLive();
  if (!demo) return;

  hud.actions.block.addEventListener('click', () => { arm(); actions.block(nowSec()); });
  hud.actions.merge.addEventListener('click', () => { arm(); actions.merge(nowSec()); });
  hud.actions.newRoom.addEventListener('click', () => { arm(); actions.newRoom(nowSec()); });
}
