import { CONTROL_ICONS, type ControlIcon } from "./control-icons.ts";
import type { UiCopy } from "./types.ts";

/** One row of the controls list: the keys or buttons, a picture, then a copy key for what they do. */
export interface ControlRow { readonly keys: string; readonly action: string; readonly icon: ControlIcon; readonly hold?: boolean }

/** Keyboard bindings, kept in step with src/input/keyboard.ts and the render-only keys in src/main.ts. */
export const KEYBOARD_ROWS: readonly ControlRow[] = [
  { keys: "W A S D / ↑ ← ↓ →", action: "ui.help.move", icon: "move" },
  { keys: "Shift", action: "ui.help.sprint", icon: "sprint", hold: true },
  { keys: "Space", action: "ui.controls.brake", icon: "sprint" },
  { keys: "F", action: "ui.controls.enterExit", icon: "car" },
  { keys: "E / Enter", action: "ui.controls.fire", icon: "water", hold: true },
  { keys: "Q", action: "ui.controls.scan", icon: "scan", hold: true },
  { keys: "Z", action: "ui.controls.watch", icon: "watch", hold: true },
  { keys: "R", action: "ui.controls.interact", icon: "interact", hold: true },
  { keys: "B", action: "ui.controls.altFire", icon: "flowers", hold: true },
  { keys: "T", action: "ui.controls.cone", icon: "cone" },
  { keys: "G", action: "ui.controls.gadget", icon: "gadget" },
  { keys: "U", action: "ui.controls.gear", icon: "gear" },
  { keys: "X", action: "ui.controls.streak", icon: "streak" },
  { keys: "Y", action: "ui.help.emote", icon: "emote" },
  { keys: "H", action: "ui.help.horn", icon: "horn" },
  { keys: "P", action: "ui.controls.phone", icon: "phone" },
  { keys: "I", action: "ui.help.runway", icon: "car" },
  { keys: "Esc", action: "ui.help.pause", icon: "pause" },
  { keys: "Mouse drag", action: "ui.help.orbit", icon: "camera", hold: true },
  { keys: "C", action: "ui.help.camera", icon: "camera" },
  { keys: "V", action: "ui.help.fly", icon: "fly" },
  { keys: "N", action: "ui.help.night", icon: "night" },
  { keys: "? / F1", action: "ui.help.show", icon: "help" },
];

/** Standard-mapping gamepad bindings, kept in step with src/input/controller.ts and menu-gamepad.ts. */
export const GAMEPAD_ROWS: readonly ControlRow[] = [
  { keys: "Left stick", action: "ui.help.move", icon: "move" },
  { keys: "LT", action: "ui.controls.brake", icon: "sprint", hold: true },
  { keys: "RT", action: "ui.controls.fire", icon: "water", hold: true },
  { keys: "A", action: "ui.controls.enterExit", icon: "car" },
  { keys: "B", action: "ui.controls.cone", icon: "cone" },
  { keys: "X", action: "ui.controls.gadget", icon: "gadget" },
  { keys: "Y", action: "ui.controls.interact", icon: "interact", hold: true },
  { keys: "LB", action: "ui.controls.watch", icon: "watch", hold: true },
  { keys: "RB", action: "ui.controls.altFire", icon: "flowers", hold: true },
  { keys: "Right stick", action: "ui.help.orbit", icon: "camera" },
  { keys: "L3", action: "ui.help.horn", icon: "horn" },
  { keys: "R3", action: "ui.controls.scan", icon: "scan", hold: true },
  { keys: "D-pad ↑", action: "ui.controls.gear", icon: "gear" },
  { keys: "D-pad ↓", action: "ui.controls.streak", icon: "streak" },
  { keys: "Start", action: "ui.help.menu", icon: "menu" },
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
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("fc-help-icon");
    svg.innerHTML = CONTROL_ICONS[row.icon];
    what.append(svg, row.hold ? `${copy(row.action)} ${copy("ui.help.hold")}` : copy(row.action));
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
