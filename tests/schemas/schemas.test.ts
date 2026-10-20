// Every data file the game ships must validate against its schema.
import Ajv2020 from "ajv/dist/2020.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readJson } from "../helpers.ts";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schema = (name: string) => ajv.compile(readJson(`schemas/${name}.schema.json`));
const manifestV = schema("tile-manifest");
const colliderV = schema("tile-collider");

function check(v: ReturnType<typeof schema>, rel: string): void {
  const ok = v(readJson(rel));
  expect(ok, `${rel}: ${ajv.errorsText(v.errors)}`).toBe(true);
}

describe("world tiles validate", () => {
  const worlds = readdirSync(join(ROOT, "public/tiles"));
  for (const w of worlds) {
    const manifestRel = `public/tiles/${w}/manifest.json`;
    if (!existsSync(join(ROOT, manifestRel))) continue;
    it(manifestRel, () => check(manifestV, manifestRel));
    const m = readJson<{ tiles: Array<{ collider: string }> }>(manifestRel);
    for (const t of m.tiles) {
      const rel = `public/tiles/${w}/${t.collider}`;
      it(rel, () => check(colliderV, rel));
    }
  }
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
