// Regression for the real-SF ambient deadlock the Missions stream found on integrate/wave2
// ff7db5b (seed 1, wave 3; coordinator report 2026-10-23): at three FiDi/SoMa junctions people and
// robots stood frozen in "go" mode (their sidewalk line hugged a facade, or they were pressed
// against a stopped robotaxi, and the physical layer refused every step) while robotaxis waited
// on them for good. Walkers now walk to the first clear point ahead, step out of a nook, or pick a
// new way after WALKER_STALL_TICKS (src/sim/agents/runtime.ts). Soak: over 90 s of the game
// composition, nobody within 120 m of each junction stands still for 40 s (a robotaxi queueing at a
// busy all-way stop can wait half a minute; the deadlock held everyone for the whole run), with
// zero contacts.
import { describe, expect, it } from "vitest";
import { agentsOf, createGameSystems, createInitialState, dodgeExtOf, makeFoot, step, type SimState } from "../../src/sim/index.ts";
import { loadWorld, worldExists } from "../helpers.ts";
import { SF_RUN_MS } from "./fixtures.ts";

const JUNCTIONS: ReadonlyArray<readonly [number, number]> = [[-620, 746], [-866, 625], [-1169, -252]];

describe.skipIf(!worldExists("sf"))("no frozen walkers at the reported real-SF junctions (seed 1, wave 3)", () => {
  const { world } = loadWorld("sf", { roads: true });
  const systems = createGameSystems({ wave: 3 });
  for (const [x, z] of JUNCTIONS) {
    it(`(${x}, ${z}): nobody stands still for 40 s over 90 s`, () => {
      let s: SimState = createInitialState(world, 1, ["p1"], { x: x + 400, z: z + 400, heading: 0 });
      // The player on foot on the pavement by the junction (never in the road, where traffic would
      // rightly wait for them); their car parked far off the streets in question.
      const pavement = [...world.sidewalks!.nodes].sort((a, b) => Math.hypot(a.x - x - 20, a.z - z - 20) - Math.hypot(b.x - x - 20, b.z - z - 20) || (a.id < b.id ? -1 : 1))[0]!;
      s = { ...s, players: { p1: { ...s.players.p1!, mode: "foot", foot: makeFoot(pavement.x, s.players.p1!.car.y, pavement.z, 0) } } };
      const still = new Map<number, number>();
      let worst = 0, who = "";
      for (let t = 0; t < 5400; t++) {
        s = step(world, s, {}, [], systems);
        for (const a of agentsOf(s)) {
          if (Math.hypot(a.x - x, a.z - z) > 120) { still.delete(a.id); continue; }
          const n = a.speed < 0.05 && a.dwell === 0 ? (still.get(a.id) ?? 0) + 1 : 0;
          still.set(a.id, n);
          if (n > worst) { worst = n; who = `${a.id} ${a.kind} at ${a.x.toFixed(1)},${a.z.toFixed(1)}`; }
        }
      }
      expect(worst, who).toBeLessThan(40 * 60);
      expect(dodgeExtOf(s).contacts).toBe(0);
    }, SF_RUN_MS);
  }
});
