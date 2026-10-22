// Vendor items and prices (content/vendor.json): typed access, what a purchase changes, and the
// consistency rules with docs/design.md's economy.

import vendorJson from "../../content/vendor.json" with { type: "json" };
import { SITES } from "./places.ts";

export interface VendorItem {
  id: string;
  name: string;
  kind: "tank" | "flow" | "food";
  tier?: number;
  priceCents: number;
  wave: number;
  requires?: string;
  effect: { tankL?: number; flowLps?: number; runwayMonths?: number };
  blurb: string;
}

export interface VendorFile {
  version: 1;
  base: { tankL: number; flowLps: number; particleL: number; runwayMaxMonths: number; startCashCents: number };
  limits: { tankMaxL: number; flowMaxLps: number; upgradeMinCents: number; upgradeMaxCents: number };
  items: VendorItem[];
  vendors: Array<{ id: string; site: string; label: string; wave: number; items: string[] }>;
}

export const VENDOR = vendorJson as unknown as VendorFile;

export function vendorItem(id: string, f: VendorFile = VENDOR): VendorItem {
  const i = f.items.find((x) => x.id === id);
  if (!i) throw new Error(`vendor: unknown item ${id}`);
  return i;
}

/** Particles per second at a flow (the sim's stream is deterministic particles of particleL litres). */
export function particlesPerSecond(flowLps: number, f: VendorFile = VENDOR): number {
  return flowLps / f.base.particleL;
}

export interface Loadout {
  cashCents: number;
  runwayMonths: number;
  tankL: number;
  flowLps: number;
  owned: string[];
}

/** What buying `id` does, or why it cannot be bought. Pure; the sim applies the same rule. */
export function buy(l: Loadout, id: string, wave: number, f: VendorFile = VENDOR): Loadout | { refused: string } {
  const i = vendorItem(id, f);
  if (i.wave > wave) return { refused: "not yet" };
  if (l.cashCents < i.priceCents) return { refused: "cash" };
  if (i.requires && !l.owned.includes(i.requires)) return { refused: `needs ${i.requires}` };
  if (i.kind !== "food" && l.owned.includes(i.id)) return { refused: "owned" };
  const next: Loadout = { ...l, cashCents: l.cashCents - i.priceCents, owned: i.kind === "food" ? l.owned : [...l.owned, i.id] };
  if (i.effect.tankL !== undefined) next.tankL = Math.max(l.tankL, i.effect.tankL);
  if (i.effect.flowLps !== undefined) next.flowLps = Math.max(l.flowLps, i.effect.flowLps);
  if (i.effect.runwayMonths !== undefined) next.runwayMonths = Math.min(f.base.runwayMaxMonths, l.runwayMonths + i.effect.runwayMonths);
  return next;
}

export function checkVendor(f: VendorFile = VENDOR): string[] {
  const errs: string[] = [];
  const ids = new Set(f.items.map((i) => i.id));
  for (const i of f.items) {
    if (i.requires && !ids.has(i.requires)) errs.push(`item ${i.id}: requires unknown ${i.requires}`);
    if (i.kind !== "food" && (i.priceCents < f.limits.upgradeMinCents || i.priceCents > f.limits.upgradeMaxCents)) errs.push(`item ${i.id}: an upgrade costs $500-8,000`);
    if (i.effect.tankL !== undefined && (i.effect.tankL <= f.base.tankL || i.effect.tankL > f.limits.tankMaxL)) errs.push(`item ${i.id}: tank must be above ${f.base.tankL} L and at most ${f.limits.tankMaxL} L`);
    if (i.effect.flowLps !== undefined && (i.effect.flowLps <= f.base.flowLps || i.effect.flowLps > f.limits.flowMaxLps)) errs.push(`item ${i.id}: flow must be above ${f.base.flowLps} and at most ${f.limits.flowMaxLps} L/s`);
    if ((i.kind === "tank") !== (i.effect.tankL !== undefined) || (i.kind === "flow") !== (i.effect.flowLps !== undefined) || (i.kind === "food") !== (i.effect.runwayMonths !== undefined)) errs.push(`item ${i.id}: effect does not match kind ${i.kind}`);
  }
  const tanks = f.items.filter((i) => i.kind === "tank").sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
  for (let k = 1; k < tanks.length; k++) {
    const a = tanks[k - 1] as VendorItem;
    const b = tanks[k] as VendorItem;
    if ((b.effect.tankL ?? 0) <= (a.effect.tankL ?? 0) || b.priceCents <= a.priceCents) errs.push(`tank tiers must grow in size and price: ${a.id} -> ${b.id}`);
    if (b.requires !== a.id) errs.push(`${b.id} must require ${a.id}`);
  }
  for (const v of f.vendors) {
    if (!SITES.some((s) => s.id === v.site)) errs.push(`vendor ${v.id}: unknown site ${v.site}`);
    for (const id of v.items) if (!ids.has(id)) errs.push(`vendor ${v.id}: unknown item ${id}`);
  }
  return errs;
}
