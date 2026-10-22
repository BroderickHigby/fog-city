// Storefront kits: the brief's NAICS mapping, longest-prefix lookup, and full coverage of the
// codes the pipeline emits as storefront anchors.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STOREFRONTS, checkStorefronts, shopfrontFor, storefrontFor, type StorefrontKit } from "../../src/content/storefronts.ts";
import { toLocal } from "../../src/geo/project.ts";
import { ROOT } from "../helpers.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const id = (code: string | null | undefined) => storefrontFor(code)?.id ?? null;
const kit = (type: string) => STOREFRONTS.types.find((t) => t.id === type)!;

describe("content/storefronts.json", () => {
  it("passes its consistency rules", () => expect(checkStorefronts()).toEqual([]));

  it("is unnamed: every signText is null", () => {
    for (const t of STOREFRONTS.types) expect(t.signText, t.id).toBeNull();
  });

  it("has the brief's kits, signs and props", () => {
    expect(kit("bar")).toMatchObject({ signShape: "neonPanel" });
    expect(kit("bar").props).toContain("beerNeonPanel");
    expect(kit("restaurant").props).toEqual(expect.arrayContaining(["tablecloths", "awning", "sidewalkTables"]));
    expect(kit("cafe").props).toEqual(expect.arrayContaining(["awning", "aFrameBlank", "cupSign"]));
    expect(kit("cafe").signShape).toBe("cupBlade");
    expect(kit("grocery").props).toEqual(expect.arrayContaining(["stripedAwning", "produceCrates", "hangingSalami"]));
    expect(kit("barber").signShape).toBe("barberPole");
    expect(kit("laundromat").props).toContain("washingMachines");
    expect(kit("pharmacy").signShape).toBe("projectingCross");
    expect(kit("retail").naicsPrefixes).toEqual(["44", "45"]);
  });

  it("every kit has house kit K5's shopfront: a 5 m glazed bay, 3.5 to 4.5 m tall, and an empty sign slot", () => {
    for (const t of STOREFRONTS.types) {
      expect(t.shopfront.bayWidthM, t.id).toBe(5);
      expect(t.shopfront.heightM, t.id).toBeGreaterThanOrEqual(3.5);
      expect(t.shopfront.heightM, t.id).toBeLessThanOrEqual(4.5);
      expect(t.shopfront.glazing, t.id).toBeGreaterThan(0.4);
      expect(t.signText, t.id).toBeNull();
      expect(t.signSlot.widthM * t.signSlot.heightM, t.id).toBeGreaterThan(0);
    }
  });

  it("awning shapes vary by category, and icons are shapes only", () => {
    const shapes = new Set(STOREFRONTS.types.map((t) => t.awning.shape));
    expect(shapes.size).toBeGreaterThanOrEqual(7);
    expect(kit("grocery").awning).toMatchObject({ shape: "striped" });
    expect(kit("bakery").awning.shape).toBe("scalloped");
    expect(kit("restaurant").awning.shape).toBe("box");
    expect(kit("bar").awning.shape).toBe("none");
    expect(kit("fuel").awning.shape).toBe("canopy");
    // Distinct sign icons for the specific kits (the generic fascia band is shared).
    const icons = STOREFRONTS.types.map((t) => t.signShape).filter((s) => s !== "fasciaBand");
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("checkStorefronts rejects an awning with no colour, colours on no awning and a stripe off a striped awning", () => {
    const k = clone(STOREFRONTS) as StorefrontKit;
    kitIn(k, "cafe").awning.colours = [];
    kitIn(k, "bar").awning.colours = ["#202020"];
    kitIn(k, "restaurant").awning.stripe = "#ffffff";
    const errs = checkStorefronts(k).join("\n");
    expect(errs).toContain("type cafe: an awning has a depth and colours");
    expect(errs).toContain("type bar: an awning has a depth and colours");
    expect(errs).toContain("type restaurant: a striped awning");
  });
});

const kitIn = (k: StorefrontKit, id: string) => k.types.find((t) => t.id === id)!;

describe("the committed sf world's storefront anchors (house kit K5, W-47)", () => {
  const anchors = (JSON.parse(readFileSync(join(ROOT, "public/tiles/sf/storefronts.json"), "utf8")) as {
    storefronts: Array<{ id: string; x: number; z: number; naics: string; category: string; buildingId: string }>;
  }).storefronts;

  it("every anchor gets a kit, and the kit serves the anchor's pipeline category", () => {
    expect(anchors.length).toBeGreaterThan(10_000);
    const wrong: string[] = [];
    for (const a of anchors) {
      const t = storefrontFor(a.naics);
      if (!t || !t.categories.includes(a.category)) wrong.push(`${a.id} ${a.naics} ${a.category} -> ${t?.id ?? "none"}`);
    }
    expect(wrong).toEqual([]);
  });

  it("each pipeline category is served mainly by its own kit, not the generic one", () => {
    const byCat = new Map<string, Map<string, number>>();
    for (const a of anchors) {
      const m = byCat.get(a.category) ?? new Map<string, number>();
      const id = storefrontFor(a.naics)!.id;
      m.set(id, (m.get(id) ?? 0) + 1);
      byCat.set(a.category, m);
    }
    for (const [cat, m] of byCat) {
      if (cat === "retail") continue;
      const total = [...m.values()].reduce((x, y) => x + y, 0);
      const generic = m.get("retail") ?? 0;
      // Pharmacy: only the dispensing codes get the cross; cosmetics and optical stay generic.
      if (cat !== "pharmacy") expect(generic / total, cat).toBeLessThan(0.05);
    }
  });

  it("shopfrontFor picks a kit, an awning colour and a frame colour per anchor, the same on every call", () => {
    let drawn = 0;
    for (const a of anchors) {
      const p = shopfrontFor(a);
      if (!p) continue;
      drawn++;
      expect(p.kit.awning.shape === "none" ? p.awningColour === null : p.kit.awning.colours.includes(p.awningColour!), a.id).toBe(true);
      expect(p.kit.shopfront.frames).toContain(p.frameColour);
    }
    expect(drawn / anchors.length).toBeGreaterThan(0.99);
    expect(shopfrontFor(anchors[0]!)).toEqual(shopfrontFor(anchors[0]!));
  });

  it("Mission St from 16th to 24th shows a varied run of shopfronts, not one repeated awning", () => {
    const a = toLocal(37.7651, -122.4196);
    const b = toLocal(37.7524, -122.4184);
    const along = anchors.filter((s) => {
      const t = ((s.x - a.x) * (b.x - a.x) + (s.z - a.z) * (b.z - a.z)) / ((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
      const px = a.x + t * (b.x - a.x);
      const pz = a.z + t * (b.z - a.z);
      return t >= 0 && t <= 1 && Math.hypot(s.x - px, s.z - pz) < 25;
    });
    expect(along.length).toBeGreaterThan(100);
    const plans = along.map((s) => shopfrontFor(s)).filter((p) => p !== null);
    expect(new Set(plans.map((p) => p.kit.id)).size).toBeGreaterThanOrEqual(10);
    expect(new Set(plans.map((p) => `${p.kit.awning.shape}:${p.awningColour}`)).size).toBeGreaterThanOrEqual(15);
  });
});

describe("storefrontFor", () => {
  it.each([
    ["722410", "bar"], ["722511", "restaurant"], ["722513", "takeout"], ["722515", "cafe"], ["445110", "grocery"],
    ["445131", "grocery"], ["445210", "grocery"], ["445291", "bakery"], ["311811", "bakery"], ["812111", "barber"],
    ["812112", "salon"], ["812113", "nails"], ["812199", "salon"], ["812310", "laundromat"], ["812320", "drycleaner"],
    ["446110", "pharmacy"], ["456110", "pharmacy"], ["453110", "florist"], ["459310", "florist"],
    ["448120", "clothing"], ["458110", "clothing"], ["458310", "clothing"], ["456120", "retail"], ["445320", "liquor"], ["445310", "liquor"],
    ["44", "retail"], ["4451", "grocery"], ["445", "grocery"], ["722514", "restaurant"], ["722110", "restaurant"], ["722211", "takeout"],
    ["722213", "cafe"], ["722", "restaurant"], ["444130", "hardware"], ["4445", "hardware"], ["443142", "electronics"], ["449210", "electronics"],
    ["442110", "furniture"], ["449110", "furniture"], ["451211", "hobby"], ["459210", "hobby"], ["459120", "hobby"], ["441110", "auto"],
    ["447110", "fuel"], ["457110", "fuel"], ["452319", "general"], ["455219", "general"], ["459420", "retail"], ["459999", "retail"],
  ])("%s -> %s", (code, want) => expect(id(code)).toBe(want));

  it.each([["541511"], ["531110"], ["454110"], ["722320"], ["722330"], ["72"], ["7"], [""], [null], [undefined], ["abc"]])(
    "%s -> no storefront",
    (code) => expect(id(code)).toBeNull(),
  );

  it("tolerates whitespace and punctuation in the registry field", () => {
    expect(id(" 722515 ")).toBe("cafe");
    expect(id(" 722513 ")).toBe("takeout");
    expect(id("7224-10")).toBe("bar");
  });

  it("gives a kit to every code the pipeline turns into a storefront anchor", () => {
    // The pipeline's contract (pipeline/lib/storefronts.ts): include 44, 45, 722, 8121, 8123; exclude 454, 7223.
    const include = ["44", "45", "722", "8121", "8123"];
    const exclude = ["454", "7223"];
    // Every 6-digit code under each include prefix (about 21,000 codes).
    for (const p of include) {
      for (let n = 0; n < 10 ** (6 - p.length); n++) {
        const code = p + String(n).padStart(6 - p.length, "0");
        const excluded = exclude.some((e) => code.startsWith(e));
        expect(id(code) === null, code).toBe(excluded);
      }
    }
  });

  it("longest prefix wins, regardless of file order", () => {
    const k = clone(STOREFRONTS) as StorefrontKit;
    k.types.reverse();
    expect(storefrontFor("812111", k)?.id).toBe("barber");
    expect(storefrontFor("445291", k)?.id).toBe("bakery");
    expect(storefrontFor("722515", k)?.id).toBe("cafe");
    expect(storefrontFor("722513", k)?.id).toBe("takeout");
    expect(storefrontFor("445320", k)?.id).toBe("liquor");
  });

  it("checkStorefronts rejects a prefix claimed twice and sign text", () => {
    const k = clone(STOREFRONTS) as StorefrontKit;
    k.types[0]!.naicsPrefixes.push("812111");
    (k.types[1] as { signText: unknown }).signText = "Luigi's";
    const errs = checkStorefronts(k).join("\n");
    expect(errs).toContain("prefix 812111 claimed by both");
    expect(errs).toContain("signText must be null");
  });
});
