// Generative lounge music, all WebAudio, no files. Bars are pure functions of
// (barIndex, rng); MusicController schedules them with a lookahead timer on
// its own gain chain, separate from the sound effects.

export const JAZZ = { bpm: 104, progression: ['Dm7', 'G7', 'Cmaj7', 'A7'] };
export const HOUSE = { bpm: 124, progression: ['Am7', 'Fmaj7', 'C', 'G'] };
const STYLES = { jazz: { ...JAZZ, bar: jazzBar }, house: { ...HOUSE, bar: houseBar } };

const CHORDS = {
  Dm7: { root: 2, tones: [0, 3, 7, 10], scale: [0, 2, 3, 5, 7, 9, 10] },
  G7: { root: 7, tones: [0, 4, 7, 10], scale: [0, 2, 4, 5, 7, 9, 10] },
  Cmaj7: { root: 0, tones: [0, 4, 7, 11], scale: [0, 2, 4, 5, 7, 9, 11] },
  A7: { root: 9, tones: [0, 4, 7, 10], scale: [0, 1, 4, 5, 7, 8, 10] },
  Am7: { root: 9, tones: [0, 3, 7, 10] },
  Fmaj7: { root: 5, tones: [0, 4, 7, 11] },
  C: { root: 0, tones: [0, 4, 7, 12] },
  G: { root: 7, tones: [0, 4, 7, 12] },
};

const SWING = 2 / 3;
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const chordAt = (style, bar) => CHORDS[style.progression[((bar % 4) + 4) % 4]];
const bassRoot = ch => 36 + ch.root;

// Chord tones (no root) voiced upward from `low`.
function voicing(ch, low) {
  const tones = ch.tones.length > 3 ? [ch.tones[1], ch.tones[3], 14] : [ch.tones[1], ch.tones[2], 12];
  return tones.map(iv => {
    let m = ch.root + iv;
    while (m < low) m += 12;
    return m;
  });
}

export function jazzBar(barIndex, rng) {
  const ch = chordAt(JAZZ, barIndex), next = chordAt(JAZZ, barIndex + 1);
  const ev = [];
  const R = bassRoot(ch), N = bassRoot(next);

  // Walking bass: root, two chord/scale tones, chromatic or fifth approach.
  const mid1 = pick(rng, [ch.tones[1], ch.tones[2], ch.scale[1]]);
  const mid2 = pick(rng, [ch.tones[2], ch.tones[3], ch.scale[5]].filter(iv => iv !== mid1));
  const approach = pick(rng, [N === 36 ? 37 : N - 1, N + 1, N + 7]);
  [R, R + mid1, R + mid2, approach].forEach((midi, i) => ev.push({ at: i, voice: 'bass', midi, dur: 0.9, vel: i === 0 ? 0.8 : 0.65 }));

  // Ride "ding, ding-a, ding, ding-a", heavier on 2 and 4, plus the hi-hat foot.
  for (const at of [0, 1, 1 + SWING, 2, 3, 3 + SWING]) {
    const accent = at === 1 || at === 3 ? 0.55 : 0.38;
    ev.push({ at, voice: 'ride', dur: 0.9, vel: accent * (0.85 + rng() * 0.3) });
  }
  ev.push({ at: 1, voice: 'hat', dur: 0.2, vel: 0.3 }, { at: 3, voice: 'hat', dur: 0.2, vel: 0.3 });
  for (let b = 0; b < 4; b++) if (rng() < 0.25) ev.push({ at: b + SWING, voice: 'snare', dur: 0.2, vel: 0.12 });

  // Soft comping.
  const comp = pick(rng, [[0, 1 + SWING], [1 + SWING], [SWING, 2 + SWING], [1, 2 + SWING]]);
  for (const at of comp) for (const midi of voicing(ch, 52)) ev.push({ at, voice: 'stab', midi, dur: 0.6, vel: 0.28 });

  // Sax: an unhurried phrase on swung eighths, walking the chord scale.
  if (rng() < 0.7) {
    const pool = [];
    for (let m = 62; m <= 79; m++) if (ch.scale.includes(((m - ch.root) % 12 + 12) % 12)) pool.push(m);
    const isTone = m => ch.tones.includes(((m - ch.root) % 12 + 12) % 12);
    const grid = [0, SWING, 1, 1 + SWING, 2, 2 + SWING, 3, 3 + SWING];
    let gi = Math.floor(rng() * 4);
    const len = 3 + Math.floor(rng() * 4);
    const starts = pool.map((m, i) => i).filter(i => isTone(pool[i]) && pool[i] >= 66 && pool[i] <= 74);
    let pi = pick(rng, starts);
    const notes = [];
    for (let k = 0; k < len && gi < grid.length; k++) {
      if (k > 0 && rng() < 0.2) { gi++; continue; }
      notes.push({ gi, pi });
      pi = Math.max(0, Math.min(pool.length - 1, pi + pick(rng, [-2, -1, -1, 1, 1, 2])));
      gi += rng() < 0.3 ? 2 : 1;
    }
    notes.forEach((n, k) => {
      const last = k === notes.length - 1;
      let midi = pool[n.pi];
      if (last && !isTone(midi)) midi = pool[n.pi > 0 && isTone(pool[n.pi - 1]) ? n.pi - 1 : Math.min(pool.length - 1, n.pi + 1)];
      const at = grid[n.gi];
      const dur = last ? 1.2 : (grid[notes[k + 1].gi] - at) * 0.95;
      ev.push({ at, voice: 'lead', midi, dur, vel: 0.5 + rng() * 0.15 });
    });
  }
  return ev.sort((a, b) => a.at - b.at);
}

