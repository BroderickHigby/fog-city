// Synthetic worlds for sim tests. Hand-built so every feature the traffic code must handle
// is present and known: 4-way and T intersections, a one-way street, a four-lane arterial,
// a dead end, an acute diagonal junction, a hill, and a building that intrudes onto one
// sidewalk (that sidewalk must be refused by the road graph and never walked).

import { buildWorld, type BuildingCollider, type Heightfield, type RoadsFile, type TileCollider, type World } from "../../src/sim/index.ts";
import { loadWorld, readJson } from "../helpers.ts";

/**
 * Timeout for tests that run thousands of ticks. They take 0.5 to 4 s on an idle 4-core
 * machine, and a loaded CI runner can be several times slower, so vitest's default 5 s would
 * fail them at random. Set per test here because vitest.config.ts belongs to the harness.
 */
export const LONG_RUN_MS = 60_000;

/** Timeout for the real-SF world tests: building the city plus hundreds of ticks with hundreds of agents. */
export const SF_RUN_MS = 180_000;

/** The dev world (public/tiles/dev) with its roads.json loaded too. */
export function loadDevWorldWithRoads(): { world: World; spawn: { x: number; z: number; heading: number } } {
  const { world: plain, manifest } = loadWorld("dev");
  const roads = readJson<RoadsFile>("public/tiles/dev/roads.json");
  return { world: buildWorld(plain.tiles, roads), spawn: manifest.spawn };
}

function rect(id: string, x0: number, z0: number, x1: number, z1: number, topY = 15): BuildingCollider {
  return { id, footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY: 0, topY };
}

export const GRID = 100;

/**
 * A 4 x 4 grid of nodes 100 m apart (x and z in [0, 300]), 3 x 3 blocks of buildings set back
 * 12 m from the street centrelines (sidewalks centred 7.5 m out on 11 m roads), plus:
 *  - street x = 100 is one-way southbound (+z), two lanes;
 *  - street z = 200 is a four-lane arterial (18 m wide);
 *  - a dead-end stub east from (300, 100) to (360, 100);
 *  - a diagonal from (0, 0) to (-70, -60) meeting the grid at an acute angle with the
 *    street running north from (0, 0) to (0, -80);
 *  - building "intruder" covers the south sidewalk of street z = 0 between x 130 and 170;
 *  - building "awning" narrows the north sidewalk of z = 0 between x 230 and 270.
 * The ground rises 12% eastwards from x = 150 to x = 300 when `hill` is set.
 */
