import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jazzBar, houseBar, JAZZ, HOUSE, MusicController } from '../../lounge/js/music.js';
import { mulberry32 } from '../../lounge/js/rng.js';

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const BARS = [0, 1, 2, 3, 4, 7, 13, 42];

test('JAZZ and HOUSE expose bpm and progression', () => {
  assert.deepEqual(JAZZ, { bpm: 104, progression: ['Dm7', 'G7', 'Cmaj7', 'A7'] });
  assert.deepEqual(HOUSE, { bpm: 124, progression: ['Am7', 'Fmaj7', 'C', 'G'] });
});

test('jazzBar: events stay inside the bar, walking bass on every beat, swung ride', () => {
  for (const seed of [1, 2, 3, 99]) {
    const rng = mulberry32(seed);
    for (const bar of BARS) {
      const evs = jazzBar(bar, rng);
      assert.ok(evs.length > 0);
      for (const e of evs) {
        assert.ok(e.at >= 0 && e.at < 4, `bar ${bar}: at ${e.at}`);
        assert.ok(e.dur > 0 && e.vel > 0 && e.vel <= 1, `bar ${bar}: dur/vel`);
      }
      const bass = evs.filter(e => e.voice === 'bass');
      assert.deepEqual(bass.map(e => e.at), [0, 1, 2, 3], `bar ${bar}: walking bass`);
      for (const b of bass) assert.ok(b.midi >= 36 && b.midi <= 55, `bar ${bar}: bass midi ${b.midi}`);
      const ride = evs.filter(e => e.voice === 'ride');
      assert.ok(ride.some(e => near(e.at % 1, 2 / 3)), `bar ${bar}: swung ride`);
    }
  }
});

test('houseBar: four-on-the-floor kick and off-beat hats', () => {
  const rng = mulberry32(5);
  for (const bar of BARS) {
    const evs = houseBar(bar, rng);
    assert.ok(evs.every(e => e.at >= 0 && e.at < 4), `bar ${bar}`);
    assert.deepEqual(evs.filter(e => e.voice === 'kick').map(e => e.at), [0, 1, 2, 3]);
    assert.deepEqual(evs.filter(e => e.voice === 'hat').map(e => e.at), [0.5, 1.5, 2.5, 3.5]);
  }
});

test('bars are deterministic for the same barIndex and seed', () => {
  for (const gen of [jazzBar, houseBar]) {
    for (const bar of BARS) assert.deepEqual(gen(bar, mulberry32(11)), gen(bar, mulberry32(11)));
  }
});

// Minimal WebAudio stand-in: counts oscillators and records what is started.
function fakeCtx({ resumes = true } = {}) {
  const param = v => ({
    value: v,
    setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    setTargetAtTime() {}, cancelScheduledValues() {},
  });
  const node = extra => {
    const n = { connectedTo: null, disconnects: 0, ...extra };
    n.connect = t => { n.connectedTo = t; return t; };
    n.disconnect = () => { n.disconnects++; };
    return n;
  };
  const ctx = {
    state: 'suspended', currentTime: 0, sampleRate: 8000, destination: node(),
    oscillators: 0, started: 0, resumeCalls: 0, startTimes: [],
    resume() { ctx.resumeCalls++; if (resumes) ctx.state = 'running'; return Promise.resolve(); },
    gains: [],
    createGain: () => { const g = node({ gain: param(1) }); ctx.gains.push(g); return g; },
    createBiquadFilter: () => node({ type: 'lowpass', frequency: param(350), Q: param(1) }),
    createOscillator: () => { ctx.oscillators++; return node({ type: 'sine', frequency: param(440), detune: param(0), start(t) { ctx.started++; ctx.startTimes.push(t); }, stop() {} }); },
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => node({ buffer: null, playbackRate: param(1), start(t) { ctx.started++; ctx.startTimes.push(t); }, stop() {} }),
  };
  return ctx;
}

// With `defer`, timeouts wait in `pending` until the test runs them.
function fakeTimers({ defer = false } = {}) {
  const live = new Set(), pending = [];
  return {
    live, pending,
    setInterval(fn, ms) { const h = { fn, ms }; live.add(h); return h; },
    clearInterval(h) { live.delete(h); },
    setTimeout(fn, ms) { if (defer) pending.push({ fn, ms }); else fn(); return 0; },
  };
}

