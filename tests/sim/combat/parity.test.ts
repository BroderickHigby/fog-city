import { describe,expect,it } from "vitest";
import * as combat from "../../../src/sim/combat/index.ts";
import * as serializer from "../../../src/sim/serialize.ts";
import { runCombatParity } from "./parity-scenario.ts";

describe("mixed combat replay baseline",()=>{
  it("preserves the verified 2,000-tick Node/Chromium replay and protected corridor",()=>{
    const replay=runCombatParity(combat,serializer);
    // Initial baseline verified against system Chromium: water, repairs, cones,
    // every reward, flowers, refill and timed collapse share the same fixed clock.
    expect(replay.finalHash).toBe("1a8363b9");
    expect(replay.ticks).toBe(2000);expect(replay.hashes).toHaveLength(33);
    expect(replay.shieldSnapshot).toEqual({protectedWetUntil:0,behindRust:0});
    for(const kind of ["weapon.water","scan.result","vehicle.pull-over","balloon.burst","pvp.flower-hit","refill.complete","robot.heap","agi.pause","tensor.loaded"]) {
      expect(replay.eventCounts[kind],kind).toBeGreaterThan(0);
    }
    expect(replay.eventCounts["streak.used"]).toBe(6);
    expect(replay.maxProjectiles).toBeLessThanOrEqual(combat.COMBAT_LIMITS.projectiles);
  });
});
