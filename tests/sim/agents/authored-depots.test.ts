import { describe, expect, it } from "vitest";
import { buildWorld } from "../../../src/sim/world.ts";
import type { RoadsFile } from "../../../src/sim/roads.ts";
import { authoredStandbyDepots, SF_FERRY_STANDBY } from "../../../src/sim/agents/authored-depots.ts";
import { createFleetState, stepFleet } from "../../../src/sim/agents/runtime-services.ts";
import { loadWorldFiles, worldExists } from "../../helpers.ts";

function matchingRoad(lanes = 3, offset = 0) {
  const x = SF_FERRY_STANDBY.x + 3.5 + offset;
  const z = SF_FERRY_STANDBY.z;
  return buildWorld([], { version: 1, nodes: [{ id: "a", x, z: z + 100 }, { id: "b", x, z: z - 100 }],
    edges: [{ id: SF_FERRY_STANDBY.roadEdgeId, a: "a", b: "b", kind: "arterial", lanes, oneway: true, widthM: 14.7,
      points: [[x, z + 100], [x, z - 100]] }] });
}

describe("authored service depots", () => {
  it("does not install the fictional SF standby on another map", () => {
    expect(authoredStandbyDepots(buildWorld([]))).toEqual([]);
    expect(SF_FERRY_STANDBY.source).toBe("game-authored-original");
  });

  it("rejects incompatible roads and blocked access without reusing another world's match", () => {
    const clear = matchingRoad();
    expect(authoredStandbyDepots(clear)).toHaveLength(1);
    expect(authoredStandbyDepots(matchingRoad(2))).toEqual([]);
    expect(authoredStandbyDepots(matchingRoad(3, 2))).toEqual([]);
    const { x, z } = SF_FERRY_STANDBY;
    const blocked = buildWorld([{ tileId: "blocked", ground: null,
      buildings: [{ id: "shed", baseY: 0, topY: 10, footprint: [[x - 5, z - 5], [x + 5, z - 5], [x + 5, z + 5], [x - 5, z + 5]] }] }]);
    blocked.roads = clear.roads;
    expect(authoredStandbyDepots(blocked)).toEqual([]);
    expect(authoredStandbyDepots(clear)).toHaveLength(1);
  });

  it.skipIf(!worldExists("sf"))("physically delivers two units to the real Ferry spawn within twenty seconds", () => {
    const files = loadWorldFiles("sf");
    const world = buildWorld(files.tiles, files.roads as RoadsFile | null, files.boundary);
    const depots = authoredStandbyDepots(world);
    expect(depots).toHaveLength(1);
    const player = files.manifest.spawn;
    const obstacles = [{ id: "player-car", x: player.x, z: player.z, radius: 2.75, person: false }];
    const first = stepFleet(world, createFleetState(1000), { tick: 0, gameMinute: 1, obstacles,
      requests: [{ id: 0, requestTick: 0, playerId: "p", player, threat: 2, unitCount: 2 }] });
    const van = first.actors.find((body) => body.kind === "van");
    expect(van).toBeDefined();
    expect(van!.x).toBeCloseTo(SF_FERRY_STANDBY.x, 5);
    expect(van!.z).toBeCloseTo(SF_FERRY_STANDBY.z, 5);
    expect(first.state.vans.jobs[0]?.arrivalTick).toBeNull();
    let state = first.state;
    let last = van!;
    let delivered = 0;
    for (let tick = 1; tick <= 1200; tick++) {
      const next = stepFleet(world, state, { tick, gameMinute: 1 + tick / 60, obstacles, requests: [] });
      state = next.state;
      const physical = next.actors.find((body) => body.id === van!.id);
      if (physical) {
        const dx = physical.x - last.x; const dz = physical.z - last.z;
        expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThanOrEqual(16 / 60 + 0.001);
        last = physical;
      }
      if (next.disembarks.length) { delivered = next.disembarks[0]!.units.length; break; }
    }
    expect(delivered).toBe(2);
    expect(state.vans.jobs[0]?.onTime).toBe(true);
    expect(state.vans.jobs[0]?.arrivalTick).toBeLessThanOrEqual(1200);
  }, 30000);
});
