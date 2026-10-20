// HUD: speed (km/h and mph), position, streaming and render stats, FPS (display only), the
// in-game clock, and a strip compass. Text is rewritten a few times a second, never per
// frame; the compass moves with a CSS transform (no layout).

import { toLatLon } from "../geo/project.ts";
import { formatClock } from "./clock.ts";

export interface HudData {
  world: string;
  speedMps: number;
  x: number;
  z: number;
  onFoot: boolean;
  tilesReady: number;
  tilesTotal: number;
  tilesPending: number;
  drawCalls: number;
  triangles: number;
  fps: number;
  cameraMode: string;
  night: boolean;
  minuteOfDay: number;
  viewHeading: number;
}

const MPS_TO_KMH = 3.6;
const MPS_TO_MPH = 2.2369362920544;

function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function compassPoint(headingRad: number): string {
  const deg = ((((headingRad * 180) / Math.PI) % 360) + 360) % 360;
  return POINTS[Math.round(deg / 45) % 8]!;
}

export function hudText(d: HudData): string {
  const kmh = Math.abs(d.speedMps) * MPS_TO_KMH;
  const mph = Math.abs(d.speedMps) * MPS_TO_MPH;
  const ll = toLatLon(d.x, d.z);
  const pending = d.tilesPending > 0 ? ` (+${d.tilesPending} loading)` : "";
  return (
    `Fog City · ${d.world} · ${formatClock(d.minuteOfDay)}${d.night ? " night" : ""}\n` +
    `${kmh.toFixed(0).padStart(3)} km/h  ${mph.toFixed(0).padStart(3)} mph${d.onFoot ? "  on foot" : ""}\n` +
    `x ${d.x.toFixed(1)}  z ${d.z.toFixed(1)}  ${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}\n` +
    `tiles ${d.tilesReady}/${d.tilesTotal}${pending}  calls ${d.drawCalls}  tris ${fmtCount(d.triangles)}  ${d.fps.toFixed(0)} fps\n` +
    `cam ${d.cameraMode} · C camera · V fly · N night`
  );
}

export class Hud {
  private text: HTMLElement;
  private strip: HTMLElement | null;
  private label: HTMLElement | null;
  private lastText = 0;
  private lastLabel = "";

  constructor(doc: Document = document) {
    this.text = doc.getElementById("hud") ?? doc.body.appendChild(doc.createElement("div"));
    const compass = doc.getElementById("compass");
    this.strip = compass?.querySelector<HTMLElement>(".strip") ?? null;
    this.label = compass?.querySelector<HTMLElement>(".label") ?? null;
    if (this.strip && this.strip.childElementCount === 0) this.buildStrip(doc);
  }

  /** Ticks every 15 degrees over three turns, so the strip can scroll without wrapping. */
  private buildStrip(doc: Document): void {
    const strip = this.strip!;
    for (let k = -360; k <= 720; k += 15) {
      const deg = ((k % 360) + 360) % 360;
      const el = doc.createElement("span");
      el.className = deg % 45 === 0 ? "tick major" : "tick";
      el.style.left = `${k * 2}px`;
      el.textContent = deg % 45 === 0 ? POINTS[deg / 45]! : deg % 15 === 0 ? "·" : "";
      strip.appendChild(el);
    }
  }

  update(now: number, d: HudData): void {
    if (this.strip) {
      const deg = ((((d.viewHeading * 180) / Math.PI) % 360) + 360) % 360;
      this.strip.style.transform = `translateX(${-deg * 2}px)`;
    }
    if (now - this.lastText < 200) return;
    this.lastText = now;
    this.text.textContent = hudText(d);
    if (this.label) {
      const deg = Math.round(((((d.viewHeading * 180) / Math.PI) % 360) + 360) % 360) % 360;
      const s = `${deg.toString().padStart(3, "0")}° ${compassPoint(d.viewHeading)}`;
      if (s !== this.lastLabel) {
        this.label.textContent = s;
        this.lastLabel = s;
      }
    }
  }

  error(msg: string): void {
    this.text.textContent = msg;
  }
}
