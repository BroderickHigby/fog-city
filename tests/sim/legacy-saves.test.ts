// Saves written by the legacy sims that the v7 contract absorbed, recorded by running each
// branch's own code (scripts/golden/legacy-saves.ts): qa/sim (v4: gravity and surfaces),
// feature/dodge (also stamped v4: the dodge) and their combination (v5). Each must load
// through upgradeState with every saved field intact, and keep stepping with finite state.
import { describe, expect, it } from "vitest";
import {
  Action, SIM_VERSION, canonicalJson, createGameSystems, hashState, step, upgradeState,
  type InputFrame, type SimState,
} from "../../src/sim/index.ts";
import qaSim from "../golden/legacy-saves/v4-qa-sim.json";
import dodge from "../golden/legacy-saves/v4-feature-dodge.json";
import combined from "../golden/legacy-saves/v5-combined.json";
import { deepFreeze } from "../helpers.ts";
import { loadDevWorldWithRoads, LONG_RUN_MS } from "./fixtures.ts";

const SAVES = [
  { name: "qa/sim v4", save: qaSim, version: 4 },
  { name: "feature/dodge v4", save: dodge, version: 4 },
  { name: "combined v5", save: combined, version: 5 },
] as const;

describe("legacy saves from the absorbed branches", () => {
  const { world } = loadDevWorldWithRoads();
  for (const { name, save, version } of SAVES) {
    it(`loads ${name} with every saved field kept and only missing fields filled`, () => {
      const old = deepFreeze(save.state) as unknown as SimState;
      expect(old.version).toBe(version);
      expect(save.simVersion).toBe(version);
      expect(hashState(old)).toBe(save.hash);
      const upgraded = upgradeState(old);
      expect(upgraded.version).toBe(SIM_VERSION);
      expect(old.version).toBe(version);
      expect(hashState(old)).toBe(save.hash);
      // Everything the old sim wrote survives exactly (version aside).
      expect(upgraded).toMatchObject({ ...old, version: SIM_VERSION });
      for (const id of Object.keys(old.players).sort()) {
        const before = old.players[id]!, after = upgraded.players[id]!;
        expect(after.car.nearMisses).toBe(before.car.nearMisses ?? 0);
        if (before.foot) {
          expect(after.foot).toEqual({ ...before.foot, vy: before.foot.vy, grounded: before.foot.grounded, dodge: before.foot.dodge ?? null });
        } else expect(after.foot).toBeNull();
      }
      expect(old.players.p1!.mode).toBe("foot");
      expect(upgraded.ext.agents!.list).toHaveLength(old.ext.agents!.list.length);
      for (const [i, agent] of upgraded.ext.agents!.list.entries()) {
        expect(agent).toEqual({ ...old.ext.agents!.list[i]!, dodge: old.ext.agents!.list[i]!.dodge ?? null });
      }
      expect(upgradeState(upgraded)).toBe(upgraded);
      expect(upgradeState(JSON.parse(JSON.stringify(old)))).toEqual(upgraded);
    });

    it(`keeps stepping ${name} through the composed game systems`, () => {
      const systems = createGameSystems();
      let state = upgradeState(deepFreeze(save.state) as unknown as SimState);
      // These saves end with the walker pressed against an obstacle: turn it round, then walk.
      const saved = state.players.p1!;
      state = { ...state, players: { ...state.players, p1: { ...saved, foot: { ...saved.foot!, heading: saved.foot!.heading + Math.PI } } } };
      const start = { ...state.players.p1!.foot! };
      for (let t = 0; t < 240; t++) {
        const inputs: InputFrame = {
          p1: { throttle: 1, steer: 0, brake: t < 120 ? 0 : 1, actions: t === 200 ? Action.fire : 0 },
          p2: { throttle: 0.5, steer: 0.2, brake: 0, actions: 0 },
        };
        state = step(world, state, inputs, [], systems);
        expect(() => canonicalJson(state)).not.toThrow();
      }
      const foot = state.players.p1!.foot!;
      expect(state.players.p1!.mode).toBe("foot");
      expect(Math.abs(foot.x - start.x) + Math.abs(foot.z - start.z)).toBeGreaterThan(2);
      expect(typeof foot.grounded).toBe("boolean");
      expect(state.tick).toBe(save.state.tick + 240);
    }, LONG_RUN_MS);
  }
});
