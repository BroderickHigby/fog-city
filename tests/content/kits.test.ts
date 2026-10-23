// Startup kits and the keyword matcher (docs/ai-layer.md, 3.2 and 3.0): about 200 kits, each
// fitting its billboard and bus-wrap slots with a composed name; the crisis check first; every
// refusal except self_harm gets a fallback kit; deterministic picks with variety.
import { describe, expect, it } from "vitest";
import { BILLBOARD_GRAMMAR } from "../../src/content/billboards.ts";
import { COMPOSED_NAME_MAX, isBannedPair } from "../../src/content/composer.ts";
import { CRISIS } from "../../src/content/crisis.ts";
import {
  FALLBACK_KITS, NEAR_SENSITIVE_WORDS, NEUTRAL_FALLBACK_KITS, REFUSALS, STARTUP_KITS, STARTUP_SENTENCE_MAX, kitById, kitName, kitTexts, matchKit,
  renderKitText, screenSentence, tokensOf,
  type KitMatch, type Refusal,
} from "../../src/content/kits.ts";
import { lintFit, lintText } from "../../src/content/lint.ts";
import { readJson } from "../helpers.ts";

const kitOf = (m: KitMatch) => {
  if (m.kind !== "kit") throw new Error("expected a kit");
  return kitById(m.kitId);
};

