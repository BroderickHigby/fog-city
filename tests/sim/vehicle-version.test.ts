import { describe, expect, it } from "vitest";
import { SIM_VERSION, canonicalJson, createGameSystems, hashState, step, upgradeState, type InputFrame, type SimEvent, type SimState } from "../../src/sim/index.ts";
import saved from "../golden/legacy-saves/v17-pre-vehicle-contacts.json";
import { deepFreeze } from "../helpers.ts";
import { loadDevWorldWithRoads } from "./fixtures.ts";

const sourceCommit = "a95ca99bec243c10dd9983776ec83c5e6231bfe1";

describe("actual v17 save through the solid-vehicle migration", () => {
  it("keeps every field of the previous release's own save without mutation", () => {
    expect(saved.sourceCommit).toBe(sourceCommit);
    expect(saved.simVersion).toBe(17);
    expect(saved.sourceFiles).toEqual({
      "src/sim/contract.ts": "96db59adda10a0181d4d28a64c1eeefc669a0cb6c3f298e2cdfcefabebc1160e",
      "src/sim/step.ts": "ce8f16d192a7403b4b66c7676eeafb741b6c626fd165b00efe9d42762e285e6a",
      "src/sim/car.ts": "3470b68468865c9aa61cf3d39f44745b160ac771ee5d3a531a67addaa6dac00b",
      "src/sim/agents.ts": "04bb01480a66e9dce50369ce835c825d7bdc86fca75b93b31eb282557cf34caa",
      "src/sim/impacts.ts": "4e949c8cb68a80d6929e129f4a310cdd07c11d965a0f7b693c0b03b897100a6d",
      "src/sim/manual-taxi.ts": "029b37a46cbc65c61768777d0b54a0fd28a6f90b800b8e819b4f07b7462116f1",
    });
    const old = deepFreeze(saved.state) as unknown as SimState, before = canonicalJson(old);
    expect(old.version).toBe(17);
    expect(hashState(old)).toBe(saved.hash);
    expect(old.players.p1!.mode).toBe("foot");
    expect(old.ext.agents!.list.length).toBeGreaterThan(0);
    expect(old.ext.missions?.players.p1?.status).toBe("active");
    const upgraded = upgradeState(old);
    expect(SIM_VERSION).toBe(20);
    expect(upgraded).toEqual({ ...old, version: SIM_VERSION });
    expect(upgraded.players).toBe(old.players);
    expect(upgraded.ext).toBe(old.ext);
    expect(upgraded.ext.compatibilitySentinel).toEqual({ nested: { keep: [37, true, "v17"] } });
    expect(canonicalJson(old)).toBe(before);
    expect(upgradeState(upgraded)).toBe(upgraded);
  });

  it("retains the original v17 continuation hashes when the save is replayed without upgrading", () => {
    const { world } = loadDevWorldWithRoads(), systems = createGameSystems({ wave: 3 });
    let state = JSON.parse(JSON.stringify(saved.state)) as SimState;
    const hashes: string[] = [];
    for (const [i, frame] of saved.frames.entries()) {
      state = step(world, state, frame.inputs as InputFrame, frame.events as SimEvent[], systems);
      if (i % 30 === 29) hashes.push(hashState(state));
    }
    expect(state.version).toBe(17);
    expect(hashes).toEqual(saved.originalHashesEvery30);
  });

  it("continues the recorded ordinary controls identically after a current save and JSON restore", () => {
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
    expect(direct.state.version).toBe(SIM_VERSION);
    expect(direct.state.ext.missions?.players.p1?.missionId).toBe("hot-desk");
    expect(direct.state.ext.economy?.players.p1?.cashCents).toBe(saved.state.ext.economy.players.p1.cashCents);
    expect(direct.state.ext.compatibilitySentinel).toEqual(saved.state.ext.compatibilitySentinel);
  });
});
