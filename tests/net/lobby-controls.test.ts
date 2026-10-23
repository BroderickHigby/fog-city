import { describe, expect, it } from "vitest";
import { Keyboard } from "../../src/input/keyboard.ts";

describe("lobby keyboard ownership", () => {
  it("releases both held controls and one-shot actions when a form takes focus", () => {
    const target = new EventTarget();
    const keyboard = new Keyboard(target as unknown as Window);
    const key = (code: string): Event => Object.assign(new Event("keydown"), { code });
    target.dispatchEvent(key("KeyW")); target.dispatchEvent(key("KeyF"));
    keyboard.release();
    expect(keyboard.sample()).toEqual({ throttle: 0, steer: 0, brake: 0, actions: 0 });
    expect(keyboard.isDown("KeyW")).toBe(false);
  });
});
