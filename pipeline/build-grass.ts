// DataSF-only lawns, from a committed, hash-pinned subset of the 2026-10-23 snapshot.
// No download, OSM extract, Git ref or ignored cache is needed to reproduce the asset.
//   node pipeline/build-grass.ts [--out <world-directory>] [--check]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonLines, jsonPretty } from "./lib/output.ts";

export const GRASS_FILE = "street-grass.json";
export const GRASS_ATTRIBUTION = "Lawns: Functional Areas maintained by Recreation and Parks Department, San Francisco Recreation and Parks via DataSF (38b7-6db3), ODC PDDL 1.0.";
export interface GrassPiece { id: string; kind: "lawn"; rings: number[][]; sourceId?: string }
export interface GrassSnapshot {
  version: number; datasetId: string; datasetUrl: string; metadataUrl: string;
  license: string; licenseUrl: string; snapshotDate: string; selection: string;
  sourceFile: string; sourceSha256: string; compressedSha256: string;
  compiledSourceCommit: string; compiledSourcePath: string; compiledSourceSha256: string;
  originalResponseSha256: string; originalResponseNote: string; sourcePieces: number;
}
const sha = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Preserve every coordinate and hole; disambiguate only repeated source ids by geometry. */
export function lawnPieces(source: unknown): GrassPiece[] {
  if (!record(source) || !Array.isArray(source.grass)) throw new Error("Grass source needs a grass array");
  const pieces: GrassPiece[] = source.grass.map((v: unknown) => {
    if (!record(v) || typeof v.id !== "string" || v.kind !== "lawn" || !Array.isArray(v.rings) || !v.rings.length) throw new Error("Only identified DataSF Lawn records are allowed");
    const cell = /^rpd:[\w.-]+:\d+@(-?\d+),(-?\d+)$/.exec(v.id);
    if (!cell) throw new Error(`Invalid DataSF lawn id: ${v.id}`);
    const cx = Number(cell[1]), cz = Number(cell[2]);
    const rings = v.rings.map((r: unknown) => {
      if (!Array.isArray(r) || r.length < 6 || r.length % 2 || !r.every(n => typeof n === "number" && Number.isFinite(n))) throw new Error(`Invalid lawn ring: ${v.id}`);
      const ring = r as number[];
      for (let i = 0; i < ring.length; i += 2) {
        if (ring[i]! < cx * 100 - .02 || ring[i]! > (cx + 1) * 100 + .02 || ring[i + 1]! < cz * 100 - .02 || ring[i + 1]! > (cz + 1) * 100 + .02) throw new Error(`Lawn leaves its source cell: ${v.id}`);
      }
      return [...ring];
    });
    return { id: v.id, kind: "lawn", rings };
  });
  const counts = new Map<string, number>();
  for (const p of pieces) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
  for (const p of pieces) if (counts.get(p.id)! > 1) {
    const id = p.id, at = id.indexOf("@");
    p.sourceId = id;
    p.id = `${id.slice(0, at)}~${sha(JSON.stringify(p.rings)).slice(0, 12)}${id.slice(at)}`;
  }
  pieces.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(pieces.map(p => p.id)).size !== pieces.length) throw new Error("Duplicate lawn geometries remain");
  return pieces;
}

export function readGrassSnapshot(root: string): { source: unknown; snapshot: GrassSnapshot } {
  const dir = join(root, "pipeline");
  const snapshot = JSON.parse(readFileSync(join(dir, "grass-snapshot.json"), "utf8")) as GrassSnapshot;
  const compressed = readFileSync(join(dir, snapshot.sourceFile));
  if (sha(compressed) !== snapshot.compressedSha256) throw new Error("Grass compressed snapshot hash mismatch");
  const bytes = gunzipSync(compressed);
  if (sha(bytes) !== snapshot.sourceSha256) throw new Error("Grass source snapshot hash mismatch");
  return { source: JSON.parse(bytes.toString("utf8")) as unknown, snapshot };
}

