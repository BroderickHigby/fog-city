import { describe, expect, it } from "vitest";
import { holdCombatTimers } from "../../../src/sim/combat/pause.ts";
import { initialPlayer, initialTarget } from "../../../src/sim/combat/shared.ts";
import type { CombatPlayer, CombatState } from "../../../src/sim/combat/types.ts";
import { seedRng } from "../../../src/sim/rng.ts";
import { canonicalJson } from "../../../src/sim/serialize.ts";

function fixture(): CombatState {
  const player: CombatPlayer = { id: "p1", x: 0, y: 0, z: 0, heading: 0, speed: 0, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1 };
  return {
    version: 1, tick: 100, rng: seedRng(7), nextId: 10, pauseUntil: 280,
    players: { p1: initialPlayer(player) }, targets: { bot: initialTarget() },
    projectiles: [], gadgets: [], attacks: [], attackSequence: {}, events: [],
  };
}

describe("combat pause timers", () => {
  it("holds all active player deadlines and marks without consuming action progress or resources", () => {
    const s = fixture(), p = s.players.p1!;
    p.nextWaterTick = 101; p.nextConeTick = 120; p.nextFlowerTick = 130;
    p.nextGadgetTick = 140; p.nextGearTick = 150; p.nextScanTick = 110;
    p.gearUntil = 200; p.boostUntil = 210; p.lastParrotsTick = 0;
    p.refillId = "tap"; p.refillTicks = 80; p.scanId = "bot"; p.scanTicks = 40;
    p.held = ["fire", "scan"];
    p.marks = [{ targetId: "bot", untilTick: 220, confidence: 98, hallucination: false }];
    holdCombatTimers(s);
    expect(p).toMatchObject({
      nextWaterTick: 102, nextConeTick: 121, nextFlowerTick: 131, nextGadgetTick: 141,
      nextGearTick: 151, nextScanTick: 111, gearUntil: 201, boostUntil: 211, lastParrotsTick: 1,
      water: 8, cones: 3, balloons: 2, refillTicks: 80, scanTicks: 40, held: ["fire", "scan"],
    });
    expect(p.marks[0]!.untilTick).toBe(221);
    expect(s.tick).toBe(100);
    expect(s.pauseUntil).toBe(280);
    expect(s.events).toEqual([]);
  });

  it("holds lifecycle and exposure timestamps including valid zero-tick values", () => {
    const s = fixture(), target = s.targets.bot!;
    Object.assign(target, {
      phase: "seized", phaseTick: 0, lastWaterTick: 0, wetHits: [0, 50, 99],
      wetUntil: 120, blindUntil: 121, waryUntil: 122, pullOverTick: 123,
      stoppedUntil: 124, flowersUntil: 125, slowUntil: 126, distractedUntil: 127,
    });
    holdCombatTimers(s);
    expect(target).toMatchObject({
      phase: "seized", phaseTick: 1, lastWaterTick: 1, wetHits: [1, 51, 100],
      wetUntil: 121, blindUntil: 122, waryUntil: 123, pullOverTick: 124,
      stoppedUntil: 125, flowersUntil: 126, slowUntil: 127, distractedUntil: 128,
    });
    expect(target.heightScale).toBe(1);
    expect(target.rust).toBe(0);
    expect(target.puddle).toBe(false);
  });

  it("preserves expired, unset and unlimited sentinels", () => {
    const s = fixture(), p = s.players.p1!, target = s.targets.bot!;
    p.nextWaterTick = 0; p.nextConeTick = -1; p.nextFlowerTick = 99;
    p.nextGadgetTick = Number.MAX_SAFE_INTEGER; p.lastParrotsTick = -3600;
    target.phaseTick = 0; target.lastWaterTick = -1000;
    target.flowersUntil = Number.MAX_SAFE_INTEGER;
    target.blindUntil = 0; target.waryUntil = 99;
    holdCombatTimers(s);
    expect(p).toMatchObject({ nextWaterTick: 0, nextConeTick: -1, nextFlowerTick: 99, nextGadgetTick: Number.MAX_SAFE_INTEGER, lastParrotsTick: -3600 });
    expect(target).toMatchObject({ phaseTick: 0, lastWaterTick: -1000, flowersUntil: Number.MAX_SAFE_INTEGER, blindUntil: 0, waryUntil: 99 });
  });

  it("holds projectiles, gadgets, and pending attacks without moving or resolving them", () => {
    const s = fixture();
    s.projectiles = [{ id: 1, kind: "water", ownerId: "p1", x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6, distance: 7, range: 12, bornTick: 0, volume: 0.08, salt: false, vehicle: false, rustRate: 0.025 }];
    s.gadgets = [{ id: 2, kind: "sprinkler", ownerId: "p1", x: 2, y: 0, z: 2, untilTick: 150, targetId: "", radius: 4, progress: 30, boost: "wide" }];
    s.attacks = [{ id: "channel", kind: "forced-update", attackerId: "bot", targetId: "friend", startTick: 0, resolveTick: 100, endTick: 0, presses: 2, active: true }];
    holdCombatTimers(s);
    expect(s.projectiles[0]).toMatchObject({ bornTick: 1, x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6, distance: 7 });
    expect(s.gadgets[0]).toMatchObject({ untilTick: 151, progress: 30 });
    expect(s.attacks[0]).toMatchObject({ startTick: 1, resolveTick: 101, endTick: 1, presses: 2, active: true });
    expect(s.events).toEqual([]);
  });

  it("preserves remaining durations and elapsed ages through a full 180-tick pause", () => {
    const s = fixture(), p = s.players.p1!, target = s.targets.bot!;
    s.tick = 99;
    p.gearUntil = 150; p.nextConeTick = 130; p.lastParrotsTick = 20;
    target.phase = "slumping"; target.phaseTick = 50; target.lastWaterTick = 40; target.wetUntil = 170;
    const rng = [...s.rng];
    for (let n = 0; n < 180; n++) { s.tick += 1; holdCombatTimers(s); }
    expect(p.gearUntil - s.tick).toBe(51);
    expect(p.nextConeTick - s.tick).toBe(31);
    expect(s.tick - p.lastParrotsTick).toBe(79);
    expect(s.tick - target.phaseTick).toBe(49);
    expect(s.tick - target.lastWaterTick).toBe(59);
    expect(target.wetUntil - s.tick).toBe(71);
    expect(s.pauseUntil).toBe(280);
    expect(s.rng).toEqual(rng);
    expect(() => canonicalJson(s)).not.toThrow();
  });
});
