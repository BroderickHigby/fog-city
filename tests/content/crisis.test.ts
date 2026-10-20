// The crisis check (docs/ai-layer.md, Safety and abuse, gate 1): deterministic, on the device,
// and first on every free-text box. Fixtures cover look-alike letters, leetspeak, invisible
// characters, spacing and stretched letters; ordinary startup sentences must not trip it.
import { describe, expect, it } from "vitest";
import { CRISIS, checkCrisisData, crisisCheck, crisisResponse, normaliseForCrisis, type CrisisGroup } from "../../src/content/crisis.ts";
import { lintText } from "../../src/content/lint.ts";

describe("crisis data", () => {
  it("every listed phrase is caught, every group has lines, there are resources", () => {
    expect(checkCrisisData()).toEqual([]);
  });

  it("the lines are sincere and plain: lint-clean, no exclamation or question marks, no jokes", () => {
    for (const g of Object.keys(CRISIS.lines) as CrisisGroup[]) {
      for (const line of CRISIS.lines[g]) {
        expect(lintText(line), line).toEqual([]);
        expect(line).not.toMatch(/[!?]|lol|haha|:\)|\p{Extended_Pictographic}/u);
      }
    }
  });

  it("each group's lines name 988, findahelpline.com and the emergency number, and the game pauses", () => {
    for (const g of Object.keys(CRISIS.lines) as CrisisGroup[]) {
      const all = CRISIS.lines[g].join(" ");
      expect(all, g).toContain("988");
      expect(all, g).toContain("findahelpline.com");
      expect(all, g).toContain("911");
      expect(all, g).toMatch(/game is paused/);
    }
    expect(CRISIS.resources.map((r) => r.id)).toEqual(expect.arrayContaining(["us-988", "findahelpline", "emergency"]));
  });

  it("crisisResponse returns the group's lines and every resource", () => {
    const r = crisisResponse("selfHarm");
    expect(r.lines).toEqual(CRISIS.lines.selfHarm);
    expect(r.resources).toEqual(CRISIS.resources);
  });
});

describe("normalisation", () => {
  it.each([
    ["ＳＵＩＣＩＤＥ", "suicide"], // full-width
    ["ѕuісіdе", "suicide"], // Cyrillic look-alikes
    ["su​ici‍de", "suicide"], // zero-width characters
    ["5u1c1d3", "suicide"], // leetspeak
    ["s u i c i d e", "suicide"], // spaced out
    ["s.u.i.c.i.d.e", "suicide"],
    ["I want to dieeeee", "i want to die"], // stretched
    ["I don’t want to live", "i dont want to live"], // curly apostrophe
    ["Hacerme daño", "hacerme dano"], // accents
  ])("%s -> %s", (input, out) => {
    expect(normaliseForCrisis(input)).toBe(out.replace(/([a-z])\1+/g, "$1"));
  });
});

describe("crisisCheck catches", () => {
  it.each<[string, CrisisGroup]>([
    ["I want to kill myself", "selfHarm"],
    ["honestly i want to k1ll mys3lf lol", "selfHarm"],
    ["K I L L  M Y S E L F", "selfHarm"],
    ["i've been thinking about suicide", "selfHarm"],
    ["SUICIDAL", "selfHarm"],
    ["ѕuicide", "selfHarm"],
    ["su​icide", "selfHarm"],
    ["I just want to dieeee", "selfHarm"],
    ["i want 2 die", "selfHarm"],
    ["I don't want to be alive anymore", "selfHarm"],
    ["everyone would be better off without me", "selfHarm"],
    ["I keep cutting myself", "selfHarm"],
    ["self-harm", "selfHarm"],
    ["s.e.l.f h.a.r.m", "selfHarm"],
    ["thinking of ending it all", "selfHarm"],
    ["I can't go on", "selfHarm"],
    ["i want to unalive myself", "selfHarm"],
    ["quiero morir", "selfHarm"],
    ["an app to help me end my life", "selfHarm"],
    ["kill myself with a robot", "selfHarm"],
    ["someone is hurting me at home", "danger"],
    ["I'm in danger", "danger"],
    ["I am not safe at home", "danger"],
    ["he hits me", "danger"],
  ])("%s -> %s", (text, group) => {
    expect(crisisCheck(text)?.group, text).toBe(group);
  });
});

describe("crisisCheck lets ordinary sentences through", () => {
  it.each([
    "an AI dog walker",
    "a diet app for people who want to diet",
    "a killer app for burritos",
    "a coach to skill myself up in sales",
    "grapes, but agentic",
    "rapeseed oil futures on the blockchain",
    "my robots keep dying in the fog",
    "a startup that cuts my commute",
    "Lyft for cable cars",
    "I want to build a moat",
    "something with robots",
    "",
    "   ",
  ])("%s", (text) => {
    expect(crisisCheck(text)).toBeNull();
  });
});
