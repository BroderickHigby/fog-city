import { Action, type SimInput } from "../sim/contract.ts";

const NO_PRESSES: readonly string[] = Object.freeze([]);

const HELD: Readonly<Record<string, number>> = { KeyE: Action.fire, Enter: Action.fire, KeyQ: Action.scan, KeyZ: Action.watch, KeyB: Action.altFire, KeyR: Action.interact };
export const KEY_ACTIONS: Readonly<Record<string, number>> = { KeyF: Action.enterExit, KeyH: Action.horn, KeyG: Action.gadget, KeyU: Action.gear, KeyT: Action.cone, KeyX: Action.streak, KeyY: Action.emote };

export function isTextEntry(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.("input,textarea,select,[contenteditable='true']");
}

/** Held movement/fire and edge-triggered actions; typing never drives the player. */
export class Keyboard {
  private held = new Set<string>();
  private pressed = 0;
  /** Render-only toggles (camera, night mode); never reach the sim. */
  private uiPresses: string[] = [];

  private readonly target: Window;
  private readonly blocked: () => boolean;
  private suspended = false;
  private readonly keydown = (e: KeyboardEvent): void => {
    if (this.suspended || this.blocked() || isTextEntry(e.target) || e.repeat && !this.held.has(e.code)) return;
    if (!this.held.has(e.code)) this.onPress(e.code);
    this.held.add(e.code);
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  };
  private readonly keyup = (e: KeyboardEvent): void => { this.held.delete(e.code); };
  private readonly blur = (): void => { this.releaseAll(); };

  constructor(target: Window = window, blocked?: () => boolean) {
    this.target = target;
    this.blocked = blocked ?? (() => isTextEntry(target.document?.activeElement));
    target.addEventListener("keydown", this.keydown);
    target.addEventListener("keyup", this.keyup);
    target.addEventListener("blur", this.blur);
  }

  private onPress(code: string): void {
    if (KEY_ACTIONS[code]) this.pressed |= KEY_ACTIONS[code];
    else if (!HELD[code]) this.uiPresses.push(code);
  }

  private axis(pos: string[], neg: string[]): number {
    const p = pos.some((k) => this.held.has(k)) ? 1 : 0;
    const n = neg.some((k) => this.held.has(k)) ? 1 : 0;
    return p - n;
  }

  /** Input for the next sim tick. Consumes one-shot actions. */
  sample(): SimInput {
    if (this.suspended || this.blocked()) { this.releaseAll(); return { throttle: 0, steer: 0, brake: 0, actions: 0 }; }
    let actions = this.pressed;
    for (const code of this.held) actions |= HELD[code] ?? 0;
    const input: SimInput = {
      throttle: this.axis(["KeyW", "ArrowUp"], ["KeyS", "ArrowDown"]),
      steer: this.axis(["KeyD", "ArrowRight"], ["KeyA", "ArrowLeft"]),
      brake: this.held.has("Space") ? 1 : 0,
      actions,
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

  releaseAll(): void { this.held.clear(); this.pressed = 0; this.uiPresses = []; }
  setBlocked(value: boolean): void { this.suspended = value; if(value)this.releaseAll(); }

  dispose(): void {
    this.releaseAll();
    this.target.removeEventListener("keydown", this.keydown);
    this.target.removeEventListener("keyup", this.keyup);
    this.target.removeEventListener("blur", this.blur);
  }

  /** Render-only key presses since the last call (e.g. "KeyC" camera, "KeyN" night). */
  takeUiPresses(): readonly string[] {
    if (this.uiPresses.length === 0) return NO_PRESSES;
    const out = this.uiPresses;
    this.uiPresses = [];
    return out;
  }
}
