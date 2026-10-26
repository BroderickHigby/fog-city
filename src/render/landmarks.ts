// Landmark placement (content/landmarks.json, schemas/landmarks.schema.json) and clock-hand
// maths. Pure: the scene applies the results to three.js objects.
//
// Placement: the model's origin goes to toLocal(lat, lon) on the ground, rotated so a model
// that faces -z (north) at rest faces headingDeg (compass, clockwise from north), scaled
// uniformly by `scale` (default 1).
//
// Clock hands: a node is a clock hand when its glTF extras say so ({"clockHand": "hour"})
// or its name says so ("ClockHourHand", "hand_minute", "clock.hand.second.N"). A hand turns
// clockwise, as seen from in front of the face, about its local +Z axis (or extras
// "clockAxis": [x, y, z]); at rest it points at 12.

import { toLocal } from "../geo/project.ts";
import type { GroundFn } from "./types.ts";

export interface LandmarkEntry {
  id: string;
  model: string;
  lat: number;
  lon: number;
  headingDeg: number;
  scale?: number;
  replacesBuildingIds?: string[];
  collider?: Array<[number, number]>;
  viewpoint?: { lat: number; lon: number };
}

export interface LandmarkPlacement {
  id: string;
  /** URL path relative to the site root, e.g. "models/ferry-building.glb". */
  url: string;
  x: number;
  y: number;
  z: number;
  /** Apply as object.rotation.y. */
  rotationY: number;
  scale: number;
  replaces: string[];
}

const DEG = Math.PI / 180;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Read a landmarks document defensively. Entries missing a required field are skipped
 * (and reported), never thrown on: the file is produced by another track and may be
 * mid-edit. A missing or malformed document yields no landmarks.
 */
export function parseLandmarks(doc: unknown): { entries: LandmarkEntry[]; skipped: string[] } {
  const entries: LandmarkEntry[] = [];
  const skipped: string[] = [];
  const list = (doc as { landmarks?: unknown } | null)?.landmarks;
  if (!Array.isArray(list)) return { entries, skipped };
  list.forEach((raw: unknown, i) => {
    const e = raw as Partial<LandmarkEntry> | null;
    const label = typeof e?.id === "string" ? e.id : `#${i}`;
    if (!e || typeof e.id !== "string" || typeof e.model !== "string" || e.model.length === 0) {
      skipped.push(label);
      return;
    }
    if (!finite(e.lat) || !finite(e.lon) || !finite(e.headingDeg)) {
      skipped.push(label);
      return;
    }
    const out: LandmarkEntry = { id: e.id, model: e.model, lat: e.lat, lon: e.lon, headingDeg: e.headingDeg };
    if (finite(e.scale) && e.scale > 0) out.scale = e.scale;
    if (Array.isArray(e.replacesBuildingIds)) out.replacesBuildingIds = e.replacesBuildingIds.filter((s) => typeof s === "string");
    if(e.viewpoint&&finite(e.viewpoint.lat)&&finite(e.viewpoint.lon))out.viewpoint={lat:e.viewpoint.lat,lon:e.viewpoint.lon};
    entries.push(out);
  });
  return { entries, skipped };
}

/** "public/models/x.glb", "/models/x.glb" and "models/x.glb" all mean models/x.glb. */
export function modelUrl(model: string): string {
  let m = model.trim().replace(/\\/g, "/");
  while (m.startsWith("./")) m = m.slice(2);
  while (m.startsWith("/")) m = m.slice(1);
  if (m.startsWith("public/")) m = m.slice("public/".length);
  return m;
}

export function placeLandmark(e: LandmarkEntry, ground: GroundFn): LandmarkPlacement {
  const { x, z } = toLocal(e.lat, e.lon);
  const y = ground(x, z);
  return {
    id: e.id,
    url: modelUrl(e.model),
    x,
    y: Number.isFinite(y) ? y : 0,
    z,
    rotationY: -e.headingDeg * DEG,
    scale: e.scale !== undefined && e.scale > 0 ? e.scale : 1,
    replaces: e.replacesBuildingIds ?? [],
  };
}

export type ClockHandKind = "hour" | "minute" | "second";

function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Classify a node as a clock hand from its extras (userData) or its name. */
export function clockHandKind(name: string, userData?: Record<string, unknown> | null): ClockHandKind | null {
  const declared = userData?.clockHand;
  if (declared === "hour" || declared === "minute" || declared === "second") return declared;
  const lower = name.toLowerCase();
  const t = tokens(name);
  const isHand = t.some((w) => w === "hand" || w === "hands") || /(hour|minute|second)hand/.test(lower);
  if (!isHand) return null;
  if (t.some((w) => w === "second" || w === "seconds" || w === "sec") || lower.includes("secondhand")) return "second";
  if (t.some((w) => w === "minute" || w === "minutes" || w === "min") || lower.includes("minutehand")) return "minute";
  if (t.some((w) => w === "hour" || w === "hours" || w === "hr") || lower.includes("hourhand")) return "hour";
  return null;
}

/** The axis a hand turns about, from extras "clockAxis", else local +Z. Always unit length. */
export function clockHandAxis(userData?: Record<string, unknown> | null): [number, number, number] {
  const a = userData?.clockAxis;
  if (Array.isArray(a) && a.length === 3 && a.every(finite)) {
    const [x, y, z] = a as [number, number, number];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-9) return [x / len, y / len, z / len];
  }
  return [0, 0, 1];
}

/**
 * Clockwise angle of each hand from 12 o'clock, radians in [0, 2pi), for a time given as
 * minutes since midnight (fractions allowed). The hour hand moves continuously.
 */
export function clockHandAngles(minuteOfDay: number): Record<ClockHandKind, number> {
  const TAU = Math.PI * 2;
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  const hour = ((m / 60) % 12) / 12;
  const minute = (m % 60) / 60;
  const second = ((m * 60) % 60) / 60;
  return { hour: hour * TAU, minute: minute * TAU, second: second * TAU };
}

/**
 * Rotation to apply about the hand's axis (right-handed, radians): clockwise as seen from
 * in front of the face (looking along -axis) is a negative rotation about +axis.
 */
export function clockHandRotation(kind: ClockHandKind, minuteOfDay: number): number {
  return -clockHandAngles(minuteOfDay)[kind];
}
