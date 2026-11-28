import { t, normalizeLang } from './i18n.js';
import { clampDt } from './timing.js';
import { W, H, drawStatic } from './scene-static.js';
import { renderFrame, portrait, doorOpen } from './scene.js';
import { buildFacade, drawFacade } from './scene-facade.js';
import { buildLobby, drawLobby } from './scene-lobby.js';
import { THEMES, themeOf } from './themes.js';
import { go, rehome, stateAfterAnswer, STACK_DX } from './agents.js';
import { startSpin, isSpinning } from './slots.js';
import { createSfx } from './sfx.js';
import { panelModel, renderPanel, musicMenuModel, renderMusicMenu, appendMarked } from './panel.js';
import { MusicController } from './music.js';
import { hudModel, renderHud, renderHelp, viewsModel, renderViews, chipModel, chipText, themeButtonModel, tagRise } from './hud.js';
import { STEPS, demoFloors } from './demo.js';
import { FLOOR, LOBBY } from './places.js';
import { defaultView } from './building.js';
import { createNav, show, rideTo as navRide, stepNav, landing, follow, applyFloors, clampScroll, liftHere, floorButton, floorOf, musicOfView, userActs } from './views.js';
import { STEP, makeRngs, createWorld, stepWorld, ringNow, demoActions } from './sim.js';
import { createLiveCast, createBell, titleFor, LiveSource } from './live.js';
import { receptionSession, openTerminal, wakeRoom, loungePlacement } from './reception.js';
import { saveFloorTheme, themeSwitch, withSavedTheme } from './floors-api.js';

