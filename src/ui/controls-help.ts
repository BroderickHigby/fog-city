import type { UiCopy } from "./types.ts";

/** One row of the controls list: the keys or buttons, then a copy key for what they do. */
export interface ControlRow { readonly keys: string; readonly action: string; readonly hold?: boolean }

/** Keyboard bindings, kept in step with src/input/keyboard.ts and the render-only keys in src/main.ts. */
export const KEYBOARD_ROWS: readonly ControlRow[] = [
  { keys: "W A S D / ↑ ← ↓ →", action: "ui.help.move" },
  { keys: "Space", action: "ui.controls.brake" },
  { keys: "F", action: "ui.controls.enterExit" },
  { keys: "E / Enter", action: "ui.controls.fire", hold: true },
  { keys: "Q", action: "ui.controls.scan", hold: true },
  { keys: "Z", action: "ui.controls.watch", hold: true },
  { keys: "R", action: "ui.controls.interact", hold: true },
  { keys: "B", action: "ui.controls.altFire", hold: true },
  { keys: "T", action: "ui.controls.cone" },
  { keys: "G", action: "ui.controls.gadget" },
  { keys: "U", action: "ui.controls.gear" },
  { keys: "X", action: "ui.controls.streak" },
  { keys: "Y", action: "ui.help.emote" },
  { keys: "H", action: "ui.help.horn" },
  { keys: "P", action: "ui.controls.phone" },
  { keys: "Esc", action: "ui.help.pause" },
  { keys: "C", action: "ui.help.camera" },
  { keys: "V", action: "ui.help.fly" },
  { keys: "N", action: "ui.help.night" },
  { keys: "? / F1", action: "ui.help.show" },
];

/** Standard-mapping gamepad bindings, kept in step with src/input/controller.ts and menu-gamepad.ts. */
export const GAMEPAD_ROWS: readonly ControlRow[] = [
  { keys: "Left stick", action: "ui.help.move" },
  { keys: "LT", action: "ui.controls.brake" },
  { keys: "RT", action: "ui.controls.fire", hold: true },
  { keys: "A", action: "ui.controls.enterExit" },
  { keys: "B", action: "ui.controls.cone" },
  { keys: "X", action: "ui.controls.gadget" },
  { keys: "Y", action: "ui.controls.interact", hold: true },
  { keys: "LB", action: "ui.controls.watch", hold: true },
  { keys: "RB", action: "ui.controls.altFire", hold: true },
  { keys: "L3", action: "ui.help.horn" },
  { keys: "R3", action: "ui.controls.scan", hold: true },
  { keys: "D-pad ↑", action: "ui.controls.gear" },
  { keys: "D-pad ↓", action: "ui.controls.streak" },
  { keys: "Start", action: "ui.help.menu" },
];

function table(doc: Document, copy: UiCopy, caption: string, rows: readonly ControlRow[]): HTMLTableElement {
  const t = doc.createElement("table");
  t.className = "fc-help-table";
  const c = doc.createElement("caption");
  c.textContent = caption;
  t.append(c);
  const body = doc.createElement("tbody");
  for (const row of rows) {
    const tr = doc.createElement("tr");
    const key = doc.createElement("th");
    key.scope = "row";
    const kbd = doc.createElement("kbd");
    kbd.textContent = row.keys;
    key.append(kbd);
    const what = doc.createElement("td");
    what.textContent = row.hold ? `${copy(row.action)} ${copy("ui.help.hold")}` : copy(row.action);
    tr.append(key, what);
    body.append(tr);
  }
  t.append(body);
  return t;
}

/** The controls list shown by the top-right Controls button, ? / F1, and the pause menu. */
export function createControlsHelp(doc: Document, copy: UiCopy): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.className = "fc-help";
  const hint = doc.createElement("p");
  hint.textContent = copy("ui.help.hint");
  const grid = doc.createElement("div");
  grid.className = "fc-help-grid";
  grid.append(table(doc, copy, copy("ui.help.keyboard"), KEYBOARD_ROWS), table(doc, copy, copy("ui.help.gamepad"), GAMEPAD_ROWS));
  wrap.append(hint, grid);
  return wrap;
}
