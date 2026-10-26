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
  it("v16 first incidents retain the data's idle window, spread across it", () => {
    const [lo, hi] = CITY_LIFE.director.idleWindowS;
    const due = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const t = stepActivities(createActivities(), context(), 0, createMissions(), seed, 16).players.p!.nextDirectorTick;
      expect(t).toBeGreaterThanOrEqual(lo * 60);
      expect(t).toBeLessThanOrEqual(hi * 60);
      due.add(t);
    }
    expect(due.size).toBeGreaterThan(30);
  });

  it("v17 first incidents arrive in 15–20 s using the same per-player RNG draw", () => {
    const due = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const legacy = stepActivities(createActivities(), context(), 100, createMissions(), seed, 16).players.p!;
      const first = stepActivities(createActivities(), context(), 100, createMissions(), seed, 17).players.p!;
      expect(first.nextDirectorTick - 100).toBeGreaterThanOrEqual(15 * 60);
      expect(first.nextDirectorTick - 100).toBeLessThanOrEqual(20 * 60);
      expect(first.directorRng).toEqual(legacy.directorRng);
      due.add(first.nextDirectorTick);
    }
    expect(due.size).toBeGreaterThan(30);
  });

  it("v17 retains later authored cadence and an existing saved schedule", () => {
    const ctx = context({ directorCards: [{ ...DEFAULT_CATALOG.directorCards[0]!, protectedAreas: true }] });
    const first = stepActivities(createActivities(), ctx, 0, createMissions(), 7, 17);
    const due = first.players.p!.nextDirectorTick;
    const staged = stepActivities(first, ctx, due, createMissions(), 7, 17);
    expect(staged.events.some(e => e.kind === "director.stage")).toBe(true);
    expect(staged.players.p!.nextDirectorTick - due).toBeGreaterThanOrEqual(CITY_LIFE.director.idleWindowS[0] * 60);
    expect(staged.players.p!.nextDirectorTick - due).toBeLessThanOrEqual(CITY_LIFE.director.idleWindowS[1] * 60);

    const saved = stepActivities(createActivities(), ctx, 0, createMissions(), 7, 16);
    const restored = stepActivities(saved, ctx, 1, createMissions(), 7, 17);
    expect(restored.players.p).toEqual(saved.players.p);
    expect(saved.players.p!.nextDirectorTick).toBeGreaterThan(20 * 60);
  });

  it("v17 respects known time and player-mode requirements while v16 retains its picks", () => {
    const card = { ...DEFAULT_CATALOG.directorCards[0]!, id: "night-drive", protectedAreas: true, when: { time: "night" as const, playerState: "inCar" as const } };
    const walk = { ...card, id: "day-walk", when: { time: "day" as const, playerState: "onFoot" as const } };
    const picked = (version: number, hour: number | undefined, mode: "foot" | "vehicle") => {
      const ctx = context({ directorCards: [card, walk], hour, bodies: [{ id: "p", x: 0, y: 0, z: 0, speed: 0, mode }] });
      const first = stepActivities(createActivities(), ctx, 0, createMissions(), 7, version);
      return stepActivities(first, ctx, first.players.p!.nextDirectorTick, createMissions(), 7, version).events.find(e => e.kind === "director.stage")?.targetId;
    };
    expect(picked(17, 12, "foot")).toBe("day-walk");
    expect(picked(17, 12, "vehicle")).toBeUndefined();
    expect(picked(17, 22, "foot")).toBeUndefined();
    expect(picked(17, 22, "vehicle")).toBe("night-drive");
    expect(picked(17, 19, "vehicle")).toBe("night-drive");
    expect(picked(17, 6, "vehicle")).toBeUndefined();
    expect(picked(17, undefined, "vehicle")).toBe("night-drive");
    expect(picked(16, 12, "foot")).toBeDefined();
    expect(picked(16, 12, "foot")).toEqual(picked(16, 22, "vehicle"));
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
    const staged = (stepId: string, version: number) => {
      const first = stepActivities(createActivities(), context(), 0, onStep(stepId), 3, version);
      let state = first;
      for (let tick = 60; tick <= 6000; tick += 60) {
        state = stepActivities(state, context(), tick, onStep(stepId), 3, version);
        if (state.events.some((e) => e.kind === "director.stage")) return true;
      }
      return false;
    };
    for (const version of [16, 17]) {
      expect(staged(go.id, version)).toBe(true);
      expect(staged(objective.id, version)).toBe(false);
    }
  });
});
