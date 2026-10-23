// Ambient bodies the agents runtime claims near a player leave it with its fidelity range: an
// ordinary one retires (runtime.ts, the despawn tier), a significant one with no proposal goes
// back to ambient stepping (agents.ts releaseClaimed). Either way none stands frozen forever or
// piles up until the runtime's actor budget throws.
import { describe, expect, it } from "vitest";
import {
  DESPAWN_RANGE_M, MAX_AGENTS_TOTAL, POP_INTERVAL, createGameSystems, createInitialState, makeCar,
  meshGroundHeight, step, type AgentState, type SimState, type World,
} from "../../../src/sim/index.ts";
import { ACTIVE_FIDELITY_M } from "../../../src/sim/agents/fidelity.ts";
import { MAX_RUNTIME_ACTORS, agentsRuntimeOf } from "../../../src/sim/agents/runtime.ts";
import { createAgentsSystem } from "../../../src/sim/agents/systems.ts";
import { allocateActorIds } from "../../../src/sim/identity.ts";
import { gridCity, SF_RUN_MS } from "../fixtures.ts";
import { buildWorldWithRoads, loadWorldFiles, worldExists } from "../../helpers.ts";

const claimed = (s: SimState): AgentState[] => (s.ext.agents?.list ?? []).filter((a) => a.runtimeLegacy === true && a.runtimeId !== undefined);
const legacy = (s: SimState): AgentState[] => (s.ext.agents?.list ?? []).filter((a) => a.runtimeId === undefined);
function moveTo(world: World, s: SimState, x: number, z: number): SimState {
  const p = s.players.p!;
  return { ...s, players: { p: { ...p, car: makeCar(x, z, 0, meshGroundHeight(world, x, z)) } } };
}
function run(world: World, s: SimState, ticks: number, systems: Parameters<typeof step>[4]): SimState {
  for (let t = 0; t < ticks; t++) s = step(world, s, {}, [], systems);
  return s;
}
const nearestPlayer = (s: SimState, a: { x: number; z: number }): number => {
  const c = s.players.p!.car;
  return Math.sqrt((a.x - c.x) * (a.x - c.x) + (a.z - c.z) * (a.z - c.z));
};

describe("claimed ambient bodies leave the runtime with fidelity", () => {
  const world = gridCity();
  const systems = [createAgentsSystem(() => ({ services: false }), allocateActorIds)];

  it("ordinary ones retire, significant ones walk on under ambient stepping, and all despawn far away", () => {
    let s = run(world, createInitialState(world, 5, ["p"], { x: 150, z: 150, heading: 0 }), 90, systems);
    const held = claimed(s);
    expect(held.length).toBeGreaterThan(5);
    const heldIds = new Set(held.map((a) => a.id));
    // Half of them significant (as wet or rusted bodies are): the runtime keeps their records
    // out of fidelity, and with no proposal their bodies go back to ambient stepping.
    const significant = new Set(held.filter((_, i) => i % 2 === 0).map((a) => a.id));
    const runtime = agentsRuntimeOf(s)!;
    const actors = { ...runtime.actors };
    for (const id of significant) actors[`agent:${id}`] = { ...actors[`agent:${id}`]!, significant: true };
    s = { ...s, ext: { ...s.ext, robots: { ...runtime, actors } as unknown as SimState["ext"]["robots"] } };

    // Out of fidelity (more than ACTIVE_FIDELITY_M from every one of them), inside the despawn range.
    s = moveTo(world, s, 150, -480);
    for (const a of held) expect(nearestPlayer(s, a)).toBeGreaterThan(ACTIVE_FIDELITY_M);
    s = run(world, s, 2, systems);
    expect(claimed(s)).toEqual([]);
    const present = (s.ext.agents?.list ?? []).filter((a) => heldIds.has(a.id));
    // Ordinary bodies retire with their runtime record; none is left frozen.
    expect(present.filter((a) => !significant.has(a.id))).toEqual([]);
    const before = new Map(present.map((a) => [a.id, a]));
    expect(before.size).toBeGreaterThan(significant.size / 2);
    for (const a of before.values()) expect(a.runtimeId === undefined && a.radius === undefined && a.protected === undefined && a.posture === undefined).toBe(true);
    s = run(world, s, 120, systems);
    expect(claimed(s)).toEqual([]);
    const moved = [...before.values()].filter((a) => {
      const now = legacy(s).find((b) => b.id === a.id);
      return now !== undefined && (now.x !== a.x || now.z !== a.z);
    });
    // Ambient stepping moves them again (a few may be waiting at a corner).
    expect(moved.length).toBeGreaterThan(before.size / 2);

    // Two kilometres away: past the despawn range, the next population tick removes every one.
    s = moveTo(world, s, 2150, 150);
    s = run(world, s, POP_INTERVAL + 2, systems);
    const left = (s.ext.agents?.list ?? []).filter((a) => heldIds.has(a.id));
    expect(left).toEqual([]);
    for (const a of s.ext.agents?.list ?? []) expect(nearestPlayer(s, a)).toBeLessThanOrEqual(DESPAWN_RANGE_M);
  });

  it("keeps bodies and runtime actors bounded across many trips in and out", () => {
    let s = createInitialState(world, 9, ["p"], { x: 150, z: 150, heading: 0 });
    let most = 0;
    for (let trip = 0; trip < 12; trip++) {
      s = moveTo(world, s, 150, 150);
      s = run(world, s, 45, systems);
      s = moveTo(world, s, trip % 2 ? 150 : 2150, trip % 2 ? -480 : 150);
      s = run(world, s, POP_INTERVAL + 2, systems);
      expect(claimed(s)).toEqual([]);
      const actors = Object.keys(agentsRuntimeOf(s)?.actors ?? {}).length;
      most = Math.max(most, actors, s.ext.agents!.list.length);
    }
    expect(s.ext.agents!.list.length).toBeLessThanOrEqual(MAX_AGENTS_TOTAL);
    // The runtime only tracks bodies that exist (plus significant ones), never the whole history.
    expect(most).toBeLessThan(MAX_RUNTIME_ACTORS / 8);
  });
});

describe.skipIf(!worldExists("sf"))("claimed ambient bodies on the real city", () => {
  it("a player more than 2 km across SF leaves no frozen pedestrians behind", () => {
    const files = loadWorldFiles("sf");
    const sf = buildWorldWithRoads(files.tiles, files.roads, files.boundary, files);
    const systems = createGameSystems({ protectedArea: () => false });
    const spawn = files.manifest.spawn as { x: number; z: number; heading: number };
    let s = run(sf, createInitialState(sf, 7, ["p"], spawn), 60, systems);
    const held = claimed(s);
    expect(held.length).toBeGreaterThan(20);
    const heldIds = new Set(held.map((a) => a.id));
    // The Mission, over 4 km from the Ferry Building spawn.
    s = moveTo(sf, s, -2490, 3390);
    expect(Math.sqrt((spawn.x + 2490) * (spawn.x + 2490) + (spawn.z - 3390) * (spawn.z - 3390))).toBeGreaterThan(2000);
    s = run(sf, s, POP_INTERVAL + 2, systems);
    expect(claimed(s).filter((a) => heldIds.has(a.id))).toEqual([]);
    expect((s.ext.agents?.list ?? []).filter((a) => heldIds.has(a.id))).toEqual([]);
    expect(s.ext.agents!.list.length).toBeLessThanOrEqual(MAX_AGENTS_TOTAL);
  }, SF_RUN_MS);
});
