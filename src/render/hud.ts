// HUD: speed (km/h and mph; walking speed on foot), position, streaming and render stats,
// FPS (display only), the in-game clock, a strip compass, and short hints ("no room to get
// out" when F does nothing). Text is rewritten a few times a second, never per frame; the
// compass moves with a CSS transform (no layout).

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

/** The part of PlayerState the hint rule reads. */
export interface ExitHintPlayer {
  mode: "vehicle" | "foot";
  exitPending: boolean;
}

export const HINT_NO_ROOM = "No room to get out";
export const HINT_TOO_FAR = "Too far from your car to get in";

/**
 * The hint to show after one tick, or null: F (enterExit, `pressed`) did nothing. In the car:
 * the sim found no clear spot beside the car, so the player stays in (an exit that was
 * pending ended without getting out, and not because F was pressed again to cancel it). On
 * foot: F did not get the player back in.
 */
export function exitHint(before: ExitHintPlayer | undefined, after: ExitHintPlayer | undefined, pressed: boolean): string | null {
  if (!before || !after) return null;
  if (before.mode === "foot") return pressed && after.mode === "foot" ? HINT_TOO_FAR : null;
  if (after.mode !== "vehicle") return null;
  if (pressed && !before.exitPending && !after.exitPending) return HINT_NO_ROOM;
  if (!pressed && before.exitPending && !after.exitPending) return HINT_NO_ROOM;
  return null;
}

const HINT_MS = 2500;

export class Hud {
  private text: HTMLElement;
  private hintEl: HTMLElement | null = null;
  private hintUntil = 0;
  private readonly doc: Document;
  private strip: HTMLElement | null;
  private label: HTMLElement | null;
  private lastText = 0;
  private lastLabel = "";
  private lastDeg = NaN;

  constructor(doc: Document = document) {
    this.doc = doc;
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
    if (this.hintEl && this.hintUntil > 0 && now > this.hintUntil) {
      this.hintEl.style.display = "none";
      this.hintUntil = 0;
    }
    if (this.strip) {
      const deg = Math.round((((((d.viewHeading * 180) / Math.PI) % 360) + 360) % 360) * 4) / 4;
      if (deg !== this.lastDeg) {
        this.lastDeg = deg;
        this.strip.style.transform = `translateX(${-deg * 2}px)`;
      }
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

  /** Show a short hint near the bottom of the screen for a couple of seconds. */
  hint(msg: string, now: number): void {
    if (!this.hintEl) {
      const el = this.doc.createElement("div");
      el.id = "hint";
      el.setAttribute("role", "status");
      Object.assign(el.style, {
        position: "fixed",
        left: "50%",
        bottom: "48px",
        transform: "translateX(-50%)",
        zIndex: "3",
        font: "13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#f3f5f8",
        background: "rgba(12, 15, 20, 0.72)",
        padding: "6px 12px",
        borderRadius: "3px",
        pointerEvents: "none",
        display: "none",
      });
      this.doc.body.appendChild(el);
      this.hintEl = el;
    }
    this.hintEl.textContent = msg;
    this.hintEl.style.display = "block";
    this.hintUntil = now + HINT_MS;
  }

  /** The hint on screen now, or "" (tests and the debug handle). */
  hintText(): string {
    return this.hintEl && this.hintEl.style.display !== "none" ? (this.hintEl.textContent ?? "") : "";
  }

  error(msg: string): void {
    this.text.textContent = msg;
  }
}
