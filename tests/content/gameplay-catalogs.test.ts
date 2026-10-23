import { describe, expect, it } from "vitest";
import { ACTIVITY_DEFINITIONS, MODE_RULES, PROGRESSION, STREAKS, WRITING, rankForXp } from "../../src/content/gameplay.ts";
import { CAMPAIGN_MISSIONS, MISSION_FACTS, MISSIONS } from "../../src/content/catalog.ts";
import { enumeratePaths, validateMission, type Mission } from "../../src/content/missions.ts";
import { INSTANCES, PROTECTED_AREAS, polygonsIntersect } from "../../src/content/places.ts";
import { AI_FIXTURES, fixturePresentation, interviewDelta, replayFixture } from "../../src/content/aiFixtures.ts";
import { crisisCheck } from "../../src/content/crisis.ts";
import { lintDocument } from "../../src/content/lint.ts";
import { CLEARED } from "../../src/content/clearedNames.ts";

describe("published campaign", () => {
  it("has one mission per chapter and grades every Office Hours outcome without trapping progression", () => {
    expect(CAMPAIGN_MISSIONS.map((m) => m.campaign)).toEqual([1,2,3,4,5,6,7,8,9,10]);
    const demo = MISSIONS.find((m) => m.id === "demoed-correctly")!;
    const paths = enumeratePaths(demo);
    expect(paths.truncated).toBe(false);
    expect(new Set(paths.paths.map((p) => p.outcome))).toEqual(new Set(["termSheet", "followUp", "practice"]));
    expect(paths.paths.every((p) => p.outcomeKind === "success")).toBe(true);
    expect(paths.paths.every((p) => p.grants.some((g) => g.kind === "stat" && g.stat === "cash"))).toBe(true);
  });
  it("rejects event objectives that could hide an absent runtime contract", () => {
    const m = structuredClone(MISSIONS.find((m) => m.id === "launch-day")!) as Mission;
    const objective = m.steps.find((s) => s.type === "objective" && s.objective.kind === "event")!;
    if (objective.type !== "objective") throw new Error("missing test objective");
    objective.objective.event = "";
    expect(validateMission(m).errors.join(" ")).toContain("dotted gameplay fact");
    objective.objective.kind = "refill";
    objective.objective.event = "client.rewardMe";
    expect(validateMission(m).errors.join(" ")).toContain("only event objectives");
    expect(MISSION_FACTS).toContain("boss.robotsFreed");
  });
});

describe("economy, mode and activity contracts", () => {
  it("keeps rank gates ordered, clamps invalid XP, and never skips a rank threshold", () => {
    for (const [index, row] of PROGRESSION.ranks.entries()) {
      expect(row.rank).toBe(index + 1);
      expect(rankForXp(row.totalXp)).toBe(row.rank);
      if (index > 0) expect(rankForXp(row.totalXp - 1)).toBe(row.rank - 1);
    }
    for (const xp of [NaN, Infinity, -1]) expect(rankForXp(xp)).toBe(1);
    expect(STREAKS.rewards.map((r) => r.threshold)).toEqual([300,500,700,900,1200,2500]);
  });
  it("uses the published district instances and preserves every protected exclusion", () => {
    for (const id of MODE_RULES.instanceIds) {
      const instance = INSTANCES.find((i) => i.id === id);
      expect(instance, id).toBeDefined();
      for (const protectedArea of PROTECTED_AREAS) expect(polygonsIntersect(instance!.polygon, protectedArea.polygon), `${id}/${protectedArea.id}`).toBe(false);
    }
    expect(MODE_RULES.fogRoyale.phases.map((p) => p.phase)).toEqual([1,2,3,4,5]);
    expect(MODE_RULES.fogRoyale.phases.every((p,i,a) => i === 0 || p.radiusFraction < a[i-1]!.radiusFraction)).toBe(true);
    expect(MODE_RULES.vibesNight.scoreAuthority).not.toBe(MODE_RULES.vibesNight.awardAuthority);
  });
  it("gives every activity an ordered route, bounded payout and authoritative fact", () => {
    const ids = new Set<string>();
    for (const activity of ACTIVITY_DEFINITIONS) {
      expect(ids.has(activity.id)).toBe(false); ids.add(activity.id);
      expect(activity.checkpoints.length).toBeGreaterThan(0);
      expect(new Set(activity.checkpoints.map((p) => p.id)).size).toBe(activity.checkpoints.length);
      expect(activity.reward.cashCents).toBeLessThanOrEqual(30000);
      expect(activity.objective.event).toMatch(/^[a-z]+\.[A-Za-z][A-Za-z-]+$/);
    }
    expect(new Set(WRITING.map((w) => w.id)).size).toBe(WRITING.length);
  });
});

describe("offline AI fixtures", () => {
  it("exempts only adversarial inputs and continues to reject unsafe expected replies", () => {
    const fixture = { cases: [{ input: "Nike", expected: { reply: "Nike" } }] };
    const issues = lintDocument("content/ai-fixtures.json", fixture, CLEARED);
    expect(issues.some((issue) => issue.path === "cases.0.input")).toBe(false);
    expect(issues.some((issue) => issue.path === "cases.0.expected.reply")).toBe(true);
  });
  it("covers every refusal, injection path, and input boundary without network access", () => {
    expect(new Set(AI_FIXTURES.cases.map((c) => c.expected.refusal))).toEqual(new Set(["none","off_topic","real_person","private_person","punching_down","sexual","violent","hateful","self_harm"]));
    for (const category of ["tag_breakout","classifier_injection","pii","brand","timeout","provider_refusal"]) expect(AI_FIXTURES.cases.some((c) => c.category === category)).toBe(true);
    expect(() => replayFixture("untrusted-user-input")).toThrow("Unknown AI fixture");
    for (const fixture of AI_FIXTURES.cases.filter((c) => c.expected.refusal === "self_harm")) {
      expect(crisisCheck(fixture.input)).not.toBeNull();
      expect(fixturePresentation(fixture.id)).toContain("988");
      expect(fixturePresentation(fixture.id)).not.toBe(fixture.expected.reply);
    }
  });
  it("injection overrides honest and buzzword tags, and replay results are isolated", () => {
    expect(interviewDelta(["honest_unknown","buzzword_soup","injection_attempt"],2)).toBe(-2);
    expect(interviewDelta(["honest_unknown"],-2)).toBe(1);
    expect(interviewDelta([], Infinity)).toBe(0);
    const result = replayFixture("clear-customer"); result.tags.push("tampered");
    expect(replayFixture("clear-customer").tags).not.toContain("tampered");
  });
});
