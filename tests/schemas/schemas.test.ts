// Every data file the game ships must validate against its schema.
import Ajv2020 from "ajv/dist/2020.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readJson } from "../helpers.ts";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
const schema = (name: string) => {
  let v = compiled.get(name);
  if (!v) compiled.set(name, (v = ajv.compile(readJson(`schemas/${name}.schema.json`))));
  return v;
};
const manifestV = schema("tile-manifest");
const colliderV = schema("tile-collider");
const roadsV = schema("roads");

function check(v: ReturnType<typeof schema>, rel: string): void {
  const ok = v(readJson(rel));
  expect(ok, `${rel}: ${ajv.errorsText(v.errors)}`).toBe(true);
}

interface ManifestShape {
  roads?: string | null;
  tiles: Array<{ collider: string; glb: string | null }>;
  worldColliders?: string;
  far?: Array<{ glb: string }>;
  /** layer name -> file; each file validates against schemas/<file name without .json>.schema.json */
  layers?: Record<string, string>;
}

/** Files beside the manifest that are not named by it, and the schema each validates against. */
const EXTRAS: Record<string, string> = { "storefronts.json": "storefronts", "report.json": "tile-report" };

describe("world tiles validate", () => {
  const worlds = readdirSync(join(ROOT, "public/tiles"));
  for (const w of worlds) {
    const dir = `public/tiles/${w}`;
    const manifestRel = `${dir}/manifest.json`;
    if (!existsSync(join(ROOT, manifestRel))) continue;
    it(manifestRel, () => check(manifestV, manifestRel));
    const m = readJson<ManifestShape>(manifestRel);
    // Every file in the world directory is checked: JSON against its schema here, binaries
    // (glb tiles, far-LOD cells, the collider pack) by tests/pipeline and tests/render.
    const covered = new Set<string>(["manifest.json"]);
    if (m.roads) {
      const roadsRel = `${dir}/${m.roads}`;
      covered.add(m.roads);
      it(roadsRel, () => check(roadsV, roadsRel));
    }
    for (const t of m.tiles) {
      const rel = `${dir}/${t.collider}`;
      covered.add(t.collider);
      if (t.glb) covered.add(t.glb);
      it(rel, () => check(colliderV, rel));
    }
    for (const f of m.far ?? []) covered.add(f.glb);
    if (m.worldColliders) covered.add(m.worldColliders);
    for (const file of Object.values(m.layers ?? {})) {
      const rel = `${dir}/${file}`;
      covered.add(file);
      it(`${rel} (layer)`, () => check(schema(file.replace(/\.json$/, "")), rel));
    }
    for (const [file, s] of Object.entries(EXTRAS)) {
      if (!existsSync(join(ROOT, dir, file))) continue;
      covered.add(file);
      it(`${dir}/${file}`, () => check(schema(s), `${dir}/${file}`));
    }
    it(`${dir}: every file is named by the manifest or is a known extra`, () => {
      const stray = readdirSync(join(ROOT, dir)).filter((f) => !covered.has(f));
      expect(stray).toEqual([]);
    });
  }
});

describe("world schemas are closed: an undeclared field is an error", () => {
  const edge = { id: "e", a: "n1", b: "n2", kind: "residential", lanes: 2, oneway: false, points: [[0, 0], [1, 0]] };
  const roads = (e: object) => ({ version: 1, nodes: [{ id: "n1", x: 0, z: 0 }, { id: "n2", x: 1, z: 0 }], edges: [e] });
  it("road edges: declared flags pass, unknown keys and false flags fail", () => {
    expect(roadsV(roads({ ...edge, cnn: "1", classcode: 5, pedestrian: true, gradeSeparated: true, bridge: true }))).toBe(true);
    expect(roadsV(roads({ ...edge, bridges: true }))).toBe(false);
    expect(roadsV(roads({ ...edge, bridge: false }))).toBe(false);
  });
  it("colliders: ground.water is declared, other ground keys are not; meta stays open", () => {
    const ground = { x0: 0, z0: 0, cellSizeM: 10, nx: 2, nz: 2, heights: [0, 0, 0, 0] };
    const b = { id: "b", footprint: [[0, 0], [1, 0], [1, 1]], baseY: 0, topY: 3 };
    expect(colliderV({ tileId: "t", buildings: [{ ...b, meta: { condo: true, units: 4, zone: "x" } }], ground: { ...ground, water: [0, 1, 0, 0] } })).toBe(true);
    expect(colliderV({ tileId: "t", buildings: [b], ground: { ...ground, slope: [] } })).toBe(false);
    expect(colliderV({ tileId: "t", buildings: [{ ...b, height: 3 }], ground })).toBe(false);
    expect(colliderV({ tileId: "t", buildings: [{ ...b, meta: { stories: 0 } }], ground })).toBe(false);
  });
});

// content/<file>.json -> schemas/<schema>.schema.json
const CONTENT: Record<string, string> = {
  "content/billboards.json": "billboard-grammar",
  "content/storefronts.json": "storefront-kit",
  "content/bot-tells.json": "bot-tells",
  "content/landmarks.json": "landmarks",
};

describe("content validates", () => {
  for (const [rel, s] of Object.entries(CONTENT)) {
    it.skipIf(!existsSync(join(ROOT, rel)))(rel, () => check(schema(s), rel));
  }
  const missions = join(ROOT, "content/missions");
  if (existsSync(missions)) {
    const v = schema("mission");
    for (const f of readdirSync(missions).filter((f) => f.endsWith(".json"))) {
      it(`content/missions/${f}`, () => check(v, `content/missions/${f}`));
    }
  }
});
