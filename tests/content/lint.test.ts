// The content lint library: every rule fails on its fixture, harmless look-alikes pass, and the
// registry of name fields rejects an invented proper name missing from cleared-names.json.
import { describe, expect, it } from "vitest";
import { CLEARED, CLEARED_NAMES_FILE, GAME_BRANDS, checkClearedNames, clearedNames } from "../../src/content/clearedNames.ts";
import { EXEMPTIONS } from "../../src/content/denylists.ts";
import { FONT_FIT, lintDocument, lintFit, lintModeName, lintText, maxRenderedLength, splitIdWords, type LintRule } from "../../src/content/lint.ts";

const rules = (t: string): LintRule[] => lintText(t).map((i) => i.rule);

describe("lintText fails on each fixture", () => {
  it.each<[string, LintRule]>([
    ["Apply to YC by Friday.", "accelerator"],
    ["Our YC partner says hi.", "accelerator"],
    ["Backed by Y Combinator.", "accelerator"],
    ["A Y-Combinator company", "accelerator"],
    ["Make something people want.", "accelerator"],
    ["Office hours with Paul Graham", "person"],
    ["As Elon Musk once said", "person"],
    ["Office hours with Tom Blomfield", "accelerator"],
    ["Our logo is an orange Y mark.", "accelerator"],
    ["Inspired by Modern Warfare.", "shooter"],
    ["Earn a Scorestreak for every melt.", "shooter"],
    ["Earn a killstreak.", "shooter"],
    ["Your Field Upgrade is ready.", "shooter"],
    ["Equip two Tacticals.", "shooter"],
    ["Call of Duty, but robots.", "shooter"],
    ["The bots attack in a battle royale.", "shooter"],
    ["Kill the bad robot.", "lexicon"],
    ["Shoot the robot.", "lexicon"],
    ["Nice shot.", "lexicon"],
    ["A sleeper cell of bad robots.", "lexicon"],
    ["killSwitch", "lexicon"],
    ["robot-ambush-site", "lexicon"],
    ["Bad robots infect the good ones.", "disease"],
    ["patientZeroBot", "disease"],
    ["The update spreads like a virus.", "disease"],
    ["Go hunting for robots.", "restricted"],
    ["A bounty hunter.", "restricted"],
    ["Sweep the block.", "restricted"],
    ["Help the homeless robot.", "punchDown"],
    ["Tents and shopping carts on the corner.", "punchDown"],
    ["Raise the rent.", "housing"],
    ["An up-and-coming neighbourhood.", "housing"],
    ["What the hell.", "profanity"],
    ["Fuhgeddaboudit, the bus is late.", "dialect"],
    ["Hola amigo, want a burrito?", "dialect"],
    ["Chinatown firmware is behind it.", "places"],
    ["Posted on Clout.", "renamed"],
    ["A Porter carries the groceries.", "renamed"],
    ["Listen to Marine Layer FM.", "renamed"],
    ["Inspired by Stochastic Parrots.", "renamed"],
    ["Built on Anthropic's models.", "brand"],
    ["Faster than any Waymo.", "brand"],
  ])("%s -> %s", (text, rule) => {
    expect(rules(text), text).toContain(rule);
  });
});

describe("lintText passes harmless look-alikes", () => {
  it.each([
    "Take a screenshot.",
    "Call me on my cell phone.",
    "Emotional intelligence for every cell.",
    "Bot Hunt starts at the Ferry Building.",
    "Hunters Point has a bounty.",
    "Bot Sweep: a co-op mode.",
    "The melt went viral.",
    "Plans for world domination, in a deck.",
    "Typed answers go to an AI model (Anthropic's API) through this server. This server does not keep them.",
    "Your second brain, rented.",
    "Shell out for a burrito.",
    "Recycle the bicycle.",
    "ramen-pitch",
    "The Ramen house at Pier 70.",
    "A Footman carries the groceries.",
    "Posted on Humbled.",
  ])("%s", (text) => {
    expect(lintText(text)).toEqual([]);
  });

  it("the AI notice is the only exemption, and it exempts only the brand rule", () => {
    expect(EXEMPTIONS.map((e) => e.text)).toEqual(["(Anthropic's API)"]);
    expect(rules("(Anthropic's API)")).toEqual([]);
    expect(rules("(Anthropic's API) Anthropic")).toContain("brand");
  });

  it("splits ids at camelCase, dashes and underscores", () => {
    expect(splitIdWords("killSwitch-for_robots")).toBe("kill Switch for robots");
  });
});

