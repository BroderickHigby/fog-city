// Decks, tunnels and piers on the real city (world QA W-02, W-03, W-12, W-13, W-14 sim half;
// docs/design.md "Decks, tunnels and water"). The pipeline writes decks (freeway viaducts and
// ramps, street bridges, overpasses) and tunnel bores (floor and ceiling) into the collider
// pack; surfaceAt puts bodies on them. Before (01d9cb9, the sim reading only the ground) a car
// drove the bare ground under every deck: the 3rd St bridge at sea level, the Broadway Tunnel
// over Russian Hill into the houses, I-280 into the buildings under its viaduct.
import { describe, expect, it } from "vitest";
import { CAR, blocksBand, closestOnBoundary, contradictoryDecks, nearbyBuildings, onWater, pointInPolygon, roadSurfaceHeight, stepCar, surfaceAt, makeCar, type CarState, type RoadsFile, type World } from "../../../src/sim/index.ts";
import { CITY_MS, SF, bearing, drivePath, resample, sfWorld } from "./load.ts";

/** A chain of edges as one path every metre, in travel order (`rev` drives it backwards). */
function route(roads: RoadsFile, ids: readonly string[], rev = false): Array<[number, number]> {
  const byId = new Map(roads.edges.map((e) => [e.id, e]));
  const out: Array<[number, number]> = [];
  for (const id of rev ? [...ids].reverse() : ids) {
    let pts = resample(byId.get(id)!.points, 1);
    if (rev) pts = pts.reverse();
    out.push(...(out.length ? pts.slice(1) : pts));
  }
  return out;
}

/** The edge each point of route(roads, ids) lies on. */
function routeEdges(roads: RoadsFile, ids: readonly string[]): string[] {
  const byId = new Map(roads.edges.map((e) => [e.id, e]));
  const out: string[] = [];
  for (const id of ids) {
    const n = resample(byId.get(id)!.points, 1).length;
    for (let k = out.length ? 1 : 0; k < n; k++) out.push(id);
  }
  return out;
}

/** Is a building that blocks the car's body within 1 m of its rectangle (a hit on a building, not on a rail or a wall)? */
function buildingBeside(world: World, c: CarState): boolean {
  const reach = Math.hypot(CAR.halfLength, CAR.halfWidth) + 1;
  for (const b of nearbyBuildings(world, c.x, c.z, reach)) {
    if (!blocksBand(b, c.y + 0.5, c.y + CAR.bodyHeight)) continue;
    if (pointInPolygon(c.x, c.z, b.footprint) || closestOnBoundary(c.x, c.z, b.footprint).d2 < reach * reach) return true;
  }
  return false;
}

/** The surface a car starting on edge `edge` at the path's first point stands on. */
function startY(world: World, edge: string, path: ReadonlyArray<readonly [number, number]>): number {
  const [x, z] = path[0]!;
  return surfaceAt(world, x, z, roadSurfaceHeight(world, edge, x, z)).y;
}

/** The decks of an edge, from every tile. */
function decksOf(world: World, edge: string): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (const t of world.tiles) for (const d of t.decks ?? []) if (d.edge === edge) out.push(...d.path);
  return out;
}

