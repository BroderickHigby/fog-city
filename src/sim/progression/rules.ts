import { LOADOUTS, PROGRESSION, STREAKS } from "../../content/gameplay.ts";
import type { Progression } from "../player/types.ts";

export type StreakId = "confidence" | "parrots" | "tensor" | "blimp" | "hydrants" | "agi";
const STREAK_ALIAS: Readonly<Record<string, StreakId>> = {
  confidence: "confidence", "confidence-score": "confidence",
  parrots: "parrots", "buzzword-parrots": "parrots",
  tensor: "tensor", "tensor-brick-drop": "tensor",
  blimp: "blimp", "blimp-impressions": "blimp",
  hydrants: "hydrants", "open-hydrants": "hydrants",
  agi: "agi", "agi-allegedly": "agi",
};
const GADGET_ALIAS: Readonly<Record<string, string>> = {
  balloon: "water-balloon", "water-balloon": "water-balloon",
  sprinkler: "lawn-sprinkler", "lawn-sprinkler": "lawn-sprinkler",
  speaker: "decoy-speaker", "decoy-speaker": "decoy-speaker",
};
const GADGET_RUNTIME: Readonly<Record<string, Progression["gadget"]>> = {
  "water-balloon": "balloon", "lawn-sprinkler": "sprinkler", "decoy-speaker": "speaker",
};
const GEAR_ALIAS: Readonly<Record<string, string>> = {
  none: "none", boots: "rubber-boots", "rubber-boots": "rubber-boots",
  airplane: "airplane-mode", "airplane-mode": "airplane-mode",
  microclimate: "microclimate",
};
const GEAR_RUNTIME: Readonly<Record<string, Progression["gear"]>> = {
  none: "none", "rubber-boots": "boots", "airplane-mode": "airplane", microclimate: "microclimate",
};
const NOZZLE_ALIAS: Readonly<Record<string, string>> = {
  standard: "standard-nozzle", "standard-nozzle": "standard-nozzle",
  wide: "wide-nozzle", "wide-nozzle": "wide-nozzle",
  "nozzle-pressure":"pressure-nozzle",
  pressure: "pressure-nozzle", "pressure-nozzle": "pressure-nozzle",
};
const NOZZLE_RUNTIME: Readonly<Record<string, Progression["nozzle"]>> = {
  "standard-nozzle": "standard", "wide-nozzle": "wide", "pressure-nozzle": "pressure",
};
const PERK_ALIAS: Readonly<Record<string, string>> = {
  marine: "marine-layer", quiet: "do-not-disturb", stealth: "stealth-mode",
  alive: "default-alive", whisperer: "hydrant-whisperer",
};
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined;

export function normalizeStreakId(id: string): StreakId | null {
  return own(STREAK_ALIAS, id) ?? null;
}

/** Combat keeps the short IDs; point thresholds come only from the authored reward catalog. */
export const STREAK_COST: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(
  STREAKS.rewards.map((reward) => [normalizeStreakId(reward.id)!, reward.threshold]),
));
export const STREAK_REWARDS = STREAKS.rewards.map((reward) => ({ ...reward, runtimeId: normalizeStreakId(reward.id)! }));

export type LoadoutChoice =
  | { kind: "nozzle"; value: Progression["nozzle"]; rank: number; requiresOwnership: boolean }
  | { kind: "gadget"; value: Progression["gadget"]; rank: number }
  | { kind: "gear"; value: Progression["gear"]; rank: number }
  | { kind: "perk"; value: string; rank: number }
  | { kind: "streak"; value: StreakId; rank: number };

/** All aliases go through the same catalog lookup and therefore the same unlock gate. */
export function normalizeLoadoutChoice(id: string): LoadoutChoice | null {
  const nozzleId = own(NOZZLE_ALIAS, id);
  if (nozzleId === "standard-nozzle") return { kind: "nozzle", value: "standard", rank: 1, requiresOwnership: false };
  const nozzle = PROGRESSION.upgrades.find((row) => row.id === nozzleId && row.kind === "nozzle");
  if (nozzle) return { kind: "nozzle", value: NOZZLE_RUNTIME[nozzle.id]!, rank: nozzle.rank, requiresOwnership: true };
  const gadget = LOADOUTS.gadgets.find((row) => row.id === own(GADGET_ALIAS, id));
  if (gadget) return { kind: "gadget", value: GADGET_RUNTIME[gadget.id]!, rank: gadget.rank };
  const gearId = own(GEAR_ALIAS, id);
  if (gearId === "none") return { kind: "gear", value: "none", rank: 1 };
  const gear = LOADOUTS.gear.find((row) => row.id === gearId);
  if (gear) return { kind: "gear", value: GEAR_RUNTIME[gear.id]!, rank: (gear as { rank?: number }).rank ?? ({"rubber-boots":8,"airplane-mode":20,microclimate:1}[gear.id]??1) };
  const perkId = own(PERK_ALIAS, id) ?? id;
  const perk = LOADOUTS.perks.find((row) => row.id === perkId);
  if (perk) return { kind: "perk", value: perk.id, rank: 1 };
  const streak = normalizeStreakId(id);
  if (streak && STREAK_REWARDS.some((row) => row.runtimeId === streak)) return { kind: "streak", value: streak, rank: 1 };
  return null;
}

export function loadoutSlots(kind: "perkSlots" | "streakSlots", rank: number, wave: number): number {
  if (wave < 4) return kind === "perkSlots" ? 0 : 1;
  const unlocked = PROGRESSION.gates.filter((gate) => gate.kind === kind && gate.rank <= rank)
    .reduce((n, gate) => Math.max(n, gate.value), 0);
  return Math.min(unlocked, kind === "perkSlots" ? LOADOUTS.slots.perk : Math.min(LOADOUTS.slots.streak, STREAKS.equippedSlots));
}

export function streakPointsFor(mode: string | undefined, outcome: string): number {
  const table = STREAKS.modes.find((row) => row.id === (mode ?? "freeRoam"));
  return table ? (table.points as Readonly<Record<string, number | undefined>>)[outcome] ?? 0 : 0;
}

export function streakResetsOn(mode: string | undefined, outcome: string): boolean {
  const table = STREAKS.modes.find((row) => row.id === (mode ?? "freeRoam"));
  return table?.resetOn.some((name) => name === outcome) ?? false;
}
