// The pickup ring is the sim's stop rule drawn on the ground, and the waiting person's life:
// waiting (jump, wave), ready (the car holds inside), boarding (walks to the car), gone.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { SIM_VERSION, createInitialState, type SimState } from "../../src/sim/index.ts";
import { buildWorld } from "../../src/sim/world.ts";
import { RUNWAY_RULES, stopRadiusFor, type RunwayRun } from "../../src/sim/runway-run/index.ts";
import { INVESTOR_SIDE_M, besideLane, pickupMarkers, runwayPickups, type PickupMarker } from "../../src/presentation/pickup-markers.ts";
import { BOARD_S, FADE_S, PickupMarkerLayer, RING_SEGMENTS, ringGeometry, ringOuterRadius } from "../../src/render/pickup-markers.ts";

const FEET_15_M = 15 * 0.3048;

function withRun(patch: Partial<RunwayRun> = {}, version = SIM_VERSION): SimState {
  const s = createInitialState(buildWorld([]), 7, ["p"], { x: 0, z: 0, heading: 0 });
  const run: RunwayRun = {
    phase: "running", startTick: 0, endTick: 0, runwayTicks: 90 * 60, raised: 0, closed: 0, best: 0, hype: 1, rng: [1, 2, 3, 4],
    investor: 2, carrying: false, target: { x: 40, z: -120 }, network: 0, pickedAt: null, tripStart: 0, downRounds: 0, hold: 0,
    nearSeen: 0, bumpSeen: 0, impactSeen: 0, lastDownTick: 0, nextNote: 1, notes: [], ...patch,
  };
  return { ...s, version, ext: { ...s.ext, runway: { version: 1, runs: { p: run } } } };
}

const flat = (_x: number, y: number): number => y;
const meshNamed = (layer: PickupMarkerLayer, name: string): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  layer.group.traverse((o) => { if (o.name === name) out.push(o as THREE.Mesh); });
  return out;
};

