import { Action, type SimInput } from "../sim/contract.ts";

const NO_PRESSES: readonly string[] = Object.freeze([]);

const HELD: Readonly<Record<string, number>> = { KeyE: Action.fire, Enter: Action.fire, KeyQ: Action.scan, KeyZ: Action.watch, KeyR: Action.watch, KeyB: Action.altFire, KeyT: Action.interact };
export const KEY_ACTIONS: Readonly<Record<string, number>> = { KeyF: Action.enterExit, KeyH: Action.horn, KeyJ: Action.gadget, KeyG: Action.cone, KeyX: Action.streak, KeyY: Action.emote };

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
  private readonly keydown = (e: KeyboardEvent): void => {
    if (this.blocked() || isTextEntry(e.target)) return;
    if (!this.held.has(e.code)) this.onPress(e.code);
    this.held.add(e.code);
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  };
  private readonly keyup = (e: KeyboardEvent): void => { this.held.delete(e.code); };
  private readonly mouseDown = (e:MouseEvent):void => {if(e.button===0&&(e.target as Element|null)?.id==="game-canvas")this.held.add("Mouse0");};
  private readonly mouseUp = ():void => {this.held.delete("Mouse0");};
  private readonly blur = (): void => { this.releaseAll(); };

  constructor(target: Window = window, blocked?: () => boolean) {
    this.target = target;
    this.blocked = blocked ?? (() => isTextEntry(target.document?.activeElement));
    target.addEventListener("keydown", this.keydown);
    target.addEventListener("keyup", this.keyup);
    target.addEventListener("blur", this.blur);
    target.addEventListener("focusin", this.blur);
    target.addEventListener("mousedown",this.mouseDown);
    target.addEventListener("mouseup",this.mouseUp);
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
    if (this.blocked()) { this.releaseAll(); return { throttle: 0, steer: 0, brake: 0, actions: 0 }; }
    let actions = this.pressed;
    for (const code of this.held) actions |= code === "Mouse0" ? Action.fire : HELD[code] ?? 0;
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

  release():void {this.releaseAll();}

  releaseAll(): void { this.held.clear(); this.pressed = 0; this.uiPresses = []; }

  dispose(): void {
    this.releaseAll();
    this.target.removeEventListener("keydown", this.keydown);
    this.target.removeEventListener("keyup", this.keyup);
    this.target.removeEventListener("blur", this.blur);
    this.target.removeEventListener("focusin",this.blur);
    this.target.removeEventListener("mousedown",this.mouseDown);
    this.target.removeEventListener("mouseup",this.mouseUp);
  }

  /** Render-only key presses since the last call (e.g. "KeyC" camera, "KeyN" night). */
  takeUiPresses(): readonly string[] {
    if (this.uiPresses.length === 0) return NO_PRESSES;
    const out = this.uiPresses;
    this.uiPresses = [];
    return out;
  }
}
