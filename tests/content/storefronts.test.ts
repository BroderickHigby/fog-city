// Storefront kits: the brief's NAICS mapping, longest-prefix lookup, and full coverage of the
// codes the pipeline emits as storefront anchors.
import { describe, expect, it } from "vitest";
import { STOREFRONTS, checkStorefronts, storefrontFor, type StorefrontKit } from "../../src/content/storefronts.ts";

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
});

describe("storefrontFor", () => {
  it.each([
    ["722410", "bar"], ["722511", "restaurant"], ["722513", "cafe"], ["722515", "cafe"], ["445110", "grocery"],
    ["445131", "grocery"], ["445210", "grocery"], ["445291", "bakery"], ["311811", "bakery"], ["812111", "barber"],
    ["812112", "salon"], ["812113", "salon"], ["812310", "laundromat"], ["812320", "drycleaner"],
    ["446110", "pharmacy"], ["456110", "pharmacy"], ["453110", "florist"], ["459310", "florist"],
    ["448120", "retail"], ["456120", "retail"], ["445320", "retail"], ["44", "retail"], ["4451", "grocery"],
    ["722514", "restaurant"], ["722110", "restaurant"], ["722211", "cafe"], ["722", "restaurant"],
  ])("%s -> %s", (code, want) => expect(id(code)).toBe(want));

  it.each([["541511"], ["531110"], ["454110"], ["722320"], ["722330"], ["72"], ["7"], [""], [null], [undefined], ["abc"]])(
    "%s -> no storefront",
    (code) => expect(id(code)).toBeNull(),
  );

  it("tolerates whitespace and punctuation in the registry field", () => {
    expect(id(" 722513 ")).toBe("cafe");
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
    expect(storefrontFor("722513", k)?.id).toBe("cafe");
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
