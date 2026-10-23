import { describe, expect, it } from "vitest";
import type { AgentState } from "../../src/sim/agents.ts";
import type { RuntimePhysicalBody } from "../../src/sim/agents/runtime-state.ts";
import type { CombatState, TargetCombat } from "../../src/sim/combat-contract.ts";
import { initialTarget } from "../../src/sim/combat/shared.ts";
import { SIM_VERSION, type SimState } from "../../src/sim/contract.ts";
import { hideRuntimeReplacements, runtimeVisualSnapshot } from "../../src/render/runtime-snapshot.ts";

function agent(id = 1): AgentState {
  return { id, kind: "errandRobot", x: 0, y: 0, z: 0, heading: 0, pitch: 0, speed: 1, vmax: 1.8,
    edge: "e", dir: 1, lane: 1, s: 0, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 7, dodge: null };
}
function body(id = "animal:1"): RuntimePhysicalBody {
  return { id, numericId: 12, kind: "animal", model: "dog", x: 0, y: 0, z: 0, heading: 0,
    previousX: 0, previousZ: 0, previousHeading: 0, speed: 1, radius: 0.3, halfWidth: 0.3, halfLength: 0.5, height: 0.8, dodge: null };
}
function state(tick: number, list: AgentState[] = [], bodies: RuntimePhysicalBody[] = [], targets: Record<string, TargetCombat> = {}): SimState {
  const agents = { nextId: 20, list, runtime: { version: 1, tick, bodies } };
  return { version: SIM_VERSION, tick, seed: 8, rng: [1, 2, 3, 4], players: {}, ext: {
    agents, robots: { enabled: true, version: 1, wave: 2, metadata: [], actors: [] },
    combat: { targets, attacks: [] } as unknown as CombatState,
  } };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

describe("runtime render snapshot", () => {
  it("keeps legacy-only sessions on their existing renderer", () => {
    const current = state(1, [agent()], [body()]);
    delete current.ext.robots;
    const result = runtimeVisualSnapshot(state(0), current, 1);
    expect(result.snapshot.actors).toEqual([]);
    expect(result.legacyIdsToHide.size).toBe(0);
  });

  it("interpolates matching physical IDs without extrapolating births or stale bodies", () => {
    const previous = state(4, [], [body(), { ...body("removed"), x: 50 }]);
    const current = state(5, [], [{ ...body(), x: 10 }, { ...body("new"), x: 60 }]);
    const result = runtimeVisualSnapshot(previous, current, 0.25);
    expect(result.snapshot.actors.find(actor => actor.id === "animal:1")!.x).toBe(2.5);
    expect(result.snapshot.actors.find(actor => actor.id === "new")!.x).toBe(60);
    expect(result.snapshot.actors.some(actor => actor.id === "removed")).toBe(false);
    expect(runtimeVisualSnapshot(previous, current, 3).snapshot.actors[0]!.x).toBe(10);
  });

  it("uses the short heading arc across the wrap", () => {
    const previous = state(4, [], [{ ...body(), heading: Math.PI - 0.1 }]);
    const current = state(5, [], [{ ...body(), heading: -Math.PI + 0.1 }]);
    expect(runtimeVisualSnapshot(previous, current, 0.5).snapshot.actors[0]!.heading).toBeCloseTo(Math.PI);
  });

  it("replaces only affected legacy robots and immediately draws current combat remains", () => {
    const a = agent(), healthy = agent(2);
    const current = state(4, [a, healthy], [], { "agent:1": { ...initialTarget(), phase: "heap", heightScale: 0.2, puddle: true, rust: 1 } });
    current.ext.robots!.metadata = [{ agentId: 1, phase: "active", rust: 0 }];
    const result = runtimeVisualSnapshot(state(3, [a, healthy]), current, 0);
    expect([...result.legacyIdsToHide]).toEqual([1]);
    expect(result.snapshot.actors.map(actor => actor.kind)).toEqual(["heap", "puddle"]);
    expect(result.snapshot.actors[0]!.speed).toBe(0);
    expect(result.physicalCount).toBe(1);
  });

  it("uses authoritative slump height and suppresses a cleared body", () => {
    const current = state(8, [agent()], [], { "agent:1": { ...initialTarget(), phase: "slumping", heightScale: 0.35 } });
    const result = runtimeVisualSnapshot(state(7), current, 1);
    expect(result.snapshot.actors[0]).toMatchObject({ kind: "footman", heightScale: 0.35, speed: 0 });
    current.ext.combat!.targets["agent:1"]!.phase = "cleared";
    const cleared = runtimeVisualSnapshot(state(7), current, 1);
    expect(cleared.snapshot.actors).toEqual([]);
    expect(cleared.legacyIdsToHide.has(1)).toBe(true);
  });

  it("draws an override leap along its supplied arc and preserves the dodge state", () => {
    const jumping = body();
    jumping.x = 10; jumping.y = 0.5;
    jumping.dodge = { phase: "dive", sx: 0, sz: 0, tx: 10, tz: 0, t: 5, dur: 10, hop: 0.5, peak: 0.5, leap: true };
    const current = freeze(state(5, [], [jumping]));
    const result = runtimeVisualSnapshot(freeze(state(4)), current, 1);
    expect(result.snapshot.actors[0]!.x).toBe(5);
    expect(result.snapshot.actors[0]!.mode).toBe("fly");
    expect(result.dodging).toBe(1);
    expect(jumping.x).toBe(10);
  });

  it("makes render-only filtered states without mutating either authoritative snapshot", () => {
    const current = freeze(state(5, [agent(), agent(2)]));
    const before = JSON.stringify(current);
    const filtered = hideRuntimeReplacements(current, new Set([1]));
    expect(filtered.ext.agents!.list.map(actor => actor.id)).toEqual([2]);
    expect(filtered.players).toBe(current.players);
    expect(filtered.ext.robots).toBe(current.ext.robots);
    expect(filtered.ext.agents!.list[0]).toBe(current.ext.agents!.list[1]);
    expect(JSON.stringify(current)).toBe(before);
    expect(hideRuntimeReplacements(current, new Set())).toBe(current);
  });

  it("draws actual finale weak-point poses and current rust as decorations", () => {
    const previous = state(4), current = state(5, [], [], { "boss/weak/knee": { ...initialTarget(), rust: 0.8 } });
    const beforeRuntime = previous.ext.agents as unknown as { runtime: Record<string, unknown> };
    const currentRuntime = current.ext.agents as unknown as { runtime: Record<string, unknown> };
    beforeRuntime.runtime.routineOutput = { finaleWeakPoints: [{ id: "boss/weak/knee", x: 10, y: 100, z: 5, heading: 0, radius: 6 }] };
    currentRuntime.runtime.routineOutput = { finaleWeakPoints: [{ id: "boss/weak/knee", x: 14, y: 100, z: 5, heading: 0, radius: 6 }] };
    const result = runtimeVisualSnapshot(freeze(previous), freeze(current), 0.25);
    expect(result.snapshot.actors).toHaveLength(1);
    expect(result.snapshot.actors[0]).toMatchObject({ id: "boss/weak/knee", kind: "weak-point", x: 11, y: 100, z: 5, rust: 0.8, scale: 12 });
    expect(result.physicalCount).toBe(0);
    expect(result.legacyIdsToHide.size).toBe(0);
  });

  it("replaces a controlled player's human walker with its authoritative robot body", () => {
    const current = state(5), previous = state(4);
    const car = {} as SimState["players"][string]["car"];
    current.players.p1 = { id: "p1", mode: "foot", car, exitPending: false,
      foot: { x: 10, y: 1, z: 4, heading: 0, speed: 1.6, sprint: false, dodge: null, vy: 0, grounded: true } };
    previous.players.p1 = { ...current.players.p1, foot: { ...current.players.p1.foot!, x: 8 } };
    const runtime = current.ext.agents as unknown as { runtime: Record<string, unknown> };
    runtime.runtime.routineOutput = { actorMetadata: { "player:p1": { kind: "robot", robotBody: true, model: "trundle" } } };
    const result = runtimeVisualSnapshot(freeze(previous), freeze(current), 0.5);
    expect([...result.playerIdsToHide]).toEqual(["p1"]);
    expect(result.snapshot.actors).toEqual([expect.objectContaining({ id: "player:p1", kind: "trundle", x: 9, y: 1, z: 4 })]);
    expect(result.physicalCount).toBe(0);
  });

  it("attaches one heap to Tidy's cradle and removes the carried puddle", () => {
    const heap = { ...agent(1), x: 4, y: 0.4, z: 2 };
    const tidy = { ...body("agent:20"), numericId: 20, kind: "robot" as const, model: "tidy", x: 4, z: 2 };
    const current = state(5, [heap], [tidy], { "agent:1": { ...initialTarget(), phase: "heap", puddle: true, rust: 1 } });
    const runtime = current.ext.agents as unknown as { runtime: Record<string, unknown> };
    runtime.runtime.effectState = { bindings: [{ heapId: "agent:1", tidyId: "agent:20" }] };
    const result = runtimeVisualSnapshot(state(4), freeze(current), 1);
    expect(result.snapshot.actors.filter(actor => actor.kind === "heap")).toHaveLength(1);
    expect(result.snapshot.actors.find(actor => actor.kind === "heap")).toMatchObject({ x: 4, y: 0.4, z: 1.45 });
    expect(result.snapshot.actors.some(actor => actor.kind === "puddle")).toBe(false);
    expect(result.snapshot.actors.find(actor => actor.kind === "tidy")!.mode).toBe("hauling");
    expect(heap.z).toBe(2);
  });

  it("binds a dog's leash to its actual owner and marks only conference member IDs", () => {
    const owner = { ...agent(20), kind: "person" as const, x: 10 }, other = { ...agent(21), kind: "person" as const, x: 20 };
    const dog = { ...body(), x: 12 };
    const current = state(5, [owner, other], [dog]);
    const runtime = current.ext.agents as unknown as { runtime: Record<string, unknown> };
    runtime.runtime.spatial = { animals: [{ id: dog.id, kind: "dog", ownerId: 20 }] };
    runtime.runtime.lanyardPersonIds = [20];
    const result = runtimeVisualSnapshot(state(4), freeze(current), 1);
    expect(result.snapshot.links).toHaveLength(1);
    expect(result.snapshot.links![0]!.from).toEqual({ x: 12, y: 0.5, z: -0.27 });
    expect(result.snapshot.links![0]!.to.x).toBeGreaterThan(10);
    expect(result.snapshot.links![0]!.to.x).toBeLessThan(10.25);
    expect(result.snapshot.actors.filter(actor => actor.kind === "lanyard").map(actor => actor.id)).toEqual(["agent:20:lanyard"]);
    expect(result.physicalCount).toBe(1);
  });
});
