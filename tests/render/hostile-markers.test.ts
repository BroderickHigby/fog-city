// Draft destination: tests/render/hostile-markers.test.ts. Do not run from scratch.
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { HOSTILE_MARKER_LIMIT, HOSTILE_MARKER_RANGE, HostileMarkerLayer, hostileMarkers, hostileMarkerSize } from "../../src/render/hostile-markers.ts";
import { createAgentsRuntime, type RuntimeSpawn } from "../../src/sim/agents/runtime.ts";
import { createCombatState } from "../../src/sim/combat/system.ts";
import { initialTarget } from "../../src/sim/combat/shared.ts";
import { createInitialState } from "../../src/sim/step.ts";
import { buildWorld } from "../../src/sim/world.ts";
import { setRenderRetirementOwner } from "../../src/render/renderer-warmup.ts";

function fixture(patches: Partial<RuntimeSpawn>[] = [{}]) {
  const state = createInitialState(buildWorld([]), 7, ["p"], { x: 0, z: 0, heading: 0 });
  const spawns: RuntimeSpawn[] = patches.map((patch, index) => ({ id: `robot:${index}`, numericId: index + 1, model: "footman", firmware: "bad",
    x: 0, y: 2, z: -35, heading: 0, radius: .4, height: 1.8, ...patch }));
  const runtime = createAgentsRuntime(state, { spawns }); state.ext.robots = runtime;
  state.ext.combat = createCombatState(7, { actors: [], players: [{ id: "p", x: 0, y: 0, z: 0, heading: 0, speed: 0,
    tankTier: 0, flowTier: 0, scannerTier: 1, mount: "vehicle" }], refills: [], walls: [] });
  for (const spawn of spawns) state.ext.combat.targets[spawn.id] = initialTarget();
  return { state, runtime, combat: state.ext.combat };
}
const pending = { id: "real:attack", kind: "shove" as const, attackerId: "robot:0", targetId: "p", startTick: 10, resolveTick: 40, endTick: 40, presses: 0, active: false };
const meshes = (layer: HostileMarkerLayer) => layer.root.children as THREE.InstancedMesh[];

