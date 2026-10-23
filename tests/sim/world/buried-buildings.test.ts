// W-05 (sim half): buried hillside buildings make no invisible walls and teleport nobody. At
// each of the QA's 31 buried-roof sites (records whose roof lies under the ground somewhere in
// the footprint), a car driven in from the uphill side with the full step() and a walker
// walking in never move more than speed x DT + 0.5 m in a tick, and the walker either crosses
// or stops at a wall standing at least 2.5 m above its feet. (The pipeline half, terraced
// footprints with no roof under the ground, is tests/pipeline/grounding.test.ts.)
import { describe, expect, it } from "vitest";
import {
  FOOT,
  closestOnBoundary,
  createInitialState,
  meshGroundHeight,
  makeFoot,
  nearbyBuildings,
  pointInPolygon,
  step,
  stepFoot,
  type BuildingCollider,
} from "../../../src/sim/index.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { CITY_MS, SF, fixture, moveExcess, sfWorld } from "./load.ts";

interface Site {
  id: string;
  worst: { at: [number, number]; nx: number; nz: number };
}

describe.skipIf(!SF)("buried hillside buildings (W-05)", () => {
  const sites = (): Site[] => fixture<{ sites: Site[] }>("buried-sites.json").sites;

  it(
    "a car driven at each buried roof from the uphill side, full step(), never moves beyond speed x DT + 0.5 m in a tick",
    () => {
      const { world } = sfWorld();
      expect(sites()).toHaveLength(31);
      for (const s of sites()) {
        const p = toLocal(s.worst.at[0], s.worst.at[1]);
        const { nx, nz } = s.worst;
        const heading = Math.atan2(-nx, nz);
        for (const throttle of [0.4, 0.8]) {
          let st = createInitialState(world, 1, ["p"], { x: p.x + nx * 15, z: p.z + nz * 15, heading });
          for (let t = 0; t < 400; t++) {
            const c0 = st.players.p!.car;
            st = step(world, st, { p: { throttle, steer: 0, brake: 0, actions: 0 } });
            expect(moveExcess(c0, st.players.p!.car), `${s.id} throttle ${throttle} tick ${t}`).toBeLessThanOrEqual(1e-9);
          }
        }
      }
    },
    CITY_MS,
  );

  it(
    "a walker coming down the hill at each site crosses, or stops at a wall at least 2.5 m tall",
    () => {
      const { world } = sfWorld();
      const byId = new Map<string, BuildingCollider>();
      for (const t of world.tiles) for (const b of t.buildings) byId.set(b.id, b);
      let crossed = 0;
      for (const s of sites()) {
        const b = byId.get(s.id)!;
        const p = toLocal(s.worst.at[0], s.worst.at[1]);
        const { nx, nz } = s.worst;
        const x0 = p.x + nx * 8;
        const z0 = p.z + nz * 8;
        let f = makeFoot(x0, meshGroundHeight(world, x0, z0), z0, Math.atan2(-nx, nz));
        let still = 0;
        let entered = false;
        for (let t = 0; t < 900; t++) {
          const prev = f;
          f = stepFoot(world, f, { throttle: 1, steer: 0, brake: 0, actions: 0 }, [], []);
          expect(Math.hypot(f.x - prev.x, f.z - prev.z), `${s.id} tick ${t}`).toBeLessThanOrEqual(FOOT.walk / 60 + 0.5);
          if (pointInPolygon(f.x, f.z, b.footprint)) entered = true;
          still = f.grounded && Math.abs(f.speed) < 0.2 ? still + 1 : 0;
          if (still === 30) {
            // Held: every building it is pressed against stands at least 2.5 m above its feet.
            for (const q of nearbyBuildings(world, f.x, f.z, 2)) {
              if (q.topY <= q.baseY || pointInPolygon(f.x, f.z, q.footprint)) continue;
              if (closestOnBoundary(f.x, f.z, q.footprint).d2 > (FOOT.radius + 0.05) ** 2) continue;
              expect(q.topY - f.y, `${s.id}: held at ${q.id}`).toBeGreaterThanOrEqual(2.5);
            }
            break;
          }
        }
        if (entered) crossed++;
      }
      // Most walkers get onto the roof (it is flush with the hill on that side).
      expect(crossed).toBeGreaterThan(20);
    },
    CITY_MS,
  );
});
