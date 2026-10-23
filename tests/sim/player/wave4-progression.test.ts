import { describe, expect, it } from "vitest";
import { LOADOUTS, PROGRESSION, STREAKS } from "../../../src/content/gameplay.ts";
import { createProgression, createProgressionPlayer, stepProgression } from "../../../src/sim/progression/system.ts";
import { normalizeLoadoutChoice, normalizeStreakId, STREAK_COST, streakPointsFor } from "../../../src/sim/progression/rules.ts";
import type { GameplayContext, GameplayEvent, Progression, ProgressionState } from "../../../src/sim/player/types.ts";

function context(overrides: Partial<GameplayContext> = {}): GameplayContext {
  return { wave: 4, bodies: [{ id: "p", x: 0, y: 0, z: 0, mode: "foot", speed: 0 }], observations: [], actors: [], facts: [], commands: [], missions: [], items: [], sites: [], directorCards: [], activities: [], validKitIds: [], day: 1, month: 1, ...overrides };
}
function atRank(rank: number, overrides: Partial<Progression> = {}): ProgressionState {
  const state = createProgression();
  state.players.p = { ...createProgressionPlayer(), xp: PROGRESSION.ranks.find((r) => r.rank === rank)!.totalXp, rank, ...overrides };
  return state;
}
function grant(id: number, kind = "bounty.paid", overrides: Partial<GameplayEvent> = {}): GameplayEvent {
  return { id, tick: 1, kind, playerId: "p", targetId: "bad", amount: 0, detail: "", ...overrides };
}
function choose(state: ProgressionState, itemId: string, sequence = 1): ProgressionState {
  return stepProgression(state, context({ commands: [{ playerId: "p", kind: "loadout", itemId, sequence }] }), sequence, {});
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { Object.freeze(v); for (const child of Object.values(v)) freeze(child); }
  return v;
}

describe("wave 4 authored loadout gates", () => {
  for (const [canonical, legacy, previous] of [
    ["lawn-sprinkler", "sprinkler", "balloon"],
    ["decoy-speaker", "speaker", "balloon"],
  ] as const) {
    it(`${canonical} and ${legacy} obey the same authored rank gate`, () => {
      const required = LOADOUTS.gadgets.find((g) => g.id === canonical)!.rank;
      for (const id of [canonical, legacy]) {
        const locked = choose(atRank(required - 1, { gadget: previous }), id);
        expect(locked.players.p!.gadget).not.toBe(legacy);
        const unlocked = choose(atRank(required, { gadget: previous }), id);
        expect(unlocked.players.p!.gadget).toBe(legacy);
      }
    });
  }
  it("the base balloon keeps its legacy issued state while both equip aliases carry rank five", () => {
    expect(normalizeLoadoutChoice("water-balloon")).toEqual({ kind: "gadget", value: "balloon", rank: 5 });
    expect(normalizeLoadoutChoice("balloon")).toEqual(normalizeLoadoutChoice("water-balloon"));
    expect(stepProgression(atRank(1), context(), 1, {}).players.p!.gadget).toBe("balloon");
  });
  it("gear aliases obey the same catalog policy, with no invented unlock rank", () => {
    for (const [canonical, legacy] of [["rubber-boots", "boots"], ["airplane-mode", "airplane"]] as const) {
      expect(choose(atRank(1), canonical).players.p!.gear).toBe(legacy);
      expect(choose(atRank(1), legacy).players.p!.gear).toBe(legacy);
    }
  });
  it("preserves the wave-2 issued balloon but does not allow wave-4 loadout changes early", () => {
    const next = stepProgression(createProgression(), context({ wave: 2, commands: [{ playerId: "p", kind: "loadout", itemId: "decoy-speaker", sequence: 1 }] }), 1, {});
    expect(next.players.p!.gadget).toBe("balloon");
    expect(next.players.p!.streaks).toEqual(["confidence"]);
    expect(next.players.p!.rank).toBe(1);
  });
  it("normalizes legacy persisted choices and deduplicates perks and streaks before slot limits", () => {
    const saved = atRank(30, { gear: "rubber-boots" as Progression["gear"], perks: ["marine", "marine-layer", "quiet", "stealth", "lean"], streaks: ["confidence-score", "confidence", "buzzword-parrots", "tensor-brick-drop"] });
    const next = stepProgression(freeze(saved), context(), 1, {});
    expect(next.players.p!.gear).toBe("boots");
    expect(next.players.p!.perks).toEqual(["marine-layer", "do-not-disturb", "stealth-mode"]);
    expect(next.players.p!.streaks).toEqual(["confidence", "parrots", "tensor"]);
  });
  it("enforces perk and streak slots at each rank, including before the first slot", () => {
    for (const [rank, perkCount, streakCount] of [[1, 0, 0], [3, 0, 1], [5, 1, 1], [10, 1, 2], [15, 2, 2], [25, 2, 3], [30, 3, 3]]) {
      const saved = atRank(rank!, { perks: ["marine-layer", "lean", "brackish"], streaks: ["confidence", "parrots", "tensor"] });
      const next = stepProgression(saved, context(), 1, {});
      expect(next.players.p!.perks).toHaveLength(perkCount!);
      expect(next.players.p!.streaks).toHaveLength(streakCount!);
    }
  });
  it("canonical and legacy perk commands toggle one slot instead of duplicating the perk", () => {
    const first = choose(atRank(5), "marine");
    expect(first.players.p!.perks).toEqual(["marine-layer"]);
    expect(choose(first, "marine-layer", 2).players.p!.perks).toEqual([]);
  });
  it("rejects unknown, prototype-like and unimplemented choices without consuming a slot", () => {
    for (const id of ["constructor", "__proto__", "unknown", "microclimate", "wide-nozzle"]) {
      expect(normalizeLoadoutChoice(id)).toBeNull();
      const next = choose(atRank(30), id);
      expect(next.players.p!.perks).toEqual([]);
      expect(next.players.p!.gear).toBe("none");
      expect(next.players.p!.gadget).toBe("balloon");
    }
  });
  it("a purchase grant cannot bypass the authored pressure-nozzle rank", () => {
    const ctx = context({ items: [{ id: "pressure-nozzle", kind: "nozzle", wave: 4, rank: 1, priceCents: 300000, effect: {} }] });
    expect(stepProgression(atRank(19), ctx, 1, { economy: [grant(1, "vendor.purchased", { targetId: "pressure-nozzle" })] }).players.p!.nozzle).toBe("standard");
    expect(stepProgression(atRank(20), ctx, 1, { economy: [grant(1, "vendor.purchased", { targetId: "pressure-nozzle" })] }).players.p!.nozzle).toBe("pressure");
  });
});

