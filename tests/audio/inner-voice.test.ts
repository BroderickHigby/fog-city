// The player's inner voice: lines from the mission data, said at the right moments, with
// rotation and cooldowns so they don't repeat too often.
import { describe, expect, it } from "vitest";
import { MISSIONS } from "../../src/content/catalog.ts";
import { INNER_GAP_S, INNER_TEMPLATES, InnerVoice, innerVoiceLines, spokenPlace, type InnerObservation } from "../../src/audio/inner-voice.ts";
import { missionVoiceLines } from "../../src/audio/voice-lines.ts";
import { toLocal } from "../../src/geo/project.ts";

const at = (stepId: string, visits: number, extra: Partial<InnerObservation> = {}): InnerObservation =>
  ({ missionId: "hot-desk", stepId, status: "active", visits, player: null, water: 1, badScanTick: null, ...extra });

describe("inner voice lines", () => {
  const lines = innerVoiceLines(MISSIONS);

  it("are a finite bank with unique ids, separate from every mission line", () => {
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
    const mission = new Set(missionVoiceLines(MISSIONS).map((l) => l.id));
    expect(lines.some((l) => mission.has(l.id))).toBe(false);
    expect(lines.every((l) => l.speaker === "player" && l.kind === "inner")).toBe(true);
    expect(lines.every((l) => !l.text.includes("{"))).toBe(true);
    // Small enough to voice in one paid-tier run.
    expect(lines.reduce((n, l) => n + l.text.length, 0)).toBeLessThan(20_000);
  });

  it("names every place a mission sends the player, the way a person says it", () => {
    expect(spokenPlace("The Ferry Building plaza")).toBe("the Ferry Building plaza");
    expect(spokenPlace("Bay Bridge approach deck")).toBe("the Bay Bridge approach deck");
    expect(spokenPlace("Moat Labs HQ, outside on the SoMa curb")).toBe("Moat Labs HQ");
    expect(spokenPlace("Hyde St near Union St")).toBe("Hyde Street near Union Street");
    expect(lines.find((l) => l.id === "inner.goto.the-fidi-coworking-desk.0")?.text).toBe("Okay, I gotta get to the FiDi coworking desk.");
    expect(lines.find((l) => l.id === "inner.start.the-ferry-building-plaza.1")?.text).toBe("Gotta swing by the Ferry Building plaza.");
  });
});

describe("inner voice timing", () => {
  it("says where to go when a goto step starts, and the start place when a mission opens", () => {
    const v = new InnerVoice(MISSIONS);
    expect(v.observe(at("arrive", 1), 0)?.id).toBe("inner.start.the-ferry-building-plaza.0");
    expect(v.observe(at("arrive", 1), 1)).toBeNull(); // once per step entry
    const go = v.observe(at("to-desk", 6), 100);
    expect(go?.text).toMatch(/the FiDi coworking desk/i);
    expect(go?.id).toMatch(/^inner\.gotoRush\./); // a 300 s timer: the rushed variant
  });

  it("talks through objectives by kind", () => {
    const v = new InnerVoice(MISSIONS);
    expect(v.observe(at("watch", 3), 0)?.id).toMatch(/^inner\.watch\./);
    expect(v.observe(at("melt", 4), 100)?.id).toMatch(/^inner\.melt\./);
    expect(v.observe(at("cone", 9), 200)?.id).toMatch(/^inner\.cone\./);
  });

  it("needs water when the tank runs low, once until refilled, and rotates its variants", () => {
    const v = new InnerVoice(MISSIONS);
    v.observe(at("watch", 3), 0);
    const said: string[] = [];
    let t = 100;
    for (let i = 0; i < 3; i++) {
      said.push(v.observe(at("watch", 3, { water: 0.05 }), t)!.id);
      expect(v.observe(at("watch", 3, { water: 0.04 }), t + 1)).toBeNull(); // still low: quiet
      v.observe(at("watch", 3, { water: 0.9 }), t + 2); // refilled
      t += 60;
    }
    expect(said).toEqual(["inner.water.0", "inner.water.1", "inner.water.2"]);
  });

  it("respects each situation's cooldown and the gap between lines", () => {
    const v = new InnerVoice(MISSIONS);
    v.observe(at("watch", 3), 0);
    expect(v.observe(at("watch", 3, { water: 0.05 }), INNER_GAP_S - 1)).toBeNull(); // too soon after "watch"
    v.observe(at("watch", 3, { water: 0.9 }), INNER_GAP_S);
    expect(v.observe(at("watch", 3, { water: 0.05 }), INNER_GAP_S + 1)?.id).toBe("inner.water.0");
    v.observe(at("watch", 3, { water: 0.9 }), INNER_GAP_S + 2);
    expect(v.observe(at("watch", 3, { water: 0.05 }), INNER_GAP_S + 20)).toBeNull(); // water cooldown (45 s)
  });

  it("calls out a fresh bad scan, not the same one twice", () => {
    const v = new InnerVoice(MISSIONS);
    v.observe(at("watch", 3), 0);
    expect(v.observe(at("watch", 3, { badScanTick: 500 }), 10)?.id).toMatch(/^inner\.sketchy\./);
    expect(v.observe(at("watch", 3, { badScanTick: 500 }), 50)).toBeNull();
    expect(v.observe(at("watch", 3, { badScanTick: 900 }), 50)?.id).toMatch(/^inner\.sketchy\./);
  });

  it("celebrates a win and shrugs at a retry, but not an old win on load", () => {
    const loaded = new InnerVoice(MISSIONS);
    expect(loaded.observe(at("moved-in", 11, { status: "complete" }), 0)).toBeNull();
    const v = new InnerVoice(MISSIONS);
    v.observe(at("cone", 9), 0);
    expect(v.observe(at("moved-in", 10, { status: "complete" }), 1)?.id).toMatch(/^inner\.win\./);
    const r = new InnerVoice(MISSIONS);
    r.observe(at("to-desk", 6), 0);
    expect(r.observe(at("late", 7, { status: "retry" }), 1)?.id).toMatch(/^inner\.retry\./);
  });

  it("reminds the player of a far destination now and then, never when close", () => {
    const v = new InnerVoice(MISSIONS);
    const desk = toLocal(37.7905, -122.4015);
    v.observe(at("to-desk", 6, { player: { x: 0, z: 0 } }), 0);
    expect(v.observe(at("to-desk", 6, { player: { x: 0, z: 0 } }), 60)).toBeNull();
    expect(v.observe(at("to-desk", 6, { player: { x: 2000, z: 2000 } }), 100)?.id).toMatch(/^inner\.reminder\./);
    expect(v.observe(at("to-desk", 6, { player: { x: 2000, z: 2000 } }), 120)).toBeNull(); // cooldown
    expect(v.observe(at("to-desk", 6, { player: desk }), 300)).toBeNull();
    expect(Object.keys(INNER_TEMPLATES)).toContain("reminder");
  });
});
