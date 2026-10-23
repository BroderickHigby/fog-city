// Goal tables for the bad-robot brain: one per bad archetype, every state, the design's rules.
import { describe, expect, it } from "vitest";
import { BOT_TELLS } from "../../src/content/botTells.ts";
import { BRAIN_STATES, ROBOT_GOALS, checkRobotGoals, goalsInWave, type RobotGoalsFile } from "../../src/content/robotGoals.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("content/robot-goals.json", () => {
  it("is consistent with bot-tells.json and the design", () => {
    expect(checkRobotGoals()).toEqual([]);
  });

  it("has a table for each of the (at least 6) bad archetypes, with all five states", () => {
    const bad = BOT_TELLS.archetypes.filter((a) => a.kind === "bad").map((a) => a.id).sort();
    expect(bad.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(ROBOT_GOALS.archetypes).sort()).toEqual(bad);
    for (const t of Object.values(ROBOT_GOALS.archetypes)) for (const s of BRAIN_STATES) expect(t.states[s].length).toBeGreaterThan(0);
  });

  it("carries the design's numbers: sight 30 m in a 100 degree cone, ping 30 m, scan alert 10 m, flee at rust 0.6, two in melee", () => {
    expect(ROBOT_GOALS.knowledge).toMatchObject({ sightRangeM: 30, sightConeDeg: 100, pingRadiusM: 30, scanAlertRadiusM: 10, broadcastM: 60, hearSprayM: 20, hearHornM: 40, unobservedBeyondM: 20 });
    expect(ROBOT_GOALS.rules).toMatchObject({ waryS: 10, fleeAtRust: 0.6, maxMeleeOnPlayer: 2, attackPlayerWithinM: 15, goodRobotWithinM: 10, fogFollowS: 8 });
  });

  it("no goal or attack ever targets a person", () => {
    const text = JSON.stringify(ROBOT_GOALS.archetypes) + JSON.stringify(Object.values(ROBOT_GOALS.attacks).map((a) => a.targets));
    expect(text).not.toMatch(/person|people|pedestrian|child|animal/i);
  });

  it("wave 2 robots can fight with the wave-2 attacks; wave-3 attacks are inert until then", () => {
    for (const id of Object.keys(ROBOT_GOALS.archetypes)) {
      const w2 = goalsInWave(id, "attack", 2);
      expect(w2.every((g) => g.attack === undefined || ROBOT_GOALS.attacks[g.attack]!.wave <= 2), id).toBe(true);
    }
    expect(goalsInWave("prowler", "attack", 2).some((g) => g.attack === "phoneHack")).toBe(false);
    expect(goalsInWave("prowler", "attack", 3).some((g) => g.attack === "phoneHack")).toBe(true);
    expect(goalsInWave("rogueTaxi", "attack", 3).some((g) => g.attack === "boxIn")).toBe(true);
  });

  it("every Footman and Trundle archetype has a sabotage while disguised", () => {
    for (const [id, t] of Object.entries(ROBOT_GOALS.archetypes)) expect(t.states.disguised.some((g) => g.goal === "sabotage"), id).toBe(true);
  });
});

describe("checkRobotGoals catches broken tables", () => {
  const broken = (mutate: (g: RobotGoalsFile) => void): string => {
    const g = clone(ROBOT_GOALS);
    mutate(g);
    return checkRobotGoals(g).join("\n");
  };
  it("a missing table", () => expect(broken((g) => delete g.archetypes.snatcher)).toContain("archetype snatcher: no goal table"));
  it("sabotage while wary", () =>
    expect(broken((g) => g.archetypes.snatcher!.states.wary.push({ goal: "sabotage", sabotage: "snatchGroceries", when: "unobserved", target: "nearestGoodRobot", weight: 1 }))).toContain("sabotage only while disguised"));
  it("sabotage in plain sight", () => expect(broken((g) => (g.archetypes.snatcher!.states.disguised[1]!.when = "always"))).toContain("only when unobserved"));
  it("an attack the model cannot make", () =>
    expect(broken((g) => g.archetypes.harvester!.states.attack.push({ goal: "attack", attack: "shove", when: "always", target: "player", weight: 1 }))).toContain("cannot use shove"));
  it("a robot attack aimed at the player", () =>
    expect(broken((g) => (g.archetypes.updatePusher!.states.attack[0]!.target = "player"))).toContain("cannot target player"));
  it("a wave-3 attack without fromWave", () => expect(broken((g) => delete g.archetypes.prowler!.states.attack[1]!.fromWave)).toContain("mark the goal fromWave 3"));
  it("a wary robot that does not hide a tell", () =>
    expect(broken((g) => (g.archetypes.snatcher!.states.wary = g.archetypes.snatcher!.states.wary.filter((x) => x.goal !== "hideTell")))).toContain("hides one tell"));
  it("a ping that alerts", () => expect(broken((g) => g.transitions.push({ from: ["disguised"], to: "alerted", when: "pinged" }))).toContain("never alerted"));
  it("an unreadable wind-up", () => expect(broken((g) => (g.attacks.shove!.windupS = 0.2))).toContain("not readable"));
});