test('MusicController: no AudioContext is created before the first gesture, and only one after', () => {
  const ctx = fakeCtx();
  let made = 0;
  const m = new MusicController(() => { made++; return ctx; }, { timers: fakeTimers() });
  m.setStyle('jazz');
  m.tick();
  m.setVolume(0.3);
  assert.equal(made, 0, 'setStyle, tick and setVolume never create the context');
  m.onGesture();
  assert.equal(made, 1);
  m.onGesture(); m.onGesture(); m.tick();
  assert.equal(made, 1, 'repeated gestures reuse the same context');
  m.setStyle('off');
});

test('MusicController: fast style switching keeps one timer, fades and disconnects the old bus', () => {
  const ctx = fakeCtx();
  const timers = fakeTimers({ defer: true });
  const { pending } = timers;
  const m = new MusicController(() => ctx, { rng: mulberry32(9), timers });
  m.onGesture();
  const master = ctx.gains[0];
  const busesNow = () => ctx.gains.filter(g => g.connectedTo === master);

  m.setStyle('jazz'); m.tick();
  const [jazzBus] = busesNow();
  assert.ok(jazzBus, 'jazz plays on its own bus');
  m.setStyle('house'); m.tick();
  const houseBus = busesNow().find(b => b !== jazzBus);
  assert.ok(houseBus, 'house gets a new bus');
  assert.equal(jazzBus.disconnects, 0, 'old bus still connected while it fades');
  assert.ok(pending.length === 1 && pending[0].ms >= 300, 'disconnect waits for the fade');
  pending.shift().fn();
  assert.equal(jazzBus.disconnects, 1, 'old bus disconnected after the fade');

  const notesBefore = ctx.gains.length;
  for (; ctx.currentTime < 3; ctx.currentTime += 0.025) m.tick();
  const newNotes = ctx.gains.slice(notesBefore);
  assert.ok(newNotes.length > 0);
  assert.ok(newNotes.every(g => g.connectedTo === houseBus), 'no notes routed to the old bus after the switch');

  m.setStyle('jazz'); m.tick();
  assert.equal(timers.live.size, 1, 'one live interval after jazz -> house -> jazz');
  const jazzBus2 = busesNow().find(b => b !== jazzBus && b !== houseBus);
  assert.ok(jazzBus2, 'returning to jazz starts a fresh session bus');
  pending.forEach(p => p.fn());
  assert.equal(houseBus.disconnects, 1);
  assert.equal(jazzBus2.disconnects, 0);
  m.setStyle('off');
  assert.equal(timers.live.size, 0);
});

test('MusicController: a style picked before the gesture stays silent, then starts on the gesture', () => {
  const ctx = fakeCtx();
  const timers = fakeTimers();
  const m = new MusicController(() => ctx, { rng: mulberry32(3), timers });
  assert.doesNotThrow(() => m.setStyle('jazz'));
  m.tick();
  assert.equal(ctx.oscillators, 0);
  assert.equal(ctx.started, 0);
  assert.equal(m.playing, false);

  m.onGesture();
  m.tick();
  assert.ok(ctx.oscillators >= 1, 'schedules oscillators after the gesture');
  assert.equal(m.playing, true);
  assert.equal(m.style, 'jazz');

  m.setStyle('off');
  assert.equal(m.playing, false);
  const before = ctx.started;
  ctx.currentTime = 4;
  m.tick();
  assert.equal(ctx.started, before, 'nothing new after off');
  assert.equal(timers.live.size, 0, 'scheduler timer cleared');
});

test('MusicController: the scheduler ticks every 25 ms and looks 100 ms ahead', () => {
  const ctx = fakeCtx();
  const timers = fakeTimers();
  const m = new MusicController(() => ctx, { rng: mulberry32(4), timers });
  m.onGesture();
  m.setStyle('house');
  assert.equal(timers.live.size, 1);
  assert.equal([...timers.live][0].ms, 25);
  m.tick();
  const first = ctx.started;
  assert.ok(first >= 1, 'downbeat kick inside the horizon');
  assert.ok(ctx.startTimes.every(t => t < 0.1), 'nothing beyond the 100 ms horizon');
  m.tick();
  assert.equal(ctx.started, first, 'no double scheduling at the same time');
  ctx.currentTime = 2;
  m.tick();
  assert.ok(ctx.started > first, 'keeps scheduling as time advances');
  assert.ok(ctx.startTimes.every(t => t < 2.1), 'still inside the horizon');
  m.setStyle('off');
});

