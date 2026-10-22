// Provenance (docs/ai-layer.md, How agents write it, step 5): every content file an agent wrote
// carries a provenance block whose contentHash matches its text, so an edit after review is
// visible. The four schemas the harness compiles on their own carry an inline copy of the
// provenance schema; the copies must match schemas/provenance.schema.json.
import { describe, expect, it } from "vitest";
import { PROVENANCE_EXEMPT, expectedContentHash } from "../../src/content/provenance.ts";
import { readJson } from "../helpers.ts";
import { CONTENT_FILES, readContent } from "./content-files.ts";

const exempt = new Set(PROVENANCE_EXEMPT.map((e) => e.file));

describe("every content file carries a current provenance block", () => {
  it("covers the files the review named", () => {
    for (const f of [
      "content/missions/hot-desk.json", "content/missions/spill.json", "content/missions/ramen-pitch.json", "content/bot-tells.json",
      "content/robot-goals.json", "content/brands.json", "content/vendor.json", "content/activities.json", "content/districts.json",
    ]) {
      expect(CONTENT_FILES).toContain(f);
      expect(exempt.has(f), f).toBe(false);
    }
  });

  for (const rel of CONTENT_FILES.filter((f) => !exempt.has(f))) {
    it(rel, () => {
      const doc = readContent(rel) as { provenance?: { contentHash: string; source: string; authorSession: string; reviewedBy: string[] } };
      expect(doc.provenance, `${rel} has no provenance block`).toBeDefined();
      expect(doc.provenance?.contentHash, `${rel}: stale contentHash; recompute it after an edit`).toBe(expectedContentHash(rel, doc));
      expect(doc.provenance?.authorSession.length).toBeGreaterThan(4);
    });
  }

  it("the exempt files say why", () => {
    for (const e of PROVENANCE_EXEMPT) {
      expect(CONTENT_FILES).toContain(e.file);
      expect(e.why.length).toBeGreaterThan(10);
    }
  });
});

describe("inline provenance schemas match the shared one", () => {
  const shared = readJson<Record<string, unknown>>("schemas/provenance.schema.json");
  const strip = (s: Record<string, unknown>) => {
    const { $schema: _a, $id: _b, title: _c, description: _d, ...rest } = s;
    return rest;
  };
  it.each(["mission", "bot-tells", "billboard-grammar", "storefront-kit"])("%s", (name) => {
    const s = readJson<{ $defs: { provenance: Record<string, unknown> }; properties: { provenance: unknown } }>(`schemas/${name}.schema.json`);
    expect(strip(s.$defs.provenance)).toEqual(strip(shared));
    expect(s.properties.provenance).toEqual({ $ref: "#/$defs/provenance" });
  });
});
