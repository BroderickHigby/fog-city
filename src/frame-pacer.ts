// How many fixed sim ticks a render frame runs. The sim only ever sees whole ticks with
// recorded inputs, so this policy changes how fast game time passes, never what happens.
//
// A plain `while (acc >= DT)` accumulator spirals once a tick costs more than real time: each
// frame owes more ticks, runs them all, takes longer, and owes even more. The pacer caps the
// catch-up at MAX_CATCHUP_TICKS per frame and also stops once the ticks it ran this frame have
// used SIM_BUDGET_MS (always at least one tick, so the game never stalls). Time it could not
// simulate is dropped: the game runs slower instead of the frame rate collapsing.

/** Most ticks one frame may run to catch up. */
export const MAX_CATCHUP_TICKS = 4;
/** Sim wall time one frame may spend before it stops catching up (it always runs one tick). */
export const SIM_BUDGET_MS = 24;
/** Frames the "running slow" flag stays up after the last frame that dropped time. */
const SLOW_HOLD_FRAMES = 30;

export interface PacerStats {
  /** Game seconds per real second over recent frames, 1 when keeping up. */
  readonly speed: number;
  /** True while the sim recently could not keep up and dropped time. */
  readonly slow: boolean;
  /** Smoothed wall milliseconds one tick takes. */
  readonly tickMs: number;
  /** Ticks dropped since the pacer was created or reset. */
  readonly droppedTicks: number;
}

export class FramePacer {
  private acc = 0;
  private ran = 0;
  private spent = 0;
  private owed = 0;
  private speedEma = 1;
  private tickEma = 0;
  private slowHold = 0;
  private dropped = 0;

  private readonly dt: number;
  private readonly maxTicks: number;
  private readonly budgetMs: number;

  constructor(dt: number, maxTicks = MAX_CATCHUP_TICKS, budgetMs = SIM_BUDGET_MS) {
    this.dt = dt;
    this.maxTicks = maxTicks;
    this.budgetMs = budgetMs;
  }

  /** Start a frame that covers `frameS` real seconds (already clamped by the caller). */
  begin(frameS: number): void {
    this.acc += Math.max(0, frameS);
    this.owed = frameS;
    this.ran = 0;
    this.spent = 0;
  }

  /** Whether the frame should run another tick now. */
  wantTick(): boolean {
    if (this.acc < this.dt) return false;
    if (this.ran >= this.maxTicks) return false;
    return this.ran === 0 || this.spent < this.budgetMs;
  }

  /** Record one tick that took `ms` wall milliseconds. */
  ticked(ms: number): void {
    this.acc -= this.dt;
    this.ran++;
    this.spent += ms;
    this.tickEma = this.tickEma === 0 ? ms : this.tickEma * 0.9 + ms * 0.1;
  }

  /** End the frame: drop whatever backlog it could not run, keeping the sub-tick fraction. */
  end(): void {
    let lost = 0;
    if (this.acc >= this.dt) {
      lost = Math.floor(this.acc / this.dt);
      this.acc -= lost * this.dt;
      this.dropped += lost;
      this.slowHold = SLOW_HOLD_FRAMES;
    } else if (this.slowHold > 0) this.slowHold--;
    if (this.owed > 0) {
      const ratio = Math.min(1, (this.owed - lost * this.dt) / this.owed);
      this.speedEma = this.speedEma * 0.9 + ratio * 0.1;
    }
  }

  /** Interpolation fraction between the last two ticks. */
  alpha(): number {
    return this.acc / this.dt;
  }

  /** Forget any backlog (pause, restore). */
  reset(): void {
    this.acc = 0;
    this.slowHold = 0;
    this.speedEma = 1;
  }

  stats(): PacerStats {
    return { speed: this.speedEma, slow: this.slowHold > 0, tickMs: this.tickEma, droppedTicks: this.dropped };
  }
}