describe.skipIf(!SF)("street bridges over the creeks (W-12)", () => {
  // The bridges the QA drove: 3rd St (Lefty O'Doul, its bascule held closed) and 4th St over
  // Mission Creek, 3rd St and Illinois St over Islais Creek.
  const BRIDGES: Array<[string, string[]]> = [
    ["3rd St over Mission Creek", ["c182000", "c183000"]],
    ["4th St over Mission Creek", ["c270002", "c271000"]],
    ["3rd St over Islais Creek", ["c197101", "c197201"]],
    ["Illinois St over Islais Creek", ["c15166000"]],
  ];

  it(
    "at 15 and 25 m/s both ways: over the water the car is on the deck, never below its lower abutment less 0.2 m, never airborne; to the end",
    () => {
      const { world, roads } = sfWorld();
      const shore = world.walls!.shore;
      for (const [name, ids] of BRIDGES) {
        // The lower abutment: the lower of the decks' two ends (where they meet the banks).
        let lower = Infinity;
        for (const id of ids) {
          const d = decksOf(world, id);
          expect(d.length, `${name}: ${id} has a deck`).toBeGreaterThan(1);
          lower = Math.min(lower, d[0]![1], d[d.length - 1]![1]);
        }
        for (const rev of [false, true]) {
          for (const v of [15, 25]) {
            const path = route(roads, ids, rev);
            let wet = 0;
            let minWetY = Infinity;
            let wetAir = 0;
            let offDeck = 0;
            const r = drivePath(
              world,
              path,
              v,
              Math.min(v, 15),
              (c) => {
                if (!onWater(shore, c.x, c.z)) return;
                wet++;
                minWetY = Math.min(minWetY, c.y);
                if (!c.grounded) wetAir++;
                // No wheel on the water: what the car stands on there is the deck.
                if (surfaceAt(world, c.x, c.z, c.y).kind !== "deck") offDeck++;
              },
              startY(world, rev ? ids[ids.length - 1]! : ids[0]!, path),
            );
            const label = `${name}${rev ? " (back)" : ""} at ${v} m/s`;
            expect(r.reached, label).toBe(true);
            expect(wet, `${label}: crosses the water`).toBeGreaterThan(10);
            expect(offDeck, label).toBe(0);
            expect(minWetY, label).toBeGreaterThanOrEqual(lower - 0.2);
            expect(wetAir, label).toBe(0);
          }
        }
      }
    },
    CITY_MS,
  );

  it(
    "design.md: seeded drives over the 3rd St bridge keep y above 3 m over the water, and a car steered hard off it mid-span stays on the deck",
    () => {
      const { world, roads } = sfWorld();
      const shore = world.walls!.shore;
      const path = route(roads, ["c182000", "c183000"]);
      // Seeded: start speed and throttle from an LCG, both ways.
      let s = 12345;
      const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
      for (let k = 0; k < 8; k++) {
        const p = k % 2 === 0 ? path : [...path].reverse();
        const v = 10 + 18 * rnd();
        let minY = Infinity;
        drivePath(world, p, v, v * rnd(), (c) => {
          if (onWater(shore, c.x, c.z)) minY = Math.min(minY, c.y);
        }, startY(world, k % 2 === 0 ? "c182000" : "c183000", p));
        expect(minY, `run ${k} at ${v.toFixed(1)} m/s`).toBeGreaterThan(3);
      }
      // Mid-span (the first point over the water plus 20 m), full lock either way at 20 m/s.
      const mid = path.findIndex(([x, z]) => onWater(shore, x, z)) + 20;
      const [x, z] = path[mid]!;
      const [nx, nz] = path[mid + 3]!;
      for (const steer of [1, -1]) {
        let c: CarState = { ...makeCar(x, z, bearing(nx - x, nz - z), surfaceAt(world, x, z, 3.5).y), speed: 20 };
        for (let t = 0; t < 180; t++) {
          c = stepCar(world, c, { throttle: 1, steer, brake: 0, actions: 0 });
          if (onWater(shore, c.x, c.z)) expect(c.y, `steer ${steer} tick ${t}`).toBeGreaterThan(3);
        }
      }
    },
    CITY_MS,
  );
});