describe("mode and item names", () => {
  it.each(["Domination", "Robot Domination", "Hardpoint", "Hard Point Hold", "Search & Destroy", "Team Deathmatch", "dominationMode"])("rejects %s", (n) => {
    expect(lintModeName(n).map((i) => i.rule)).toEqual(["shooterMode"]);
  });
  it.each(["Bot Sweep", "Clean Streets", "Hide in the Crowd", "Fog Royale", "Tank I", "Burrito"])("allows %s", (n) => {
    expect(lintModeName(n)).toEqual([]);
  });

  it("a mode named Domination fails in a modes file, through the registry", () => {
    const doc = { modes: [{ id: "zone", name: "Domination" }] };
    expect(lintDocument("content/modes/instances.json", doc, CLEARED).map((i) => i.rule)).toEqual(["shooterMode"]);
    // The same word in prose elsewhere is ordinary English.
    expect(lintDocument("content/barks/robots.json", { barks: [{ text: "World domination, but polite." }] }, CLEARED)).toEqual([]);
  });
});

describe("cleared names", () => {
  it("cleared-names.json and brands.json agree", () => {
    expect(checkClearedNames()).toEqual([]);
  });

  it("is pending the user's sign-off, and every search is dated and sourced", () => {
    expect(CLEARED_NAMES_FILE.status).toBe("pending user sign-off");
    for (const n of CLEARED_NAMES_FILE.names) {
      expect(n.searchedOn, n.name).toBe("2026-10-20");
      expect(n.queries.length, n.name).toBeGreaterThanOrEqual(2);
      expect(n.sources.length, n.name).toBeGreaterThan(0);
    }
  });

  it("covers the names the roadmap requires", () => {
    const names = new Set(CLEARED_NAMES_FILE.names.map((n) => n.name));
    for (const n of ["Moat Labs", "Meander", "FogCast", "Marine Layer", "Bramblecot Home", "Dry Powder", "Brackish", "Ramen"]) expect(names.has(n), n).toBe(true);
    // Clout was searched and renamed.
    expect(CLEARED_NAMES_FILE.renamed.find((r) => r.from === "Clout")?.to).toBe("Humbled");
  });

  it("an invented proper name missing from cleared-names.json fails the lint", () => {
    const brands = { brands: [{ id: "zorblax", kind: "company", name: "Zorblax Ventures" }] };
    const issues = lintDocument("content/brands.json", brands, CLEARED);
    expect(issues.map((i) => i.rule)).toEqual(["clearedName"]);
    expect(issues[0]!.path).toBe("brands.0.name");
    const mission = { cast: { host: { name: "Quentin Velour", role: "Host" } } };
    expect(lintDocument("content/missions/fixture.json", mission, CLEARED).map((i) => i.rule)).toEqual(["clearedName"]);
  });

  it("a renamed (conflicting) name is not cleared, and generic labels are", () => {
    const withClout = { ...CLEARED_NAMES_FILE, names: [...CLEARED_NAMES_FILE.names, { ...CLEARED_NAMES_FILE.names[0]!, name: "Clout", verdict: "conflict" as const }] };
    expect(clearedNames(withClout).cleared.has("Clout")).toBe(false);
    expect(checkClearedNames(withClout).join("\n")).toMatch(/Clout: a conflict must be renamed/);
    expect(lintDocument("content/missions/fixture.json", { cast: { p: { name: "You", role: "Founder" } } }, CLEARED)).toEqual([]);
  });

  it("every brand name passes the brand and person blocklist as prose", () => {
    for (const b of GAME_BRANDS) expect(lintText(b.name), b.name).toEqual([]);
  });

  it("a brand whose name was never searched is caught", () => {
    expect(checkClearedNames(CLEARED_NAMES_FILE, [...GAME_BRANDS, { id: "newCo", kind: "company", name: "Newco Robotics" }]).join("\n")).toMatch(/Newco Robotics" is not in cleared-names/);
  });
});

describe("font fit", () => {
  it("fills placeholders at their maximum length", () => {
    expect(maxRenderedLength("{name} for dogs")).toBe(16 + 9);
    expect(maxRenderedLength("{$product}.")).toBe(13);
  });
  it("rejects copy that cannot fit its surface", () => {
    expect(lintFit("x".repeat(FONT_FIT.billboardHeadline), "billboardHeadline")).toEqual([]);
    expect(lintFit("x".repeat(FONT_FIT.billboardHeadline + 1), "billboardHeadline").map((i) => i.rule)).toEqual(["fontFit"]);
    expect(lintFit("{name} is hiring humans for the parts agents won't do", "busWrapHeadline").map((i) => i.rule)).toEqual(["fontFit"]);
    expect(lintFit("Street Cleaning Tue 8-10", "sign")).toEqual([]);
  });
});
