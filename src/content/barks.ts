// Bark pools (content/barks/*.json) and the district packs' lines: typed access, the keyed-hash
// picker the presentation track uses, and the provenance hash.
//
// Presentation text is picked by a keyed hash of an event id, never from the sim's RNG stream
// (docs/ai-layer.md, Validation), so a replay shows the same line without the sim knowing it.

import robotsJson from "../../content/barks/robots.json" with { type: "json" };
import wetJson from "../../content/barks/wet.json" with { type: "json" };
import { FONT_FIT } from "./lint.ts";
import { hashString } from "./prng.ts";

export interface Bark {
  id: string;
  speaker: string;
  context: string;
  mood: string;
  text: string;
  maxLength: number;
}

export interface Provenance {
  source: "agent" | "batch" | "human";
  authorSession: string;
  contentHash: string;
  reviewedBy: string[];
  review: string;
}

export interface BarkPool {
  version: 1;
  pool: "robots" | "wet";
  provenance: Provenance;
  barks: Bark[];
}

export const ROBOT_BARKS = robotsJson as unknown as BarkPool;
export const WET_BARKS = wetJson as unknown as BarkPool;

/** "fnv1a32:xxxxxxxx" over the texts joined by newlines: edits must update the provenance block. */
export function contentHash(texts: readonly string[]): string {
  return `fnv1a32:${hashString(texts.join("\n")).toString(16).padStart(8, "0")}`;
}

/** Barks matching a speaker and context, in file order. */
export function barksFor(barks: readonly Bark[], speaker: string, context: string): Bark[] {
  return barks.filter((b) => b.speaker === speaker && b.context === context);
}

/**
 * The line for one moment: a keyed hash of `key` (an event id, a robot id plus a tick) picks
 * among the matching barks. Deterministic, no RNG state, no clock. Null when nothing matches.
 */
export function pickBark(barks: readonly Bark[], speaker: string, context: string, key: string): Bark | null {
  const c = barksFor(barks, speaker, context);
  if (c.length === 0) return null;
  return c[hashString(`${speaker}:${context}:${key}`) % c.length] as Bark;
}

/** Counts per "speaker/context", for coverage tests. */
export function coverage(barks: readonly Bark[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of barks) out[`${b.speaker}/${b.context}`] = (out[`${b.speaker}/${b.context}`] ?? 0) + 1;
  return out;
}

/** Structural rules: unique ids, text within its bubble, bubbles within the font-fit limit. */
export function checkBarks(barks: readonly Bark[], where: string): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const b of barks) {
    if (ids.has(b.id)) errs.push(`${where}: duplicate id ${b.id}`);
    ids.add(b.id);
    const norm = b.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (texts.has(norm)) errs.push(`${where}: ${b.id} repeats another line word for word`);
    texts.add(norm);
    if (b.text.length > b.maxLength) errs.push(`${where}: ${b.id} is ${b.text.length} characters, its bubble holds ${b.maxLength}`);
    if (b.maxLength > FONT_FIT.bark) errs.push(`${where}: ${b.id} maxLength ${b.maxLength} exceeds the bubble limit ${FONT_FIT.bark}`);
    if (/\{/.test(b.text)) errs.push(`${where}: ${b.id} has a placeholder; shared barks are plain lines`);
  }
  return errs;
}
