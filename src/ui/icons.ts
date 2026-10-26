/** Original line drawings for the HUD; labels belong on the surrounding control. */
const ICON_PATHS = {
  cash: [
    "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
    "M3 9a4 4 0 0 0 4-4m10 0a4 4 0 0 0 4 4M3 15a4 4 0 0 1 4 4m10 0a4 4 0 0 1 4-4",
    "M14.5 12a2.5 3.5 0 1 1-5 0 2.5 3.5 0 1 1 5 0Z",
  ],
  water: [
    "M12 3c-1.5 3.2-6.5 7.8-6.5 11.4a6.5 6.5 0 0 0 13 0C18.5 10.8 13.5 6.2 12 3Z",
    "M9 14.5a3 3 0 0 0 3 3",
  ],
  runway: [
    "M6 3h12M6 21h12",
    "M7 3v3c0 3 5 4.5 5 6s-5 3-5 6v3m10-18v3c0 3-5 4.5-5 6s5 3 5 6v3",
    "m9 18 3-2 3 2",
  ],
  threat: [
    "M6 7h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z",
    "M12 7V3m-2 0h4M2 11v5m20-5v5",
    "M8 11v2m8-2v2m-7 4h6",
  ],
  reputation: [
    "m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4-4.6-4.5 6.4-.9L12 3Z",
  ],
  status: [
    "M15.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 1 1 7 0Z",
    "M5 21v-2a7 7 0 0 1 14 0v2",
  ],
  map: [
    "m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z",
    "M9 3v16m6-14v16",
  ],
  phone: [
    "M7 2.5h10a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2Z",
    "M9 2.5v2h6v-2m-4.5 16h3",
  ],
  shop: [
    "M5 4h14l2 6H3l2-6Z",
    "M3 10v1a2.25 2.25 0 0 0 4.5 0 2.25 2.25 0 0 0 4.5 0 2.25 2.25 0 0 0 4.5 0 2.25 2.25 0 0 0 4.5 0v-1",
    "M5 14v7h14v-7m-10 7v-5h6v5",
  ],
  help: [
    "M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0Z",
    "M9 8.5a3 3 0 0 1 5.8 1c0 2.2-2.8 2.3-2.8 4.5",
    "M12 17.5v.1",
  ],
  performance: [
    "M4 3v17h17",
    "m7 15 4-5 4 3 6-7",
  ],
  sun: [
    "M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 1 1 9 0Z",
    "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5",
  ],
  moon: [
    "M10 3a9.2 9.2 0 1 0 11 11 7.5 7.5 0 0 1-11-11Z",
  ],
  chevronDown: ["m6 9 6 6 6-6"],
  arrowRight: ["M4 12h16m-6-6 6 6-6 6"],
  close: ["m6 6 12 12M6 18 18 6"],
  more: ["M5 12h.01M12 12h.01M19 12h.01"],
} as const;

export type IconName = keyof typeof ICON_PATHS;

const SVG_NS = "http://www.w3.org/2000/svg";

/** A fresh, decorative SVG that inherits its control's color and can be sized in CSS. */
export function createIcon(doc: Document, name: IconName): SVGSVGElement {
  const icon = doc.createElementNS(SVG_NS, "svg");
  for (const [key, value] of Object.entries({
    width: "20", height: "20", viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round",
    "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
    class: "fc-icon", "data-icon": name,
  })) icon.setAttribute(key, value);
  for (const d of ICON_PATHS[name]) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  return icon;
}
