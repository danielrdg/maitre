export const MAX_DT = 0.05;

export function clampDt(dtSec) {
  if (!(dtSec > 0)) return 0;
  return Math.min(MAX_DT, dtSec);
}

// Wall-clock based: after a hidden tab comes back it rings at most once.
export class DingScheduler {
  constructor(intervalSec = 22) {
    this.interval = intervalSec;
    this.last = -Infinity;
  }

  shouldRing(nowSec, blockedCount) {
    if (blockedCount <= 0) return false;
    if (nowSec - this.last < this.interval) return false;
    this.last = nowSec;
    return true;
  }

  markRung(nowSec) {
    this.last = nowSec;
  }
}