describe.skipIf(!SF)("tunnels (W-02)", () => {
  /** Drive a tunnel edge (from `from`, an index into its path) at 25 m/s: progress, hits, and in the bore the most it rose off the floor and its airborne ticks. */
  function driveBore(world: World, roads: RoadsFile, id: string, rev: boolean, from = 0): { reached: boolean; hits: number; boreTicks: number; off: number; air: number; progress: string } {
    const path = route(roads, [id], rev).slice(from);
    let boreTicks = 0;
    let off = 0;
    let air = 0;
    const r = drivePath(
      world,
      path,
      25,
      15,
      (c) => {
        const s = surfaceAt(world, c.x, c.z, c.y);
        if (s.kind !== "tunnel") return;
        boreTicks++;
        off = Math.max(off, Math.abs(c.y - s.y));
        if (!c.grounded) air++;
      },
      startY(world, id, path),
    );
    return { reached: r.reached, hits: r.hits, boreTicks, off, air, progress: `${r.progressM} of ${r.lenM} m` };
  }

  it(
    "both Broadway Tunnel bores, Stockton and the Toll Plaza tunnel both ways, at 25 m/s along the whole edge: end to end, 0 hits, on the bore's floor, never airborne in it",
    () => {
      const { world, roads } = sfWorld();
      for (const [id, rev] of [
        ["c3186101", false],
        ["c3186201", false],
        ["c12225000", false],
        ["c12225000", true],
        ["c19939000", false],
        ["c19939000", true],
      ] as const) {
        const r = driveBore(world, roads, id, rev);
        const label = `${id}${rev ? " (back)" : ""}: ${r.progress}`;
        expect(r.reached, label).toBe(true);
        expect(r.hits, label).toBe(0);
        expect(r.boreTicks, label).toBeGreaterThan(60);
        // (The QA's bound: within 1 m of the bore's floor line.)
        expect(r.off, label).toBeLessThan(1);
        expect(r.air, label).toBe(0);
      }
    },
    CITY_MS,
  );

  it(
    "the one deck that contradicts its own edge's bore is the overpass ribbon over the Broadway Tunnel's west portal; the eastbound approach runs on the ground into the bore",
    () => {
      const { world, roads } = sfWorld();
      // The pipeline's c3186101.o~0 rose from 53.8 m to 62.2 m along the eastbound approach and
      // ended at 60.8 m over the west portal, 5 m over the bore's floor, so a car following the
      // edge climbed it and stopped against the houses over the portal (at a6caf4e: 204 of 885 m).
      // The sim leaves it out (contradictoryDecks); listed for Pipeline to drop at the source.
      expect([...contradictoryDecks(world.tiles)]).toEqual(["c3186101.o"]);
      const bore = world.tiles.flatMap((t) => t.tunnels ?? []).filter((u) => u.edge === "c3186101");
      const portal = bore.map((u) => u.path[0]!).sort((a, b) => a[0] - b[0])[0]!;
      const path = route(roads, ["c3186101"]);
      // Along the approach, up to 5 m short of the portal, a car on the road stands on the ground.
      let n = 0;
      for (const [x, z] of path) {
        if (Math.hypot(x - portal[0], z - portal[2]) < 5 || x > portal[0]) break;
        const g = surfaceAt(world, x, z, -1000).y;
        const s = surfaceAt(world, x, z, g + 0.1);
        expect(s.kind, `${x.toFixed(1)}, ${z.toFixed(1)}`).toBe("ground");
        n++;
      }
      expect(n).toBeGreaterThan(150);
    },
    CITY_MS,
  );

  it(
    "both Broadway Tunnel bores and the Stockton tunnel are open to traffic: their lanes are clear of the houses over them, and robotaxis ride the floor",
    () => {
      const { world } = sfWorld();
      for (const id of ["c3186101", "c3186201", "c12225000"]) {
        const e = world.roads!.edges.find((q) => q.id === id)!;
        expect(e.drivable, id).toBe(true);
        expect(e.laneClear[0].some(Boolean) || e.laneClear[1].some(Boolean), id).toBe(true);
      }
      // Halfway along the westbound bore its road surface is the floor, 20 m or more under Russian Hill.
      const u = world.tiles.flatMap((t) => t.tunnels ?? []).find((q) => q.edge === "c3186201" && q.path.length > 60)!;
      const [x, y, z] = u.path[Math.floor(u.path.length / 2)]!;
      expect(roadSurfaceHeight(world, "c3186201", x, z)).toBeCloseTo(y, 6);
      expect(surfaceAt(world, x, z, y + 30).y - y).toBeGreaterThan(20);
    },
    CITY_MS,
  );
});

