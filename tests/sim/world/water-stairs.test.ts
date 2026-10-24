// Inland lakes are water and stairways are walked, never driven, on the real city (world QA
// W-11 sim half, W-33 sim half; docs/design.md "nothing enters open water"). The pipeline rings
// every lake with a shore line in boundary.json (tagged with its lake) and flags its lattice
// samples; the sim walls lake shores like the Bay's. Stairways (roads.json `stairs`) get a ring
// of barriers cars meet and walkers do not. Before (01d9cb9 and its world) a car drove 625 m
// across Lake Merced's South Lake at 28 m/s, and up the Filbert St steps.
import { describe, expect, it } from "vitest";
import {
  CAR,
  FOOT,
  STAIRS_HALF_M,
  clearCarSpot,
  makeCar,
  makeFoot,
  onWater,
  pointInPolygon,
  stepCar,
  stepFoot,
  surfaceHeight,
  type CarState,
  type FootState,
  type World,
} from "../../../src/sim/index.ts";
import { loadWorldFiles } from "../../helpers.ts";
import { CITY_MS, SF, bearing, sfWorld } from "./load.ts";

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Is (x, z) a lake sample of the lattice (the nearest one), the lake's water? */
function onLake(world: World, x: number, z: number): boolean {
  const T = 500;
  const t = world.tiles.find((q) => q.tileId === `t${Math.floor(x / T)}_${Math.floor(z / T)}`);
  const g = t?.ground as (World["tiles"][number]["ground"] & { lake?: number[] }) | null | undefined;
  if (!g || !g.lake) return false;
  const i = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / g.cellSizeM + 0.5)));
  const k = Math.min(g.nz - 1, Math.max(0, Math.floor((z - g.z0) / g.cellSizeM + 0.5)));
  return g.lake[k * g.nx + i] === 1;
}

