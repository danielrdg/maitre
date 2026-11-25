export const SYMBOL_COUNT = 4;
export const USER_WIN_CHANCE = 0.3;
const REEL_HZ = 30;

export function createSlot(x, index = 0) {
  return {
    x,
    reels: [index % 4, (index + 1) % 4, (index + 2) % 4],
    spin: [false, false, false],
    result: [0, 0, 0],
    stopAt: [0, 0, 0],
    user: false,
    flash: 0,
    auto: index * 1.4,
    pulled: -99,
    reelTick: -1,
    events: [],
  };
}

export const isSpinning = slot => slot.spin.some(Boolean);

export function startSpin(slot, t, user, rng = Math.random) {
  slot.spin = [true, true, true];
  slot.user = user;
  slot.pulled = t;
  const base = user ? [0.9, 1.35, 1.8] : [0.5, 0.7, 0.9];
  slot.stopAt = base.map(b => t + b);
  if (user) {
    const win = rng() < USER_WIN_CHANCE;
    const sym = rng() * SYMBOL_COUNT | 0;
    if (win) slot.result = [sym, sym, sym];
    else {
      const r = [0, 1, 2].map(() => rng() * SYMBOL_COUNT | 0);
      if (r[0] === r[1] && r[1] === r[2]) r[2] = (r[2] + 1) % SYMBOL_COUNT;
      slot.result = r;
    }
  } else {
    slot.result = [0, 1, 2].map(() => rng() * SYMBOL_COUNT | 0);
  }
}

// Idle machines with a player in front spin on their own every 2.8 s.
export function maybeAutoSpin(slot, t, occupied, rng = Math.random) {
  if (isSpinning(slot) || !occupied || slot.user || t - slot.auto <= 2.8) return false;
  slot.auto = t;
  startSpin(slot, t, false, rng);
  return true;
}

// Pushes 'tick' / 'stop' onto slot.events for user spins (the caller plays the sounds).
// Returns 'jackpot' | 'lose' once, on the step the last reel of a user spin stops.
export function stepSlot(slot, t) {
  if (!isSpinning(slot)) return 'idle';
  const tick = Math.floor(t * REEL_HZ);
  const advance = tick !== slot.reelTick;
  slot.reelTick = tick;
  let outcome = 'spinning';
  for (let r = 0; r < 3; r++) {
    if (!slot.spin[r]) continue;
    if (t >= slot.stopAt[r]) {
      slot.spin[r] = false;
      slot.reels[r] = slot.result[r];
      if (slot.user) slot.events.push('stop');
      if (r === 2 && slot.user) {
        slot.user = false;
        slot.auto = t + 2;
        const [a, b, c] = slot.result;
        if (a === b && b === c) { slot.flash = t + 2.5; outcome = 'jackpot'; } else outcome = 'lose';
      }
    } else if (advance) {
      slot.reels[r] = (slot.reels[r] + 1) % SYMBOL_COUNT;
      if (slot.user) slot.events.push('tick');
    }
  }
  if (outcome === 'spinning' && !isSpinning(slot)) return 'idle';
  return outcome;
}