describe("current hostile marker projection", () => {
  it("excludes benign units, all human/animal/civilian models and protected metadata even with bad firmware", () => {
    const { state } = fixture([{ firmware: "good" }, { firmware: "none" }, { model: "person" }, { model: "associate" }, { model: "dog" },
      { model: "pigeon" }, { model: "bus" }, { model: "van" }, { protected: true }, { child: true }, { mobilityAid: true }]);
    expect(hostileMarkers(state, "p")).toEqual([]);
    expect(hostileMarkers(state, "absent")).toEqual([]);
  });

  it("uses current converted firmware and active combat phase, never stale marks or incident assignments", () => {
    const { state, runtime, combat } = fixture([{ firmware: "good" }, {}]);
    const bot = runtime.actors["robot:0"]!;
    combat.players.p!.marks = [{ targetId: bot.id, untilTick: 1000, confidence: 1, hallucination: true }];
    bot.converted = true; bot.behavior = "attack";
    expect(hostileMarkers(state, "p").map(row => row.targetId)).toEqual(["robot:1"]);
    bot.firmware = "bad";
    expect(hostileMarkers(state, "p").map(row => row.targetId)).toEqual(["robot:0", "robot:1"]);
    for (const phase of ["seized", "slumping", "heap", "disabled", "cleared"] as const) {
      combat.targets[bot.id]!.phase = phase;
      expect(hostileMarkers(state, "p").map(row => row.targetId)).toEqual(["robot:1"]);
    }
    combat.targets[bot.id]!.phase = "active"; bot.firmware = "good";
    runtime.incidents = { stale: { id: "stale", cardId: "stale", playerId: "p", targetIds: [bot.id], actorIds: [bot.id], tick: 0, x: bot.x, z: bot.z } };
    expect(hostileMarkers(state, "p").map(row => row.targetId)).toEqual(["robot:1"]);
  });

  it("excludes every player's occupied taxi and the local controlled identity", () => {
    const { state, runtime } = fixture([{ model: "robotaxi", numericId: 41 }, { model: "robotaxi", numericId: 42 }, { id: "player:p" }]);
    state.players.q = structuredClone(state.players.p!);
    state.players.q.ride = { agentId: 41, x: 0, y: 0, z: 0, heading: 0, speed: 0, goal: null, exitPending: false };
    runtime.actors["robot:1"]!.legacyId = 41;
    expect(hostileMarkers(state, "p")).toEqual([]);
    delete state.players.q.ride;
    expect(hostileMarkers(state, "p").map(row => row.targetId)).toEqual(["robot:0", "robot:1"]);
  });

  it("bounds the nearest stable IDs, rejects retired/abstract/out of range, and leaves simulation unchanged", () => {
    const patches = Array.from({ length: HOSTILE_MARKER_LIMIT + 8 }, (_, index) => ({ id: `r:${String(index).padStart(2, "0")}`, x: index, z: -35 }));
    const { state, runtime } = fixture(patches);
    runtime.actors["r:00"]!.retired = true; runtime.actors["r:01"]!.fidelity = "abstract";
    runtime.actors["r:02"]!.fidelity = "despawn"; runtime.actors["r:03"]!.z = -HOSTILE_MARKER_RANGE - 1;
    const before = JSON.stringify(state), rows = hostileMarkers(state, "p");
    expect(rows).toHaveLength(HOSTILE_MARKER_LIMIT);
    expect(rows[0]!.targetId).toBe("r:04"); expect(rows.at(-1)!.targetId).toBe("r:27");
    expect(rows.every(row => row.confirmed && row.mapCue.confirmed && row.mapCue.id === `hostile:${row.targetId}`)).toBe(true);
    expect(rows.every(row => row.distance <= HOSTILE_MARKER_RANGE)).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("shows wind-up only during the real pending combat interval and clears it on neutralization", () => {
    const { state, combat, runtime } = fixture(); combat.attacks = [{ ...pending }];
    runtime.actors["robot:0"]!.behavior = "attack";
    state.tick = 9; expect(hostileMarkers(state, "p")[0]!.windup).toBeNull();
    state.tick = 25; expect(hostileMarkers(state, "p")[0]!.windup).toEqual({ attackId: pending.id, kind: "shove", targetId: "p", startTick: 10, resolveTick: 40, progress: .5 });
    state.tick = 40; expect(hostileMarkers(state, "p")[0]!.windup).toBeNull();
    state.tick = 25; combat.attacks[0]!.active = true; expect(hostileMarkers(state, "p")[0]!.windup).toBeNull();
    combat.attacks[0]!.active = false; combat.targets["robot:0"]!.phase = "seized"; expect(hostileMarkers(state, "p")).toEqual([]);
  });
});

describe("pooled hostile geometry", () => {
  it("allocates lazily, faces the camera's world rotation and retains normal opaque depth occlusion", () => {
    const scene = new THREE.Scene(), layer = new HostileMarkerLayer(scene), { state, runtime } = fixture([{ firmware: "good" }]);
    const parent = new THREE.Group(), camera = new THREE.PerspectiveCamera(60, 1, .1, 200);
    parent.rotation.y = .7; camera.rotation.x = -.1; parent.add(camera); parent.updateMatrixWorld(true);
    layer.update(state, "p", camera); expect(scene.children).toEqual([]); expect(layer.info().targets).toBe(0);
    runtime.actors["robot:0"]!.firmware = "bad"; layer.update(state, "p", camera);
    expect(layer.info()).toEqual({ targets: 1, windups: 0, drawCalls: 3, triangles: 8 });
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
    meshes(layer)[0]!.getMatrixAt(0, matrix); matrix.decompose(position, rotation, scale);
    expect(position.x).toBe(0); expect(position.z).toBe(-35); expect(position.y).toBeGreaterThan(3.8);
    expect(Math.abs(rotation.dot(camera.getWorldQuaternion(new THREE.Quaternion())))).toBeCloseTo(1, 5);
    expect(scale.x).toBeCloseTo(hostileMarkerSize(35), 5);
    for (const mesh of meshes(layer)) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      expect(material.depthTest).toBe(true); expect(material.depthWrite).toBe(true); expect(material.transparent).toBe(false);
      expect(mesh.renderOrder).toBe(0); expect(mesh.castShadow).toBe(false); expect(material.map).toBeNull();
    }
    // Headless material/geometry contract only; a real wall occlusion screenshot remains an integration gate.
    expect(hostileMarkerSize(80)).toBe(2.3); layer.dispose();
  });

  it("keeps caps, reuses all resources, follows moved targets and clears neutralized geometry immediately", () => {
    const { state, combat, runtime } = fixture(Array.from({ length: 80 }, (_, index) => ({ x: index % 20, z: -40 - Math.floor(index / 20) })));
    state.tick = 25; combat.attacks = [{ ...pending }];
    const layer = new HostileMarkerLayer(new THREE.Scene()), camera = new THREE.PerspectiveCamera();
    layer.update(state, "p", camera);
    const resources = meshes(layer).map(mesh => [mesh, mesh.geometry, mesh.material]);
    expect(layer.info()).toEqual({ targets: HOSTILE_MARKER_LIMIT, windups: 1, drawCalls: 4, triangles: HOSTILE_MARKER_LIMIT * 8 + 4 });
    for (const actor of Object.values(runtime.actors)) { actor.x += .01; combat.targets[actor.id]!.phase = "heap"; }
    layer.update(state, "p", camera);
    expect(layer.info()).toEqual({ targets: 0, windups: 0, drawCalls: 0, triangles: 0 }); expect(meshes(layer).every(mesh => mesh.count === 0)).toBe(true);
    combat.targets["robot:0"]!.phase = "active"; layer.update(state, "p", camera);
    expect(meshes(layer).map(mesh => [mesh, mesh.geometry, mesh.material])).toEqual(resources);
    const position = new THREE.Vector3(), transform = new THREE.Matrix4(); meshes(layer)[0]!.getMatrixAt(0, transform); position.setFromMatrixPosition(transform);
    expect(position.x).toBeCloseTo(.01, 6); expect(layer.info().triangles).toBeLessThanOrEqual(HOSTILE_MARKER_LIMIT * 12); layer.dispose();
  });

  it("retires shared buffers/materials exactly once, waiting for an active compiler loan", async () => {
    const scene = new THREE.Scene(), layer = new HostileMarkerLayer(scene), { state } = fixture(), camera = new THREE.PerspectiveCamera();
    layer.update(state, "p", camera);
    const geometry = [...new Set(meshes(layer).map(mesh => mesh.geometry))], materials = [...new Set(meshes(layer).map(mesh => mesh.material as THREE.Material))];
    const spies = [...geometry, ...materials, ...meshes(layer)].map(resource => vi.spyOn(resource, "dispose"));
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    setRenderRetirementOwner(layer.root, { retire: () => barrier });
    layer.dispose(); layer.dispose(); layer.update(state, "p", camera);
    expect(scene.children).toEqual([]); expect(spies.every(spy => spy.mock.calls.length === 0)).toBe(true);
    release(); await barrier; await Promise.resolve();
    expect(spies.every(spy => spy.mock.calls.length === 1)).toBe(true); expect(layer.info().targets).toBe(0);
  });
});