describe.skipIf(!SF)("freeways on their decks (W-03, W-07)", () => {
  // The routes in travel order, from roads.json (the city part of I-80: the Bay Bridge's west
  // span over the open Bay is walled until wave 8 models it).
  const I280_NB = ["c19313000", "c19312000", "c19311000", "c19310000", "c19309000", "c19308000", "c19307000", "c19306000", "c19305000", "c19304000", "c19298000", "c19303000", "c19302000", "c19301000", "c19300000"];
  const I280_SB = ["c19338000", "c19339000", "c19340000", "c19341000", "c19342000", "c19343000", "c19344000", "c19345000", "c19346000", "c19347000", "c19348000", "c19349000", "c19350000", "c19351000", "c19352000"];
  const I80_EB = ["c19370000", "c19369000", "c19368000", "c19367000", "c19366000", "c19365000", "c19364000", "c14248000"];
  const I80_WB = ["c14249000", "c19382000", "c19383000", "c19384000", "c19385000", "c19386000", "c19387000", "c19388000"];

  /**
   * Drive a freeway route at v (25) m/s: progress, hits (and the hardest), hits with a building
   * beside the car, and on its decks how far the car was over the deck at most.
   */
  function freeway(world: World, roads: RoadsFile, ids: readonly string[], from = 0, v = 25): { reached: boolean; hits: number; hardest: number; buildingHits: number; deckTicks: number; offDeck: number; progress: string; end: CarState } {
    const path = route(roads, ids).slice(from);
    let deckTicks = 0;
    let offDeck = 0;
    let hits = 0;
    let hardest = 0;
    let buildingHits = 0;
    const r = drivePath(
      world,
      path,
      v,
      Math.min(v, 20),
      (c) => {
        if (c.hits > hits) {
          hits = c.hits;
          hardest = Math.max(hardest, c.impactSpeed);
          if (buildingBeside(world, c)) buildingHits++;
        }
        const s = surfaceAt(world, c.x, c.z, c.y);
        if (s.kind !== "deck") return;
        deckTicks++;
        offDeck = Math.max(offDeck, c.y - s.y);
      },
      startY(world, ids[0]!, path),
    );
    return { reached: r.reached, hits: r.hits, hardest, buildingHits, deckTicks, offDeck, progress: `${r.progressM} of ${r.lenM} m`, end: r.end };
  }

  it(
    "I-280 northbound and southbound, end to end at 25 m/s: no stop, no building in the way, on the decks over the creeks and the streets",
    () => {
      const { world, roads } = sfWorld();
      for (const [name, ids] of [
        ["I-280 northbound", I280_NB],
        ["I-280 southbound", I280_SB],
      ] as const) {
        const r = freeway(world, roads, ids);
        expect(r.reached, `${name}: ${r.progress}`).toBe(true);
        expect(r.buildingHits, name).toBe(0);
        // At two exits southbound the off-ramp's deck overlaps the freeway's lane where it
        // leaves it (c19320000, c19321000) and the car grazes its rail at 2 m/s; nothing harder.
        expect(r.hits, name).toBeLessThanOrEqual(2);
        expect(r.hardest, name).toBeLessThan(3);
        // Most of the way on a deck (the rest in cuts and on embankments, on the ground).
        expect(r.deckTicks, name).toBeGreaterThan(5000);
        // (A crest or a deck's end can leave the car a little in the air; never a fall.)
        expect(r.offDeck, name).toBeLessThan(1.5);
      }
    },
    CITY_MS,
  );

  it(
    "I-80 from the US-101 interchange to the Bay Bridge's west span, and westbound from the span's shore end to US-101: no stop on the way, no building",
    () => {
      const { world, roads } = sfWorld();
      const shore = world.walls!.shore;
      // Eastbound: until the span leaves the shore at Rincon Point.
      const eb = route(roads, I80_EB);
      const wetAt = eb.findIndex(([x, z]) => onWater(shore, x, z));
      expect(wetAt).toBeGreaterThan(2000);
      const ebR = freeway(world, roads, I80_EB);
      // It stops only at the span's wall, where the freeway leaves the shore.
      expect(Number(ebR.progress.split(" ")[0]), ebR.progress).toBeGreaterThan(wetAt - 40);
      expect(Math.hypot(ebR.end.x - eb[wetAt]![0], ebR.end.z - eb[wetAt]![1]), ebR.progress).toBeLessThan(40);
      expect(ebR.hits, ebR.progress).toBeLessThanOrEqual(1);
      expect(ebR.buildingHits, `eastbound building hits, ${ebR.progress}`).toBe(0);
      expect(ebR.deckTicks).toBeGreaterThan(3000);
      // Westbound: the whole land route, from where it leaves the span (c19382000) to US-101, at
      // 20 and 25 m/s. Near 1st St (x 186 to 200, z 1100 to 1110) the pipeline's westbound deck
      // lies inside the eastbound one (centrelines 2.5 m apart, both ribbons 13.8 m wide), rising
      // 1 to 3 m over it, and ends there on the ground under it; a car keeps to its own deck by
      // its centreline (at a6caf4e it rode onto the eastbound deck at a crest and stopped at 458
      // of 2756 m; the overlap is listed for Pipeline).
      for (const v of [20, 25]) {
        const wbR = freeway(world, roads, I80_WB.slice(1), 0, v);
        expect(wbR.reached, `westbound at ${v} m/s: ${wbR.progress}`).toBe(true);
        // (Rail grazes only, as on I-280.)
        expect(wbR.hits, `westbound hits at ${v} m/s, ${wbR.progress}`).toBeLessThanOrEqual(2);
        expect(wbR.hardest, "westbound hardest hit").toBeLessThan(3);
        expect(wbR.buildingHits, "westbound building hits").toBe(0);
        expect(wbR.deckTicks).toBeGreaterThan(3000);
      }
    },
    CITY_MS,
  );

  it(
    "a car steered hard off the I-280 viaduct at 25 m/s is held by its rail: it stays on the deck",
    () => {
      const { world, roads } = sfWorld();
      const path = route(roads, I280_NB);
      const edges = routeEdges(roads, I280_NB);
      // Every 200 m along the route where the deck stands 5 m or more over the ground.
      let tried = 0;
      for (let i = 50; i + 5 < path.length; i += 200) {
        const [x, z] = path[i]!;
        const s = surfaceAt(world, x, z, roadSurfaceHeight(world, edges[i]!, x, z));
        if (s.kind !== "deck" || s.y - surfaceAt(world, x, z, -100).y < 5) continue;
        tried++;
        const [nx, nz] = path[i + 5]!;
        for (const steer of [1, -1]) {
          let c: CarState = { ...makeCar(x, z, bearing(nx - x, nz - z), s.y), speed: 25 };
          for (let t = 0; t < 150; t++) {
            c = stepCar(world, c, { throttle: 1, steer, brake: 0, actions: 0 });
            const under = surfaceAt(world, c.x, c.z, c.y);
            // Never off the edge: never more than a hop over what is under it (off the deck's
            // side it would be 5 m or more over the ground).
            expect(c.y - under.y, `at ${i} m, steer ${steer}, tick ${t}`).toBeLessThan(1.5);
          }
        }
      }
      expect(tried).toBeGreaterThan(10);
    },
    CITY_MS,
  );
});

