// The Ambient Director's city-life pacing (content/city-life.json): the idle window comes from
// the data, picks follow the weights, and a mission's travel leg (a goto step) leaves room for a
// street incident while any other active step holds the director off.
import { describe, expect, it } from "vitest";
import { createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { CITY_LIFE, cardWeight } from "../../../src/content/cityLife.ts";
import type { GameplayContext, MissionState } from "../../../src/sim/player/types.ts";

const context = (extra: Partial<GameplayContext> = {}): GameplayContext => ({ ...DEFAULT_CATALOG, wave: 3, bodies: [{ id: "p", x: 0, y: 0, z: 0, speed: 0, mode: "foot" }], commands: [], facts: [], actors: [], observations: [], day: 1, month: 1, ...extra });
const hotDesk = DEFAULT_CATALOG.missions.find((m) => m.id === "hot-desk")!;
const onStep = (stepId: string): MissionState => ({ ...createMissions(), players: { p: { missionId: "hot-desk", stepId, status: "active" } as never } });

describe("city-life director pacing", () => {
  it("first incidents fall inside the data's idle window, spread across it", () => {
    const [lo, hi] = CITY_LIFE.director.idleWindowS;
    const due = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const t = stepActivities(createActivities(), context(), 0, createMissions(), seed).players.p!.nextDirectorTick;
      expect(t).toBeGreaterThanOrEqual(lo * 60);
      expect(t).toBeLessThanOrEqual(hi * 60);
      due.add(t);
    }
    expect(due.size).toBeGreaterThan(30);
  });

  it("picks the weighted street incidents more often than an unweighted card", () => {
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 400; seed++) {
      const first = stepActivities(createActivities(), context(), 0, createMissions(), seed);
      const staged = stepActivities(first, context(), first.players.p!.nextDirectorTick, createMissions(), seed).events.find((e) => e.kind === "director.stage");
      if (staged) counts.set(staged.targetId, (counts.get(staged.targetId) ?? 0) + 1);
    }
    const weighted = ["crosswalk-squatter", "robotaxi-standoff", "malfunction-spree"].reduce((n, id) => n + (counts.get(id) ?? 0), 0);
    expect(cardWeight("crosswalk-squatter")).toBeGreaterThan(1);
    // Three cards at weight 3 among ~80 total weight: about 11% of picks, far above 3/63 unweighted.
    expect(weighted / 400).toBeGreaterThan(0.06);
  });

  it("stages during a mission's travel leg, never during its other active steps", () => {
    const go = hotDesk.steps.find((s) => s.type === "goto")!, objective = hotDesk.steps.find((s) => s.type === "objective")!;
    const staged = (stepId: string) => {
      const first = stepActivities(createActivities(), context(), 0, onStep(stepId), 3);
      let state = first;
      for (let tick = 60; tick <= 6000; tick += 60) {
        state = stepActivities(state, context(), tick, onStep(stepId), 3);
        if (state.events.some((e) => e.kind === "director.stage")) return true;
      }
      return false;
    };
    expect(staged(go.id)).toBe(true);
    expect(staged(objective.id)).toBe(false);
  });
});