export function gridCity(hill = false): World {
  const nodes: RoadsFile["nodes"][number][] = [];
  const id = (i: number, j: number) => `g${i}${j}`;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) nodes.push({ id: id(i, j), x: i * GRID, z: j * GRID });
  nodes.push({ id: "stub", x: 360, z: 100 }, { id: "diag", x: -70, z: -60 }, { id: "north", x: 0, z: -80 });

  type Edge = RoadsFile["edges"][number];
  const edges: Edge[] = [];
  const street = (eid: string, a: string, b: string, pts: Array<[number, number]>, extra: Partial<Edge> = {}): void => {
    edges.push({ id: eid, a, b, kind: "residential", lanes: 2, oneway: false, widthM: 11, speedLimitMps: 11.18, points: pts, ...extra });
  };
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 3; i++) {
      const arterial = j === 2;
      street(`h${i}${j}`, id(i, j), id(i + 1, j), [[i * GRID, j * GRID], [(i + 1) * GRID, j * GRID]], arterial ? { kind: "arterial", lanes: 4, widthM: 18 } : {});
    }
  }
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      const oneway = i === 1;
      street(`v${i}${j}`, id(i, j), id(i, j + 1), [[i * GRID, j * GRID], [i * GRID, (j + 1) * GRID]], oneway ? { oneway: true, lanes: 2 } : {});
    }
  }
  street("stub", id(3, 1), "stub", [[300, 100], [330, 100], [360, 100]]);
  street("diag", id(0, 0), "diag", [[0, 0], [-35, -30], [-70, -60]]);
  street("north", id(0, 0), "north", [[0, 0], [0, -80]]);

  const roads: RoadsFile = { version: 1, nodes, edges };

  const buildings: BuildingCollider[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const halfArterial = (z: number) => (z === 200 ? 15.5 : 12);
      buildings.push(rect(`b${i}${j}`, i * GRID + 12, j * GRID + halfArterial(j * GRID), (i + 1) * GRID - 12, (j + 1) * GRID - halfArterial((j + 1) * GRID)));
    }
  }
  // Pokes across the whole south sidewalk of z = 0 and into the parking strip: no sidewalk
  // line on that side clears it.
  buildings.push(rect("intruder", 130, 4.0, 170, 12));
  // An awning over the north sidewalk of z = 0 east of x = 200: the preferred line (2 m beyond
  // the kerb) and the 1.5 m fallback touch it, the 1 m fallback clears it.
  buildings.push(rect("awning", 230, -9.5, 270, -7.8, 4));
  // A building at the end of the stub and one inside the acute corner.
  buildings.push(rect("stub-end", 368, 80, 390, 120));
  buildings.push(rect("acute", -30, -70, -12, -40));

  let ground: Heightfield | null = null;
  if (hill) {
    const x0 = -150;
    const z0 = -150;
    const cell = 5;
    const nx = 121;
    const nz = 101;
    const heights: number[] = [];
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = x0 + ix * cell;
        heights.push(x <= 150 ? 0 : 0.12 * (Math.min(x, 300) - 150));
      }
    }
    ground = { x0, z0, cellSizeM: cell, nx, nz, heights };
  }
  const tile: TileCollider = { tileId: "grid", buildings, ground };
  return buildWorld([tile], roads);
}

/** A flat world with no buildings and no roads. */
export function emptyWorld(): World {
  return buildWorld([{ tileId: "empty", buildings: [], ground: null }]);
}

/** A heightfield world (no buildings) from h(x, z), cell `cell` metres, covering [-r, r] square. */
export function terrainWorld(h: (x: number, z: number) => number, r = 400, cell = 2): World {
  const n = Math.round((2 * r) / cell) + 1;
  const heights: number[] = [];
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) heights.push(h(-r + ix * cell, -r + iz * cell));
  return buildWorld([{ tileId: "terrain", buildings: [], ground: { x0: -r, z0: -r, cellSizeM: cell, nx: n, nz: n, heights } }]);
}

/** A flat world with one long wall: footprint x in [-300, 300], z in [-60, -50], 10 m tall. */
export function wallWorld(): World {
  return buildWorld([{ tileId: "wall", buildings: [rect("wall", -300, -60, 300, -50, 10)], ground: null }]);
}

/** The height of surfaceWorld's overpass deck at z (its vertices sample this every 4 m). */
export function overpassY(z: number): number {
  if (z <= 0 || z >= 260) return 0;
  if (z <= 100) return 3 * (1 - Math.cos((Math.PI * z) / 100));
  if (z <= 160) return 6;
  return 3 * (1 + Math.cos((Math.PI * (z - 160)) / 100));
}