describe("authored score and banked reward accounting", () => {
  it("uses the authored threshold for every canonical and legacy reward", () => {
    for (const reward of STREAKS.rewards) {
      const id = normalizeStreakId(reward.id)!;
      expect(STREAK_COST[id]).toBe(reward.threshold);
      const saved = atRank(30, { streaks: [reward.id], streakPoints: reward.threshold - 1 });
      const ctx = context({ actors: [{ id: "bad", firmware: "bad" }] });
      const next = stepProgression(saved, ctx, 1, { economy: [grant(1)] });
      expect(next.players.p!.banked[id]).toBe(1);
      expect(next.players.p!.streakPoints).toBe(reward.threshold - 1 + streakPointsFor("freeRoam", "melt"));
    }
  });
  it("banks every equipped reward crossed by a score jump, without spending the score", () => {
    const saved = atRank(30, { streaks: ["confidence", "parrots", "tensor"], streakPoints: 250 });
    const next = stepProgression(saved, context({ actors: [{ id: "bad", firmware: "bad", armoured: true, caughtInAct: true }] }), 1, { economy: [grant(1), grant(2)] });
    expect(next.players.p!.streakPoints).toBe(750);
    expect(next.players.p!.banked).toEqual({ confidence: 1, parrots: 1, tensor: 1 });
  });
  it("a call spends one earned reward and never uses raw points as a second currency", () => {
    const saved = atRank(30, { streaks: ["confidence"], streakPoints: 500, banked: { confidence: 1 }, earnedStreaks: ["confidence", "parrots"] });
    const first = stepProgression(freeze(saved), context({ commands: [{ playerId: "p", kind: "streak-call", itemId: "confidence-score", sequence: 1 }] }), 1, {});
    expect(first.events.filter((e) => e.kind === "streak.grant")).toEqual([expect.objectContaining({ targetId: "confidence", amount: 1 })]);
    expect(first.players.p!.streakPoints).toBe(500);
    expect(first.players.p!.banked.confidence).toBe(0);
    const second = stepProgression(first, context({ commands: [{ playerId: "p", kind: "streak-call", itemId: "confidence", sequence: 2 }] }), 2, {});
    expect(second.events).toEqual([]);
    expect(second.players.p!.streakSequence).toBe(1);
  });
  it("reset clears the current run but retains previously earned rewards, and a new run can earn another", () => {
    const old = atRank(30, { streaks: ["confidence"], streakPoints: 300, banked: { confidence: 1 }, earnedStreaks: ["confidence"] });
    const reset = stepProgression(old, context(), 1, { player: [grant(1, "player.down")] });
    expect(reset.players.p!.streakPoints).toBe(0);
    expect(reset.players.p!.earnedStreaks).toEqual([]);
    expect(reset.players.p!.banked.confidence).toBe(1);
    const next = stepProgression(reset, context({ actors: [{ id: "bad", firmware: "bad" }] }), 2, { economy: [grant(1), grant(2), grant(3)] });
    expect(next.players.p!.banked.confidence).toBe(2);
  });
  it("duplicate and replayed producer grants cannot earn twice", () => {
    const saved = atRank(30, { streaks: ["confidence"], streakPoints: 200 });
    const ctx = context({ actors: [{ id: "bad", firmware: "bad" }] });
    const first = stepProgression(freeze(saved), ctx, 1, { economy: [grant(1), grant(1)] });
    const again = stepProgression(first, ctx, 2, { economy: [grant(1)] });
    expect(again.players.p!.streakPoints).toBe(300);
    expect(again.players.p!.banked.confidence).toBe(1);
    expect(again.players.p!.xp).toBe(saved.players.p!.xp + PROGRESSION.awards.melt);
  });
  it("cannot farm a crossed threshold by toggling the reward or switching its alias", () => {
    const saved = atRank(30, { streaks: ["confidence"], streakPoints: 300, banked: { confidence: 0 }, earnedStreaks: ["confidence"] });
    const off = choose(saved, "confidence-score");
    const on = choose(off, "confidence", 2);
    const next = stepProgression(on, context({ actors: [{ id: "bad", firmware: "bad" }] }), 3, { economy: [grant(1)] });
    expect(next.players.p!.banked.confidence).toBe(0);
  });
  it("already banked rewards remain callable after unequipping them", () => {
    const saved = atRank(30, { streaks: [], banked: { "confidence-score": 1 }, earnedStreaks: ["confidence"] });
    const next = stepProgression(saved, context({ commands: [{ playerId: "p", kind: "streak-call", itemId: "confidence", sequence: 1 }] }), 1, {});
    expect(next.events[0]?.kind).toBe("streak.grant");
    expect(next.players.p!.banked.confidence).toBe(0);
  });
  it("migrates legacy point-only saves once and preserves them through JSON replay", () => {
    const saved = atRank(30, { streaks: ["confidence-score", "buzzword-parrots"], streakPoints: 550 });
    delete saved.players.p!.earnedStreaks;
    const migrated = stepProgression(freeze(saved), context(), 1, {});
    expect(migrated.players.p!.banked).toEqual({ confidence: 1, parrots: 1 });
    const again = stepProgression(JSON.parse(JSON.stringify(migrated)) as ProgressionState, context(), 2, {});
    expect(again.players.p!.banked).toEqual(migrated.players.p!.banked);
    expect(saved.players.p!.earnedStreaks).toBeUndefined();
  });
  it("scores existing producer events with the selected mode's table", () => {
    for (const mode of ["freeRoam", "botSweep", "cleanStreets", "hideInTheCrowd", "fogRoyale"] as const) {
      const next = stepProgression(atRank(30), context({ mode, actors: [{ id: "bad", firmware: "bad", caughtInAct: true }] }), 1, { economy: [grant(1), grant(2, "update.rewarded")] });
      expect(next.players.p!.streakPoints).toBe(streakPointsFor(mode, "melt") + streakPointsFor(mode, "caughtInAct") + streakPointsFor(mode, "interruptedUpdate"));
    }
  });
  it("does not invent the before-first-attack bonus when the producer supplies no flag", () => {
    const next = stepProgression(atRank(30), context({ actors: [{ id: "bad", firmware: "bad", caughtInAct: true }] }), 1, { economy: [grant(1)] });
    expect(next.players.p!.streakPoints).toBe(150);
  });
  it("ignores invalid numeric grant IDs and amounts without poisoning cursors or state", () => {
    const next = stepProgression(atRank(30), context(), 1, { missions: [grant(NaN, "mission.xp", { amount: 900 }), grant(1, "mission.xp", { amount: Infinity })] });
    expect(next.players.p!.xp).toBe(PROGRESSION.ranks.find((r) => r.rank === 30)!.totalXp);
    expect(next.grantCursors.missions).toBe(1);
    expect(JSON.stringify(next)).not.toContain("null");
  });
});
