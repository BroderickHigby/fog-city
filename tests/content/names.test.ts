// Invented startup names: deterministic, varied, and provably never a real brand or person.
import { describe, expect, it } from "vitest";
import {
  BRANDS,
  GENERIC_BRANDS,
  PEOPLE,
  SURNAMES,
  blockedNameReason,
  blockedProseReason,
  editDistance,
  normalize,
  withinOneEdit,
} from "../../src/content/blocklist.ts";
import { NAME_MAX, NAME_MIN, NAME_PATTERNS, allNames, generateName, namesOfPattern, rejectedCandidates } from "../../src/content/names.ts";
import { hashString, makePrng } from "../../src/content/prng.ts";

describe("generateName", () => {
  it("is deterministic", () => {
    for (const s of [0, 1, 99, "player:bo", "tile-3_4"]) expect(generateName(s)).toBe(generateName(s));
  });

  it("is varied: 1000 seeds give at least 800 distinct names, from every pattern", () => {
    const names = Array.from({ length: 1000 }, (_, i) => generateName(i));
    expect(new Set(names).size).toBeGreaterThanOrEqual(800);
    for (const p of NAME_PATTERNS) {
      const pool = new Set(namesOfPattern(p));
      expect(names.some((n) => pool.has(n)), `pattern ${p} never chosen`).toBe(true);
    }
  });

  it("stays within NAME_MIN..NAME_MAX", () => {
    for (let i = 0; i < 2000; i++) {
      const n = generateName(i);
      expect(n.length).toBeGreaterThanOrEqual(NAME_MIN);
      expect(n.length).toBeLessThanOrEqual(NAME_MAX);
    }
  });
});

describe("no real name ever comes out", () => {
  const space = allNames();

  it("the complete output space is large and fully enumerable", () => {
    expect(space.length).toBeGreaterThanOrEqual(2000);
  });

  it("EVERY name in the output space passes the brand and people blocklist", () => {
    const bad = space.map((n) => [n, blockedNameReason(n)] as const).filter(([, why]) => why !== null);
    expect(bad).toEqual([]);
  });

  it("no name in the space is any blocklisted brand, word for word", () => {
    const banned = new Set([...BRANDS, ...GENERIC_BRANDS].map(normalize));
    for (const n of space) {
      expect(banned.has(normalize(n)), n).toBe(false);
      for (const w of n.split(/[\s.]+/)) expect(banned.has(normalize(w)), `${n}: ${w}`).toBe(false);
    }
  });

  it("the filter actually removed real-brand collisions the patterns can spell", () => {
    // If this ever reads 0, either the patterns changed or the filter stopped running.
    const brandHits = rejectedCandidates().filter((r) => /brand|person|surname/.test(r.reason));
    expect(brandHits.length).toBeGreaterThan(0);
    for (const r of brandHits) expect(space).not.toContain(r.name);
  });
});

describe("blocklist", () => {
  it("is substantial", () => {
    expect(BRANDS.length).toBeGreaterThanOrEqual(300);
    expect(GENERIC_BRANDS.length).toBeGreaterThanOrEqual(80);
    expect(PEOPLE.length).toBeGreaterThanOrEqual(60);
    expect(SURNAMES.length).toBeGreaterThanOrEqual(40);
  });

  it("has no duplicates", () => {
    const all = [...BRANDS, ...GENERIC_BRANDS].map(normalize);
    const dupes = all.filter((x, i) => all.indexOf(x) !== i);
    expect(dupes).toEqual([]);
  });

  it.each([
    ["OpenAI", "brand"], ["openai", "brand"], ["Open AI", "brand"], ["Anthropik", "near-miss"], ["Waymo Labs", "brand"],
    ["Stripely", "brand"], ["Nvidiaa", "brand"], ["Apple", "brand"], ["Quiet Apple", "brand"], ["Slack", "brand"],
    ["Y Combinator", "brand"], ["kale.ycombinator", "brand"], ["Altman AI", "surname"], ["Sam Altman", "person"],
    ["Zuckerberg Labs", "surname"], ["Go Pro", "brand"], ["Tesla", "brand"], ["Teslo", "near-miss"],
    ["Instacart", "brand"], ["DoorDashly", "brand"], ["Lyftr", "brand"], ["Gooogle", "near-miss"],
  ])("blocks %s (%s)", (name, why) => {
    const r = blockedNameReason(name);
    expect(r, name).not.toBeNull();
    expect(r).toContain(why);
  });

  it.each(["Kelpforge", "Feral Teapot", "moss.ai", "Pondr", "Velora", "Kale AI", "Hey Hatch", "Paxton Longform", "Slotsworth", "Batchery"])(
    "allows invented %s",
    (name) => expect(blockedNameReason(name)).toBeNull(),
  );

  it("prose check finds brands and people as whole words, ignores generic English", () => {
    expect(blockedProseReason("Faster than any Waymo.")).toContain("Waymo");
    expect(blockedProseReason("as Elon Musk once said")).toContain("Musk");
    expect(blockedProseReason("A square block of slack apple boxes.")).toBeNull();
    expect(blockedProseReason("Uberly fine.")).toBeNull(); // not a whole word: names catch this, prose does not
  });

  it("withinOneEdit agrees with Levenshtein distance <= 1", () => {
    const rng = makePrng("edit");
    const alpha = "abcde";
    const rand = (): string => Array.from({ length: 1 + rng.int(6) }, () => alpha[rng.int(alpha.length)]).join("");
    for (let i = 0; i < 5000; i++) {
      const a = rand();
      const b = rng.int(3) === 0 ? a : rand();
      expect(withinOneEdit(a, b), `${a} ${b}`).toBe(editDistance(a, b) <= 1);
    }
  });
});

describe("prng", () => {
  it("is deterministic, seeds diverge, and int() stays in range", () => {
    const a = makePrng(1);
    const b = makePrng(1);
    const c = makePrng(2);
    const xs = Array.from({ length: 20 }, () => a.nextU32());
    expect(xs).toEqual(Array.from({ length: 20 }, () => b.nextU32()));
    expect(xs).not.toEqual(Array.from({ length: 20 }, () => c.nextU32()));
    const r = makePrng("range");
    const counts = new Array(7).fill(0);
    for (let i = 0; i < 7000; i++) counts[r.int(7)]++;
    for (const n of counts) expect(n).toBeGreaterThan(800);
    expect(() => r.int(0)).toThrow(RangeError);
  });

  it("hashString is FNV-1a 32", () => {
    expect(hashString("")).toBe(0x811c9dc5);
    expect(hashString("a")).toBe(0xe40c292c);
    expect(hashString("foobar")).toBe(0xbf9cf968);
  });

  it("matches a pinned sequence (engines must agree)", () => {
    const r = makePrng(12345);
    expect(Array.from({ length: 5 }, () => r.nextU32())).toMatchInlineSnapshot(`
      [
        2977242774,
        3666342370,
        284612288,
        1272139869,
        3250622756,
      ]
    `);
  });
});
