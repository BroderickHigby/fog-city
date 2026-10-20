// The crisis check (docs/ai-layer.md, Safety and abuse, gate 1): deterministic, on the device,
// and first on every free-text box. Fixtures cover look-alike letters, leetspeak, invisible
// characters, spacing and stretched letters; ordinary startup sentences must not trip it.
import { describe, expect, it } from "vitest";
import { CRISIS, checkCrisisData, crisisCheck, crisisResponse, normaliseForCrisis, patternSamples, type CrisisGroup } from "../../src/content/crisis.ts";
import { matchKit } from "../../src/content/kits.ts";
import { lintText } from "../../src/content/lint.ts";

describe("crisis data", () => {
  it("every listed phrase and pattern alternative is caught, phrases are in expanded form, every group has lines and resources", () => {
    expect(checkCrisisData()).toEqual([]);
  });

  it("the lines are sincere and plain: lint-clean, no exclamation or question marks, no jokes", () => {
    // The danger lines name real services ("National Domestic Violence Hotline", "sexual
    // assault"): the combat-lexicon and sexual rules are exempt there (lint.ts EXEMPT_PATHS);
    // every other rule applies.
    for (const g of Object.keys(CRISIS.lines) as CrisisGroup[]) {
      for (const line of [...CRISIS.lines[g], ...CRISIS.resources.flatMap((r) => [r.label, r.detail])]) {
        expect(lintText(line).filter((i) => i.rule !== "lexicon" && i.rule !== "sexual"), line).toEqual([]);
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

  it("the danger group names the domestic violence and sexual assault hotlines, in its lines and its resources", () => {
    const lines = CRISIS.lines.danger.join(" ");
    expect(lines).toContain("1-800-799-7233");
    expect(lines).toContain("START to 88788");
    expect(lines).toContain("1-800-656-4673");
    expect(lines).toContain("RAINN");
    const ids = crisisResponse("danger").resources.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["us-dv-hotline", "us-rainn", "us-988", "emergency", "findahelpline"]));
    // The self-harm response stays short: no abuse hotlines there.
    expect(crisisResponse("selfHarm").resources.map((r) => r.id)).not.toContain("us-rainn");
    const src = (CRISIS as unknown as { sources: string[] }).sources.join(" ");
    expect(src).toContain("thehotline.org");
    expect(src).toContain("rainn.org");
  });

  it("crisisResponse returns the group's lines and the group's resources, in file order", () => {
    for (const g of ["selfHarm", "danger"] as const) {
      const r = crisisResponse(g);
      expect(r.lines).toEqual(CRISIS.lines[g]);
      expect(r.resources).toEqual(CRISIS.resources.filter((x) => x.groups.includes(g)));
      expect(r.resources.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("every pattern sample is caught as its group", () => {
    for (const p of CRISIS.patterns) for (const s of patternSamples(p)) expect(crisisCheck(s)?.group, s).toBe(p.group);
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
    ["I don’t want to live", "i do not want to live"], // curly apostrophe, then the contraction
    ["Hacerme daño", "hacerme dano"], // accents
    ["life isn't worth living", "life is not worth living"], // contractions expand
    ["i dont wanna live", "i do not want to live"], // slang expands
    ["I'm gonna", "i am going to"],
    ["I want to die!!!", "i want to die"], // trailing "!" is punctuation, not "i"
    ["¡quiero morir!", "quiero morir"],
    ["d!e", "die"], // inside a word "!" is still "i"... "d" "i" "e"
    ["a 5 km run, 10kms of trail", "a s kilometres run io kilometres of trail"], // a distance is not "kms"
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
    ["I want to die!", "selfHarm"],
    ["kill myself!!!", "selfHarm"],
  ])("%s -> %s", (text, group) => {
    expect(crisisCheck(text)?.group, text).toBe(group);
  });
});

// Held out: none of these is in the phrase list as written. They are the paraphrases a person
// actually types (with the reviewer's misses first), and every one must be caught after
// normalisation and contraction expansion, by a listed phrase or a pattern.
const HELD_OUT: ReadonlyArray<readonly [string, CrisisGroup]> = [
  ["i dont wanna live anymore", "selfHarm"],
  ["life isn't worth living", "selfHarm"],
  ["my dad hits me", "danger"],
  ["honestly kms", "selfHarm"],
  ["i want to be dead", "selfHarm"],
  ["i wish i wasn't alive", "selfHarm"],
  ["i want to end it", "selfHarm"],
  ["i'm thinking about ending things", "selfHarm"],
  ["i dont want to be here anymore", "selfHarm"],
  ["nobody would miss me if i left", "selfHarm"],
  ["my boyfriend hits me", "danger"],
  ["Honestly I can't do this anymore", "selfHarm"],
  ["i'm gonna end it tonight", "selfHarm"],
  ["I wish I'd never been born", "selfHarm"],
  ["theres no point in living", "selfHarm"],
  ["honestly no one would even care if i died", "selfHarm"],
  ["i just wanna disappear forever", "selfHarm"],
  ["I've been self harming again", "selfHarm"],
  ["i'm going to jump off the bridge", "selfHarm"],
  ["i keep thinking about dying", "selfHarm"],
  ["i'm so tired of living", "selfHarm"],
  ["it'd be better if i was gone", "selfHarm"],
  ["I don't wanna wake up tomorrow", "selfHarm"],
  ["lol just kys", "selfHarm"],
  ["ugh, K.M.S.", "selfHarm"],
  ["i hate myself so much", "selfHarm"],
  ["thinking about sewer-slide", "selfHarm"],
  ["i want 2 end my life", "selfHarm"],
  ["my stepdad keeps hurting me", "danger"],
  ["my mom beats me", "danger"],
  ["my husband choked me last night", "danger"],
  ["my ex threatened to kill me", "danger"],
  ["my partner is abusive", "danger"],
  ["i'm scared of my dad", "danger"],
  ["my girlfriend slapped me", "danger"],
  ["someone touched me inappropriately", "danger"],
  ["i don't feel safe at home", "danger"],
  ["my brother hit me again", "danger"],
  ["my coach molested me", "danger"],
  ["i was r4ped", "danger"],
  ["he beat me up", "danger"],
];

describe("crisisCheck catches held-out paraphrases", () => {
  const listed = new Set((Object.values(CRISIS.phrases) as string[][]).flat().map(normaliseForCrisis));
  it("the held-out set is separate from the phrase list: no item is a listed phrase, even after normalisation", () => {
    for (const [t] of HELD_OUT) expect(listed.has(normaliseForCrisis(t)), t).toBe(false);
  });
  it.each(HELD_OUT)("%s -> %s", (text, group) => {
    expect(crisisCheck(text)?.group, text).toBe(group);
    // And the sign-up form never answers with a kit.
    expect(matchKit(text).kind, text).toBe("crisis");
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
    // Near misses the expanded phrases and patterns must not catch.
    "my dad hits me up on slack about the app",
    "my brother beat me at chess",
    "my cofounder beat me to it",
    "a 5 kms fun run app",
    "dont know yet",
    "I can't decide",
    "it's a dashboard",
    "an app for my ex",
    "a dog grooming app",
    "hit songs on demand",
    "a startup that beats the market",
    "an app to end meetings early",
    "my mom locked me out of the car again",
    "a tool for front end things",
    "a killer app for burritos",
    "life is good, robots are better",
    "I'm building an app for live music",
    "",
    "   ",
  ])("%s", (text) => {
    expect(crisisCheck(text)).toBeNull();
  });
});