describe("the ring is the pickup rule", () => {
  it("is 2.3 m in radius (about 15 ft across) for this SIM_VERSION, the sim's own radius", () => {
    const [row] = runwayPickups(withRun(), "p", null);
    expect(row!.radiusM).toBe(stopRadiusFor(SIM_VERSION));
    expect(row!.radiusM).toBe(RUNWAY_RULES.stopRadiusM);
    expect(row!.radiusM * 2).toBeCloseTo(FEET_15_M, 1);
    const layer = new PickupMarkerLayer(null, false, flat);
    layer.update([row!], null, { x: 0, z: 0 }, 1 / 60);
    const [ring] = meshNamed(layer, "pickup-ring");
    expect(ringOuterRadius(ring!.geometry)).toBeCloseTo(row!.radiusM, 5);
    expect(layer.info().ringRadii).toEqual([2.3]);
  });
  it("follows an older replay's radius, so the ring never lies about the rule", () => {
    expect(runwayPickups(withRun({}, 27), "p", null)[0]!.radiusM).toBe(8);
  });
  it("is centred on the sim's target, and the investor stands inside it", () => {
    const [row] = runwayPickups(withRun(), "p", null);
    expect({ x: row!.x, z: row!.z }).toEqual({ x: 40, z: -120 });
    const d = Math.hypot(row!.person!.x - row!.x, row!.person!.z - row!.z);
    expect(d).toBeCloseTo(INVESTOR_SIDE_M, 5);
    expect(d).toBeLessThan(row!.radiusM);
  });
  it("lies on a hill: every vertex sits on the ground under it", () => {
    const g = ringGeometry(2, 2.3, RING_SEGMENTS, (x, z) => 0.2 * x - 0.1 * z + 5);
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) expect(p.getY(i)).toBeCloseTo(0.2 * p.getX(i) - 0.1 * p.getZ(i) + 5, 5);
    const slope = new PickupMarkerLayer(null, false, (x, _y, z) => 0.1 * x + 0.05 * z);
    const [row] = runwayPickups(withRun(), "p", null);
    slope.update([row!], null, { x: 0, z: 0 }, 1 / 60);
    const ring = meshNamed(slope, "pickup-ring")[0]!, q = ring.geometry.getAttribute("position");
    for (let i = 0; i < q.count; i += 7) {
      const wx = q.getX(i) + ring.parent!.position.x, wz = q.getZ(i) + ring.parent!.position.z;
      expect(q.getY(i)).toBeCloseTo(0.1 * wx + 0.05 * wz + 0.06, 4);
    }
  });
  it("shows the dwell: green and filling while the car holds inside, slow", () => {
    const layer = new PickupMarkerLayer(null, false, flat);
    const half = runwayPickups(withRun({ hold: RUNWAY_RULES.stopHoldTicks / 2 }), "p", null)[0]!;
    expect(half).toMatchObject({ inside: true, progress: 0.5 });
    layer.update([half], { x: 40, y: 0, z: -120, heading: 0 }, { x: 0, z: 0 }, 1 / 60);
    const arc = meshNamed(layer, "pickup-progress")[0]!, ring = meshNamed(layer, "pickup-ring")[0]!;
    expect(arc.visible).toBe(true);
    expect(arc.geometry.drawRange.count).toBe(RING_SEGMENTS / 2 * 6);
    expect((ring.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x46ff7e);
    const waiting = runwayPickups(withRun(), "p", null)[0]!;
    expect(waiting).toMatchObject({ inside: false, progress: 0 });
    layer.update([waiting], null, { x: 0, z: 0 }, 1 / 60);
    expect(arc.visible).toBe(false);
    expect((ring.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xffc22e);
  });
  it("marks the demo with a ring and beacon, nobody waiting", () => {
    const [row] = runwayPickups(withRun({ carrying: true, target: { x: 500, z: 0 } }), "p", null);
    expect(row).toMatchObject({ kind: "demo", x: 500, z: 0, person: null, radiusM: 2.3 });
    const layer = new PickupMarkerLayer(null, false, flat);
    layer.update([row!], null, { x: 0, z: 0 }, 1 / 60);
    expect(meshNamed(layer, "pickup-beacon")).toHaveLength(1);
    expect(layer.info()).toMatchObject({ markers: 1, people: 0 });
  });
  it("is absent with no run, a finished run, or a run of someone else", () => {
    const s = createInitialState(buildWorld([]), 7, ["p"], { x: 0, z: 0, heading: 0 });
    expect(pickupMarkers(s, "p", null, null)).toEqual([]);
    expect(runwayPickups(withRun({ phase: "over", target: null }), "p", null)).toEqual([]);
    expect(runwayPickups(withRun(), "q", null)).toEqual([]);
  });
  it("stands the person to the lane's right, facing the lane", () => {
    // A lane running north (-z): its right is east (+x).
    const graph = { nodes: [], edges: [] } as unknown as Parameters<typeof besideLane>[0];
    expect(besideLane(null, 0, 0, 1.6)).toMatchObject({ x: 1.6, z: 0 });
    expect(besideLane(graph, 0, 0, 1.6)).toMatchObject({ x: 1.6, z: 0 });
  });
});

describe("the waiting person", () => {
  const row = (patch: Partial<PickupMarker> = {}): PickupMarker => ({
    key: "k", kind: "investor", x: 0, y: 0, z: 0, radiusM: 2.3, person: { x: 1.6, y: 0, z: 0, agentId: null, rest: 0 }, inside: false, progress: 0, ...patch,
  });
  const standIn = (layer: PickupMarkerLayer): THREE.Object3D | undefined => layer.group.getObjectByName("pickup:stand-in");

  it("shows at once as a stand-in before any crowd file loads, jumping with both arms overhead", () => {
    const layer = new PickupMarkerLayer(null, false, flat);
    let top = 0;
    for (let i = 0; i < 60; i++) { layer.update([row()], null, { x: 0, z: 0 }, 1 / 60); top = Math.max(top, standIn(layer)!.position.y); }
    const person = standIn(layer)!;
    expect(person.visible).toBe(true);
    expect(top).toBeGreaterThan(0.2);
    // Both upper arms above the shoulder: rotated more than 120 degrees from hanging.
    const arms = person.children.filter((c) => c.type === "Group" && Math.abs(c.position.y - 1.43) < 1e-6);
    expect(arms).toHaveLength(2);
    for (const arm of arms) expect(Math.abs(arm.rotation.z)).toBeGreaterThan(2.1);
  });
  it("faces an approaching car and stops jumping once the car holds inside", () => {
    const layer = new PickupMarkerLayer(null, false, flat);
    const facingRoad = row({ person: { x: 1.6, y: 0, z: 0, agentId: null, rest: -Math.PI / 2 } });
    layer.update([facingRoad], null, { x: 0, z: 0 }, 1 / 60);
    expect(standIn(layer)!.rotation.y).toBeCloseTo(Math.PI / 2, 5);
    for (let i = 0; i < 120; i++) layer.update([facingRoad], { x: 1.6, y: 0, z: -30, heading: Math.PI }, { x: 0, z: 0 }, 1 / 60);
    // Car due north of them: they face compass 0 (the stand-in's rotation.y is -heading).
    expect(Math.abs(standIn(layer)!.rotation.y)).toBeLessThan(0.05);
    for (let i = 0; i < 30; i++) layer.update([row({ inside: true, progress: i / 30 })], { x: 0, y: 0, z: -1, heading: 0 }, { x: 0, z: 0 }, 1 / 60);
    expect(standIn(layer)!.position.y).toBe(0);
  });
  it("boards the car when picked up: walks to it, then person and ring are gone", () => {
    const layer = new PickupMarkerLayer(null, false, flat);
    layer.update([row({ inside: true, progress: 0.9 })], { x: 0, y: 0, z: 0, heading: 0 }, { x: 0, z: 0 }, 1 / 60);
    const before = standIn(layer)!.position.x;
    layer.update([], { x: 0, y: 0, z: 0, heading: 0 }, { x: 0, z: 0 }, 1 / 60);
    expect(layer.info()).toMatchObject({ markers: 1, boarding: 1 });
    for (let t = 0; t < BOARD_S * 0.5; t += 1 / 60) layer.update([], { x: 0, y: 0, z: 0, heading: 0 }, { x: 0, z: 0 }, 1 / 60);
    // Walking toward the car's kerb-side door (1 m to its right, +x), from 1.6 m out.
    expect(standIn(layer)!.position.x).toBeLessThan(before);
    for (let t = 0; t < BOARD_S; t += 1 / 60) layer.update([], { x: 0, y: 0, z: 0, heading: 0 }, { x: 0, z: 0 }, 1 / 60);
    expect(layer.info()).toMatchObject({ markers: 0, people: 0, boarding: 0 });
    expect(standIn(layer)).toBeUndefined();
    expect(meshNamed(layer, "pickup-ring")).toHaveLength(0);
  });
  it("fades out without boarding when the run ends far from the car", () => {
    const layer = new PickupMarkerLayer(null, false, flat);
    layer.update([row()], { x: 200, y: 0, z: 0, heading: 0 }, { x: 0, z: 0 }, 1 / 60);
    layer.update([], { x: 200, y: 0, z: 0, heading: 0 }, { x: 0, z: 0 }, 1 / 60);
    expect(layer.info().boarding).toBe(0);
    for (let t = 0; t < FADE_S + 0.05; t += 1 / 60) layer.update([], null, { x: 0, z: 0 }, 1 / 60);
    expect(layer.info().markers).toBe(0);
  });
  it("hides the taxi passenger's own sim body from the crowd while it draws them", () => {
    const layer = new PickupMarkerLayer(null, false, flat);
    layer.update([row({ kind: "fare", person: { x: 3.5, y: 0, z: 0, agentId: 42, rest: 0 } })], null, { x: 0, z: 0 }, 1 / 60);
    expect([...layer.hiddenAgents()]).toEqual([42]);
    for (let t = 0; t < 1; t += 1 / 60) layer.update([], null, { x: 0, z: 0 }, 1 / 60);
    expect([...layer.hiddenAgents()]).toEqual([]);
  });
  it("is render-only: building rows and drawing them leaves the sim state unchanged", () => {
    const s = withRun({ hold: 10 });
    const before = JSON.stringify(s);
    const layer = new PickupMarkerLayer(null, false, flat);
    for (let i = 0; i < 10; i++) layer.update(pickupMarkers(s, "p", null, null), null, { x: 0, z: 0 }, 1 / 60);
    expect(JSON.stringify(s)).toBe(before);
    layer.dispose();
    expect(layer.group.parent).toBeNull();
  });
});
