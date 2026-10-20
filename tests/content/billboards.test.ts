// Billboard and bus-wrap copy: deterministic, varied, always fits, never names a real brand.
import { describe, expect, it } from "vitest";
import {
  BILLBOARD_GRAMMAR,
  checkBillboardGrammar,
  contrastRatio,
  generateBillboard,
  generateBillboardSet,
  generateBusWrap,
  type BillboardGrammar,
} from "../../src/content/billboards.ts";
import { blockedProseReason } from "../../src/content/blocklist.ts";
import { countDerivations, expandTemplate } from "../../src/content/grammar.ts";
import { NAME_MAX } from "../../src/content/names.ts";
import { makePrng } from "../../src/content/prng.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const key = (b: { headline: string; subline: string }): string => `${b.headline} | ${b.subline}`;

describe("billboard grammar (static proof over every derivation)", () => {
  const report = checkBillboardGrammar();

  it("has no structural, length, palette or blocklist errors", () => {
    expect(report.errors).toEqual([]);
  });

  it("every possible billboard headline is <= 32 chars, every bus-wrap headline <= 40", () => {
    expect(report.bounds.billboard!.headlineMax).toBeLessThanOrEqual(32);
    expect(report.bounds.busWrap!.headlineMax).toBeLessThanOrEqual(40);
    expect(BILLBOARD_GRAMMAR.starts.billboard.headlineMax).toBe(32);
    expect(BILLBOARD_GRAMMAR.external["$product"]!.maxLength).toBe(NAME_MAX);
  });

  it("billboards and bus wraps use separate start symbols", () => {
    expect(BILLBOARD_GRAMMAR.starts.billboard.symbol).not.toBe(BILLBOARD_GRAMMAR.starts.busWrap.symbol);
  });

  it("has well over 300 derivations even with the product name fixed", () => {
    expect(countDerivations(BILLBOARD_GRAMMAR.rules, "{billboard}")).toBeGreaterThanOrEqual(300);
    expect(countDerivations(BILLBOARD_GRAMMAR.rules, "{busWrap}")).toBeGreaterThanOrEqual(50);
  });

  it("catches a headline that could overflow", () => {
    const g = clone(BILLBOARD_GRAMMAR) as BillboardGrammar;
    g.rules.billboard!.push("{$product} is the future of everything forever.|{$product}.");
    expect(checkBillboardGrammar(g).errors.some((e) => e.includes("headline can reach"))).toBe(true);
  });

  it("catches unknown symbols, cycles, a missing separator and a real brand", () => {
    const g = clone(BILLBOARD_GRAMMAR) as BillboardGrammar;
    g.rules.billboard!.push("{nope} for {$product}.|Sub.");
    g.rules.coworker!.push("{coworker}s");
    g.rules.billboard!.push("No separator here, {$product}.");
    g.rules.apiSub!.push("Better than Waymo.");
    const errs = checkBillboardGrammar(g).errors.join("\n");
    expect(errs).toContain("unknown symbol {nope}");
    expect(errs).toContain("cycle");
    // (A cycle stops the analysis early, so check the remaining two on a clean copy.)
    const h = clone(BILLBOARD_GRAMMAR) as BillboardGrammar;
    h.rules.billboard!.push("No separator here, {$product}.");
    h.rules.apiSub!.push("Better than Waymo.");
    const errs2 = checkBillboardGrammar(h).errors.join("\n");
    expect(errs2).toContain('has 0 "|"');
    expect(errs2).toContain('brand "Waymo"');
  });

  it("catches a low-contrast palette", () => {
    const g = clone(BILLBOARD_GRAMMAR) as BillboardGrammar;
    g.palettes.push({ id: "mush", bg: "#888888", fg: "#999999", accent: "#000000" });
    expect(checkBillboardGrammar(g).errors.some((e) => e.includes("palette mush"))).toBe(true);
  });
});

