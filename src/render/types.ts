// Shapes the renderer reads from world data (schemas/tile-manifest.schema.json,
// schemas/roads.schema.json). Optional fields are optional on purpose: the renderer
// tolerates manifests from any producer that satisfies the schema.

export interface ManifestTile {
  id: string;
  ix?: number;
  iz?: number;
  /** [minX, minZ, maxX, maxZ] in local metres. */
  bbox?: [number, number, number, number];
  collider: string;
  glb: string | null;
  roads?: string | null;
  stats?: Record<string, number>;
}

export interface Manifest {
  version: number;
  world: string;
  origin?: { lat: number; lon: number };
  tileSizeM?: number;
  spawn: { x: number; z: number; heading: number };
  attribution?: string[];
  tiles: ManifestTile[];
  roads?: string | null;
  /** The citywide collider pack (schemas/world-colliders.md). */
  worldColliders?: string;
  /** Data layers by name: boundary, districts, sidewalks, ... */
  layers?: Record<string, string>;
  /** Side of a far-LOD cell, metres. */
  farCellSizeM?: number;
  /** Far-LOD cells: one glb per cell, drawn beyond the streamed tiles (far-layer.ts). */
  far?: Array<{ id: string; cx?: number; cz?: number; bbox?: [number, number, number, number]; glb: string; stats?: Record<string, number> }>;
  /** The sea: its height, the candidate rectangle, and the open-water tiles that have no files. */
  water?: { y: number; bbox?: [number, number, number, number]; tiles?: string[] };
  /** Tiles with land but no file (Marin, Alcatraz, Daly City): far terrain only. */
  outside?: { description?: string; tiles: Array<{ id: string; area?: string }> };
}

export type RoadKind = "freeway" | "arterial" | "collector" | "residential" | "alley" | "ramp" | "other";

export interface RoadNode {
  id: string;
  x: number;
  z: number;
  y?: number;
}

export interface RoadEdge {
  id: string;
  a: string;
  b: string;
  kind: RoadKind;
  lanes: number;
  oneway: boolean;
  widthM?: number;
  speedLimitMps?: number;
  name?: string;
  points: Array<[number, number]>;
  /** Pedestrian-only (stairways included): not a carriageway. */
  pedestrian?: boolean;
  /** A limited-access road on a viaduct, in a cut or a tunnel: its points are the ground under it. */
  gradeSeparated?: boolean;
  /** Part of it is on a deck (the colliders' decks hold its surface). */
  deck?: boolean;
  /** Part of it runs in a bore (the colliders' tunnels). */
  tunnel?: boolean;
  /** A public stairway. */
  stairs?: boolean;
}

export interface RoadGraph {
  version: number;
  nodes: RoadNode[];
  edges: RoadEdge[];
}

/** A renderable pose: position plus compass heading (radians clockwise from north). */
export interface Pose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

/** Ground height lookup in local metres. */
export type GroundFn = (x: number, z: number) => number;
