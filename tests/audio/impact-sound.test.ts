// Collision sounds from the sim's impact events: each once, none on load, tiers by dv, the
// surface's timbre, scrapes for grinding contact, the player's own hits, and the hydrant hiss.
import { describe, expect, it } from "vitest";
import { BUMP_DV, IMPACT_HEAR_M, ImpactSoundTracker, MAX_IMPACTS_PER_FRAME, SMASH_DV, surfaceOf, tierOf, type ImpactEventLike, type ImpactsLike } from "../../src/audio/impact-sound.ts";

const here = { x: 0, z: 0, heading: 0 };
const SELF = "p:p1";
let nextId = 1;
const ev = (o: Partial<ImpactEventLike> = {}): ImpactEventLike => ({ id: nextId++, tick: 100, kind: "taxi-taxi", a: "a:t1", b: "a:t2", x: 10, z: 0, speed: 5, dv: 5, ...o });
const primed = (initial: ImpactEventLike[] = []): ImpactSoundTracker => {
  const t = new ImpactSoundTracker();
  t.update({ events: initial }, here, SELF, false);
  return t;
};

describe("impact events", () => {
  it("stays silent with no impacts system, and never replays events there at load", () => {
    const t = new ImpactSoundTracker();
    expect(t.update(undefined, here, SELF, false)).toEqual([]);
    const old = [ev(), ev()];
    const t2 = new ImpactSoundTracker();
    expect(t2.update({ events: old }, here, SELF, false)).toEqual([]);
    expect(t2.update({ events: old }, here, SELF, false)).toEqual([]);
  });

  it("plays each new event once, deduped by id, as the ring of 24 rolls", () => {
    const t = primed();
    const ring: ImpactEventLike[] = [];
    let played = 0;
    for (let i = 0; i < 60; i++) {
      ring.push(ev({ tick: 100 + i * 100, a: `a:x${i}`, b: `a:y${i}` }));
      if (ring.length > 24) ring.shift();
      played += t.update({ events: ring }, here, SELF, false).length;
      played += t.update({ events: ring }, here, SELF, false).length;
    }
    expect(played).toBe(60);
  });

  it("tiers by dv: bump, crunch, smash; harder is louder", () => {
    expect(tierOf(BUMP_DV - 0.1)).toBe("bump");
    expect(tierOf(5)).toBe("crunch");
    expect(tierOf(SMASH_DV + 0.1)).toBe("smash");
    const t = primed();
    const [soft] = t.update({ events: [ev({ dv: 1, a: "a:1", b: "a:2" })] }, here, SELF, false);
    const [hard] = t.update({ events: [ev({ dv: 12, a: "a:3", b: "a:4" })] }, here, SELF, false);
    expect(soft!.tier).toBe("bump");
    expect(hard!.tier).toBe("smash");
    expect(hard!.gain).toBeGreaterThan(soft!.gain);
  });

  it("picks the timbre from the surface hit, with robot falls and prop breaks", () => {
    expect(surfaceOf("car-robot")).toBe("robot");
    expect(surfaceOf("taxi-car")).toBe("car");
    expect(surfaceOf("car-prop")).toBe("prop");
    expect(surfaceOf("car-unicorn")).toBeNull();
    const t = primed();
    const cues = t.update({
      events: [
        ev({ kind: "car-robot", a: SELF, b: "a:r1", fell: true, disabled: true }),
        ev({ kind: "car-prop", a: "p:p2", b: "prop:tree:42", broke: true }),
        ev({ kind: "car-prop", a: "p:p3", b: "prop:hydrant-7", broke: false }),
      ],
      props: { "tree:42": { kind: "tree" } },
    }, here, SELF, false);
    const robot = cues.find((c) => c.material === "robot")!;
    expect(robot.fell && robot.disabled && robot.self).toBe(true);
    expect(cues.find((c) => c.material === "wood")?.broke).toBe(true);
    expect(cues.find((c) => c.material === "post")?.broke).toBe(false);
    expect(t.update({ events: [ev({ kind: "car-car", a: "p:p2", b: "p:p3" })] }, here, SELF, false)[0]!.material).toBe("metal");
  });

  it("scrapes when the same bodies touch again soon, and crunches again after a pause", () => {
    const t = primed();
    expect(t.update({ events: [ev({ tick: 100 })] }, here, SELF, false)[0]!.scrape).toBe(false);
    expect(t.update({ events: [ev({ tick: 110, a: "a:t2", b: "a:t1" })] }, here, SELF, false)[0]!.scrape).toBe(true);
    expect(t.update({ events: [ev({ tick: 400 })] }, here, SELF, false)[0]!.scrape).toBe(false);
  });

  it("is heard only within range, panned by side, and the player's own hit always plays", () => {
    const t = primed();
    expect(t.update({ events: [ev({ x: IMPACT_HEAR_M + 5 })] }, here, SELF, false)).toEqual([]);
    const [right] = t.update({ events: [ev({ x: 20, a: "a:9", b: "a:8" })] }, here, SELF, false);
    expect(right!.pan).toBeGreaterThan(0);
    // A pile-up: at most a few at once, the player's own among them.
    const pile = Array.from({ length: 10 }, (_, i) => ev({ a: `a:q${i}`, b: `a:w${i}`, x: 2, dv: 12 }));
    pile.push(ev({ a: SELF, b: "a:taxi", x: 80, dv: 0.5, kind: "car-taxi" }));
    const cues = t.update({ events: pile }, here, SELF, false);
    expect(cues.length).toBe(MAX_IMPACTS_PER_FRAME);
    expect(cues.some((c) => c.self)).toBe(true);
  });

  it("forgets everything on a restore", () => {
    const t = primed();
    const later = [ev(), ev()];
    t.reset();
    expect(t.update({ events: later }, here, SELF, false)).toEqual([]);
  });
});

describe("hydrant hiss", () => {
  it("hisses near a hydrant heard breaking, louder closer, and stops when it is fixed", () => {
    const t = primed();
    const broke = ev({ kind: "car-prop", a: SELF, b: "prop:hydrant:3", x: 6, z: 0, broke: true });
    const gushing: ImpactsLike = { events: [broke], props: { "hydrant:3": { kind: "hydrant" } } };
    t.update(gushing, here, SELF, false);
    const near = t.hydrant(gushing, here)!;
    const far = t.hydrant(gushing, { x: -20, z: 0, heading: 0 })!;
    expect(near.gain).toBeGreaterThan(far.gain);
    expect(t.hydrant(gushing, { x: 200, z: 0, heading: 0 })).toBeNull();
    expect(t.hydrant({ events: [broke], props: {} }, here)).toBeNull();
    // A broken tree never hisses.
    const tree: ImpactsLike = { events: [ev({ kind: "car-prop", b: "prop:tree:1", broke: true })], props: { "tree:1": { kind: "tree" } } };
    t.update(tree, here, SELF, false);
    expect(t.hydrant(tree, here)).toBeNull();
  });
});
