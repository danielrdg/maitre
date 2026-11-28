// WebAudio sound effects, no files. Silent until arm() (first user gesture).

const defaultCtx = () => {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  return AC ? new AC() : null;
};

export function createSfx({ makeCtx = defaultCtx, rng = Math.random } = {}) {
  let ac = null, on = true, armed = false;

  function audio() {
    if (!ac) { try { ac = makeCtx(); } catch { ac = null; } }
    if (ac && ac.state === 'suspended') Promise.resolve(ac.resume()).catch(() => {});
    return ac;
  }

  function tone(f, dur, type, vol, when, slide) {
    if (!on || !armed) return; const a = audio(); if (!a) return; const t0 = a.currentTime + (when || 0);
    const o = a.createOscillator(), gn = a.createGain(); o.type = type || 'square'; o.frequency.setValueAtTime(f, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(f * slide, t0 + dur);
    gn.gain.setValueAtTime(vol || 0.05, t0); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(gn).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  }

  function noise(dur, vol, when) {
    if (!on || !armed) return; const a = audio(); if (!a) return; const t0 = a.currentTime + (when || 0);
    const b = a.createBuffer(1, a.sampleRate * dur, a.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (rng() * 2 - 1) * (1 - i / d.length);
    const s = a.createBufferSource(), gn = a.createGain(); s.buffer = b; gn.gain.value = vol;
    s.connect(gn).connect(a.destination); s.start(t0);
  }

  return {
    get armed() { return armed; },
    get on() { return on; },
    setOn(v) { on = !!v; },
    arm() { if (armed) return false; armed = true; audio(); return true; },
    noise,
    ding() { [0, 0.34].forEach(w => { tone(1568, 1.1, 'sine', 0.11, w); tone(3136, 0.5, 'sine', 0.03, w); tone(2093, 0.7, 'triangle', 0.035, w + 0.01); }); },
    tick() { tone(700 + rng() * 500, 0.025, 'square', 0.018); },
    thunk() { tone(160, 0.12, 'square', 0.05, 0, 0.5); },
    lose() { tone(392, 0.14, 'square', 0.035); tone(294, 0.3, 'square', 0.035, 0.14); },
    jackpot() {
      [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.13, 'square', 0.045, i * 0.09));
      for (let i = 0; i < 14; i++) tone(2200 + rng() * 1600, 0.05, 'triangle', 0.03, 0.75 + i * 0.06);
    },
    send() { [523, 659, 988].forEach((f, i) => tone(f, 0.11, 'square', 0.04, i * 0.08)); },
    fanfare() {
      [392, 523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, 0.17, 'square', 0.045, i * 0.12));
      for (let i = 0; i < 5; i++) noise(0.25, 0.06, 0.9 + i * 0.35);
    },
    pop() { tone(880, 0.06, 'square', 0.03); },
    lift() { tone(1319, 0.5, 'sine', 0.07); tone(1047, 0.7, 'sine', 0.07, 0.18); },
  };
}
