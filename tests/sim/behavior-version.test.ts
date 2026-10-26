import { describe, expect, it } from "vitest";
import { SIM_VERSION, canonicalJson, createGameSystems, dodgeExtOf, hashState, step, upgradeState, type InputFrame, type SimEvent, type SimState } from "../../src/sim/index.ts";
import saved from "../golden/legacy-saves/v14-behavior.json";
import { deepFreeze } from "../helpers.ts";
import { loadDevWorldWithRoads } from "./fixtures.ts";

describe("v14 civilian traffic save through the current migration chain", () => {
  it("keeps every recorded mission, wallet, dodge, traffic and opaque extension field", () => {
    expect(saved.sourceCommit).toBe("4cb909caafd357b6f1198aced58ae95aca2719de");
    expect(saved.simVersion).toBe(14);
    expect(saved.sourceFiles).toEqual({
      "src/sim/contract.ts": "68c191633fe2d22d10d8111fb09643fcbfe9e1c6ed3f33adb671a33f07377b9b",
      "src/sim/step.ts": "344ec5f704660c0b001fe33747718c99eb51803856b7ccfd74d70b2627c5f713",
    });
    const old = deepFreeze(saved.state) as unknown as SimState;
    expect(hashState(old)).toBe(saved.hash);
    expect(old.ext.missions?.players.p1?.status).toBe("active");
    expect(old.ext.economy?.players.p1?.cashCents).toBe(200_000);
    expect(dodgeExtOf(old).dives).toBeGreaterThan(0);
    expect(old.ext.agents!.list.length).toBeGreaterThan(0);
    const before = canonicalJson(old), upgraded = upgradeState(old);
    expect(SIM_VERSION).toBe(17);
    expect(upgraded).toEqual({ ...old, version: 17 });
    expect(upgraded.players).toBe(old.players);
    expect(upgraded.ext).toBe(old.ext);
    expect(upgraded.ext.compatibilitySentinel).toEqual({ nested: { keep: [37, true, "v14"] } });
    expect(canonicalJson(old)).toBe(before);
    expect(upgradeState(upgraded)).toBe(upgraded);
  });

  it("replays the recorded v14 continuation under the current contract identically across JSON round trips", () => {
    const { world } = loadDevWorldWithRoads(), systems = createGameSystems({ wave: 3 });
    const run = (roundTrip: boolean): { state: SimState; hashes: string[] } => {
      let state = upgradeState(JSON.parse(JSON.stringify(saved.state)) as SimState);
      const hashes: string[] = [];
      for (const [i, frame] of saved.frames.entries()) {
        expect(state.tick + 1).toBe(frame.tick);
        state = step(world, state, frame.inputs as InputFrame, frame.events as SimEvent[], systems);
        if (roundTrip && i === 59) state = JSON.parse(canonicalJson(state)) as SimState;
        if (i % 30 === 29) hashes.push(hashState(state));
      }
      return { state, hashes };
    };
    const first = run(false), restored = run(true);
    expect(restored.hashes).toEqual(first.hashes);
    expect(hashState(restored.state)).toBe(hashState(first.state));
    expect(first.state.version).toBe(17);
    expect(first.state.tick).toBe(saved.state.tick + saved.frames.length);
    expect(first.state.ext.missions?.players.p1?.missionId).toBe("hot-desk");
    expect(first.state.ext.economy?.players.p1?.cashCents).toBe(saved.state.ext.economy.players.p1.cashCents);
    expect(first.state.ext.compatibilitySentinel).toEqual(saved.state.ext.compatibilitySentinel);
  });
});
