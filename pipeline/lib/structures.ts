// Street structures in the collider contract (schemas/tile-collider.schema.json, docs/design.md
// "Decks, tunnels and water"): what a road is carried on where the bare-earth DEM is not the
// road surface.
//
//   decks     ribbons above the ground: freeway viaducts and ramps, street bridges over creeks,
//             streets carried over a freeway cut. Per vertex: centreline x, z, the road surface
//             y and the full width w (kerb to kerb); the surface between two vertices is the
//             ruled quad between them. layer orders stacked decks (1 = over the ground, 2 = over
//             another deck).
//   tunnels   ribbons below the ground with a ceiling clearanceM above the road surface: bored
//             tunnels (portal to portal) and underpasses beneath a freeway embankment.
//   movable   a bascule leaf: the deck piece that lifts about a hinge line (the Lefty O'Doul
//             drawbridge on 3rd St). Its angle is sim state, not data.
//
// Every length is a whole number of centimetres, so the JSON and the collider pack agree bit
// for bit. Each tile lists the ribbon segments whose midpoints lie in it (splitPieces), so a
// world built from all tiles holds every segment exactly once.

import { TILE_SIZE_M } from "../../src/geo/project.ts";
import { r2 } from "./geom.ts";

export const DECK_KINDS = ["freeway", "ramp", "bridge", "overpass", "pier"] as const;
export type DeckKind = (typeof DECK_KINDS)[number];
export const TUNNEL_KINDS = ["tunnel", "underpass"] as const;
export type TunnelKind = (typeof TUNNEL_KINDS)[number];
export const MOVABLE_KINDS = ["bascule"] as const;
export type MovableKind = (typeof MOVABLE_KINDS)[number];

/** [x, y, z, w]: centreline position, road-surface height and full width, metres. */
export type RibbonVertex = [number, number, number, number];

export interface Deck {
  id: string;
  kind: DeckKind;
  /** The roads.json edge the deck carries. */
  edge?: string;
  layer: number;
  path: RibbonVertex[];
}

export interface Tunnel {
  id: string;
  kind: TunnelKind;
  edge?: string;
  /** Ceiling height above the road surface, metres. */
  clearanceM: number;
  path: RibbonVertex[];
}

export interface Movable {
  id: string;
  kind: MovableKind;
  /** The deck piece that lifts. */
  deck: string;
  /** The hinge line [x, z] -> [x, z]; the leaf rises on the side away from it. */
  hinge: [[number, number], [number, number]];
  /** Fully open angle, radians. */
  openRad: number;
}

/** A whole ribbon before it is cut into tiles. */
export interface Ribbon {
  /** Id prefix: pieces are `${id}~${n}`. */
  id: string;
  path: RibbonVertex[];
}

const tileOf = (x: number, z: number): string => `t${Math.floor(x / TILE_SIZE_M)}_${Math.floor(z / TILE_SIZE_M)}`;

/** Round a vertex to centimetres (positions, heights and widths). */
export function cmVertex(v: readonly number[]): RibbonVertex {
  return [r2(v[0]!), r2(v[1]!), r2(v[2]!), r2(v[3]!)];
}

/**
 * Cut a ribbon into per-tile pieces: each segment belongs to the tile holding its midpoint, and
 * a maximal run of consecutive segments in one tile is one piece. Neighbouring pieces share
 * their boundary vertex. Pieces are numbered along the ribbon.
 */
export function splitPieces(r: Ribbon): Array<{ tile: string; id: string; path: RibbonVertex[] }> {
  const out: Array<{ tile: string; id: string; path: RibbonVertex[] }> = [];
  const p = r.path;
  let cur: { tile: string; id: string; path: RibbonVertex[] } | null = null;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!;
    const b = p[i]!;
    const t = tileOf((a[0] + b[0]) / 2, (a[2] + b[2]) / 2);
    if (!cur || cur.tile !== t) {
      cur = { tile: t, id: `${r.id}~${out.length}`, path: [a] };
      out.push(cur);
    }
    cur.path.push(b);
  }
  return out;
}
