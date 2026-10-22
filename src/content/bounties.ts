// Shared BotBounty templates (content/bounties.json): typed access, rendering and checks.
// District bounty sets live in the district packs (packs.ts).

import bountiesJson from "../../content/bounties.json" with { type: "json" };
import type { Provenance } from "./barks.ts";
import { lintFit } from "./lint.ts";
import { hashString } from "./prng.ts";

export interface BountyTemplate {
  id: string;
  crew: "crew" | "single";
  headline: string;
  lastSeen: string;
  hint: string;
}

export interface BountyFile {
  version: 1;
  crewSize: { min: number; max: number; withinM: number };
  pay: { standard: number; armoured: number; note: string };
  provenance: Provenance;
  templates: BountyTemplate[];
}

export const BOUNTY_TEMPLATES = bountiesJson as unknown as BountyFile;

export const BOUNTY_PLACEHOLDERS = ["model", "place", "tell", "pay"] as const;
export type BountyFill = Record<(typeof BOUNTY_PLACEHOLDERS)[number], string>;

export function bountyTexts(f: BountyFile = BOUNTY_TEMPLATES): string[] {
  return f.templates.map((t) => `${t.headline}|${t.lastSeen}|${t.hint}`);
}

/** Fill a template. The tell goes in lower case, the way a posting says it. */
export function renderBounty(t: BountyTemplate, fill: BountyFill): { headline: string; lastSeen: string; hint: string } {
  const f = (s: string) =>
    s.replace(/\{(model|place|tell|pay)\}/g, (_m, k: keyof BountyFill) => (k === "tell" ? fill.tell.toLowerCase() : fill[k]));
  return { headline: f(t.headline), lastSeen: f(t.lastSeen), hint: f(t.hint) };
}

/**
 * The template for one posting, chosen by keyed hash of the bounty id. A protected area may only
 * post a single baseline robot, so it draws from the single templates.
 */
export function pickBountyTemplate(bountyId: string, inProtectedArea: boolean, f: BountyFile = BOUNTY_TEMPLATES): BountyTemplate {
  const pool = f.templates.filter((t) => (inProtectedArea ? t.crew === "single" : true));
  return pool[hashString(bountyId) % pool.length] as BountyTemplate;
}

export function checkBountyTemplates(f: BountyFile = BOUNTY_TEMPLATES): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const t of f.templates) {
    if (ids.has(t.id)) errs.push(`template ${t.id}: duplicate id`);
    ids.add(t.id);
    for (const s of [t.headline, t.lastSeen, t.hint]) {
      for (const m of s.matchAll(/\{([^}]*)\}/g)) {
        if (!(BOUNTY_PLACEHOLDERS as readonly string[]).includes(m[1] as string)) errs.push(`template ${t.id}: unknown placeholder {${m[1]}}`);
      }
    }
    for (const i of [...lintFit(t.headline, "phone", 48), ...lintFit(t.lastSeen, "phone"), ...lintFit(t.hint, "phone")]) errs.push(`template ${t.id}: ${i.message}`);
    if (t.crew === "single" && /\bcrew\b/i.test(`${t.lastSeen} ${t.hint}`) && !/last of a crew/i.test(t.lastSeen)) errs.push(`template ${t.id}: a single robot is not a crew`);
  }
  return errs;
}