export function houseBar(barIndex, rng) {
  const ch = chordAt(HOUSE, barIndex);
  const ev = [];
  const R = bassRoot(ch);
  for (let b = 0; b < 4; b++) {
    ev.push({ at: b, voice: 'kick', dur: 0.5, vel: 0.9 });
    ev.push({ at: b + 0.5, voice: 'hat', dur: 0.25, vel: 0.32 });
    if (rng() < 0.7) ev.push({ at: b + 0.25, voice: 'ride', dur: 0.1, vel: 0.1 });
    if (rng() < 0.7) ev.push({ at: b + 0.75, voice: 'ride', dur: 0.1, vel: 0.12 });
    ev.push({ at: b + 0.5, voice: 'bass', midi: b === 3 && rng() < 0.4 ? R + 12 : R, dur: 0.35, vel: 0.7 });
  }
  ev.push({ at: 1, voice: 'snare', dur: 0.3, vel: 0.35 }, { at: 3, voice: 'snare', dur: 0.3, vel: 0.35 });
  const stabs = pick(rng, [[0.75, 2.5], [1.5, 3.25], [0.5, 1.75, 3]]);
  for (const at of stabs) for (const midi of voicing(ch, 57)) ev.push({ at, voice: 'stab', midi, dur: 0.22, vel: 0.32 });
  return ev.sort((a, b) => a.at - b.at);
}

// ---------- playback ----------

const TICK_MS = 25;
const LOOKAHEAD = 0.1;
const LEAD_IN = 0.06;
const STALE = 0.02;
const OFF = 0.0001;
const mtof = m => 440 * 2 ** ((m - 69) / 12);

const defaultTimers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: h => globalThis.clearInterval(h),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
};

export class MusicController {
  constructor(makeCtx, { rng = Math.random, timers = defaultTimers } = {}) {
    this.makeCtx = makeCtx;
    this.rng = rng;
    this.timers = timers;
    this.ac = null;
    this.master = null;
    this.noiseBuf = null;
    this.timer = null;
    this.session = null;
    this._style = 'off';
    this._volume = 0.6;
  }

  get style() { return this._style; }
  get volume() { return this._volume; }
  get playing() { return this._style !== 'off' && !!this.session && this.ac?.state === 'running'; }