describe.skipIf(!SF)("inland lakes are water (W-11)", () => {
  it(
    "Lake Merced and the next largest lakes: cars driven at their shores from all round at 20 m/s and walkers sprinting at them never get onto the water",
    () => {
      const { world } = sfWorld();
      const boundary = loadWorldFiles("sf").boundary as unknown as { shore: Array<{ closed: boolean; points: number[][]; lake?: string }> };
      const rings = boundary.shore.filter((s) => s.lake !== undefined).sort((a, b) => b.points.length - a.points.length);
      // Lake Merced's South Lake (120028665) and North Lake (120028664) are the two largest rings.
      expect(rings[0]!.lake).toBe("120028665");
      expect(rings[1]!.lake).toBe("120028664");
      let cars = 0;
      let walkers = 0;
      for (const ring of rings.slice(0, 6)) {
        const poly = ring.points.map((p) => [p[0]!, p[1]!] as [number, number]);
        const n = poly.length;
        const stride = Math.max(1, Math.floor(n / 24));
        for (let i = 0; i < n; i += stride) {
          const [ax, az] = poly[i]!;
          const [bx, bz] = poly[(i + 1) % n]!;
          const len = Math.hypot(bx - ax, bz - az);
          if (len < 1) continue;
          const ux = (bx - ax) / len;
          const uz = (bz - az) / len;
          // Land is on the left of travel (uz, -ux); start 12 m out on it, facing the water.
          const mx = (ax + bx) / 2;
          const mz = (az + bz) / 2;
          const sx = mx + uz * 12;
          const sz = mz - ux * 12;
          if (pointInPolygon(sx, sz, poly) || onLake(world, sx, sz)) continue;
          const heading = bearing(-uz, ux);
          const spot = clearCarSpot(world, sx, sz, heading);
          if (pointInPolygon(spot.x, spot.z, poly)) continue;
          let c: CarState = { ...makeCar(spot.x, spot.z, heading, surfaceHeight(world, spot.x, spot.z, 1000)), speed: 20 };
          for (let t = 0; t < 240; t++) {
            c = stepCar(world, c, { throttle: 1, steer: 0, brake: 0, actions: 0 });
            expect(pointInPolygon(c.x, c.z, poly), `lake ${ring.lake} from (${sx.toFixed(0)}, ${sz.toFixed(0)}): car on the water at tick ${t}`).toBe(false);
          }
          cars++;
          let f: FootState = makeFoot(spot.x, surfaceHeight(world, spot.x, spot.z, 1000), spot.z, heading);
          for (let t = 0; t < 360; t++) {
            f = stepFoot(world, f, { throttle: 1, steer: 0, brake: 1, actions: 0 }, [], []);
            expect(pointInPolygon(f.x, f.z, poly), `lake ${ring.lake} from (${sx.toFixed(0)}, ${sz.toFixed(0)}): walker on the water at tick ${t}`).toBe(false);
          }
          walkers++;
        }
      }
      expect(cars).toBeGreaterThan(80);
      expect(walkers).toBe(cars);
    },
    CITY_MS,
  );

  it(
    "Lake Merced cannot be driven across: cars aimed at the middle of South Lake and North Lake from 8 sides at 28 m/s stop at the shore",
    () => {
      const { world } = sfWorld();
      const boundary = loadWorldFiles("sf").boundary as unknown as { shore: Array<{ closed: boolean; points: number[][]; lake?: string }> };
      for (const id of ["120028665", "120028664"]) {
        const poly = boundary.shore.find((s) => s.lake === id)!.points.map((p) => [p[0]!, p[1]!] as [number, number]);
        // The middle: the point inside the lake farthest from its shore, on a 10 m grid.
        const xs = poly.map((p) => p[0]);
        const zs = poly.map((p) => p[1]);
        let mid: [number, number] = [0, 0];
        let far = -1;
        for (let x = Math.min(...xs); x <= Math.max(...xs); x += 10) {
          for (let z = Math.min(...zs); z <= Math.max(...zs); z += 10) {
            if (!pointInPolygon(x, z, poly)) continue;
            let d = Infinity;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const [ax, az] = poly[j]!;
              const [bx, bz] = poly[i]!;
              const ex = bx - ax;
              const ez = bz - az;
              const L2 = ex * ex + ez * ez;
              const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2)) : 0;
              d = Math.min(d, Math.hypot(ax + ex * t - x, az + ez * t - z));
            }
            if (d > far) {
              far = d;
              mid = [x, z];
            }
          }
        }
        expect(far, id).toBeGreaterThan(40);
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          // Out from the middle until 30 m past the shore, then drive back at it.
          let r = far;
          while (pointInPolygon(mid[0] + Math.sin(a) * r, mid[1] - Math.cos(a) * r, poly) && r < 3000) r += 5;
          r += 30;
          const heading = a + Math.PI;
          const spot = clearCarSpot(world, mid[0] + Math.sin(a) * r, mid[1] - Math.cos(a) * r, heading);
          if (pointInPolygon(spot.x, spot.z, poly)) continue;
          let c: CarState = { ...makeCar(spot.x, spot.z, heading, surfaceHeight(world, spot.x, spot.z, 1000)), speed: 28 };
          for (let t = 0; t < 600; t++) {
            c = stepCar(world, c, { throttle: 1, steer: 0, brake: 0, actions: 0 });
            expect(pointInPolygon(c.x, c.z, poly), `lake ${id}, side ${k}, tick ${t}`).toBe(false);
          }
          expect(c.hits, `lake ${id}, side ${k}: stopped at the shore`).toBeGreaterThan(0);
        }
      }
    },
    CITY_MS,
  );
});

