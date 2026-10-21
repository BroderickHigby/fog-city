// Ambient Director cards: 40-60 hand-written, schema-valid, consistent with the robots, never a
// person as a target, never a bad robot in a protected area, and always something to stage.
import { describe, expect, it } from "vitest";
import { DIRECTOR_CARDS, cardHasBadRobot, checkDirectorCards, eligibleCards, type DirectorContext, type DirectorCardsFile } from "../../src/content/directorCards.ts";
import { makePrng } from "../../src/content/prng.ts";
import { DISTRICTS } from "../../src/content/places.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const cards = DIRECTOR_CARDS.cards;

describe("content/director-cards.json", () => {
  it("has 40-60 cards, at least 40 of them for wave 2", () => {
    expect(cards.length).toBeGreaterThanOrEqual(40);
    expect(cards.length).toBeLessThanOrEqual(60);
    expect(cards.filter((c) => c.fromWave <= 2).length).toBeGreaterThanOrEqual(40);
  });

  it("passes every cross-reference rule", () => {
    expect(checkDirectorCards()).toEqual([]);
  });

  it("stages within 150 m after 45-75 s idle", () => {
    expect(DIRECTOR_CARDS.maxRadiusM).toBe(150);
    expect(DIRECTOR_CARDS.idleWindowS).toEqual([45, 75]);
    for (const c of cards) expect(c.radiusM).toBeLessThanOrEqual(150);
  });

  it("covers the design's examples: a snatch, oranges downhill, a robotaxi on a hydrant, a Trundle in a puddle, a quick call", () => {
    const ids = new Set(cards.map((c) => c.id));
    for (const id of ["snatch-in-progress", "oranges-downhill", "hydrant-blocker", "stuck-in-a-puddle", "quick-call"]) expect(ids.has(id), id).toBe(true);
  });

  it("teaches false tells: several cards where the right play is to hold fire", () => {
    expect(cards.filter((c) => c.payoff.kind === "holdFire").length).toBeGreaterThanOrEqual(4);
  });

  it("no card with a bad robot runs in a protected area", () => {
    for (const c of cards) if (cardHasBadRobot(c)) expect(c.protectedAreas, c.id).toBe(false);
  });

  it("from 20 seeded moments in the shipped districts there is always a card to stage within 150 m", () => {
    const rng = makePrng("director-coverage");
    const features = ["hydrant", "crosswalk", "busStop", "busShelter", "parkedCars", "storefront", "door", "chargingDock", "park", "hill", "robotaxiPickup", "puddle", "billboard"];
    const times = ["morning", "day", "evening", "night"] as const;
    const weathers = ["clear", "rain", "fog"] as const;
    const active = DISTRICTS.filter((d) => d.active);
    for (let i = 0; i < 20; i++) {
      const near = new Set(["sidewalk", "road"]);
      for (const f of features) if (rng.int(3) === 0) near.add(f);
      const ctx: DirectorContext = {
        wave: 2, near, time: rng.pick(times), weather: rng.pick(weathers), threat: 0, stars: 0,
        district: rng.pick(active).id, inProtectedArea: false, playerState: rng.int(2) === 0 ? "onFoot" : "inCar",
      };
      expect(eligibleCards(ctx).length, JSON.stringify({ ...ctx, near: [...near] })).toBeGreaterThan(0);
      // Inside a protected area only cards without a bad robot remain, and there still is one.
      const prot = eligibleCards({ ...ctx, inProtectedArea: true });
      expect(prot.every((c) => !cardHasBadRobot(c))).toBe(true);
      expect(prot.length, `protected ${i}`).toBeGreaterThan(0);
    }
  });

  it("eligibility honours wave, district, weather and threat", () => {
    const base: DirectorContext = { wave: 2, near: new Set(["sidewalk", "road", "hydrant", "puddle"]), time: "day", weather: "clear", threat: 0, stars: 0, district: "soma", inProtectedArea: false, playerState: "onFoot" };
    expect(eligibleCards(base).some((c) => c.id === "quick-call")).toBe(false);
    expect(eligibleCards({ ...base, wave: 3, stars: 2 }).some((c) => c.id === "quick-call")).toBe(true);
    expect(eligibleCards(base).some((c) => c.id === "stuck-in-a-puddle")).toBe(false);
    expect(eligibleCards({ ...base, weather: "rain" }).some((c) => c.id === "stuck-in-a-puddle")).toBe(true);
    expect(eligibleCards(base).some((c) => c.id === "lanyard-demo")).toBe(true);
    expect(eligibleCards({ ...base, district: "marina" }).some((c) => c.id === "lanyard-demo")).toBe(false);
    expect(eligibleCards(base).some((c) => c.id === "broadcast")).toBe(false);
    expect(eligibleCards({ ...base, threat: 1 }).some((c) => c.id === "broadcast")).toBe(true);
  });
});

describe("checkDirectorCards catches broken cards", () => {
  const broken = (mutate: (f: DirectorCardsFile) => void): string => {
    const f = clone(DIRECTOR_CARDS);
    mutate(f);
    return checkDirectorCards(f).join("\n");
  };
  const card = (f: DirectorCardsFile, id: string) => f.cards.find((c) => c.id === id)!;
  it("a beat aimed at a person", () => {
    expect(broken((f) => (card(f, "caught-on-camera").beats[0]!.target = "crowd"))).toContain("targets a person");
  });
  it("a bad robot allowed into protected areas", () => {
    expect(broken((f) => (card(f, "snatch-in-progress").protectedAreas = true))).toContain("may not run in a protected area");
  });
  it("a sabotage the archetype never does", () => {
    expect(broken((f) => (card(f, "poster-swap").beats[0]!.sabotage = "parkAcrossHydrant"))).toContain("has no parkAcrossHydrant sabotage");
  });
  it("a false tell the robot never shows", () => {
    expect(broken((f) => (card(f, "low-battery").beats[0]!.tell = "scenicRoute"))).toContain("never shows scenicRoute");
  });
  it("a bark context that does not exist", () => {
    expect(broken((f) => (card(f, "snatch-in-progress").beats[2]!.context = "monologue"))).toContain("no shared barks for goodRobot/monologue");
  });
  it("an associate in wave 2", () => {
    expect(broken((f) => (card(f, "quick-call").fromWave = 2))).toContain("arrive in wave 3");
  });
});