describe.skipIf(!SF)("piers and grade separations (W-13, W-14)", () => {
  it(
    "Al Scoma Way, Pier 45 Vly and Pier 50 Vly at 15 m/s both ways: on the pier deck (2.5 m or more) over the water, 0 hits, to the end",
    () => {
      const { world, roads } = sfWorld();
      const shore = world.walls!.shore;
      for (const id of ["c15207000", "c15356000", "c15358000"]) {
        for (const rev of [false, true]) {
          const path = route(roads, [id], rev);
          let low = Infinity;
          let piers = 0;
          const r = drivePath(world, path, 15, 10, (c) => {
            if (onWater(shore, c.x, c.z)) piers++;
            low = Math.min(low, c.y);
          }, startY(world, id, path));
          expect(r.reached, `${id}${rev ? " back" : ""}: ${r.progressM} of ${r.lenM} m`).toBe(true);
          expect(r.hits, id).toBe(0);
          expect(low, id).toBeGreaterThanOrEqual(2.5);
          expect(piers, `${id}: never over open water`).toBe(0);
        }
      }
    },
    CITY_MS,
  );

  it(
    "Richland Ave over I-280 at 16 and 20 m/s both ways: no airborne interval over 0.2 s, 0 hits",
    () => {
      const { world, roads } = sfWorld();
      for (const v of [16, 20]) {
        for (const rev of [false, true]) {
          const path = route(roads, ["c11011002"], rev);
          const r = drivePath(world, path, v, v, undefined, startY(world, "c11011002", path));
          expect(r.reached).toBe(true);
          expect(r.hits).toBe(0);
          expect(r.maxAirS, `${v} m/s${rev ? " back" : ""}`).toBeLessThanOrEqual(0.2);
        }
      }
    },
    CITY_MS,
  );
});