/**
 * Decks, a tunnel bore and a stairway (world QA W-02, W-03, W-12, W-33; surfaceAt). On a 2 m
 * lattice over [-300, 300] (flat at 0 m):
 *  - a ridge along x, 20 m high at z = -100, falling to the flat at z = -140 and z = -60;
 *  - a tunnel bore along x = 0 under it, floor level at 0 m from portal z = -150 to portal
 *    z = -50, 8 m wide, ceiling 5 m over the floor ("bore"); a house on the ridge over it
 *    ("over-bore", its underside at the ceiling, as the pipeline marks them);
 *  - an overpass deck along x = 30, 12 m wide ("overpass", vertices every 4 m): up from 0 m at
 *    z = 0 to 6 m at z = 100 on a rounded profile (overpassY, at most 9.4%), level to z = 160,
 *    down to 0 m at z = 260; a street at grade crosses under it along z = 130;
 *  - with roads: the streets x = 30 (on the deck, edge "deck-st"), x = 0 (through the bore,
 *    edge "bore-st"), z = 130 (under the deck, "under-st") and z = 200 (10 m wide, "walk-st"),
 *    and a 3 m stairway "stairs" north from (-100, 200) to (-100, 260) up 30 m of hill.
 */
export function surfaceWorld(withRoads = false): World {
  const r = 300;
  const cell = 2;
  const n = r + 1;
  const heights: number[] = [];
  const h = (x: number, z: number): number => {
    const ridge = 20 * Math.max(0, 1 - ((z + 100) / 40) ** 2);
    // The stair's hill: rising north of z = 200 west of x = -60.
    const hill = x < -60 && z > 200 ? Math.min(30, (z - 200) * 0.5) : 0;
    return ridge + hill;
  };
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) heights.push(h(-r + ix * cell, -r + iz * cell));
  const deckPath: Array<[number, number, number, number]> = [];
  for (let z = 0; z <= 260; z += 4) deckPath.push([30, overpassY(z), z, 12]);
  const tile: TileCollider = {
    tileId: "surfaces",
    buildings: [
      { id: "over-bore", footprint: [[-6, -106], [6, -106], [6, -94], [-6, -94]], baseY: 19.5, topY: 27, underY: 5 },
      { id: "beside", footprint: [[60, 20], [80, 20], [80, 60], [60, 60]], baseY: 0, topY: 12 },
    ],
    ground: { x0: -r, z0: -r, cellSizeM: cell, nx: n, nz: n, heights },
    decks: [{ id: "overpass", kind: "overpass", edge: "deck-st", layer: 1, path: deckPath }],
    tunnels: [{ id: "bore", kind: "tunnel", edge: "bore-st", clearanceM: 5, path: [[0, 0, -50, 8], [0, 0, -100, 8], [0, 0, -150, 8]] }],
  };
  if (!withRoads) return buildWorld([tile]);
  const node = (id: string, x: number, z: number): RoadsFile["nodes"][number] => ({ id, x, z });
  const roads: RoadsFile = {
    version: 1,
    nodes: [node("d0", 30, -20), node("d1", 30, 280), node("b0", 0, -20), node("b1", 0, -180), node("u0", -40, 130), node("u1", 100, 130), node("w0", -200, 200), node("w1", 0, 200), node("w2", -100, 200), node("s1", -100, 260)],
    edges: [
      { id: "deck-st", a: "d0", b: "d1", kind: "residential", lanes: 2, oneway: false, widthM: 11, deck: true, points: [[30, -20], [30, 280]] },
      { id: "bore-st", a: "b0", b: "b1", kind: "residential", lanes: 2, oneway: false, widthM: 8, tunnel: true, points: [[0, -20], [0, -180]] },
      { id: "under-st", a: "u0", b: "u1", kind: "residential", lanes: 2, oneway: false, widthM: 11, points: [[-40, 130], [100, 130]] },
      { id: "walk-st-a", a: "w0", b: "w2", kind: "residential", lanes: 2, oneway: false, widthM: 10, points: [[-200, 200], [-100, 200]] },
      { id: "walk-st-b", a: "w2", b: "w1", kind: "residential", lanes: 2, oneway: false, widthM: 10, points: [[-100, 200], [0, 200]] },
      { id: "stairs", a: "w2", b: "s1", kind: "other", lanes: 1, oneway: false, widthM: 3, pedestrian: true, stairs: true, points: [[-100, 200], [-100, 260]] },
    ],
  };
  return buildWorld([tile], roads);
}
