// Read the published economy snapshot without constructing default wallets or ownership.
import { SITES } from "../../content/places.ts";
import { toLocal } from "../../geo/project.ts";
import { sortedIds } from "../contract.ts";
import type { SimState } from "../contract.ts";
import type { RuntimeRestoreSafehouse } from "./runtime-state.ts";

const MAX_REPUTATION_PLAYERS = 24;
const MAX_WALLET_IDS = 4096;
interface WalletView { readonly reputation: number; readonly ownedSiteIds: readonly string[] }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_WALLET_IDS &&
    value.every(id => typeof id === "string" && id.length > 0 && id.length <= 256);
}
function wallet(value: unknown): WalletView | null {
  const source = object(value);
  if (!source || typeof source.reputation !== "number" || !Number.isFinite(source.reputation) || source.reputation < 0 || source.reputation > 100 ||
      typeof source.cashCents !== "number" || !Number.isSafeInteger(source.cashCents) || source.cashCents < 0 ||
      typeof source.runwayMonths !== "number" || !Number.isFinite(source.runwayMonths) || source.runwayMonths < 0 || source.runwayMonths > 18 ||
      typeof source.commandSequence !== "number" || !Number.isSafeInteger(source.commandSequence) || source.commandSequence < 0 ||
      !ids(source.paidActorIds) || !ids(source.ownedItemIds) || !ids(source.ownedSiteIds)) return null;
  return { reputation: source.reputation, ownedSiteIds: source.ownedSiteIds };
}
function wallets(state: Readonly<SimState>): Record<string, unknown> | null {
  const source = object(state.ext.economy);
  if (!source || source.version !== 1 || typeof source.tick !== "number" || !Number.isSafeInteger(source.tick) ||
      source.tick < 0 || source.tick > state.tick) return null;
  return object(source.players);
}

/** Actual valid wallet reputation overrides the explicit legacy/test fallback per player. */
export function runtimeReputations(state: Readonly<SimState>, fallback?: unknown): Record<string, number> {
  const output: Record<string, number> = Object.create(null) as Record<string, number>;
  const live = new Set(sortedIds(state.players));
  if (fallback !== undefined) {
    const source = object(fallback);
    if (!source) throw new RangeError("Invalid robot reputation context");
    const players = sortedIds(source);
    if (players.length > MAX_REPUTATION_PLAYERS) throw new RangeError("Robot reputation context capacity exceeded");
    for (const id of players) {
      const value = source[id];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new RangeError("Invalid robot reputation");
      if (live.has(id)) output[id] = value;
    }
  }
  const source = wallets(state);
  if (source) for (const id of sortedIds(state.players)) {
    const actual = wallet(source[id]);
    if (actual) output[id] = actual.reputation;
  }
  return output;
}

/** Only live players' actually owned, available catalog safehouses; garages are excluded. */
export function runtimeOwnedSafehouses(state: Readonly<SimState>, wave: number): RuntimeRestoreSafehouse[] {
  if (!Number.isInteger(wave) || wave < 2 || wave > 8) throw new RangeError("Invalid safehouse wave");
  const source = wallets(state), owned = new Set<string>();
  if (!source) return [];
  for (const id of sortedIds(state.players)) {
    const actual = wallet(source[id]);
    if (actual) for (const siteId of actual.ownedSiteIds) owned.add(siteId);
  }
  return SITES.filter(site => site.kind === "safehouse" && site.wave <= wave && owned.has(site.id))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(site => ({ id: site.id, ...toLocal(site.lat, site.lon), radiusM: 25 }));
}