  setStyle(style) {
    const next = STYLES[style] ? style : 'off';
    if (next === this._style) return;
    this._style = next;
    this._fadeOut();
    if (next === 'off') {
      if (this.timer !== null) { this.timers.clearInterval(this.timer); this.timer = null; }
      return;
    }
    if (this.timer === null) {
      this.timer = this.timers.setInterval(() => this.tick(), TICK_MS);
      this.timer?.unref?.();
    }
  }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (this.master) this.master.gain.setTargetAtTime(this._volume, this.ac.currentTime, 0.05);
  }

  // Call from every user gesture: creates or resumes the context.
  onGesture() {
    if (!this.ac) {
      try { this.ac = this.makeCtx() || null; } catch { this.ac = null; }
      if (!this.ac) return;
      this.master = this.ac.createGain();
      this.master.gain.value = this._volume;
      this.master.connect(this.ac.destination);
    }
    if (this.ac.state !== 'running') {
      try { Promise.resolve(this.ac.resume()).catch(() => {}); } catch { /* stays suspended */ }
    }
  }

  // Beats since the current style started, on the audio clock; null when silent.
  beatPos() {
    if (!this.playing) return null;
    return Math.max(0, (this.ac.currentTime - this.session.origin) / this.session.beatDur);
  }

  tick() {
    const ac = this.ac;
    if (this._style === 'off' || !ac || ac.state !== 'running') return;
    const now = ac.currentTime;
    if (!this.session) this.session = this._startSession(now);
    const s = this.session, barDur = s.beatDur * 4;
    // After a stall (background tab) skip ahead instead of bursting late notes.
    if (s.nextBar + barDur <= now) {
      const k = Math.floor((now - s.nextBar) / barDur);
      s.nextBar += k * barDur; s.bar += k;
    }
    const horizon = now + LOOKAHEAD;
    while (s.nextBar < horizon) {
      for (const e of s.gen(s.bar, this.rng)) s.queue.push({ ...e, time: s.nextBar + e.at * s.beatDur });
      s.bar++; s.nextBar += barDur;
    }
    s.queue.sort((a, b) => a.time - b.time);
    while (s.queue.length && s.queue[0].time < horizon) {
      const e = s.queue.shift();
      if (e.time >= now - STALE) this._play(e, s);
    }
  }

  _startSession(now) {
    const st = STYLES[this._style];
    const bus = this.ac.createGain();
    bus.gain.setValueAtTime(OFF, now);
    bus.gain.setTargetAtTime(1, now, 0.05);
    bus.connect(this.master);
    const origin = now + LEAD_IN;
    return { bus, gen: st.bar, beatDur: 60 / st.bpm, origin, nextBar: origin, bar: 0, queue: [] };
  }

  _fadeOut() {
    const s = this.session;
    this.session = null;
    if (!s) return;
    const t = this.ac.currentTime;
    s.bus.gain.cancelScheduledValues(t);
    s.bus.gain.setTargetAtTime(0, t, 0.08);
    this.timers.setTimeout(() => { try { s.bus.disconnect(); } catch { /* already gone */ } }, 800);
  }

  _noise() {
    if (!this.noiseBuf) {
      const a = this.ac, len = a.sampleRate;
      this.noiseBuf = a.createBuffer(1, len, a.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuf;
  }

  _env(param, t, peak, attack, end) {
    param.setValueAtTime(OFF, t);
    param.linearRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(OFF, end);
  }

  _play(e, s) {
    const a = this.ac, t = Math.max(e.time, a.currentTime), dur = e.dur * s.beatDur;
    const out = a.createGain();
    out.connect(s.bus);
    if (e.voice === 'bass') {
      const o = a.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(mtof(e.midi), t);
      this._env(out.gain, t, 0.42 * e.vel, 0.01, t + dur + 0.05);
      o.connect(out); o.start(t); o.stop(t + dur + 0.1);
    } else if (e.voice === 'kick') {
      const o = a.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      this._env(out.gain, t, 0.85 * e.vel, 0.004, t + 0.35);
      o.connect(out); o.start(t); o.stop(t + 0.4);
    } else if (e.voice === 'ride' || e.voice === 'hat' || e.voice === 'snare') {
      const src = a.createBufferSource(); src.buffer = this._noise();
      const f = a.createBiquadFilter();
      const [type, freq, q, tail, level] = {
        ride: ['highpass', 6500, 0.7, 0.35, 0.16],
        hat: ['highpass', 8000, 0.7, 0.05, 0.2],
        snare: ['bandpass', 1800, 0.8, 0.14, 0.3],
      }[e.voice];
      f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.setValueAtTime(q, t);
      this._env(out.gain, t, level * e.vel, 0.002, t + tail);
      src.connect(f).connect(out); src.start(t, this.rng() * 0.5); src.stop(t + tail + 0.05);
    } else if (e.voice === 'stab') {
      const f = a.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(s.beatDur < 0.5 ? 1500 : 900, t); f.Q.setValueAtTime(0.8, t);
      f.connect(out);
      for (const cents of [-7, 7]) {
        const o = a.createOscillator(); o.type = 'square';
        o.frequency.setValueAtTime(mtof(e.midi), t); o.detune.setValueAtTime(cents, t);
        o.connect(f); o.start(t); o.stop(t + dur + 0.1);
      }
      this._env(out.gain, t, 0.05 * e.vel, 0.008, t + dur + 0.05);
    } else if (e.voice === 'lead') {
      const freq = mtof(e.midi);
      const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(freq, t);
      const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(1400, t); f.Q.setValueAtTime(0.7, t);
      const lfo = a.createOscillator(); lfo.type = 'sine'; lfo.frequency.setValueAtTime(5.2, t);
      const depth = a.createGain();
      depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(freq * 0.007, t + Math.min(dur, 0.3));
      lfo.connect(depth).connect(o.frequency);
      out.gain.setValueAtTime(OFF, t);
      out.gain.linearRampToValueAtTime(0.09 * e.vel, t + 0.05);
      out.gain.setValueAtTime(0.09 * e.vel, t + dur * 0.85);
      out.gain.exponentialRampToValueAtTime(OFF, t + dur + 0.15);
      o.connect(f).connect(out);
      o.start(t); lfo.start(t); o.stop(t + dur + 0.2); lfo.stop(t + dur + 0.2);
    }
  }
}
