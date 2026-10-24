// Real street trees from San Francisco Public Works' Street Tree Inventory (tkzw-k3nq): every
// mapped tree with a position and a species, classed for the renderer and sized from its trunk
// diameter. Render-only (no colliders). Ids are `tree:<treeid>`, stable across rebuilds.
//
// Classes: palm (true palms and the palm-like Cordyline/Yucca), conifer (pines, cypresses,
// redwoods, junipers, yews, podocarps, araucarias, cedars), broadleaf (everything else).
// Height from DBH (inches, `mapdbh`), clamped per class; a missing DBH takes the class default.
// Empty planting sites, "Landscape Plants" and undetermined rows are left out.

import { toLocal } from "../../src/geo/project.ts";

export const TREE_CLASSES = ["broadleaf", "conifer", "palm"] as const;
export type TreeClass = (typeof TREE_CLASSES)[number];

const PALMS = /^(Phoenix|Washingtonia|Syagrus|Trachycarpus|Butia|Archontophoenix|Chamaerops|Brahea|Livistona|Howea|Jubaea|Rhopalostylis|Sabal|Cordyline|Yucca|Dracaena)\b/i;
const CONIFERS = /^(Pinus|Cupressus|Hesperocyparis|x ?Cupressocyparis|Sequoia|Sequoiadendron|Juniperus|Podocarpus|Afrocarpus|Araucaria|Cedrus|Taxus|Thuja|Callitris|Cryptomeria|Abies|Picea|Pseudotsuga|Metasequoia|Taxodium|Calocedrus|Casuarina)\b/i;
const SKIP = /^(Planting site|Landscape Plants|To Be Determine|Potential Site|Not a tree|Shrub)/i;

export function treeClass(species: string): TreeClass | null {
  const latin = species.split("::")[0]!.trim();
  if (!latin || SKIP.test(latin)) return null;
  if (PALMS.test(latin)) return "palm";
  if (CONIFERS.test(latin)) return "conifer";
  return "broadleaf";
}

const SIZE: Record<TreeClass, { base: number; perInch: number; min: number; max: number; fallback: number }> = {
  broadleaf: { base: 3, perInch: 0.42, min: 3, max: 20, fallback: 6.5 },
  conifer: { base: 4, perInch: 0.5, min: 3.5, max: 30, fallback: 9 },
  palm: { base: 3.5, perInch: 0.55, min: 2.5, max: 22, fallback: 8 },
};

/** Height in metres from DBH in inches. */
export function treeHeight(cls: TreeClass, dbh: number | null): number {
  const s = SIZE[cls];
  if (dbh === null || !Number.isFinite(dbh) || dbh <= 0 || dbh > 120) return s.fallback;
  return Math.round(Math.min(s.max, Math.max(s.min, s.base + s.perInch * dbh)) * 10) / 10;
}

export interface TreeRow {
  treeid?: string;
  species?: string;
  mapdbh?: string;
  latitude?: string;
  longitude?: string;
}

/** [treeid, x, z, class index, height] per tree, by tree id. */
export function buildTrees(rows: readonly TreeRow[], inWorld: (x: number, z: number) => boolean): { trees: Array<[number, number, number, number, number]>; skipped: number } {
  const trees: Array<[number, number, number, number, number]> = [];
  let skipped = 0;
  const seen = new Set<number>();
  for (const r of rows) {
    const id = Number(r.treeid);
    const lat = Number(r.latitude), lon = Number(r.longitude);
    const cls = treeClass(r.species ?? "");
    if (!Number.isFinite(id) || seen.has(id) || !cls || !Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0) {
      skipped++;
      continue;
    }
    const p = toLocal(lat, lon);
    if (!inWorld(p.x, p.z)) {
      skipped++;
      continue;
    }
    seen.add(id);
    const dbh = r.mapdbh === undefined ? null : Number(r.mapdbh);
    trees.push([id, Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10, TREE_CLASSES.indexOf(cls), treeHeight(cls, dbh)]);
  }
  trees.sort((a, b) => a[0] - b[0]);
  return { trees, skipped };
}