export function grassLayer(source: unknown, snapshot: GrassSnapshot, worldBounds: readonly [number, number, number, number]): Record<string, unknown> & { grass: GrassPiece[] } {
  if (snapshot.datasetId !== "38b7-6db3" || snapshot.license !== "ODC PDDL 1.0") throw new Error("Unexpected lawn dataset or licence");
  if (!worldBounds.every(Number.isFinite) || worldBounds[0] >= worldBounds[2] || worldBounds[1] >= worldBounds[3]) throw new Error("Invalid world bounds");
  const all = lawnPieces(source);
  if (all.length !== snapshot.sourcePieces) throw new Error("Grass snapshot record count mismatch");
  const excluded: string[] = [];
  const grass = all.filter(p => {
    const outer = p.rings[0]!;
    const xs = outer.filter((_, i) => i % 2 === 0), zs = outer.filter((_, i) => i % 2 === 1);
    const keep = Math.max(...xs) >= worldBounds[0] && Math.min(...xs) <= worldBounds[2] && Math.max(...zs) >= worldBounds[1] && Math.min(...zs) <= worldBounds[3];
    if (!keep) excluded.push(p.sourceId ?? p.id);
    return keep;
  });
  return {
    version: 1, world: "sf", snapshotDate: snapshot.snapshotDate,
    description: "DataSF RPD Lawn polygons only (render-only), clipped to 100 m cells. rings = [outer, ...holes], flat [x,z,...] local metres. Repeated source ids have a stable geometry-hash suffix; sourceId retains the original. Geometry and holes are unchanged from the pinned compiled source.",
    attribution: GRASS_ATTRIBUTION,
    source: {
      dataset: snapshot.datasetId, url: snapshot.datasetUrl, license: snapshot.license, licenseUrl: snapshot.licenseUrl,
      selection: snapshot.selection, compiledSourceCommit: snapshot.compiledSourceCommit,
      compiledSourcePath: snapshot.compiledSourcePath, compiledSourceSha256: snapshot.compiledSourceSha256,
      originalResponseSha256: snapshot.originalResponseSha256, originalResponseNote: snapshot.originalResponseNote,
      snapshotSha256: snapshot.sourceSha256,
      worldBounds: [...worldBounds], sourcePieces: all.length, excludedSourceIds: excluded,
    },
    grass,
  };
}

export function grassIndex(index: Record<string, unknown>, pieces: number): Record<string, unknown> {
  if (index.world !== "sf" || !record(index.layers) || !record(index.counts) || !Array.isArray(index.attribution)) throw new Error("Expected SF street-detail index");
  return { ...index, attribution: [...index.attribution.filter(a => a !== GRASS_ATTRIBUTION), GRASS_ATTRIBUTION], layers: { ...index.layers, grass: GRASS_FILE }, counts: { ...index.counts, grassPieces: pieces } };
}

export function buildGrassFiles(root: string, dir: string): Record<string, string> {
  const { source, snapshot } = readGrassSnapshot(root);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { tiles: Array<{ bbox?: number[] }> };
  const worldBounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const tile of manifest.tiles) if (tile.bbox?.length === 4) {
    worldBounds[0] = Math.min(worldBounds[0], tile.bbox[0]!); worldBounds[1] = Math.min(worldBounds[1], tile.bbox[1]!);
    worldBounds[2] = Math.max(worldBounds[2], tile.bbox[2]!); worldBounds[3] = Math.max(worldBounds[3], tile.bbox[3]!);
  }
  const layer = grassLayer(source, snapshot, worldBounds);
  const index = JSON.parse(readFileSync(join(dir, "street-detail.json"), "utf8")) as Record<string, unknown>;
  return { [GRASS_FILE]: jsonLines(layer, ["grass"]), "street-detail.json": jsonPretty(grassIndex(index, layer.grass.length)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(import.meta.dirname, "..");
  const at = process.argv.indexOf("--out");
  const dir = at < 0 ? join(root, "public/tiles/sf") : resolve(process.argv[at + 1]!);
  const files = buildGrassFiles(root, dir), check = process.argv.includes("--check");
  if (check) {
    for (const [file, bytes] of Object.entries(files)) if (readFileSync(join(dir, file), "utf8") !== bytes) throw new Error(`Stale grass output: ${file}`);
  } else {
    mkdirSync(dir, { recursive: true });
    for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dir, file), bytes);
  }
  console.log(`DataSF grass ${check ? "check OK" : "wrote"}: ${files[GRASS_FILE]!.length} bytes; offline pinned lawns only`);
}