describe.skipIf(!SF)("spawns never on the water", () => {
  it(
    "clearCarSpot never puts a car on the water: from the review's North Lake and Bay spots, and from round every lake and along the Bay's shore, it returns a dry spot",
    () => {
      const { world } = sfWorld();
      const shore = world.walls!.shore;
      const dry = (x: number, z: number, heading: number): boolean => {
        const fx = Math.sin(heading);
        const fz = -Math.cos(heading);
        for (const [l, f] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [0, 0]] as const) {
          if (onWater(shore, x - fz * l * CAR.halfWidth + fx * f * CAR.halfLength, z + fx * l * CAR.halfWidth + fz * f * CAR.halfLength)) return false;
        }
        return true;
      };
      // Inside the North Lake ring (the review's start, a6caf4e returned it unchanged), and on the
      // Bay 10 m off the pier tip at (-430, -955). (The review's own Bay spot, (-430, -955), is on
      // the pier's land side of the shore line by onWater, the sim's water rule and its walls,
      // though the lattice's water mask there is water: it is dry here.)
      for (const [x, z] of [[-8899.7, 7508.3], [-420, -945]] as const) {
        expect(onWater(shore, x, z), `${x}, ${z} is water`).toBe(true);
        const p = clearCarSpot(world, x, z, 0);
        expect(dry(p.x, p.z, 0), `from ${x}, ${z}: ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`).toBe(true);
      }
      // Every 50th shore vertex (the Bay's and every lake's), 3 m to each side, four headings.
      const boundary = loadWorldFiles("sf").boundary as unknown as { shore: Array<{ points: number[][] }> };
      let tried = 0;
      const wet: string[] = [];
      for (const ring of boundary.shore) {
        for (let i = 0; i + 1 < ring.points.length; i += 50) {
          const [ax, az] = ring.points[i]!;
          const [bx, bz] = ring.points[i + 1]!;
          const len = Math.hypot(bx! - ax!, bz! - az!);
          if (len < 0.5) continue;
          for (const side of [3, -3]) {
            const x = ax! + ((bz! - az!) / len) * side;
            const z = az! - ((bx! - ax!) / len) * side;
            for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
              const p = clearCarSpot(world, x, z, heading);
              tried++;
              // (Where nothing dry and clear is within reach, it keeps the requested spot.)
              if (!dry(p.x, p.z, heading) && (p.x !== x || p.z !== z)) wet.push(`${x.toFixed(1)}, ${z.toFixed(1)} -> ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
            }
          }
        }
      }
      expect(tried).toBeGreaterThan(500);
      expect(wet).toEqual([]);
    },
    CITY_MS,
  );
});

describe.skipIf(!SF)("stairways are walked, never driven (W-33)", () => {
  /** The stairway's polyline with its arc lengths. */
  function line(pts: ReadonlyArray<readonly number[]>): { xs: number[]; zs: number[]; cum: number[] } {
    const xs = pts.map((p) => p[0]!);
    const zs = pts.map((p) => p[1]!);
    const cum = [0];
    for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, zs[i]! - zs[i - 1]!));
    return { xs, zs, cum };
  }

  /** Arc length along the line of the point nearest (x, z), and the distance to it. */
  function project(l: ReturnType<typeof line>, x: number, z: number): { s: number; d: number } {
    let best = { s: 0, d: Infinity };
    for (let i = 1; i < l.xs.length; i++) {
      const ax = l.xs[i - 1]!;
      const az = l.zs[i - 1]!;
      const ex = l.xs[i]! - ax;
      const ez = l.zs[i]! - az;
      const L2 = ex * ex + ez * ez;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2)) : 0;
      const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
      if (d < best.d) best = { s: l.cum[i - 1]! + t * Math.sqrt(L2), d };
    }
    return best;
  }

  it(
    "at every stairway that meets a street, a car driven from the street at its foot or head never gets onto the stairs",
    () => {
      const { world, roads } = sfWorld();
      const edges = roads.edges as Array<(typeof roads.edges)[number] & { stairs?: boolean; pedestrian?: boolean }>;
      // The widest street (not stairs, not a path) at each node: where the barrier stops; and
      // every street meeting there, whose carriageway (its half width plus the 0.5 m kerb margin
      // from its centreline) is street, never stairs, however a stairway leaves it (the Twin
      // Peaks Blvd paper stairway runs beside the drive at 15 to 20 degrees for 20 m).
      const kerb = new Map<string, number>();
      const streetsAt = new Map<string, Array<{ half: number; l: ReturnType<typeof line> }>>();
      for (const e of edges) {
        if (e.stairs || e.pedestrian) continue;
        const h = (e.widthM ?? 10) / 2;
        for (const n of [e.a, e.b]) {
          kerb.set(n, Math.max(kerb.get(n) ?? 0, h));
          streetsAt.set(n, [...(streetsAt.get(n) ?? []), { half: h, l: line(e.points) }]);
        }
      }
      const inCarriageway = (x: number, z: number, nodes: readonly string[]): boolean =>
        nodes.some((n) => (streetsAt.get(n) ?? []).some((st) => project(st.l, x, z).d < st.half + 0.5));
      let runs = 0;
      const onStairs: string[] = [];
      for (const e of edges) {
        if (!e.stairs) continue;
        expect(world.roads!.edges.find((q) => q.id === e.id)!.drivable, e.id).toBe(false);
        const l = line(e.points);
        const len = l.cum[l.cum.length - 1]!;
        for (const end of [0, 1] as const) {
          const node = end === 0 ? e.a : e.b;
          const k = kerb.get(node);
          if (k === undefined) continue;
          const other = end === 0 ? kerb.get(e.b) : kerb.get(e.a);
          const s0 = end === 0 ? k + 0.5 : (other === undefined ? 0 : other + 0.5);
          const s1 = end === 0 ? len - (other === undefined ? 0 : other + 0.5) : len - k - 0.5;
          if (s1 - s0 < 1) continue;
          // From the node (the street's centre), 4 m further out into the street, at the stair.
          const i0 = end === 0 ? 0 : l.xs.length - 1;
          const i1 = end === 0 ? 1 : l.xs.length - 2;
          const dx = l.xs[i1]! - l.xs[i0]!;
          const dz = l.zs[i1]! - l.zs[i0]!;
          const dl = Math.hypot(dx, dz);
          const x = l.xs[i0]! - (dx / dl) * 4;
          const z = l.zs[i0]! - (dz / dl) * 4;
          const heading = bearing(dx, dz);
          let c: CarState = { ...makeCar(x, z, heading, surfaceHeight(world, x, z, 1000)), speed: 8 };
          let on = false;
          for (let t = 0; t < 240 && !on; t++) {
            c = stepCar(world, c, { throttle: 1, steer: 0, brake: 0, actions: 0 });
            const p = project(l, c.x, c.z);
            if (p.s > s0 && p.s < s1 && p.d < STAIRS_HALF_M && !inCarriageway(c.x, c.z, [e.a, e.b])) on = true;
          }
          runs++;
          if (on) onStairs.push(`${e.id} ${e.name ?? ""} from ${end === 0 ? "a" : "b"}`);
        }
      }
      expect(runs).toBeGreaterThan(150);
      expect(onStairs).toEqual([]);
    },
    CITY_MS,
  );

  it(
    "walkers walk the city's stairways end to end: the Filbert, Greenwich, Lyon, 16th Avenue (Moraga), Vulcan and Harry St steps",
    () => {
      const { world, roads } = sfWorld();
      const edges = roads.edges as Array<(typeof roads.edges)[number] & { stairs?: boolean }>;
      const named = ["Filbert", "Greenwich", "Lyon", "Moraga", "Vulcan", "Harry"];
      const stuck: string[] = [];
      let walked = 0;
      for (const e of edges) {
        if (!e.stairs || !named.some((n) => (e.name ?? "").includes(n))) continue;
        for (const rev of [false, true]) {
          const pts = (rev ? [...e.points].reverse() : [...e.points]).map((p) => [p[0]!, p[1]!] as [number, number]);
          const [x0, z0] = pts[0]!;
          let f: FootState = makeFoot(x0, surfaceHeight(world, x0, z0, 1000), z0, bearing(pts[1]![0] - x0, pts[1]![1] - z0));
          let k = 1;
          const len = pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]), 0);
          // (Climbing, a walker slows to FOOT.walk / (1 + FOOT.uphill * rise): about 0.5 m/s at 1:1.)
          const limit = Math.ceil((len / 0.4) * 60) + 600;
          for (let t = 0; t < limit && k < pts.length; t++) {
            const [tx, tz] = pts[k]!;
            if (Math.hypot(tx - f.x, tz - f.z) < 1) {
              k++;
              continue;
            }
            const err = wrap(bearing(tx - f.x, tz - f.z) - f.heading);
            f = stepFoot(world, f, { throttle: Math.abs(err) > 1 ? 0.2 : 1, steer: Math.max(-1, Math.min(1, err * 4)), brake: 0, actions: 0 }, [], []);
          }
          walked++;
          if (k < pts.length) stuck.push(`${e.id} ${e.name}${rev ? " (down)" : ""}: stopped ${Math.hypot(pts[k]![0] - f.x, pts[k]![1] - f.z).toFixed(1)} m short of point ${k}`);
        }
      }
      expect(walked).toBeGreaterThanOrEqual(12);
      expect(stuck).toEqual([]);
      expect(FOOT.maxGrade).toBe(1);
      expect(CAR.halfWidth).toBeLessThan(STAIRS_HALF_M);
    },
    CITY_MS,
  );
});
