// WebGL context loss. A GPU reset, a driver crash or the browser reclaiming memory takes the
// canvas's context away; without a handler the page freezes on its last frame. The guard:
//   - on webglcontextlost: prevents the default (so the browser may restore the context), tells
//     the game to stop drawing (the sim and the UI keep running) and shows a notice;
//   - on webglcontextrestored: three.js re-creates its GL state and re-uploads geometry and
//     textures from their CPU copies on the next frame; the game rebuilds what lived only on the
//     GPU (onRestored: the sky's environment maps) and draws again;
//   - if the context is not back within RESTORE_TIMEOUT_MS, or is lost again within
//     REPEAT_WINDOW_MS, it gives up (onGiveUp): the game saves and reloads in safe mode.
//
// Render-only; it never touches the sim. Tested in tests/render/context-guard.test.ts.

export const RESTORE_TIMEOUT_MS = 8000;
export const REPEAT_WINDOW_MS = 120_000;

export interface ContextGuardHooks {
  onLost(): void;
  onRestored(): void;
  onGiveUp(reason: "timeout" | "repeated"): void;
}

export interface GuardClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: GuardClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class ContextGuard {
  private lostAt: number[] = [];
  private timer: unknown = null;
  private gaveUp = false;
  private isLost = false;
  private readonly hooks: ContextGuardHooks;
  private readonly clock: GuardClock;
  private readonly target: EventTarget;
  private readonly lost = (e: Event): void => {
    e.preventDefault();
    if (this.gaveUp) return;
    this.isLost = true;
    const now = this.clock.now();
    this.lostAt = this.lostAt.filter((t) => now - t < REPEAT_WINDOW_MS);
    this.lostAt.push(now);
    this.hooks.onLost();
    if (this.lostAt.length >= 2) return this.giveUp("repeated");
    this.timer = this.clock.setTimeout(() => this.giveUp("timeout"), RESTORE_TIMEOUT_MS);
  };
  private readonly restored = (): void => {
    if (this.gaveUp) return;
    this.isLost = false;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.hooks.onRestored();
  };

  constructor(target: EventTarget, hooks: ContextGuardHooks, clock: GuardClock = realClock) {
    this.target = target;
    this.hooks = hooks;
    this.clock = clock;
    target.addEventListener("webglcontextlost", this.lost);
    target.addEventListener("webglcontextrestored", this.restored);
  }

  /** True while the context is gone: draw nothing. */
  get contextLost(): boolean {
    return this.isLost || this.gaveUp;
  }

  private giveUp(reason: "timeout" | "repeated"): void {
    if (this.gaveUp) return;
    this.gaveUp = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.hooks.onGiveUp(reason);
  }

  dispose(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.target.removeEventListener("webglcontextlost", this.lost);
    this.target.removeEventListener("webglcontextrestored", this.restored);
  }
}

/** Session keys: safe mode for the rest of the session, and a one-shot "resume the autosave". */
export const SAFE_MODE_KEY = "fogcity.gfx.safe";
export const RESUME_KEY = "fogcity.resume";

/** A plain notice over the game (the GPU is resetting, or the game is reloading). */
export function showGraphicsNotice(host: HTMLElement, text: string): HTMLElement {
  let el = host.querySelector<HTMLElement>(".fc-gfx-notice");
  if (!el) {
    el = document.createElement("div");
    el.className = "fc-gfx-notice";
    el.setAttribute("role", "status");
    el.style.cssText = "position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);padding:14px 20px;"
      + "background:#0b1a22e6;color:#e8f1f2;border:1px solid #6f8f96;border-radius:10px;font:15px system-ui,sans-serif;z-index:50;pointer-events:none";
    host.appendChild(el);
  }
  el.textContent = text;
  el.hidden = false;
  return el;
}

export function hideGraphicsNotice(host: HTMLElement): void {
  const el = host.querySelector<HTMLElement>(".fc-gfx-notice");
  if (el) el.hidden = true;
}
