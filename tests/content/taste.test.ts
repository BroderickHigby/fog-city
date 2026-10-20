// The content and taste rules, enforced on every authored string and on generated output:
// no real brands or people, no punching down, non-violent language, unnamed storefronts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateBillboard, generateBusWrap } from "../../src/content/billboards.ts";
import { blockedProseReason } from "../../src/content/blocklist.ts";
import { ROOT } from "../helpers.ts";

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? jsonFiles(p) : p.endsWith(".json") ? [p] : [];
  });
}

/** Every string value in a JSON document (keys are identifiers, not copy). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** Every [key, string value] pair in a JSON document, keys of enclosing objects included. */
function keyedStrings(v: unknown, key = "", out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof v === "string") out.push([key, v]);
  else if (Array.isArray(v)) for (const x of v) keyedStrings(x, key, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) keyedStrings(x, k, out);
  return out;
}

// Ours: everything in content/ except landmarks.json (owned by the assets track).
const FILES = jsonFiles(join(ROOT, "content")).filter((f) => !f.endsWith("landmarks.json"));

/** Never the joke: homelessness, poverty, drug use, crime victims. Word stems, whole-word. */
const PUNCH_DOWN = /\b(homeless\w*|unhoused|vagrant\w*|bums?|beggars?|panhandl\w*|junkie\w*|addicts?|crackhead\w*|tweakers?|overdos\w*|fentanyl|needles?|welfare|poor people|ghetto|mugg\w*|robb\w*|stab(s|bed|bing)?|shoot\w*|kill\w*|murder\w*|gun\w*|weapons?)\b/i;

describe("authored content", () => {
  it("covers every content file", () => {
    const rel = FILES.map((f) => f.slice(ROOT.length + 1)).sort();
    expect(rel).toEqual(
      expect.arrayContaining(["content/billboards.json", "content/bot-tells.json", "content/storefronts.json", "content/missions/yc-pitch.json"]),
    );
  });

  for (const f of FILES) {
    const rel = f.slice(ROOT.length + 1);
    const all = strings(JSON.parse(readFileSync(f, "utf8")));
    it(`${rel}: names no real brand, company or public figure`, () => {
      const hits = all.map((s) => [s, blockedProseReason(s)] as const).filter(([, why]) => why);
      expect(hits).toEqual([]);
    });
    it(`${rel}: never punches down and never turns violent`, () => {
      expect(all.filter((s) => PUNCH_DOWN.test(s))).toEqual([]);
    });
    it(`${rel}: never calls the accelerator "YC", in any case (ids excepted)`, () => {
      // Internal ids such as "yc-pitch" never reach the player; every other string might.
      const said = keyedStrings(JSON.parse(readFileSync(f, "utf8")))
        .filter(([k]) => k !== "id")
        .map(([, v]) => v)
        .filter((v) => /(^|[^a-z0-9])y\.? ?c\.?(s|'s)?($|[^a-z0-9])|y[\s.\-_]*combinator/i.test(v));
      expect(said).toEqual([]);
    });
  }
});

describe("generated copy", () => {
  it("10,000 billboards and bus wraps never punch down or turn violent", () => {
    for (let s = 0; s < 5000; s++) {
      for (const b of [generateBillboard(s), generateBusWrap(s)]) {
        expect(`${b.headline} ${b.subline}`).not.toMatch(PUNCH_DOWN);
      }
    }
  });
});
