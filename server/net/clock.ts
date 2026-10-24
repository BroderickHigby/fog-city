/** Fixed 60 Hz scheduling independent of timer rounding, with bounded catch-up after a stall. */
export class FixedClock {
  private lastMs: number;
  private accumulatorMs = 0;
  constructor(startMs: number) { this.lastMs = startMs; }
  take(nowMs: number): number {
    if (!Number.isFinite(nowMs) || nowMs < this.lastMs) return 0;
    const period = 1000 / 60;
    this.accumulatorMs = Math.min(this.accumulatorMs + nowMs - this.lastMs, 4 * period);
    this.lastMs = nowMs;
    const count = Math.floor((this.accumulatorMs + 1e-7) / period);
    this.accumulatorMs = Math.max(0, this.accumulatorMs - count * period);
    return count;
  }
}
