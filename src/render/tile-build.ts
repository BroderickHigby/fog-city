// Build one tile's meshes from collider data and the road graph, incrementally.
// buildTileMeshes is a generator: the browser pumps it under a per-frame time budget so a
// big tile never stalls the sim loop; Node (the dev-city generator) just drains it.

import type { TileCollider } from "../sim/world.ts";
import {
  MeshBuilder,
  addBuilding,
  addFlatGround,
  addHeightfield,
  addRoad,
  defaultGroundColor,
  type GroundColorFn,
  type MeshData,
  type RoadContext,
} from "./tile-geometry.ts";
import type { TileBounds } from "./tile-select.ts";
import type { RoadEdge } from "./types.ts";

export interface TileBuildInput {
  collider: TileCollider;
  bounds: TileBounds;
  /** Road edges assigned to this tile (roads.assignEdgesToTiles). */
  roads: readonly RoadEdge[];
  roadCtx: RoadContext | null;
  /** Generated buildings to leave out (replaced by landmarks). */
  skipBuildings?: ReadonlySet<string>;
  groundColor?: GroundColorFn;
  /** Land drawn around tiles whose bounds were derived from contents and that have no heightfield. */
  flatGroundMargin?: number;
  /** Which layers to build. A loaded glb may already provide some. */
  layers?: { buildings?: boolean; ground?: boolean; roads?: boolean };
  /** Visual setbacks and rooftop boxes. */
  detail?: boolean;
}

export interface TileMeshes {
  buildings: MeshData | null;
  ground: MeshData | null;
  roads: MeshData | null;
  buildingCount: number;
}

/** Height of flat land for tiles with no heightfield: just above the Bay plane at y = 0. */
export const FLAT_GROUND_Y = 0.03;

export function* buildTileMeshes(input: TileBuildInput): Generator<void, TileMeshes, void> {
  const layers = { buildings: true, ground: true, roads: true, ...input.layers };
  const out: TileMeshes = { buildings: null, ground: null, roads: null, buildingCount: 0 };

  if (layers.ground) {
    const mb = new MeshBuilder();
    const g = input.collider.ground;
    if (g) {
      addHeightfield(mb, g, input.groundColor ?? defaultGroundColor);
    } else {
      const b = input.bounds;
      const m = b.exact ? 0 : (input.flatGroundMargin ?? 300);
      if (b.maxX > b.minX || b.maxZ > b.minZ || m > 0) addFlatGround(mb, b.minX - m, b.minZ - m, b.maxX + m, b.maxZ + m, FLAT_GROUND_Y);
    }
    if (mb.indexCount > 0) out.ground = mb.build();
    yield;
  }

  if (layers.buildings) {
    const mb = new MeshBuilder({ uv: true, facade: true });
    let n = 0;
    for (const b of input.collider.buildings) {
      if (input.skipBuildings?.has(b.id)) continue;
      if (addBuilding(mb, b as typeof b & { meta?: Record<string, unknown> }, { detail: input.detail ?? true })) out.buildingCount++;
      if (++n % 40 === 0) yield;
    }
    if (mb.indexCount > 0) out.buildings = mb.build();
    yield;
  }

  if (layers.roads && input.roadCtx && input.roads.length > 0) {
    const mb = new MeshBuilder();
    let n = 0;
    for (const e of input.roads) {
      addRoad(mb, e, input.roadCtx);
      if (++n % 25 === 0) yield;
    }
    if (mb.indexCount > 0) out.roads = mb.build();
  }
  return out;
}

/** Run a generator to completion (offline tools, tests). */
export function drain<T>(gen: Generator<void, T, void>): T {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}
