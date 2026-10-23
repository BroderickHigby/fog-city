import { describe, expect, it } from "vitest";
import { robotCatalogGoalWeights, robotCatalogPresentation, robotCatalogProfile, robotCatalogProfileForSource } from "../../../src/sim/robots/catalog.ts";

const input = { tick: 0, x: 0, z: 0, heading: 0, hideOneTell: false, sabotageActive: false };

describe("bounded robot catalog integration", () => {
  it("uses stable compatible profiles and explicit difficulty only", () => {
    const profile = robotCatalogProfile(8, 37, "footman", "bad");
    expect(profile).toEqual(robotCatalogProfile(8, 37, "footman", "bad"));
    expect(profile?.model).toBe("errand-robot"); expect(profile?.level).toBe(1);
    expect(robotCatalogProfile(8, 37, "patrol", "bad")).toBeNull();
    expect(() => robotCatalogProfile(8, 37, "trundle", "bad", 1, "snatcher")).toThrow("match");
  });

  it("preserves a world-derived appearance source through JSON reload", () => {
    const source = { seed: 321, key: '["ambient",7,"2,-3",4,9]' };
    const first = robotCatalogProfileForSource(source, "footman", "bad", 3)!;
    expect(robotCatalogProfileForSource(JSON.parse(JSON.stringify(source)), "footman", "bad", 3)).toEqual(first);
    expect(robotCatalogProfileForSource(source, "footman", "good", 3)?.archetypeId).not.toBe(first.archetypeId);
    for (const seed of [-1, 0.5, 0x100000000, Infinity]) expect(() => robotCatalogProfileForSource({ ...source, seed }, "footman", "bad")).toThrow(/source/);
    for (const key of ["", "x".repeat(257)]) expect(() => robotCatalogProfileForSource({ ...source, key }, "footman", "bad")).toThrow(/source/);
  });

  it("hides one implemented own tell without turning an empty bag into groceries", () => {
    const profile = robotCatalogProfile(8, 37, "footman", "bad", 3, "snatcher")!;
    const before = robotCatalogPresentation(profile, input), hidden = robotCatalogPresentation(profile, { ...input, hideOneTell: true });
    expect(before.tellIds).toContain("emptyBag"); expect(before.presentation.bagFull).toBe(false);
    expect(hidden.hiddenTellId).toBe("emptyBag"); expect(hidden.tellIds).not.toContain("emptyBag");
    expect(hidden.presentation.bagFull).toBe(false); expect(hidden.presentation.bagSwing).toBe(1);
    expect(robotCatalogPresentation(profile, input)).toEqual(before);
    expect(before.pendingTellIds).toContain("avoidWater");
  });

  it("uses the authored four-second blink cadence and hides it while wary", () => {
    const profile = robotCatalogProfile(9, 21, "trundle", "bad", 4, "harvester")!;
    const blink = (240 - profile.phase % 240) % 240;
    expect(robotCatalogPresentation(profile, { ...input, tick: blink }).presentation.faceLight).toBe(0);
    expect(robotCatalogPresentation(profile, { ...input, tick: blink + 17 }).presentation.faceLight).toBe(0);
    expect(robotCatalogPresentation(profile, { ...input, tick: blink + 18 }).presentation.faceLight).toBe(1);
    const hidden = robotCatalogPresentation(profile, { ...input, tick: blink, hideOneTell: true });
    expect(hidden.hiddenTellId).toBe("faceLightFlicker"); expect(hidden.presentation.faceLight).toBe(1);
  });

  it("tracks actual recent observations only, with catalog range and hold limits", () => {
    const profile = robotCatalogProfile(8, 37, "footman", "bad", 2, "snatcher")!;
    const watchedTarget = { x: 5, z: -5, observedTick: 0 };
    expect(robotCatalogPresentation(profile, { ...input, watchedTarget }).presentation.headYaw).toBeLessThan(-0.7);
    expect(robotCatalogPresentation(profile, { ...input, tick: 121, watchedTarget }).presentation.headYaw).toBeNull();
    expect(robotCatalogPresentation(profile, { ...input, watchedTarget: { ...watchedTarget, x: 20 } }).presentation.headYaw).toBeNull();
    expect(robotCatalogPresentation(profile, { ...input, watchedTarget: { ...watchedTarget, observedTick: 1 } }).presentation.headYaw).toBeNull();
  });

  it("retains false tells and camouflage when hiding the robot's own tell", () => {
    const profile = { ...robotCatalogProfile(8, 37, "footman", "bad", 3, "snatcher")!,
      camouflageTellIds: ["fullBag"], falseTellIds: ["pingGlance"] };
    const metadata = robotCatalogPresentation(profile, { ...input, hideOneTell: true, pingTarget: { x: 5, z: -5, observedTick: 0 } });
    expect(metadata.hiddenTellId).toBe("emptyBag"); expect(metadata.tellIds).toContain("pingGlance");
    expect(metadata.presentation.headYaw).not.toBeNull(); expect(metadata.tellIds.length).toBeLessThanOrEqual(6);
  });

  it("uses content weights only when their conditions and wave unlocks hold", () => {
    const update = robotCatalogProfile(1, 1, "footman", "bad", 1, "updatePusher")!;
    expect(robotCatalogGoalWeights(update, "disguised", 2, {}).weights.forcedUpdate).toBe(0);
    expect(robotCatalogGoalWeights(update, "disguised", 2, { unobserved: true }).weights.forcedUpdate).toBe(5);
    const harvester = robotCatalogProfile(1, 2, "trundle", "bad", 1, "harvester")!;
    expect(robotCatalogGoalWeights(harvester, "attack", 2, {}).weights.phoneHack).toBe(0);
    expect(robotCatalogGoalWeights(harvester, "attack", 3, {}).weights.phoneHack).toBe(4);
  });

  it("reports unsupported sabotage as pending rather than substituting another attack", () => {
    const profile = robotCatalogProfile(1, 1, "footman", "bad", 1, "prowler")!;
    const result = robotCatalogGoalWeights(profile, "disguised", 3, { unobserved: true, playerFar: true });
    expect(result.pendingGoalIds).toEqual(["stealEmptyCar", "tryCarDoor"]);
    expect(Object.values(result.weights).every(value => value === 0)).toBe(true);
  });

  it("keeps cached immutable presentations equivalent across time and all dynamic variants", () => {
    for (const source of [robotCatalogProfile(8, 37, "footman", "bad", 3, "snatcher")!,
      robotCatalogProfile(9, 21, "trundle", "bad", 4, "harvester")!]) {
      const cached = Object.freeze({ ...source, ownTellIds: Object.freeze([...source.ownTellIds]),
        camouflageTellIds: Object.freeze([...source.camouflageTellIds]), falseTellIds: Object.freeze([...source.falseTellIds]) });
      for (const tick of [0, 17, 18, 120, 240, 499]) for (const hideOneTell of [false, true]) for (const returningFromDelivery of [false, true]) {
        const dynamic = { ...input, tick, hideOneTell, returningFromDelivery, sabotageActive: tick % 2 === 0,
          watchedTarget: { x: 5, z: -5, observedTick: Math.max(0, tick - 18) }, pingTarget: { x: -2, z: -3, observedTick: tick } };
        expect(robotCatalogPresentation(cached, dynamic)).toEqual(robotCatalogPresentation(source, dynamic));
      }
    }
  });

  it("observes mutations inside a shallow-frozen caller profile", () => {
    const profile = Object.freeze({ ...robotCatalogProfile(8, 37, "footman", "bad", 3, "snatcher")!,
      ownTellIds: ["emptyBag"], camouflageTellIds: [], falseTellIds: [] });
    expect(robotCatalogPresentation(profile, input).presentation.bagFull).toBe(false);
    profile.ownTellIds[0] = "fullBag";
    const changed = robotCatalogPresentation(profile, input);
    expect(changed.tellIds).toEqual(["fullBag"]);
    expect(changed.presentation.bagFull).toBe(true);
  });

  it("does not let callers mutate a cached plan through returned arrays or presentation objects", () => {
    const source = robotCatalogProfile(8, 37, "footman", "bad", 3, "snatcher")!;
    const profile = Object.freeze({ ...source, ownTellIds: Object.freeze([...source.ownTellIds]),
      camouflageTellIds: Object.freeze([...source.camouflageTellIds]), falseTellIds: Object.freeze([...source.falseTellIds]) });
    const expected = robotCatalogPresentation(profile, input), returned = robotCatalogPresentation(profile, input);
    (returned.tellIds as string[]).push("caller-only");
    (returned.pendingTellIds as string[]).length = 0;
    (returned.presentation as { bagSwing: number }).bagSwing = -999;
    expect(robotCatalogPresentation(profile, input)).toEqual(expected);
    expect(robotCatalogPresentation(profile, input).tellIds).not.toBe(expected.tellIds);
  });
});