// ?capture=1 is for README art: no overlays, no sound, and a clock that counts
// simulation steps instead of wall time. A script that sets window.__maitreManualClock
// before boot drives it frame by frame through window.__maitreCapture. It draws the
// single-room lounge; the live lounge and the demo are the building, one view at a time.
export function boot(doc = document) {
  const win = doc.defaultView;
  const params = new URLSearchParams(win.location.search);
  const lang = normalizeLang(params.get('lang') || 'en');
  const demo = params.get('demo') === '1';
  const capture = params.get('capture') === '1';
  const live = !demo && !capture;
  const theme = demo ? themeOf(params.get('theme')) : THEMES.hall;
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
  const stage = $('stage'), tip = $('tip'), panel = $('panel'), hint = $('hint'), neon = $('neon'), neon2 = $('neon2'), musicMenu = $('music');
  const viewsEl = $('views'), chipEl = $('chip');
  stage.classList.toggle('capture', capture);
  const makeCanvas = () => doc.createElement('canvas');
  const pct = (v, total) => `${v / total * 100}%`;
  const at = (el, [x, y]) => { el.style.display = ''; el.style.left = pct(x, W); el.style.top = pct(y, H); };

  // The demo is a building of made-up projects with floors of its own; the live lounge gets its floors from the server.
  const building = !capture;
  const world = createWorld({ demo, rng, fxRng, ...(building ? { floors: demo ? demoFloors() : [] } : {}) });
  const { agents } = world;
  let floors = world.floors ?? [];

  // Backgrounds, painted once each: the single room, a floor per theme, the lobby, the facade per floor count.
  const paint = (fn) => { const c = makeCanvas(); c.width = W; c.height = H; fn(c.getContext('2d')); return c; };
  const bgs = new Map();
  const cached = (key, make) => { if (!bgs.has(key)) bgs.set(key, make()); return bgs.get(key); };
  const classicBg = () => cached('classic', () => paint(g => drawStatic(g, theme)));
  const floorBg = th => cached(`floor:${th.id}`, () => paint(g => drawStatic(g, th, { landing: true })));
  const lobbyBg = () => cached('lobby', () => buildLobby(makeCanvas));
  const facadeBg = n => cached(`facade:${n}`, () => buildFacade(makeCanvas, n));
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

  // Name tags for the agents on screen. In the lobby the rooms from every floor meet, so they carry their project.
  function placeTags(shown = agents, withProject = false) {
    let q = 0;
    const on = new Set(shown);
    for (const a of agents) {
      const el = tagFor(a);
      if (!on.has(a)) { el.className = 'tag hide'; continue; }
      if (a.state === 'queue' && !a.walking) { el.className = 'tag hide'; q++; continue; }
      if (!showNames || a.state === 'exit') { el.className = 'tag hide'; continue; }
      const alert = a.state === 'blocked' && !a.walking;
      const name = withProject && a.info?.project && (a.state === 'blocked' || a.state === 'smoke') ? `${a.label} · ${a.info.project}` : a.label;
      el.className = 'tag' + (alert ? ' alert' : a.state === 'boss' ? ' gold' : '');
      el.textContent = alert ? tr('tag.needsYou', { name }) : name;
      const stag = tagRise(a, withProject);
      el.style.left = pct(a.x, W); el.style.top = pct(a.y - 33 - stag - STACK_DX * (a.tier || 0), H);
    }
    queueTag.textContent = tr(q === 1 ? 'queue.one' : 'queue.many', { n: q });
    queueTag.style.left = pct(FLOOR.queueTag[0], W); queueTag.style.top = pct(FLOOR.queueTag[1], H);
    queueTag.style.display = q && showNames ? '' : 'none';
  }

  // Scene labels (floor names, the list of floors), keyed so each keeps its element; unused ones hide.
  const labels = new Map();
  let labelled = new Set();
  function label({ key, x, y, text, sub = null, cls = '' }) {
    let el = labels.get(key);
    if (!el) { el = doc.createElement('div'); stage.appendChild(el); labels.set(key, el); }
    const want = `${text}\n${sub ?? ''}`;
    if (el.dataset.text !== want) {
      el.dataset.text = want;
      el.replaceChildren(text);
      if (sub) { const sm = doc.createElement('small'); sm.textContent = sub; el.append(sm); }
    }
    el.className = `tag ${cls}`;
    at(el, [x, y]);
    labelled.add(key);
  }
  function flushLabels() {
    for (const [k, el] of labels) if (!labelled.has(k)) el.style.display = 'none';
    labelled = new Set();
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

  // ---------- the building: views, the lift, the chip ----------
  const nav = createNav(floors, building ? (demo ? defaultView(floors) : { view: 'lobby' }) : { view: 'classic' });
  // When lift doors last opened at a level, by its key: the user's arrival or an agent stepping in or out.
  const doorsAt = new Map();
  let carOpenAt = -9;
  const placeKey = p => (p === 'lobby' ? 'lobby' : p === 'terrace' ? 'roof' : floorOf(nav, p?.slice(6))?.floor);

  function setView(v) {
    show(nav, v);
    world.here = v.view === 'floor' ? `floor:${v.project}` : null;
    world.hitboxes = [];
    world.particles.parts.length = 0; world.particles.tableCards.length = 0;
    tip.style.display = 'none';
    closePanel(); reception?.close();
    if (v.view === 'lobby') reception?.resume();
    themes.seen(v);
    syncViews();
    followTheme();
  }

  // The musician's default follows the theme of the view; the facade keeps what plays (see MusicController for hand picks).
  const followTheme = () => {
    if (!building) return;
    music.setDefault(musicOfView(nav));
    if (musicMenu.style.display === 'block') openMusic();
  };

  // Clicking a floor, a lift button or a row in the list rides the car there on the facade, then opens the view.
  function rideTo(key, then = null) {
    const wasFacade = nav.view.view === 'facade';
    if (!navRide(nav, key, then)) return;
    if (!wasFacade) setView(nav.view);
    syncViews();
  }
  function arrived(token, tNow) {
    carOpenAt = tNow; sfx.lift();
    syncViews();
    if (!token) return;
    win.setTimeout(() => {
      const v = landing(nav, token);
      if (!v) return;
      doorsAt.set(token.key, nowSec());
      setView(v);
      token.then?.();
    }, 650);
  }

  // A floor list change: everyone walks to where they now belong; the navigation decides whether the view changes.
  function onFloors(list) {
    floors = list; world.floors = list;
    rehome(world);
    const v = applyFloors(nav, list, { hold: reception?.engaged() ?? false });
    if (v) setView(v);
    syncViews();
    followTheme();
  }

  // The floor's theme button saves the next theme; the floor repaints from the `floors` event that follows,
  // or from the answer when it comes first. The demo has no server: it changes the theme on the page only.
  const themes = themeSwitch({
    save: demo ? async (project, theme) => ({ ok: true, floor: { ...floorOf(nav, project), theme } })
      : (project, theme) => saveFloorTheme(project, theme, undefined, lang),
  });
  async function cycleTheme(project) {
    const pending = themes.cycle(floors, project);
    syncViews();
    const saved = await pending;
    if (saved) { const next = withSavedTheme(floors, saved); if (next) onFloors(next); }
    syncViews();
  }

  let viewEls = null;
  function syncViews() {
    if (!building) return;
    const shown = nav.view.view === 'floor' ? floorOf(nav, nav.view.project) : null;
    viewEls = renderViews(viewsEl, viewsModel(floors, nav.view, liftHere(nav), themeButtonModel(shown, themes, lang), lang), lang);
    viewEls.theme?.addEventListener('click', () => { arm(); sfx.pop(); cycleTheme(shown.project); });
    for (const [v, b] of Object.entries(viewEls.views)) b.addEventListener('click', () => {
      arm(); nav.userMoved = true;
      const to = v === 'floor' ? floorButton(nav) : { view: v };
      if (to) setView(to);
    });
    for (const { key, button } of viewEls.lift) button.addEventListener('click', () => { arm(); sfx.pop(); rideTo(key); });
  }

  // The chip: a room needs you. Clicking it rides to the lobby and opens that room's panel.
  let chipFor = null;
  function updateChip(tNow) {
    const m = building ? chipModel(agents) : null;
    chipFor = m?.agent ?? null;
    if (!m) { chipEl.style.display = 'none'; return; }
    const text = chipText(m, lang);
    if (chipEl.dataset.text !== text) {
      chipEl.dataset.text = text;
      const bang = doc.createElement('b'); bang.textContent = '!';
      chipEl.replaceChildren(bang, text);
    }
    chipEl.style.display = 'block';
    chipEl.classList.toggle('blink', (tNow % .9) >= .6);
  }
  chipEl.addEventListener('click', e => {
    e.stopPropagation(); arm();
    const a = chipFor;
    if (!a) return;
    sfx.pop();
    if (nav.view.view === 'lobby') openPanel(a);
    else rideTo('lobby', () => { if (agents.includes(a)) openPanel(a); });
  });

  const openAt = (key, tNow) => {
    let since = Infinity;
    if (doorsAt.has(key)) since = tNow - doorsAt.get(key);
    for (const a of agents) if (a.lift && placeKey(a.lift.place) === key) since = Math.min(since, tNow - a.lift.at);
    return doorOpen(since);
  };
  const hide = el => { el.style.display = 'none'; };

  function draw(tNow) {
    let neonOn = true;
    if (nav.view.view === 'classic') {
      neonOn = renderFrame(ctx, classicBg(), world, tNow, theme);
      placeTags();
    } else if (nav.view.view === 'floor') {
      const f = floorOf(nav, nav.view.project), th = themeOf(f?.theme), place = `floor:${nav.view.project}`;
      const here = agents.filter(a => a.place === place);
      renderFrame(ctx, floorBg(th), world, tNow, th, { agents: here, npcs: floorNpcs, open: openAt(f?.floor, tNow) });
      placeTags(here);
      if (f) label({ key: 'flname', x: 44, y: 100, cls: 'gold big', text: tr('floor.title', { n: f.floor, project: f.project }) });
      const away = agents.filter(a => a.state === 'blocked' && a.info?.project === nav.view.project && a.place !== place);
      if (away.length) label({ key: 'flstuck', x: 6, y: 236, cls: 'l alert', text: tr('floor.wentDown', { names: away.map(a => a.label).join(', ') }) });
    } else if (nav.view.view === 'lobby') {
      const here = agents.filter(a => a.place === 'lobby' || a.place === 'terrace');
      const r = drawLobby(ctx, lobbyBg(), { t: tNow, world, floors, agents: here, npcs: lobbyNpcs, tr, doors: { lobby: openAt('lobby', tNow), terrace: openAt('roof', tNow) } });
      world.hitboxes = r.hitboxes;
      placeTags(here, true);
      r.tags.forEach(label);
      at(neon2, r.terraceNeon);
    } else {
      const r = drawFacade(ctx, facadeBg(floors.length), { t: tNow, frame: world.frame, floors, scroll: nav.scroll, lift: nav.lift, agents, tr, makeCanvas,
        npcs: { maitre: desk, bouncer: world.npcs.find(n => n.kind === 'bouncer') }, ringUntil: world.ringUntil, focus: nav.focus,
        particles: world.particles, carOpen: doorOpen(tNow - carOpenAt) });
      world.hitboxes = r.hitboxes;
      placeTags([]);
      r.tags.forEach(label);
      if (r.neon[1] > 0 && r.neon[1] < H) at(neon, r.neon); else hide(neon);
    }
    if (nav.view.view === 'classic') at(neon, FLOOR.neon);
    else if (nav.view.view === 'lobby') at(neon, LOBBY.neon);
    else if (nav.view.view === 'floor') hide(neon);
    if (nav.view.view !== 'lobby') hide(neon2);
    neon.style.opacity = neonOn ? 1 : 0.25;
    if (building) { flushLabels(); updateChip(tNow); }
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
    for (let i = 0; i < ticks; i++) {
      stepWorld(world, STEP, tNow, hooks);
      if (building) { const r = stepNav(nav, STEP); if (r.arrived) arrived(r.ride, tNow); }
    }
    if (building) follow(nav);
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
    const showReply = done => {
      box.style.display = '';
      say(done.view.balloon);
      if (done.view.closeAfterMs) closeTimer = win.setTimeout(close, done.view.closeAfterMs);
      else input.focus();
    };
    // A reply held while the lobby was out of sight is shown the next time the box opens.
    const open = () => { stopTimer(); const held = session.take(); if (held) showReply(held); else { box.style.display = ''; input.focus(); } };
    // A request in flight keeps its question id: the reply reopens the box.
    const close = () => {
      stopTimer(); box.style.display = 'none'; balloon?.(); balloon = null;
      if (!session.busy) session.reset();
    };
    input.addEventListener('keydown', async e => {
      stopTimer();
      userActs(nav);
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
      // The desk is in the lobby: a reply that lands after the user left is held until the lobby is back.
      if (building && nav.view.view !== 'lobby') { session.hold(done); return; }
      showReply(done);
    });
    return {
      open: () => { userActs(nav); open(); }, close, resume: () => { if (session.held) open(); },
      engaged: () => box.style.display !== 'none' || session.busy || !!session.held,
    };
  }
  const desk = world.npcs.find(n => n.kind === 'maitre');
  const reception = live && desk ? receptionBox(desk) : null;
  // In the building the maître and the doorman work the lobby; the floors keep the bar, the table and the music.
  const lobbyNpcs = world.npcs.filter(n => n.kind === 'maitre' || n.kind === 'bouncer');
  const floorNpcs = world.npcs.filter(n => !lobbyNpcs.includes(n));

  // ---------- interaction ----------
  const toCanvas = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
  function hitAt(x, y) {
    if (nav.view.view === 'classic' || nav.view.view === 'floor') for (const s of world.slots) if (x >= s.x + 24 && x <= s.x + 34 && y >= 146 && y <= 180) return { kind: 'lever', ref: s };
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
      : h.kind === 'level' || h.kind === 'call' ? tr('tip.level', { place: levelName(h.key) })
      : h.kind === 'view' ? tr(`view.${h.view}`)
      : tr('tip.agent', { name: h.ref.label, state: tr(h.ref.info?.parked ? 'state.parked' : `state.${h.ref.state}`) });
    tip.style.left = pct(x, W); tip.style.top = pct(y - 6, H);
  });
  cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  const levelName = key => (key === 'lobby' ? tr('lift.lobby') : key === 'roof' ? tr('lift.roof')
    : tr('lift.floor', { n: key, project: floors.find(f => f.floor === key)?.project ?? '' }));
  cv.addEventListener('wheel', e => {
    if (nav.view.view !== 'facade') return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
    nav.scroll = clampScroll(nav, nav.scroll - e.deltaY * px * 0.25);
  }, { passive: false });
  cv.addEventListener('click', e => {
    arm(); userActs(nav);
    const [x, y] = toCanvas(e); const h = hitAt(x, y);
    if (!h) return;
    if (h.kind === 'lever') { if (!isSpinning(h.ref)) { startSpin(h.ref, nowSec(), true, rng); sfx.thunk(); } return; }
    sfx.pop();
    if (h.kind === 'level' || h.kind === 'call') { rideTo(h.key); return; }
    if (h.kind === 'view') { nav.userMoved = true; setView({ view: h.view }); return; }
    if (h.kind === 'npc' && h.ref.kind === 'sax') { openMusic(); return; }
    if (h.kind === 'npc' && h.ref.kind === 'maitre' && reception) { reception.open(); return; }
    if (h.kind === 'npc') { popup(h.x + 9, h.y - 9, tr(`quip.${h.ref.kind}`), true); return; }
    openPanel(h.ref);
  });
  stage.addEventListener('click', arm);

  let panelFor = null;
  // Kept here, not in the panel DOM: a room event re-renders the panel and re-enables its button.
  let termError = null, termBusy = false;
  // A wake takes up to a minute: who is being woken, and the last answer, outlive a re-render too.
  let waking = null, woke = null;
  function closePanel() { panel.style.display = 'none'; panelFor = null; termError = null; woke = null; }
  async function wakeFor(a) {
    if (waking) return null;
    waking = a;
    let r;
    try { r = await wakeRoom(a.id, undefined, lang); } finally { waking = null; }
    woke = { agent: a, result: r };
    if (panelFor === a) openPanel(a);
    return r;
  }
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
      ...(live ? {
        onTerminal: () => terminalFor(a), terminalError: termError?.agent === a ? termError.message : null,
        onWake: () => wakeFor(a), waking: waking === a, wakeResult: woke?.agent === a ? woke.result : null,
      } : {}),
    });
    panel.style.display = 'block';
  }
  function answer(a, text) {
    sfx.send();
    delete a.info.block;
    a.info.steps = [...(a.info.steps || []), STEPS.answered(text)];
    go(world, a, stateAfterAnswer(agents, a, world.floors));
  }
  panel.addEventListener('click', e => e.stopPropagation());

  function closeMusic() { musicMenu.style.display = 'none'; }
  function openMusic() {
    renderMusicMenu(musicMenu, musicMenuModel(music.style, music.volume, lang), {
      onStyle: style => { music.pick(style); openMusic(); },
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
      { onClosed: () => { bell.disconnect(); refresh([]); }, onFloors }).start();
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
  doc.addEventListener('keydown', e => { if (e.key === 'Escape') { setDemoMenu(false); closeHelp(); closeMusic(); closePanel(); reception?.close(); } });

  const bSound = hud.sound;
  const soundLabel = () => { bSound.textContent = tr(sfx.on ? 'btn.sound.on' : 'btn.sound.off'); bSound.classList.toggle('off', !sfx.on); };
  soundLabel();
  bSound.addEventListener('click', () => { arm(); sfx.setOn(!sfx.on); soundLabel(); });

  const bNames = hud.names;
  const namesLabel = () => { bNames.textContent = tr(showNames ? 'btn.names.always' : 'btn.names.hover'); };
  namesLabel();
  bNames.addEventListener('click', () => { showNames = !showNames; namesLabel(); });

  if (building) setView(nav.view);

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