describe("generateBillboard", () => {
  it("is deterministic for number and string seeds", () => {
    for (const seed of [0, 1, 42, 2 ** 31 + 5, -7, "building-1234", "player:alice"]) {
      expect(generateBillboard(seed)).toEqual(generateBillboard(seed));
      expect(generateBusWrap(seed)).toEqual(generateBusWrap(seed));
    }
  });

  it("returns {headline, subline, palette} with flat-colour palettes", () => {
    const b = generateBillboard(7);
    expect(typeof b.headline).toBe("string");
    expect(typeof b.subline).toBe("string");
    expect(b.palette).toMatchObject({ bg: expect.stringMatching(/^#[0-9A-F]{6}$/), fg: expect.stringMatching(/^#[0-9A-F]{6}$/) });
    expect(BILLBOARD_GRAMMAR.palettes).toContainEqual(b.palette);
  });

  it("pins a few outputs so an accidental change to the PRNG or data shows up in review", () => {
    // Intentional copy or PRNG changes: regenerate with `pnpm exec vitest run -u tests/content/billboards.test.ts`.
    const snap = [1, 2, 3].map((s) => key(generateBillboard(s)));
    expect(snap).toMatchInlineSnapshot(`
      [
        "Disrupting walking. | Ambient Crab. Now it has a subscription.",
        "In private beta. Forever. | Polite Clam. Join 40,000 people waiting for nothing.",
        "Now on the blockchain. Again. | Hammr. We heard it was back.",
      ]
    `);
  });

  it("produces at least 300 distinct boards (and nearly all distinct with invented products)", () => {
    const free = new Set<string>();
    for (let s = 0; s < 1000; s++) free.add(key(generateBillboard(s)));
    expect(free.size).toBeGreaterThanOrEqual(900);
    const fixed = new Set<string>();
    for (let s = 0; s < 20000; s++) fixed.add(key(generateBillboard(s, { product: "Kelpforge" })));
    expect(fixed.size).toBeGreaterThanOrEqual(300);
  });

  it("uses most of its joke templates and most palettes over 2000 seeds", () => {
    const templates = new Set<string>();
    const palettes = new Set<string>();
    for (let s = 0; s < 2000; s++) {
      const b = generateBillboard(s, { product: "Kelpforge" });
      templates.add(b.headline.split(" ").slice(0, 2).join(" "));
      palettes.add(b.palette.id);
    }
    expect(templates.size).toBeGreaterThanOrEqual(50);
    expect(palettes.size).toBe(BILLBOARD_GRAMMAR.palettes.length);
  });

  it("every sampled output fits its limits and names no real brand or person", () => {
    for (let s = 0; s < 5000; s++) {
      for (const b of [generateBillboard(s), generateBusWrap(s)]) {
        const lim = BILLBOARD_GRAMMAR.starts[b.kind];
        expect(b.headline.length, b.headline).toBeLessThanOrEqual(lim.headlineMax);
        expect(b.subline.length, b.subline).toBeLessThanOrEqual(lim.sublineMax);
        expect(b.headline.length).toBeGreaterThan(0);
        expect(b.headline + b.subline).not.toMatch(/[{}|]/);
        expect(blockedProseReason(`${b.headline} ${b.subline}`), key(b)).toBeNull();
      }
    }
  });

  it("names the product it advertises, and keeps it consistent between headline and subline", () => {
    for (let s = 0; s < 500; s++) {
      const b = generateBillboard(s);
      const text = `${b.headline} ${b.subline}`;
      expect(text).toContain(b.product);
    }
  });

  it("advertises the player's own startup when asked (the YC mission reward)", () => {
    const b = generateBillboard("reward:alice", { product: "Moss Labs" });
    expect(b.product).toBe("Moss Labs");
    expect(`${b.headline} ${b.subline}`).toContain("Moss Labs");
    expect(() => generateBillboard(1, { product: "A Very Long Startup Name" })).toThrow(RangeError);
    expect(() => generateBillboard(1, { product: "AI" })).toThrow(RangeError);
  });

  it("bus wraps differ from billboards for the same seed and are varied", () => {
    const set = new Set<string>();
    let same = 0;
    for (let s = 0; s < 1000; s++) {
      const w = generateBusWrap(s);
      set.add(key(w));
      if (key(w) === key(generateBillboard(s))) same++;
    }
    expect(same).toBe(0);
    expect(set.size).toBeGreaterThanOrEqual(900);
  });
});

describe("generateBillboardSet (a street or corridor of boards)", () => {
  const templates = BILLBOARD_GRAMMAR.rules.billboard!.length;
  const first2 = (h: string) => h.split(" ").slice(0, 2).join(" ");

  it("is deterministic and returns exactly count boards", () => {
    expect(generateBillboardSet("us-101", 12)).toEqual(generateBillboardSet("us-101", 12));
    expect(generateBillboardSet("us-101", 0)).toEqual([]);
    expect(generateBillboardSet(5, 33)).toHaveLength(33);
    expect(() => generateBillboardSet(5, -1)).toThrow(RangeError);
  });

  it("never repeats a joke until every template has been used", () => {
    const set = generateBillboardSet("soma-rooftops", templates, { product: "Kelpforge" });
    // Same product everywhere, so a repeated template would print an identical board.
    expect(new Set(set.map(key)).size).toBe(templates);
    const twice = generateBillboardSet("soma-rooftops", templates * 2, { product: "Kelpforge" });
    const counts = new Map<string, number>();
    for (const b of twice) counts.set(first2(b.headline), (counts.get(first2(b.headline)) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(4); // two decks; a few templates share opening words
  });

  it("never puts the same palette on neighbouring boards", () => {
    const set = generateBillboardSet("bay-bridge", 200);
    for (let i = 1; i < set.length; i++) expect(set[i]!.palette.id).not.toBe(set[i - 1]!.palette.id);
  });

  it("works for bus wraps and fits the limits", () => {
    const set = generateBillboardSet("depot", 60, { kind: "busWrap" });
    for (const b of set) {
      expect(b.kind).toBe("busWrap");
      expect(b.headline.length).toBeLessThanOrEqual(40);
    }
    expect(new Set(set.slice(0, BILLBOARD_GRAMMAR.rules.busWrap!.length).map((b) => b.headline.slice(0, 12))).size).toBeGreaterThan(15);
  });
});

describe("grammar engine", () => {
  it("binds $-symbols once per output and expands {sym.cap}", () => {
    const rules = { $x: ["a", "b", "c", "d", "e", "f"], w: ["kale"], s: ["{$x}-{$x}-{w.cap}"] };
    for (let i = 0; i < 50; i++) {
      const out = expandTemplate(rules, "{s}", makePrng(i), new Map());
      const [a, b, c] = out.split("-");
      expect(a).toBe(b);
      expect(c).toBe("Kale");
    }
    const pre = expandTemplate(rules, "{$x}", makePrng(1), new Map([["$x", "given"]]));
    expect(pre).toBe("given");
  });

  it("contrastRatio matches WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });
});
