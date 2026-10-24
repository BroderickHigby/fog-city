// Bad robots to find, on the real city (owner feedback 2026-10-24: "there aren't really any bad
// bots anywhere"). A free-roam player spends a minute on the pavement at each of four district
// hubs (FiDi, SoMa, the Marina, North Beach) through the game composition, wave 3, seed 7. Every
// 5 s: how many bad robots are on their feet within 300 m. Asserts, per district, a bad robot
// within 150 m inside 30 s and at least two within 300 m on average; over the run, at least one
// street incident a minute; zero contacts throughout.
import { describe, expect, it } from "vitest";
import { createGameSystems, createInitialState, dodgeExtOf, makeFoot, step, type SimState } from "../../../src/sim/index.ts";
import { agentsRuntimeOf } from "../../../src/sim/agents/runtime.ts";
import { districtById } from "../../../src/content/places.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { loadWorld, worldExists } from "../../helpers.ts";

const DISTRICTS = ["fidi", "soma", "marina", "north-beach"] as const;
const MINUTE = 3600;

describe.skipIf(!worldExists("sf"))("bad robots to find in free roam on the real city", () => {
  it("a bad robot within 150 m inside 30 s, two or more within 300 m on average, an incident a minute", () => {
    const { world } = loadWorld("sf", { roads: true });
    const systems = createGameSystems({ wave: 3 });
    const report: string[] = [];
    let incidents = 0;
    for (const id of DISTRICTS) {
      const hub = districtById(id)!.hub, at = toLocal(hub.lat, hub.lon);
      const pavement = [...world.sidewalks!.nodes].sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z) || (a.id < b.id ? -1 : 1))[0]!;
      let s: SimState = createInitialState(world, 7, ["p1"], { x: pavement.x + 300, z: pavement.z + 300, heading: 0 });
      s = { ...s, players: { p1: { ...s.players.p1!, mode: "foot", foot: makeFoot(pavement.x, s.players.p1!.car.y, pavement.z, 0) } } };
      const bad = (radius: number) => {
        const runtime = agentsRuntimeOf(s);
        return Object.keys(runtime?.actors ?? {}).filter((k) => {
          const a = runtime!.actors[k]!;
          return a.firmware === "bad" && !a.retired && a.fidelity !== "abstract" && (s.ext.combat?.targets[k]?.phase ?? "active") === "active" && Math.hypot(a.x - pavement.x, a.z - pavement.z) <= radius;
        }).length;
      };
      let first = -1, sum = 0, samples = 0, agents = 0;
      const t0 = performance.now();
      const seen = new Set<string>();
      for (let t = 0; t < MINUTE; t++) {
        s = step(world, s, {}, [], systems);
        if (first < 0 && bad(150) > 0) first = t;
        if (t % 300 === 299) { sum += bad(300); samples++; agents += (s.ext.agents?.list.length ?? 0); }
        for (const k of Object.keys(agentsRuntimeOf(s)?.incidents ?? {})) seen.add(k);
      }
      incidents += seen.size;
      report.push(`${id}: first ${first < 0 ? "never" : `${(first / 60).toFixed(1)} s`}, mean within 300 m ${(sum / samples).toFixed(1)}, incidents ${seen.size}, agents ${(agents / samples).toFixed(0)}, ${((performance.now() - t0) / MINUTE).toFixed(2)} ms/tick (test machine, probes included)`);
      console.info(report.at(-1));
      expect(dodgeExtOf(s).contacts, id).toBe(0);
      expect(first, `${id}: ${report.at(-1)}`).toBeGreaterThanOrEqual(0);
      expect(first, `${id}: ${report.at(-1)}`).toBeLessThan(30 * 60);
      expect(sum / samples, `${id}: ${report.at(-1)}`).toBeGreaterThanOrEqual(2);
    }
    expect(incidents, report.join("; ")).toBeGreaterThanOrEqual(DISTRICTS.length);
  }, 1_200_000);
});
