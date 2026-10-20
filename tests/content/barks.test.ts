// Shared bark pools: 300 robot barks (good apologies, bad growth-hack taunts) and 100 wet barks
// (people being sprayed: annoyance only), with ids, speaker kind, mood and max length.
import { describe, expect, it } from "vitest";
import { ROBOT_BARKS, WET_BARKS, barksFor, checkBarks, contentHash, coverage, pickBark } from "../../src/content/barks.ts";

describe("content/barks/robots.json", () => {
  const b = ROBOT_BARKS.barks;
  it("has 300 shared robot barks with valid structure", () => {
    expect(b.length).toBeGreaterThanOrEqual(300);
    expect(checkBarks(b, "robots")).toEqual([]);
  });

  it("covers good apologies and bad growth-hack taunts, and every state of the brain", () => {
    const c = coverage(b);
    expect(c["goodRobot/apology"]).toBeGreaterThanOrEqual(30);
    expect(c["badRobot/taunt"]).toBeGreaterThanOrEqual(40);
    for (const k of ["goodRobot/idle", "goodRobot/pinged", "goodRobot/wrongTarget", "goodRobot/sabotaged", "goodRobot/weather", "goodRobot/freeze", "badRobot/sabotage", "badRobot/wary", "badRobot/attack", "badRobot/sprayed", "badRobot/flee", "badRobot/seized"]) {
      expect(c[k], k).toBeGreaterThanOrEqual(10);
    }
    expect(b.filter((x) => x.speaker === "goodRobot").length).toBeGreaterThanOrEqual(120);
    expect(b.filter((x) => x.speaker === "badRobot").length).toBeGreaterThanOrEqual(120);
  });

  it("good robots answer a ping the way design.md says ('Did you need something?')", () => {
    expect(barksFor(b, "goodRobot", "pinged").map((x) => x.text)).toContain("Did you need something?");
  });

  it("the provenance hash matches the text", () => {
    expect(ROBOT_BARKS.provenance.contentHash).toBe(contentHash(b.map((x) => x.text)));
    expect(ROBOT_BARKS.provenance.source).toBe("agent");
  });
});

describe("content/barks/wet.json", () => {
  const w = WET_BARKS.barks;
  it("has 100 wet barks from at least five kinds of adult passer-by", () => {
    expect(w.length).toBeGreaterThanOrEqual(100);
    expect(checkBarks(w, "wet")).toEqual([]);
    expect(new Set(w.map((x) => x.speaker)).size).toBeGreaterThanOrEqual(5);
    for (const x of w) expect(x.context).toBe("wet");
  });

  it("shows annoyance, never distress, pain or fear", () => {
    const distress = /\b(hurt|hurts|pain|painful|help me|scared|afraid|terrified|crying|cry|injur\w*|bleed\w*|drown\w*|can't breathe|ambulance)\b/i;
    expect(w.filter((x) => distress.test(x.text)).map((x) => x.id)).toEqual([]);
  });

  it("is never said by a child, a seated or lying person, or a mobility-aid user (they never get wet)", () => {
    for (const x of w) expect(x.speaker).not.toMatch(/child|kid|seated|wheelchair|elderly|baby/i);
  });

  it("the provenance hash matches the text", () => {
    expect(WET_BARKS.provenance.contentHash).toBe(contentHash(w.map((x) => x.text)));
  });
});

describe("pickBark", () => {
  it("is deterministic per key, varied across keys, and never picks a non-matching bark", () => {
    const a = pickBark(ROBOT_BARKS.barks, "badRobot", "taunt", "robot-17:tick-900");
    expect(pickBark(ROBOT_BARKS.barks, "badRobot", "taunt", "robot-17:tick-900")).toEqual(a);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const p = pickBark(ROBOT_BARKS.barks, "badRobot", "taunt", `robot-${i}`)!;
      expect(p.speaker).toBe("badRobot");
      expect(p.context).toBe("taunt");
      seen.add(p.id);
    }
    expect(seen.size).toBeGreaterThan(35);
    expect(pickBark(ROBOT_BARKS.barks, "nobody", "taunt", "x")).toBeNull();
  });
});
