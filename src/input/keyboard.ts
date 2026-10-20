import { Action, type SimInput } from "../sim/contract.ts";

const NO_PRESSES: readonly string[] = Object.freeze([]);

/** Maps held keys to SimInput. One-shot actions fire once per key press. */
export class Keyboard {
  private held = new Set<string>();
  private pressed = 0;
  /** Render-only toggles (camera, night mode); never reach the sim. */
  private uiPresses: string[] = [];

  constructor(target: Window = window) {
    target.addEventListener("keydown", (e) => {
      if (!this.held.has(e.code)) this.onPress(e.code);
      this.held.add(e.code);
      if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
    });
    target.addEventListener("keyup", (e) => this.held.delete(e.code));
    target.addEventListener("blur", () => this.held.clear());
  }

  private onPress(code: string): void {
    if (code === "KeyF") this.pressed |= Action.enterExit;
    else if (code === "KeyE" || code === "Enter") this.pressed |= Action.fire;
    else if (code === "KeyQ") this.pressed |= Action.scan;
    else if (code === "KeyH") this.pressed |= Action.horn;
    else this.uiPresses.push(code);
  }

  private axis(pos: string[], neg: string[]): number {
    const p = pos.some((k) => this.held.has(k)) ? 1 : 0;
    const n = neg.some((k) => this.held.has(k)) ? 1 : 0;
    return p - n;
  }

  /** Input for the next sim tick. Consumes one-shot actions. */
  sample(): SimInput {
    const input: SimInput = {
      throttle: this.axis(["KeyW", "ArrowUp"], ["KeyS", "ArrowDown"]),
      steer: this.axis(["KeyD", "ArrowRight"], ["KeyA", "ArrowLeft"]),
      brake: this.held.has("Space") ? 1 : 0,
      actions: this.pressed,
    };
    this.pressed = 0;
    return input;
  }

  /** Whether a key is held right now (the fly camera reads WASD/arrows directly). */
  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** Discard one-shot sim actions pressed so far (used while the fly camera owns the keys). */
  clearActions(): void {
    this.pressed = 0;
  }

  /** Render-only key presses since the last call (e.g. "KeyC" camera, "KeyN" night). */
  takeUiPresses(): readonly string[] {
    if (this.uiPresses.length === 0) return NO_PRESSES;
    const out = this.uiPresses;
    this.uiPresses = [];
    return out;
  }
}
