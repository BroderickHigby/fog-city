// Ambient agents on the real San Francisco world (public/tiles/sf, produced by the pipeline).
// Skipped until that world exists in the checkout. Uses only committed files, no network.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_SPEC,
  ROBOTAXI_BODY,
  agentsOf,
  blocksBand,
  buildWorld,
  circleBlockedBand,
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
  type World,
} from "../../src/sim/index.ts";
import { ROOT, readJson } from "../helpers.ts";
import { SF_RUN_MS } from "./fixtures.ts";

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

  // Built once for both tests (1 to 2 s for the city; longer on a loaded runner).
  let world: World;
  beforeAll(() => {
    world = load();
  }, SF_RUN_MS);

  it("builds the road graph and populates the area around the spawn", () => {
    expect(world.roads).not.toBeNull();
    const s = createInitialState(world, 1, ["p1"], manifest!.spawn);
    expect(agentsOf(s).length).toBeGreaterThan(50);
  }, SF_RUN_MS);

  it("over 900 ticks agents never enter buildings, and a replay reaches the same state", () => {
    const inputs = (t: number) => ({ p1: { throttle: 0.5, steer: t % 240 < 120 ? 0.3 : -0.3, brake: 0, actions: 0 } });
    const REPLAY = 450;
    let s: SimState = createInitialState(world, 1, ["p1"], manifest!.spawn);
    let atReplay = "";
    const bad: string[] = [];
    for (let t = 0; t < 900; t++) {
      s = step(world, s, inputs(t));
      if (t + 1 === REPLAY) atReplay = hashState(s);
      if (t % 5 !== 0) continue;
      for (const a of agentsOf(s)) {
        // In a building: inside its footprint and overlapping its solid band, from the agent's
        // feet to its head. A body under a span or deck (its underside over the head) or on a
        // roof (feet at the top) is not inside it.
        const sp = AGENT_SPEC[a.kind];
        const top = a.y + (a.height ?? (sp.road ? ROBOTAXI_BODY.height : 1.8));
        for (const b of nearbyBuildings(world, a.x, a.z, 1)) if (pointInPolygon(a.x, a.z, b.footprint) && blocksBand(b, a.y, top)) bad.push(`#${a.id} in ${b.id}`);
        if (sp.road) {
          const o = sp.halfLength - sp.halfWidth;
          for (const k of [-1, 1]) if (circleBlockedBand(world, a.x + dsin(a.heading) * o * k, a.z - dcos(a.heading) * o * k, sp.halfWidth * 0.79, a.y, top)) bad.push(`robotaxi #${a.id} body`);
        } else if (circleBlockedBand(world, a.x, a.z, sp.radius * 0.79, a.y, top)) bad.push(`#${a.id} body`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(agentsOf(s).length).toBeGreaterThan(50);
    // Determinism: an independent replay of the first half lands on the same state.
    let r: SimState = createInitialState(world, 1, ["p1"], manifest!.spawn);
    for (let t = 0; t < REPLAY; t++) r = step(world, r, inputs(t));
    expect(hashState(r)).toBe(atReplay);
  }, SF_RUN_MS);
});
