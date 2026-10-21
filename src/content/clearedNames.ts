// The name search record (content/cleared-names.json) and the game's invented brands
// (content/brands.json): typed access, the lint's view of what is cleared, and the consistency
// rules between the two.

import brandsJson from "../../content/brands.json" with { type: "json" };
import clearedJson from "../../content/cleared-names.json" with { type: "json" };
import type { ClearedNames } from "./lint.ts";

export type Verdict = "clear" | "caution" | "conflict";

export interface NameSearch {
  name: string;
  kind: string;
  usedFor: string;
  searchedOn: string;
  queries: string[];
  findings: string;
  verdict: Verdict;
  note?: string;
  sources: string[];
}

export interface Rename {
  from: string;
  to: string;
  kind: string;
  searchedOn: string;
  queries: string[];
  reason: string;
  sources: string[];
}

export interface ClearedNamesFile {
  version: 1;
  status: "pending user sign-off" | "signed off";
  method: string;
  verdicts: Record<Verdict, string>;
  names: NameSearch[];
  renamed: Rename[];
  generic: Array<{ label: string; why: string }>;
}

export interface GameBrand {
  id: string;
  kind: "company" | "robotModel" | "app" | "station" | "perk" | "accelerator";
  name: string;
  tagline?: string;
  model?: "errand-robot" | "sidewalk-bot" | "robotaxi";
  maker?: string;
  note?: string;
}

export const CLEARED_NAMES_FILE = clearedJson as unknown as ClearedNamesFile;
export const GAME_BRANDS: readonly GameBrand[] = (brandsJson as unknown as { brands: GameBrand[] }).brands;

/** The lint's view: names whose search did not find a conflict, plus the generic labels. */
export function clearedNames(file: ClearedNamesFile = CLEARED_NAMES_FILE): ClearedNames {
  return {
    cleared: new Set(file.names.filter((n) => n.verdict !== "conflict").map((n) => n.name)),
    generic: new Set(file.generic.map((g) => g.label)),
  };
}

export const CLEARED: ClearedNames = clearedNames();

/** A brand's display name by id ("footman" -> "Footman"). Throws on an unknown id. */
export function brandName(id: string): string {
  const b = GAME_BRANDS.find((x) => x.id === id);
  if (!b) throw new Error(`brands: unknown id ${id}`);
  return b.name;
}

/** Rules between the two files that their schemas cannot express. Empty means consistent. */
export function checkClearedNames(file: ClearedNamesFile = CLEARED_NAMES_FILE, brands: readonly GameBrand[] = GAME_BRANDS): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const n of file.names) {
    if (seen.has(n.name)) errs.push(`${n.name}: listed twice`);
    seen.add(n.name);
    if (n.verdict === "conflict") errs.push(`${n.name}: a conflict must be renamed and moved to renamed, not kept in names`);
    if (new Set(n.queries).size !== n.queries.length) errs.push(`${n.name}: repeated query`);
  }
  for (const r of file.renamed) {
    if (seen.has(r.from)) errs.push(`${r.from}: renamed away but still listed as cleared`);
    if (!r.to.startsWith("(") && !seen.has(r.to) && !r.to.startsWith("the ")) errs.push(`${r.from} -> ${r.to}: the new name was not searched`);
  }
  for (const g of file.generic) if (seen.has(g.label)) errs.push(`${g.label}: both generic and a searched name`);
  const ids = new Set<string>();
  for (const b of brands) {
    if (ids.has(b.id)) errs.push(`brand ${b.id}: duplicate id`);
    ids.add(b.id);
    if (!seen.has(b.name)) errs.push(`brand ${b.id}: "${b.name}" is not in cleared-names.json`);
  }
  for (const b of brands) if (b.maker !== undefined && !brands.some((m) => m.id === b.maker && m.kind === "company")) errs.push(`brand ${b.id}: maker ${b.maker} is not a company`);
  return errs;
}
