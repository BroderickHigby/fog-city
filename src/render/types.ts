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
