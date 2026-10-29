import { createIcon, type IconName } from "./icons.ts";
import type { PhoneApp, UiCopy } from "./types.ts";

/** Working apps lead; future apps remain visibly unavailable on the same home screen.
 *  Runway Run (the featured mode) and Taxi shift are action tiles: they start the mode, not a screen. */
export const PHONE_APPS: readonly PhoneApp[] = ["runwayRun", "taxi", "map", "loadout", "botBounty", "botCheck", "bank", "settings", "officeHours", "ride", "radio", "fogcast", "messages", "playlists"];
const EXISTING_ICONS: Partial<Record<PhoneApp, IconName>> = { runwayRun: "runway", map: "map", botBounty: "threat", bank: "cash" };
/** Original companion drawings, in the existing HUD's 24-unit / 1.8-stroke family. */
const APP_PATHS = {
  loadout:["M4 7h16v14H4Z","M8 7V3h8v4M4 12h16m-10 0v3h4v-3"],
  botCheck: ["M7 3H3v4m14-4h4v4M3 17v4h4m14-4v4h-4", "M8 8h8v8H8Z", "m10 12 1.5 1.5L15 10"],
  settings: ["M10 2h4l.6 2.8 2.2 1.3 2.7-.9 2 3.5-2.1 1.9v2.6l2.1 1.9-2 3.5-2.7-.9-2.2 1.3L14 22h-4l-.6-2.8-2.2-1.3-2.7.9-2-3.5 2.1-1.9v-2.6L2.5 8.9l2-3.5 2.7.9 2.2-1.3L10 2Z", "M16 12a4 4 0 1 1-8 0 4 4 0 1 1 8 0Z"],
  taxi: ["M10 2h4v2h-4Z", "m5 9 2-5h10l2 5", "M4 9h16v9H4Z", "M7 13h.01M17 13h.01M7 18v3m10-3v3"],
  ride: ["m5 9 2-5h10l2 5", "M4 9h16v9H4Z", "M7 13h.01M17 13h.01M7 18v3m10-3v3M9 17h6"],
  radio: ["M4 9h16v12H4Z", "m6 9 12-6M8 13h8m-8 4h.01M12 17h4"],
  fogcast: ["M7 13a4 4 0 1 1 1-7 5 5 0 0 1 9 2 3 3 0 1 1 1 5H7Z", "M4 17h16M7 21h10"],
  messages: ["M4 4h16v12H9l-5 4V4Z", "M8 8h8m-8 4h5"],
  playlists: ["M4 5h9M4 9h9M4 13h5", "M16 6v12a3 3 0 1 1-3-3h3M16 6l5-2v4l-5 2"],
  officeHours: ["M4 5h16v16H4Z", "M8 3v4m8-4v4M4 10h16", "M8 14h2m4 0h2m-8 4h2"],
} as const;
const NAV_PATHS = { back: ["M20 12H4m6-6-6 6 6 6"], home: ["m3 11 9-8 9 8", "M5 10v11h5v-7h4v7h5V10"] } as const;
function drawing(doc: Document, paths: readonly string[], name: string): SVGSVGElement {
  const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: "fc-icon", "data-icon": name })) icon.setAttribute(key, value);
  for (const d of paths) { const path = doc.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", d); icon.append(path); }
  return icon;
}
export function createPhoneAppIcon(doc: Document, app: PhoneApp): SVGSVGElement {
  const existing = EXISTING_ICONS[app];
  return existing ? createIcon(doc, existing) : drawing(doc, APP_PATHS[app as keyof typeof APP_PATHS], `phone-${app}`);
}
export function phoneAppLabel(app: PhoneApp, copy: UiCopy): string {
  return app === "officeHours" ? "Office Hours" : app === "taxi" ? "Taxi shift" : app === "runwayRun" ? copy("ui.runway.title") : copy(`ui.phone.${app}`);
}

export interface PhoneShellOptions {
  readonly app?: PhoneApp;
  readonly copy: UiCopy;
  readonly streetName?: string;
  readonly tick?: number;
  readonly onHome: () => void;
  readonly onClose: () => void;
}
/** Phone chrome owns navigation and layout; app screens keep their existing controllers. */
export function createPhoneShell(doc: Document, options: PhoneShellOptions): { status: HTMLElement; location: HTMLElement; header: HTMLElement; body: HTMLElement; footer: HTMLElement } {
  const status = doc.createElement("div"), brand = doc.createElement("span"), location = doc.createElement("span");
  status.className = "fc-phone-status"; status.dataset.tick = String(options.tick ?? 0);
  brand.textContent = "Fog City"; location.className = "fc-phone-location"; location.textContent = options.streetName ?? "";
  status.append(brand, location);
  const header = doc.createElement("header"), title = doc.createElement("h1"); header.className = "fc-phone-header";
  title.id = "fc-dialog-title"; title.textContent = options.app ? phoneAppLabel(options.app, options.copy) : options.copy("ui.phone.title");
  header.append(title);
  if (options.app) {
    const home = doc.createElement("button"); home.type = "button"; home.className = "fc-phone-apps-link";
    home.textContent = options.copy("ui.map.phoneApps"); home.addEventListener("click", options.onHome); header.append(home);
  }
  const close = doc.createElement("button"); close.type = "button"; close.className = "fc-icon-button";
  close.setAttribute("aria-label", options.copy("ui.common.close")); close.title = options.copy("ui.phone.close");
  close.append(createIcon(doc, "close")); close.addEventListener("click", options.onClose); header.append(close);
  const body = doc.createElement("div"); body.className = "fc-phone-body"; body.dataset.screen = options.app ?? "home";
  const footer = doc.createElement("nav"); footer.className = "fc-phone-navigation"; footer.setAttribute("aria-label", "Phone navigation");
  for (const key of ["back", "home"] as const) {
    const button = doc.createElement("button"), text = doc.createElement("span"); button.type = "button"; button.className = "fc-phone-nav-button";
    text.textContent = key === "back" ? options.copy("ui.common.back") : "Home";
    button.setAttribute("aria-label", key === "back" ? options.copy("ui.common.back") : "Phone home");
    if (key === "back") button.disabled = !options.app;
    if (key === "home" && !options.app) button.setAttribute("aria-current", "page");
    button.append(drawing(doc, NAV_PATHS[key], `phone-${key}`), text); button.addEventListener("click", options.onHome); footer.append(button);
  }
  return { status, location, header, body, footer };
}
