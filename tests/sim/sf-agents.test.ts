// Ambient agents on the real San Francisco world (public/tiles/sf, produced by the pipeline).
// Skipped until that world exists in the checkout. Uses only committed files, no network.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_SPEC,
  agentsOf,
  buildWorld,
  circleBlocked,
  createInitialState,
  dcos,
  dsin,
  hashState,
  pointInPolygon,
  nearbyBuildings,
  step,
  type RoadsFile,
  type SimState,
  type TileCollider,
} from "../../src/sim/index.ts";
import { ROOT, readJson } from "../helpers.ts";

const SF = "public/tiles/sf";
const present = existsSync(join(ROOT, SF, "manifest.json"));

describe.skipIf(!present)("agents on the real SF world", () => {
  const manifest = present
    ? readJson<{ spawn: { x: number; z: number; heading: number }; roads?: string | null; tiles: Array<{ collider: string }> }>(`${SF}/manifest.json`)
    : null;
  const load = () => {
    const tiles = manifest!.tiles.map((t) => readJson<TileCollider>(`${SF}/${t.collider}`));
    const roads = manifest!.roads ? readJson<RoadsFile>(`${SF}/${manifest!.roads}`) : null;
    return buildWorld(tiles, roads);
  };

  it("builds the road graph and populates the area around the spawn", () => {
    const world = load();
    expect(world.roads).not.toBeNull();
    const s = createInitialState(world, 1, ["p1"], manifest!.spawn);
    expect(agentsOf(s).length).toBeGreaterThan(50);
  });

  it("over 900 ticks agents never enter buildings and the run is deterministic", () => {
    const world = load();
    const go = (): { s: SimState; bad: string[] } => {
      let s = createInitialState(world, 1, ["p1"], manifest!.spawn);
      const bad: string[] = [];
      for (let t = 0; t < 900; t++) {
        s = step(world, s, { p1: { throttle: 0.5, steer: t % 240 < 120 ? 0.3 : -0.3, brake: 0, actions: 0 } });
        if (t % 5 !== 0) continue;
        for (const a of agentsOf(s)) {
          for (const b of nearbyBuildings(world, a.x, a.z, 1)) if (pointInPolygon(a.x, a.z, b.footprint)) bad.push(`#${a.id} in ${b.id}`);
          const sp = AGENT_SPEC[a.kind];
          if (sp.road) {
            const o = sp.halfLength - sp.halfWidth;
            for (const k of [-1, 1]) if (circleBlocked(world, a.x + dsin(a.heading) * o * k, a.z - dcos(a.heading) * o * k, sp.halfWidth * 0.79)) bad.push(`robotaxi #${a.id} body`);
          } else if (circleBlocked(world, a.x, a.z, sp.radius * 0.79)) bad.push(`#${a.id} body`);
        }
      }
      return { s, bad };
    };
    const a = go();
    expect(a.bad.slice(0, 5)).toEqual([]);
    expect(hashState(a.s)).toBe(hashState(go().s));
  });
});
