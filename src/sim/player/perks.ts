import type { CombatPlayer } from "../combat-contract.ts";
import { LOADOUTS } from "../../content/gameplay.ts";
import type { GameplayMode } from "./types.ts";

export interface PerkContext { mode?: GameplayMode; hasCoastline?: boolean; modeRole?: "spotter" | "hider" }
export function enabledPerks(ids: readonly string[], context: PerkContext = {}): string[] {
  const coastline = context.hasCoastline ?? (context.mode === undefined || context.mode === "freeRoam");
  return [...new Set(ids)].filter(id => LOADOUTS.perks.some(perk => perk.id === id) && (id !== "brackish" || coastline));
}

export function combatPerks(ids: readonly string[], context: PerkContext = {}): NonNullable<CombatPlayer["perks"]> {
  const names: Record<string, NonNullable<CombatPlayer["perks"]>[number]> = {
    "marine-layer": "marine", "do-not-disturb": "quiet", "stealth-mode": "stealth",
    lean: "lean", brackish: "brackish", "hydrant-whisperer": "whisperer",
  };
  return enabledPerks(ids, context).flatMap(id => names[id] ? [names[id]!] : []);
}

export function perkChoices(ids: readonly string[], context: PerkContext = {}) {
  const enabled = new Set(enabledPerks(LOADOUTS.perks.map(perk => perk.id), context));
  return LOADOUTS.perks.map(perk => ({ id: perk.id, equipped: ids.includes(perk.id), enabled: enabled.has(perk.id),
    reason: enabled.has(perk.id) ? "" : "This area has no coastline." }));
}
