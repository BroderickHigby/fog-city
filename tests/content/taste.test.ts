// The content and taste rules, enforced on every authored string and on generated output:
// the content lint (src/content/lint.ts) passes on every content file this track ships.
import { describe, expect, it } from "vitest";
import { generateBillboard, generateBusWrap } from "../../src/content/billboards.ts";
import { CLEARED } from "../../src/content/clearedNames.ts";
import { lintDocument, lintText } from "../../src/content/lint.ts";
import { CONTENT_FILES, readContent } from "./content-files.ts";

describe("authored content passes the content lint", () => {
  it("covers every content file", () => {
    expect(CONTENT_FILES).toEqual(
      expect.arrayContaining(["content/billboards.json", "content/bot-tells.json", "content/storefronts.json", "content/missions/ramen-pitch.json", "content/brands.json"]),
    );
  });

  for (const rel of CONTENT_FILES) {
    it(rel, () => {
      const issues = lintDocument(rel, readContent(rel), CLEARED).map((i) => `${i.path}: ${i.message} | ${(i.text ?? "").slice(0, 80)}`);
      expect(issues).toEqual([]);
    });
  }
});

describe("generated copy", () => {
  it("10,000 billboards and bus wraps pass the text lint", () => {
    for (let s = 0; s < 5000; s++) {
      for (const b of [generateBillboard(s), generateBusWrap(s)]) {
        const issues = lintText(`${b.headline} ${b.subline}`);
        expect(issues, `${b.headline} | ${b.subline}`).toEqual([]);
      }
    }
  });
});
