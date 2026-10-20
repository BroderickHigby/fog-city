// Shared by the content tests: every JSON file under content/ that this track owns.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildProseLexicon, type ProseLexicon } from "../../src/content/proseNames.ts";
import { ROOT } from "../helpers.ts";

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? jsonFiles(p) : p.endsWith(".json") ? [p] : [];
  });
}

/** Repo-relative paths ("content/brands.json"), sorted; landmarks.json belongs to the assets track. */
export const CONTENT_FILES: readonly string[] = jsonFiles(join(ROOT, "content"))
  .map((f) => f.slice(ROOT.length + 1))
  .filter((f) => f !== "content/landmarks.json")
  .sort();

export function readContent(rel: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

/** Every string in a parsed document with its key, skipping provenance, sources and developer notes. */
export function playerStrings(doc: unknown): string[] {
  const out: string[] = [];
  const skip = new Set(["provenance", "sources", "source", "attribution", "$schema", "$comment", "designNote", "note", "naicsNote", "why", "url", "urls", "glb", "phrases", "patterns", "contractions", "normalise"]);
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!skip.has(k)) walk(x);
  };
  walk(doc);
  return out;
}

/** The place gazetteer: sf street names, districts and hubs, protected areas, safehouses, landmarks, and the game-term fields. */
export function gazetteer(): string[] {
  const out: string[] = [];
  const roads = JSON.parse(readFileSync(join(ROOT, "public/tiles/sf/roads.json"), "utf8")) as { edges: Array<{ name?: string }> };
  for (const e of roads.edges) if (e.name) out.push(e.name);
  const d = readContent("content/districts.json") as { districts: Array<{ name: string; hub?: { label: string } }> };
  for (const x of d.districts) out.push(x.name, x.hub?.label ?? "");
  const p = readContent("content/places.json") as { protectedAreas: Array<{ name: string }>; moatSites?: Array<{ name?: string; label?: string }> };
  for (const x of p.protectedAreas) out.push(x.name);
  for (const x of p.moatSites ?? []) out.push(x.name ?? x.label ?? "");
  const s = readContent("content/safehouses.json") as { sites: Array<{ label: string }> };
  for (const x of s.sites) out.push(x.label);
  const l = readContent("content/landmarks.json") as { landmarks: Array<{ id: string }> };
  for (const x of l.landmarks) out.push(x.id.replace(/-/g, " "));
  // Game terms in registered mode, activity and item fields (the shooterMode rule reviews them).
  const a = readContent("content/activities.json") as { activities: Array<{ name: string }> };
  for (const x of a.activities) out.push(x.name);
  const m = readContent("content/modes/instances.json") as { modes: Array<{ name: string }>; instances: Array<{ name: string }> };
  for (const x of [...m.modes, ...m.instances]) out.push(x.name);
  const v = readContent("content/vendor.json") as { items: Array<{ name: string }> };
  for (const x of v.items) out.push(x.name);
  return out.filter((x) => x.length > 0);
}

/** The proseName rule's lexicon for this checkout's content. */
export function contentLexicon(): ProseLexicon {
  const c = readContent("content/cleared-names.json") as { names: Array<{ name: string }>; generic: Array<{ label: string }> };
  return buildProseLexicon({
    corpus: CONTENT_FILES.filter((f) => !/cleared-names|banned-pairs|name-parts/.test(f)).flatMap((f) => playerStrings(readContent(f))),
    gazetteer: gazetteer(),
    cleared: [...c.names.map((n) => n.name), ...c.generic.map((g) => g.label)],
  });
}

interface ManifestTile {
  id: string;
  ix: number;
  iz: number;
  stats?: { buildings?: number; roadEdges?: number; waterFraction?: number };
  /** District ids on this tile, once the pipeline writes them (requested from Pipeline). */
  districts?: string[];
}

/** The sf tile manifest's tiles, by id. */
export function manifestTiles(): Map<string, ManifestTile> {
  const m = JSON.parse(readFileSync(join(ROOT, "public/tiles/sf/manifest.json"), "utf8")) as { tiles: ManifestTile[] };
  return new Map(m.tiles.map((t) => [t.id, t]));
}

/**
 * The districts that ship (docs/ai-layer.md, Validation: "the test reads the current tile
 * manifest"). When the manifest's tiles carry district ids, the shipped set is their union;
 * until the pipeline writes them, it is content/districts.json's `active` flags, and the tests
 * cross-check those against the manifest instead (every shipped district's hub is on a built
 * tile).
 */
export function shippedDistricts(): { ids: string[]; source: "manifest" | "districts.json" } {
  const fromManifest = new Set<string>();
  for (const t of manifestTiles().values()) for (const d of t.districts ?? []) fromManifest.add(d);
  if (fromManifest.size > 0) return { ids: [...fromManifest].sort(), source: "manifest" };
  const d = readContent("content/districts.json") as { districts: Array<{ id: string; active: boolean }> };
  return { ids: d.districts.filter((x) => x.active).map((x) => x.id).sort(), source: "districts.json" };
}