test('MusicController: a suspended context schedules nothing until it actually runs', () => {
  const ctx = fakeCtx({ resumes: false });
  const timers = fakeTimers();
  const m = new MusicController(() => ctx, { timers });
  m.setStyle('house');
  m.onGesture();
  m.tick();
  assert.equal(ctx.oscillators, 0);
  assert.equal(m.playing, false);
  assert.ok(ctx.resumeCalls >= 1);
  ctx.state = 'running'; // resume() resolving later
  m.tick();
  assert.ok(ctx.oscillators >= 1, 'starts once the context runs');
  m.setStyle('off');
});

test('MusicController: no AudioContext available is harmless', () => {
  for (const make of [() => null, () => { throw new Error('no audio'); }]) {
    const timers = fakeTimers();
    const m = new MusicController(make, { timers });
    assert.doesNotThrow(() => { m.setStyle('jazz'); m.onGesture(); m.tick(); m.setVolume(0.3); });
    assert.equal(m.playing, false);
    assert.equal(m.beatPos(), null);
    m.setStyle('off');
  }
});

test('MusicController: volume is clamped to 0..1 and beatPos follows the audio clock', () => {
  const ctx = fakeCtx();
  const m = new MusicController(() => ctx, { timers: fakeTimers() });
  m.setVolume(2); assert.equal(m.volume, 1);
  m.setVolume(-1); assert.equal(m.volume, 0);
  m.setVolume(0.4); assert.equal(m.volume, 0.4);
  assert.equal(m.beatPos(), null, 'no beat before playing');
  m.onGesture(); m.setStyle('jazz'); m.tick();
  assert.equal(m.beatPos(), 0, 'clamped during the lead-in');
  ctx.currentTime = 1;
  const b0 = m.beatPos();
  ctx.currentTime += 60 / JAZZ.bpm;
  assert.ok(near(m.beatPos() - b0, 1, 1e-6), 'one beat per 60/bpm seconds');
  m.setStyle('off');
});

test('MusicController: the theme default changes the style only while music is on', () => {
  const timers = fakeTimers();
  const m = new MusicController(() => fakeCtx(), { timers });
  m.setDefault('house');
  assert.equal(m.style, 'off', 'a default never turns music on');
  assert.equal(timers.live.size, 0, 'and starts no scheduler');
  m.pick('house');
  assert.equal(m.style, 'house');
  assert.equal(m.picked, false, "turning music on with the view's own style follows the theme");
  m.setDefault('jazz');
  assert.equal(m.style, 'jazz', "the next view's theme sets the style");
  m.setDefault('house');
  assert.equal(m.style, 'house');
  m.setDefault('nope');
  assert.equal(m.style, 'house', 'an unknown style is ignored');
  m.pick('off');
  m.setDefault('jazz');
  assert.equal(m.style, 'off', 'off stays off');
  assert.equal(timers.live.size, 0);
});

test('MusicController: a style picked by hand holds across views until the user picks again', () => {
  const m = new MusicController(() => fakeCtx(), { timers: fakeTimers() });
  m.setDefault('jazz');
  m.pick('house');
  assert.equal(m.picked, true, "a style other than the view's own is a hand pick");
  for (const d of ['jazz', 'house', 'jazz']) { m.setDefault(d); assert.equal(m.style, 'house'); }
  m.setDefault('house');
  m.pick('jazz');
  assert.equal(m.picked, true, 'picking again while on is still by hand');
  for (const d of ['house', 'jazz', 'house']) { m.setDefault(d); assert.equal(m.style, 'jazz'); }
  m.pick('off');
  assert.equal(m.picked, false, 'off lets the theme lead again');
  m.pick('house');
  assert.equal(m.picked, false, "back on with the view's own style");
  m.setDefault('jazz');
  assert.equal(m.style, 'jazz');
  m.pick('off');
});

test("MusicController: picking the view's own style follows the theme, turning on or already on", () => {
  const m = new MusicController(() => fakeCtx(), { timers: fakeTimers() });
  m.setDefault('house');
  m.pick('jazz');
  assert.equal(m.picked, true);
  m.pick('house');
  assert.equal(m.picked, false, "back to the view's own style while on: the theme leads again");
  m.setDefault('jazz');
  assert.equal(m.style, 'jazz');
  m.pick('jazz');
  assert.equal(m.picked, false, 'clicking the playing style when it is the default still follows');
  m.setDefault('house');
  assert.equal(m.style, 'house');
  m.pick('jazz');
  assert.equal(m.picked, true, 'any other style holds');
  m.setDefault('jazz');
  m.setDefault('house');
  assert.equal(m.style, 'jazz');
  m.pick('off');
  assert.equal(m.picked, false);
  assert.equal(m.style, 'off');
});