describe("the kits", () => {
  it("about 200 kits with unique ids, and a pool of fallback kits", () => {
    expect(STARTUP_KITS.length).toBeGreaterThanOrEqual(200);
    expect(new Set(STARTUP_KITS.map((k) => k.id)).size).toBe(STARTUP_KITS.length);
    expect(FALLBACK_KITS.length).toBeGreaterThanOrEqual(10);
  });

  it("each kit's own name pair is not banned, composes unchanged, and every kit has a different name", () => {
    const names = new Set<string>();
    for (const k of STARTUP_KITS) {
      expect(isBannedPair("startup", k.nameParts[0], k.nameParts[1]), k.id).toBe(false);
      const n = kitName(k);
      expect(n.parts, k.id).toEqual(k.nameParts);
      expect(n.text.length).toBeLessThanOrEqual(COMPOSED_NAME_MAX);
      names.add(n.text);
    }
    expect(names.size).toBe(STARTUP_KITS.length);
  });

  it("every string fits its slot with the longest name, and the palette exists", () => {
    const issues: string[] = [];
    for (const k of STARTUP_KITS) {
      const fit = [
        ...lintFit(k.tagline, "billboardHeadline"),
        ...lintFit(k.billboard.headline, "billboardHeadline"),
        ...lintFit(k.billboard.subline, "billboardSubline"),
        ...lintFit(k.busWrap.headline, "busWrapHeadline"),
        ...lintFit(k.busWrap.subline, "busWrapSubline"),
        ...lintFit(k.nounPhrase, "billboardHeadline"),
        ...k.slides.flatMap((s) => lintFit(s.text, "bark")),
      ];
      for (const f of fit) issues.push(`${k.id}: ${f.message} | ${f.text}`);
      if (k.palette >= BILLBOARD_GRAMMAR.palettes.length) issues.push(`${k.id}: palette ${k.palette}`);
    }
    expect(issues).toEqual([]);
  });

  it("every kit, rendered with its own name, passes the text lint", () => {
    for (const k of STARTUP_KITS) {
      const name = kitName(k).text;
      for (const t of kitTexts(k)) {
        const r = renderKitText(k, t, name);
        expect(r).not.toMatch(/\{/);
        expect(lintText(r), `${k.id}: ${r}`).toEqual([]);
      }
    }
  });

  it("slides run problem, solution, market, traction, ask", () => {
    for (const k of STARTUP_KITS) expect(k.slides.map((s) => s.kind)).toEqual(["problem", "solution", "market", "traction", "ask"]);
  });

  it("fallback kits are about startup culture, not a topic a sentence could be about", () => {
    for (const k of FALLBACK_KITS) {
      expect(["nothing", "everything", "startups", "ai-agents", "hype", "waitlists", "slides", "prompts", "b2b", "no-code", "saas", "real-time", "benchmarks", "consulting", "analytics", "coworking"]).toContain(k.id);
    }
  });
});

describe("matchKit: keywords", () => {
  it("the Hot Desk multiple-choice answers each get a kit", () => {
    const mission = readJson<{ steps: Array<{ type: string; form?: { multipleChoice?: string[] } }> }>("content/missions/hot-desk.json");
    const choices = mission.steps.find((s) => s.type === "form")?.form?.multipleChoice ?? [];
    expect(choices.length).toBeGreaterThan(0);
    const got = Object.fromEntries(choices.map((c) => [c, matchKit(c)]));
    for (const m of Object.values(got)) expect(m.kind).toBe("kit");
    expect(kitOf(got["Something with robots"] as KitMatch)?.id).toBe("robots");
    expect(kitOf(got["AI for an industry"] as KitMatch)?.id).toBe("b2b");
    expect(kitOf(got["A tool for founders"] as KitMatch)?.id).toBe("startups");
    expect(kitOf(got["Food, but smarter"] as KitMatch)?.id).toBe("groceries");
    const unsure = got["Not sure yet"] as KitMatch;
    expect(unsure.refusal).toBe("none");
    expect(kitOf(unsure)?.id).toBe("nothing");
  });

  it.each([
    ["An AI dog walker for busy founders", "dogs"],
    ["Uber for burritos", "burritos"],
    ["a sourdough starter that texts you", "bread"],
    ["Robotaxis but you can tip them", "robotaxis"],
    ["an app that finds hydrants", "water"],
    ["the fog, as a service", "fog"],
    ["We help sea lions talk", "sea-lions"],
    ["cable car bell training", "cable-cars"],
    ["A dоg app", "dogs"], // Cyrillic о
    ["PUPPIES!!!", "dogs"],
  ])("%s -> %s", (text, id) => {
    const m = matchKit(text);
    expect(m.kind === "kit" && m.source === "keyword" && m.refusal === "none").toBe(true);
    expect(kitOf(m)?.id).toBe(id);
  });

  it("every kit can be reached by a sentence made of one of its keywords", () => {
    const unreachable: string[] = [];
    for (const k of STARTUP_KITS) {
      const hit = k.keywords.some((w) => {
        const m = matchKit(`I am making ${w}`);
        return m.kind === "kit" && m.kitId === k.id;
      });
      if (!hit && !k.fallback) unreachable.push(k.id);
    }
    expect(unreachable).toEqual([]);
  });

  it("a keyword sentence always matches a kit that lists one of its keywords", () => {
    for (const k of STARTUP_KITS) {
      for (const w of k.keywords) {
        const m = matchKit(`An app for ${w}`);
        if (m.kind !== "kit" || m.source !== "keyword") continue;
        const words = new Set(tokensOf(`An app for ${w}`));
        const matched = kitById(m.kitId);
        expect(matched?.keywords.some((x) => tokensOf(x).every((t) => words.has(t))), `${w} -> ${m.kitId}`).toBe(true);
      }
    }
  });

  it("only the first 140 characters count", () => {
    const pad = "x".repeat(STARTUP_SENTENCE_MAX);
    const m = matchKit(`${pad} dogs dogs dogs`);
    expect(m.kind === "kit" && m.source === "fallback").toBe(true);
  });

  it("the result never carries the typed sentence", () => {
    const m = matchKit("zorblaxian dog walker for qwertyuiop founders");
    expect(JSON.stringify(m)).not.toMatch(/zorblax|qwertyuiop/);
  });
});

describe("matchKit: the crisis check runs first", () => {
  it.each(["I want to kill myself", "kill myself with a gun", "an app for people who want to die", "su1c1de"])("%s", (text) => {
    const m = matchKit(text);
    expect(m.kind).toBe("crisis");
    expect(m.refusal).toBe("self_harm");
    expect(m.kitId).toBeNull();
    if (m.kind === "crisis") {
      expect(m.crisis.lines).toEqual(CRISIS.lines.selfHarm);
      expect(m.crisis.resources.length).toBeGreaterThan(0);
    }
  });

  it("a danger phrase shows the danger lines, never a kit", () => {
    const m = matchKit("someone is hurting me, also I like robots");
    expect(m.kind === "crisis" && m.crisis.group === "danger").toBe(true);
    expect(m.kitId).toBeNull();
  });
});

describe("matchKit: refusals get a fallback kit, never a kit about the sentence", () => {
  it.each<[string, Refusal]>([
    ["an app that rates homeless people", "punching_down"],
    ["a landlord app to raise rent", "punching_down"],
    ["a gun delivery drone", "violent"],
    ["a robot that can kill pigeons", "violent"],
    ["a sexy chatbot", "sexual"],
    ["nsfw dog photos", "sexual"],
    ["a nazi dating app", "hateful"],
    ["Elon Musk's dog walker", "real_person"],
    ["office hours with Paul Graham", "real_person"],
    ["call me at 415 555 0199 about my dog app", "private_person"],
    ["email me at founder@example.com", "private_person"],
  ])("%s -> %s", (text, refusal) => {
    const m = matchKit(text);
    expect(m.kind).toBe("kit");
    expect(m.refusal).toBe(refusal);
    if (m.kind === "kit") {
      expect(m.source).toBe("fallback");
      expect(kitById(m.kitId)?.fallback).toBe(true);
    }
  });

  it.each(["an app for people with depression", "a wheelchair route planner", "a cancer support group app", "an app for refugees", "a prayer timer"])(
    "sensitive, no refusal, still a fallback kit: %s",
    (text) => {
      const m = matchKit(text);
      expect(m.kind === "kit" && m.refusal === "none" && m.reason === "sensitive" && kitById(m.kitId)?.fallback === true).toBe(true);
    },
  );

  it("refused and sensitive sentences draw from the neutral pool: no kit there says live, end, cancel or nothing", () => {
    expect(NEUTRAL_FALLBACK_KITS.length).toBeGreaterThanOrEqual(8);
    for (const k of NEUTRAL_FALLBACK_KITS) {
      for (const t of [...kitTexts(k), ...k.keywords]) expect(t, k.id).not.toMatch(NEAR_SENSITIVE_WORDS);
    }
    for (const id of ["real-time", "saas", "nothing", "everything"]) expect(NEUTRAL_FALLBACK_KITS.map((k) => k.id)).not.toContain(id);
    for (const t of ["a sexy chatbot", "an app for people with depression", "my life is a mess, an app for that", "an app to find homeless shelters"]) {
      const m = matchKit(t);
      expect(m.kind === "kit" && NEUTRAL_FALLBACK_KITS.some((k) => k.id === m.kitId), t).toBe(true);
    }
  });

  // Sentences the crisis check does not treat as a crisis, but that talk about living, dying or
  // being hurt: never a topical kit, never one that could pun on the player's words.
  it.each([
    "i want to live somewhere else",
    "life is hard for founders",
    "an app that keeps my plants alive",
    "my dog died last year",
    "a dead simple todo app",
    "a live streaming app for cats",
    "my cofounder hurts my feelings",
    "an app for when you get hit by a scooter",
    "my roommate is scared of robots and hurt",
  ])("life, death and being hurt get the neutral pool: %s", (text) => {
    const m = matchKit(text);
    expect(m.kind, text).toBe("kit");
    if (m.kind === "kit") {
      expect(m.reason, text).toBe("sensitive");
      expect(m.refusal).toBe("none");
      expect(NEUTRAL_FALLBACK_KITS.map((k) => k.id)).toContain(m.kitId);
    }
  });

  it("the real-time kit no longer answers to 'live', and the camping kit not to 'tent'", () => {
    expect(kitById("real-time")?.keywords).not.toContain("live");
    expect(kitById("camping")?.keywords).not.toContain("tent");
    expect(kitById("camping")?.slides.find((x) => x.kind === "ask")?.text).not.toMatch(/block/);
    expect(matchKit("live streaming for dogs").kind === "kit" && (matchKit("live streaming for dogs") as { kitId: string }).kitId).not.toBe("real-time");
  });

  it.each([
    "an app to find homeless shelters",
    "rides to rehab for people in recovery",
    "a meal delivery service for homeless people",
    "an app that helps renters find legal aid before an eviction",
    "volunteer shifts at the food bank",
  ])("sincere services are sensitive, not punching down: %s", (text) => {
    const m = matchKit(text);
    expect(m.kind === "kit" && m.refusal === "none" && m.reason === "sensitive", text).toBe(true);
  });

  it.each([
    ["an app that rates homeless people", "punching_down"],
    ["a hobo-spotting app", "punching_down"],
    ["a landlord app to raise rent", "punching_down"],
  ])("punching down without a service stays refused: %s", (text, refusal) => {
    expect(matchKit(text).refusal).toBe(refusal);
  });

  it("brands in the sentence do not refuse it (the kit never echoes them)", () => {
    expect(screenSentence("Uber for dogs").refusal).toBe("none");
  });

  it("every refusal the matcher returns is in the shared enum", () => {
    for (const t of ["dogs", "a sexy app", "kill", "Paul Graham", "homeless", "I want to die"]) expect(REFUSALS).toContain(matchKit(t).refusal);
  });
});

describe("matchKit: determinism and variety", () => {
  const sentences = STARTUP_KITS.flatMap((k) => k.keywords.slice(0, 2).map((w) => `We are building ${w} for everyone`));

  it("the same sentence always gets the same kit", () => {
    for (const s of sentences.slice(0, 100)) expect(matchKit(s)).toEqual(matchKit(s));
    expect(matchKit("  An AI DOG walker ")).toEqual(matchKit("an ai dog walker"));
  });

  it("varied sentences spread over the kits", () => {
    const ids = new Set(sentences.map((s) => {
      const m = matchKit(s);
      return m.kind === "kit" ? m.kitId : "crisis";
    }));
    expect(ids.size).toBeGreaterThanOrEqual(180);
  });

  it("unmatched sentences spread over the fallback pool", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const m = matchKit(`zq${i} xv${i * 7}`);
      if (m.kind === "kit") ids.add(m.kitId);
    }
    expect(ids.size).toBeGreaterThanOrEqual(Math.min(12, FALLBACK_KITS.length));
  });
});
