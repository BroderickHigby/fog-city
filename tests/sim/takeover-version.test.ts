import { describe, expect, it } from "vitest";
import { SIM_VERSION, canonicalJson, createGameSystems, hashState, step, upgradeState, type InputFrame, type SimEvent, type SimState } from "../../src/sim/index.ts";
import saved from "../golden/legacy-saves/v15-pre-takeover.json";
import { deepFreeze } from "../helpers.ts";
import { loadDevWorldWithRoads } from "./fixtures.ts";

describe("actual v15 save migration to robotaxi takeover v16", () => {
  it("keeps every field of a save recorded by the previous release's own code", () => {
    expect(saved.sourceCommit).toBe("fb5d8981b600d679c796e0b1218fb78de0f0474d");
    expect(saved.simVersion).toBe(15);
    expect(saved.sourceFiles).toEqual({
      "src/sim/contract.ts": "69129bf3ca3a11eb7bee797ca92d2532e92395db723e155476b941321c1a6de8",
      "src/sim/step.ts": "b561f76afd58d4eb2c6d49f3d1f256e861dd2448ffcb9b3da6e5fc6fdb234df0",
    });
    const old = deepFreeze(saved.state) as unknown as SimState;
    const before = canonicalJson(old);
    expect(hashState(old)).toBe(saved.hash);
    expect(old.players.p1!.mode).toBe("foot");
    expect(old.ext.agents!.list.length).toBeGreaterThan(0);
    expect(old.ext.missions?.players.p1?.status).toBe("active");
    const current = upgradeState(old);
    expect(SIM_VERSION).toBe(16);
    expect(current).toEqual({ ...old, version: 16 });
    expect(current.players).toBe(old.players);
    expect(current.ext).toBe(old.ext);
    expect(current.ext.compatibilitySentinel).toEqual({ nested: { keep: [37, true, "v15"] } });
    expect(canonicalJson(old)).toBe(before);
    expect(upgradeState(current)).toBe(current);
  });

  it("continues the old recorded input log identically after a JSON save and restore", () => {
    const { world } = loadDevWorldWithRoads(), systems = createGameSystems({ wave: 3 });
    const run = (restore: boolean): { state: SimState; hashes: string[] } => {
      let state = upgradeState(JSON.parse(JSON.stringify(saved.state)) as SimState);
      const hashes: string[] = [];
      for (const [i, frame] of saved.frames.entries()) {
        expect(state.tick + 1).toBe(frame.tick);
        state = step(world, state, frame.inputs as InputFrame, frame.events as SimEvent[], systems);
        if (restore && i === 59) state = JSON.parse(canonicalJson(state)) as SimState;
        if (i % 30 === 29) hashes.push(hashState(state));
      }
      return { state, hashes };
    };
    const direct = run(false), restored = run(true);
    expect(restored.hashes).toEqual(direct.hashes);
    expect(hashState(restored.state)).toBe(hashState(direct.state));
    expect(direct.state.tick).toBe(saved.state.tick + saved.frames.length);
    expect(direct.state.version).toBe(16);
    expect(direct.state.ext.missions?.players.p1?.missionId).toBe("hot-desk");
    expect(direct.state.ext.economy?.players.p1?.cashCents).toBe(saved.state.ext.economy.players.p1.cashCents);
    expect(direct.state.ext.compatibilitySentinel).toEqual(saved.state.ext.compatibilitySentinel);
  });
});
