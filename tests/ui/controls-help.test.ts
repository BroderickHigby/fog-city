import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KEY_ACTIONS } from "../../src/input/keyboard.ts";
import { CONTROL_ICONS } from "../../src/ui/control-icons.ts";
import { GAMEPAD_ROWS, KEYBOARD_ROWS } from "../../src/ui/controls-help.ts";

const strings = (JSON.parse(readFileSync(new URL("../../content/ui-copy.json", import.meta.url), "utf8")) as { strings: Record<string, string> }).strings;
const label = (code: string): string => code.replace(/^Key/, "");

describe("controls help menu", () => {
  it("names every action with a real copy key", () => {
    for (const row of [...KEYBOARD_ROWS, ...GAMEPAD_ROWS]) expect(strings[row.action], row.action).toBeTruthy();
    expect(strings["ui.help.hold"]).toBeTruthy();
  });
  it("lists every edge-triggered keyboard action the game binds", () => {
    const listed = new Set(KEYBOARD_ROWS.flatMap((row) => row.keys.split(/[\s/]+/)));
    for (const code of Object.keys(KEY_ACTIONS)) expect(listed.has(label(code)), code).toBe(true);
    for (const key of ["E", "Q", "Z", "R", "B", "P", "Esc", "C", "V", "N", "Space", "Shift", "F1"]) expect(listed.has(key), key).toBe(true);
  });
  it("explains the shared drive-takeover and horn button for keyboard, pad and touch", () => {
    for (const keys of ["H", "L3"]) {
      const row = [...KEYBOARD_ROWS, ...GAMEPAD_ROWS].find(row => row.keys === keys)!;
      expect(strings[row.action]).toContain("Drive a stopped robotaxi");
      expect(strings[row.action]).toContain("horn when driving");
    }
    expect(strings["ui.controls.horn"]).toBe("Drive taxi / horn");
  });
  it("gives every row a picture that exists", () => {
    for (const row of [...KEYBOARD_ROWS, ...GAMEPAD_ROWS]) expect(CONTROL_ICONS[row.icon], row.keys).toMatch(/^<(path|g|circle|rect) /);
  });
  it("lists each gamepad button once", () => {
    const keys = GAMEPAD_ROWS.map((row) => row.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
