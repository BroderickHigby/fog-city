import { describe, expect, it } from "vitest";
import { SITES } from "../../../src/content/places.ts";
import { toLocal } from "../../../src/geo/project.ts";
import type { SimState } from "../../../src/sim/contract.ts";
import type { JsonObject } from "../../../src/sim/extensions.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { runtimeOwnedSafehouses, runtimeReputations } from "../../../src/sim/agents/runtime-economy.ts";
import { enableAgentRuntime, runtimeRestoreSafehouses } from "../../../src/sim/agents/runtime-state.ts";

function wallet(reputation = 50, ownedSiteIds: string[] = []): JsonObject {
  return { cashCents: 200000, runwayMonths: 18, reputation, paidActorIds: [], ownedItemIds: [], ownedSiteIds, commandSequence: 0 };
}
function economy(players: JsonObject, tick = 0): JsonObject { return { version: 1, tick, nextId: 1, players }; }
function state(source?: JsonObject): SimState {
  const result = createInitialState(buildWorld([]), 17, ["p", "q"], { x: 0, z: 0, heading: 0 });
  return source === undefined ? result : { ...result, ext: { ...result.ext, economy: source } };
}
const early = SITES.find(site => site.kind === "safehouse" && site.wave <= 2)!;
const late = SITES.find(site => site.kind === "safehouse" && site.wave > 2)!;
const garage = SITES.find(site => site.kind === "garage")!;

describe("authoritative runtime economy inputs", () => {
  it("prefers actual wallet reputation per active player, preserving explicit fallback only where absent", () => {
    const current = state(economy({ p: wallet(73) }));
    expect(runtimeReputations(current, { p: 12, q: 62 })).toEqual({ p: 73, q: 62 });
    expect(runtimeReputations(current)).toEqual({ p: 73 });
    expect(runtimeReputations(state())).toEqual({});
    expect(runtimeReputations(state(), { p: 9, departed: 100 })).toEqual({ p: 9 });
  });

  it("ignores malformed, future, or unsupported economy data instead of inventing wallets", () => {
    for (const source of [economy({ p: { ...wallet(90), cashCents: -1 } }), economy({ p: { ...wallet(90), ownedSiteIds: [1] } }),
      economy({ p: wallet(90) }, 1), { ...economy({ p: wallet(90) }), version: 2 }, economy({ p: { reputation: 90 } })]) {
      expect(runtimeReputations(state(source), { p: 23 })).toEqual({ p: 23 });
      expect(runtimeOwnedSafehouses(state(source), 8)).toEqual([]);
    }
    expect(() => runtimeReputations(state(), { p: 101 })).toThrow();
    expect(() => runtimeReputations(state(), { p: NaN })).toThrow();
    expect(() => runtimeReputations(state(), null)).toThrow();
  });

  it("uses only owned available safehouses, never garages, unknown sites, absent players, or default ownership", () => {
    const current = state(economy({ p: wallet(50, [early.id, early.id, late.id, garage.id, "unknown"]),
      departed: wallet(90, SITES.map(site => site.id)) }));
    expect(runtimeOwnedSafehouses(current, 2)).toEqual([{ id: early.id, ...toLocal(early.lat, early.lon), radiusM: 25 }]);
    expect(runtimeOwnedSafehouses(current, 8).map(site => site.id)).toEqual([early.id, late.id].sort());
    expect(runtimeOwnedSafehouses(state(), 8)).toEqual([]);
    expect(() => runtimeOwnedSafehouses(current, 9)).toThrow();
  });

  it("unions explicit restoration sites with actual ownership and keeps catalog coordinates authoritative", () => {
    const manual = { id: "authored-test-site", x: 10, z: 20, radiusM: 3 };
    const current = enableAgentRuntime(state(economy({ p: wallet(50, [early.id, late.id]) })), {
      wave: 2, restoreSafehouses: [manual, { id: early.id, x: 999, z: 999 }] });
    expect(runtimeRestoreSafehouses(current)).toEqual([manual,
      { id: early.id, ...toLocal(early.lat, early.lon), radiusM: 25 }].sort((a, b) => a.id.localeCompare(b.id)));
    const unlocked = { ...current, ext: { ...current.ext, robots: { ...current.ext.robots!, wave: 8 } } };
    expect(runtimeRestoreSafehouses(unlocked).map(site => site.id)).toContain(late.id);
    expect(runtimeRestoreSafehouses(state(economy({ p: wallet(50, [early.id]) })))).toEqual([]);
  });

  it("does not suppress invalid explicit configuration when owned sites are available", () => {
    expect(() => enableAgentRuntime(state(economy({ p: wallet(50, [early.id]) })), {
      restoreSafehouses: [{ id: "invalid", x: Infinity, z: 0 }] })).toThrow();
  });

  it("is replayable, stable under input order, and leaves wallet and catalog untouched", () => {
    const current = state(economy({ q: wallet(60, [late.id]), p: wallet(70, [early.id]) })), snapshot = JSON.stringify(current), catalog = JSON.stringify(SITES);
    const reordered = state(economy({ p: wallet(70, [early.id]), q: wallet(60, [late.id]) }));
    expect(runtimeOwnedSafehouses(current, 8)).toEqual(runtimeOwnedSafehouses(reordered, 8));
    expect(runtimeReputations(current)).toEqual(runtimeReputations(JSON.parse(snapshot) as SimState));
    expect(JSON.stringify(current)).toBe(snapshot);
    expect(JSON.stringify(SITES)).toBe(catalog);
  });
});
