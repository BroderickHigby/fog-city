import { describe, expect, it } from "vitest";
import { Action } from "../../src/sim/contract.ts";
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
  it("clicking the map does not fire, while clicking the game view does", () => {
    const target=new EventTarget(),keyboard=new Keyboard(target as unknown as Window);
    const click=(id:string)=>{const e=Object.assign(new Event("mousedown"),{button:0});Object.defineProperty(e,"target",{value:{tagName:"CANVAS",id}});target.dispatchEvent(e);};
    click("city-map");expect(keyboard.sample().actions & Action.fire).toBe(0);
    click("game-canvas");expect(keyboard.sample().actions & Action.fire).toBe(Action.fire);
    target.dispatchEvent(new Event("mouseup"));expect(keyboard.sample().actions & Action.fire).toBe(0);
  });
});
