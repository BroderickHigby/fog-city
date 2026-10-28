// The night light pools (src/render/night-light-pools.ts): the pure assignment (nearest first,
// stable, capped) and the lights that follow it. No GPU: the pools move three.js PointLights only.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { AgentLayer } from "../../src/render/agent-layer.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import type { SimState } from "../../src/sim/contract.ts";
import {
  CAR_LIGHT_PARAMS,
  CarLightPool,
  LampLightPool,
  MAX_POOL_SIZE,
  NearestPicker,
  VEHICLE_STRIDE,
  assignSlots,
  beamFor,
  effectiveDistance,
  lampId,
  poolSize,
  smoothFade,
} from "../../src/render/night-light-pools.ts";

const heads = (pts: [number, number][]): Float32Array => new Float32Array(pts.flatMap(([x, z]) => [x, 7, z]));
/** Cars as AgentLayer.vehiclePoses packs them: x, y, z, heading, id. */
const cars = (list: Array<{ id: number; x: number; z: number; heading?: number }>): Float32Array =>
  new Float32Array(list.flatMap(c => [c.x, 0, c.z, c.heading ?? 0, c.id]));

describe("NearestPicker", () => {
  it("keeps the nearest `cap` sources, nearest first", () => {
    const p = new NearestPicker(3);
    for (const [d, id] of [[50, 1], [10, 2], [30, 3], [5, 4], [40, 5]] as const) p.offer(d, id);
    expect(p.count).toBe(3);
    expect([0, 1, 2].map(i => p.id(i))).toEqual([4, 2, 3]);
    expect([0, 1, 2].map(i => p.effDist(i))).toEqual([5, 10, 30]);
  });

  it("is capped: it never holds more than `cap`, and a pool of none holds none", () => {
    const p = new NearestPicker(4);
    for (let i = 0; i < 100; i++) p.offer(i, i);
    expect(p.count).toBe(4);
    const none = new NearestPicker(0);
    none.offer(1, 1);
    expect(none.count).toBe(0);
  });

  it("does not depend on the order sources are offered in, and breaks ties on the id", () => {
    const sources = [[10, 7], [10, 3], [10, 9], [4, 5], [10, 1], [25, 2]] as const;
    const a = new NearestPicker(4);
    for (const [d, id] of sources) a.offer(d, id);
    const b = new NearestPicker(4);
    for (const [d, id] of [...sources].reverse()) b.offer(d, id);
    const ids = (p: NearestPicker): number[] => Array.from({ length: p.count }, (_, i) => p.id(i));
    expect(ids(a)).toEqual([5, 1, 3, 7]);
    expect(ids(b)).toEqual(ids(a));
  });

  it("carries each source's numbers with it", () => {
    const p = new NearestPicker(2);
    p.offer(9, 1, 11, 12, 13, 14);
    p.offer(3, 2, 21, 22, 23, 24);
    p.offer(20, 3, 31, 32, 33, 34);
    expect([p.value(0, 0), p.value(0, 1), p.value(0, 2), p.value(0, 3)]).toEqual([21, 22, 23, 24]);
    expect(p.value(1, 0)).toBe(11);
  });

  it("puts the cutoff at the first dropped source, or at the range when none was dropped", () => {
    const p = new NearestPicker(2);
    p.offer(10, 1);
    p.offer(20, 2);
    expect(p.cutoff(100)).toBe(100);
    p.offer(60, 3);
    expect(p.cutoff(100)).toBe(60);
    expect(p.cutoff(40)).toBe(40);
    p.offer(15, 4); // pushes 20 out: now the cutoff is 20
    expect(p.cutoff(100)).toBe(20);
  });

  it("fades the last sources toward the cutoff, so a swap at the edge does not pop", () => {
    const p = new NearestPicker(2);
    p.offer(10, 1);
    p.offer(59, 2);
    p.offer(60, 3);
    expect(p.fade(0, 100)).toBe(1);
    expect(p.fade(1, 100)).toBeLessThan(0.05);
    expect(smoothFade(60, 60)).toBe(0);
    expect(smoothFade(0, 60)).toBe(1);
    expect(smoothFade(37, 60)).toBe(1); // 62% of the cutoff is where the fade starts
    const mid = smoothFade(48, 60);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe("effectiveDistance", () => {
  it("is the plain distance with no look direction, and counts a source behind the camera as farther", () => {
    expect(effectiveDistance(30, 40, 0, 0)).toBe(50);
    const ahead = effectiveDistance(0, -50, 0, -1);
    const behind = effectiveDistance(0, 50, 0, -1);
    expect(ahead).toBe(50);
    expect(behind).toBeGreaterThan(ahead + 100);
  });

  it("does not penalise a source ahead of the camera", () => {
    expect(effectiveDistance(3, -20, 0, -1)).toBeCloseTo(Math.hypot(3, 20), 6);
  });
});

describe("assignSlots", () => {
  it("keeps a source in the light it had and gives new ones the lowest free slots", () => {
    const slotIds = new Float64Array(4).fill(-1);
    const slotOf = new Int32Array(4);
    assignSlots([10, 20, 30], 3, slotIds, slotOf);
    expect(Array.from(slotOf.slice(0, 3))).toEqual([0, 1, 2]);
    // 20 leaves, 40 and 10 and 30 stay or come: order of the selection changes, slots do not.
    assignSlots([30, 10, 40], 3, slotIds, slotOf);
    expect(Array.from(slotOf.slice(0, 3))).toEqual([2, 0, 1]);
    expect(Array.from(slotIds)).toEqual([10, 40, 30, -1]);
  });

  it("frees the slots of sources that left, and never hands out more slots than there are", () => {
    const slotIds = new Float64Array(2).fill(-1);
    const slotOf = new Int32Array(3);
    assignSlots([1, 2, 3], 3, slotIds, slotOf);
    expect(slotOf[2]).toBe(-1);
    assignSlots([], 0, slotIds, slotOf);
    expect(Array.from(slotIds)).toEqual([-1, -1]);
  });
});

describe("beamFor", () => {
  it("lets the beam reach in full on an open road", () => {
    expect(beamFor(Infinity, CAR_LIGHT_PARAMS)).toEqual({ ahead: CAR_LIGHT_PARAMS.aheadM, reach: CAR_LIGHT_PARAMS.reachM });
  });

  it("pulls the light back and cuts the reach when a car is close ahead", () => {
    const near = beamFor(4, CAR_LIGHT_PARAMS);
    expect(near.ahead).toBeLessThan(CAR_LIGHT_PARAMS.aheadM);
    expect(near.reach).toBeLessThan(CAR_LIGHT_PARAMS.reachM);
    expect(near.reach).toBeGreaterThanOrEqual(CAR_LIGHT_PARAMS.minReachM);
    // The light stays inside the gap: it never lands past the car in front.
    expect(near.ahead).toBeLessThan(4);
    const touching = beamFor(0, CAR_LIGHT_PARAMS);
    expect(touching.ahead).toBeGreaterThan(0);
    expect(touching.reach).toBe(CAR_LIGHT_PARAMS.minReachM);
  });
});

describe("CarLightPool", () => {
  const POOL = 4;

  it("is dark and parked by day, and keeps its lights", () => {
    const pool = new CarLightPool(POOL);
    const v = cars([{ id: 1, x: 5, z: -10 }]);
    pool.update(0, 0, 0, -1, v, 1);
    expect(pool.lit).toBe(0);
    expect(pool.lights.every(l => l.intensity === 0 && l.position.y < -100)).toBe(true);
    pool.dispose();
  });

  it("lights exactly the nearest cars at night, at most the pool's size, nearest first", () => {
    const pool = new CarLightPool(POOL);
    pool.setNight(1);
    // 12 cars in a line ahead of the camera (it looks north), 10 m apart, listed farthest first.
    const line = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, x: 3, z: -10 * (i + 1) })).reverse();
    pool.update(0, 0, 0, -1, cars(line), 12);
    expect(pool.lit).toBe(POOL);
    // The four nearest (ids 100 to 103) hold the four lights; every other car holds none.
    for (let id = 100; id < 100 + POOL; id++) expect(pool.slotFor(id), `car ${id}`).toBeGreaterThanOrEqual(0);
    for (let id = 100 + POOL; id < 112; id++) expect(pool.slotFor(id), `car ${id}`).toBe(-1);
    // And each of those lights sits ahead of its own car (cars face north, so its z is below the car's).
    for (let id = 100; id < 100 + POOL; id++) {
      const light = pool.lights[pool.slotFor(id)]!;
      const carZ = -10 * (id - 99);
      expect(light.position.z, `car ${id}`).toBeLessThan(carZ - 2.5);
      expect(light.position.z, `car ${id}`).toBeGreaterThan(carZ - 2.5 - CAR_LIGHT_PARAMS.aheadM - 1e-6);
    }
    pool.dispose();
  });

  it("parks the light of a car that vanishes: intensity 0 and below the ground", () => {
    const pool = new CarLightPool(POOL);
    pool.setNight(1);
    pool.update(0, 0, 0, -1, cars([{ id: 1, x: 0, z: -10 }, { id: 2, x: 0, z: -30 }]), 2);
    expect(pool.lit).toBe(2);
    const slot = pool.slotFor(2);
    expect(pool.lights[slot]!.intensity).toBeGreaterThan(0);
    // Car 2 is gone (despawned, or out of range): its light is idle and parked, still at night.
    pool.update(0, 0, 0, -1, cars([{ id: 1, x: 0, z: -10 }]), 1);
    expect(pool.lit).toBe(1);
    expect(pool.slotFor(2)).toBe(-1);
    expect(pool.lights[slot]!.intensity).toBe(0);
    expect(pool.lights[slot]!.position.y).toBeLessThan(-100);
    expect(pool.lights.filter(l => l.intensity === 0 && l.position.y < -100).length).toBe(POOL - 1);
    pool.dispose();
  });

  it("puts each light ahead of the nose, along the car's heading, above the road", () => {
    const pool = new CarLightPool(POOL);
    pool.setNight(1);
    // A car at the origin heading east (compass 90 deg): +x.
    pool.update(-40, 0, 1, 0, cars([{ id: 1, x: 0, z: 0, heading: Math.PI / 2 }]), 1);
    const light = pool.lights.find(l => l.intensity > 0)!;
    expect(light.position.x).toBeGreaterThan(2.5);
    expect(Math.abs(light.position.z)).toBeLessThan(1e-3);
    expect(light.position.y).toBeCloseTo(CAR_LIGHT_PARAMS.heightM, 6);
    pool.dispose();
  });

  it("cuts the beam short behind a car in the same lane, but not for a car in the next lane", () => {
    const pool = new CarLightPool(POOL);
    pool.setNight(1);
    // Both cars face north; the second is 9 m ahead (4 m bumper to bumper) in lane, or 6 m to the side.
    pool.update(0, 40, 0, -1, cars([{ id: 1, x: 0, z: 0 }, { id: 2, x: 0, z: -9 }]), 2);
    const inLane = pool.lights.filter(l => l.intensity > 0).sort((a, b) => b.position.z - a.position.z)[0]!;
    expect(inLane.distance).toBeLessThan(CAR_LIGHT_PARAMS.reachM);
    pool.update(0, 40, 0, -1, cars([{ id: 1, x: 0, z: 0 }, { id: 2, x: 6, z: -9 }]), 2);
    const trailing = pool.lights.filter(l => l.intensity > 0).sort((a, b) => b.position.z - a.position.z)[0]!;
    expect(trailing.distance).toBe(CAR_LIGHT_PARAMS.reachM);
    pool.dispose();
  });

  it("keeps a car in its light from frame to frame", () => {
    const pool = new CarLightPool(POOL);
    pool.setNight(1);
    const a = [{ id: 1, x: 0, z: -10 }, { id: 2, x: 0, z: -20 }, { id: 3, x: 0, z: -30 }];
    pool.update(0, 0, 0, -1, cars(a), 3);
    const before = [1, 2, 3].map(id => pool.slotFor(id));
    // Car 3 overtakes car 1 (the order of nearness changes); every car keeps its light.
    const b = [{ id: 1, x: 0, z: -12 }, { id: 2, x: 0, z: -20 }, { id: 3, x: 0, z: -8 }];
    pool.update(0, 0, 0, -1, cars(b), 3);
    const after = [1, 2, 3].map(id => pool.slotFor(id));
    expect(before.every(s => s >= 0)).toBe(true);
    expect(after).toEqual(before);
    pool.dispose();
  });

  it("gives no light to a car out of range or far behind the camera", () => {
    const pool = new CarLightPool(POOL);
    pool.setNight(1);
    pool.update(0, 0, 0, -1, cars([{ id: 1, x: 0, z: -CAR_LIGHT_PARAMS.rangeM - 5 }, { id: 2, x: 0, z: 90 }]), 2);
    expect(pool.lit).toBe(0);
    pool.dispose();
  });

  it("keeps a fixed number of point lights, so night on and off never changes the scene's light count", () => {
    const pool = new CarLightPool(POOL);
    const before = pool.group.children.length;
    pool.setNight(1);
    pool.update(0, 0, 0, -1, cars([{ id: 1, x: 0, z: -10 }]), 1);
    pool.setNight(0);
    pool.update(0, 0, 0, -1, cars([{ id: 1, x: 0, z: -10 }]), 1);
    expect(pool.group.children.length).toBe(before);
    expect(before).toBe(POOL);
    expect(pool.group.children.every(c => (c as THREE.PointLight).isPointLight && !(c as THREE.PointLight).castShadow)).toBe(true);
    expect(pool.lit).toBe(0);
    pool.dispose();
  });

  it("a pool of none never lights anything", () => {
    const pool = new CarLightPool(0);
    pool.setNight(1);
    pool.update(0, 0, 0, -1, cars([{ id: 1, x: 0, z: -10 }]), 1);
    expect(pool.lit).toBe(0);
    pool.dispose();
  });
});

describe("LampLightPool", () => {
  const POOL = 6;

  it("is dark by day, and lights the nearest lamps at night, at most the pool's size", () => {
    const pool = new LampLightPool(POOL);
    const lamps = heads(Array.from({ length: 30 }, (_, i) => [i * 10, 0] as [number, number]));
    pool.update(0, 0, 1, [lamps], 0, 0);
    expect(pool.lit).toBe(0);
    pool.setNight(1);
    pool.update(0, 0, 1, [lamps], 0, 0);
    expect(pool.lit).toBe(POOL);
    const xs = pool.lights.filter(l => l.intensity > 0).map(l => l.position.x).sort((a, b) => a - b);
    expect(xs).toEqual(Array.from({ length: POOL }, (_, i) => i * 10));
    expect(pool.lights.find(l => l.position.x === 0)!.position.y).toBeCloseTo(6.7);
    pool.dispose();
  });

  it("prefers lamps ahead of the camera over equally near lamps behind it", () => {
    const pool = new LampLightPool(2);
    pool.setNight(1);
    // Camera at the origin looking north (-z): lamps 20 m ahead and 20 m behind, plus one 30 m ahead.
    pool.update(0, 0, 1, [heads([[0, -20], [0, 20], [0, -30]])], 0, -1);
    const zs = pool.lights.filter(l => l.intensity > 0).map(l => l.position.z).sort((a, b) => a - b);
    expect(zs).toEqual([-30, -20]);
    pool.dispose();
  });

  it("parks the light of a lamp that leaves the pool: intensity 0 and below the ground", () => {
    const pool = new LampLightPool(POOL);
    pool.setNight(1);
    pool.update(0, 0, 1, [heads([[0, -10], [0, -20]])], 0, -1);
    expect(pool.lit).toBe(2);
    const slot = pool.lights.findIndex(l => l.position.z === -20);
    // The camera drives off: the far lamp is now out of range, and its light is idle and parked.
    pool.update(0, -10 - pool.params.rangeM + 6, 1, [heads([[0, -10]])], 0, -1);
    expect(pool.lit).toBe(0);
    expect(pool.lights[slot]!.intensity).toBe(0);
    expect(pool.lights[slot]!.position.y).toBeLessThan(-100);
    pool.dispose();
  });

  it("follows the camera across tiles and ignores lamps out of range", () => {
    const pool = new LampLightPool(POOL);
    pool.setNight(1);
    pool.update(1000, 0, 1, [heads([[0, 0], [5, 5]]), heads([[1000, 3], [1004, -2]])], 0, 0);
    expect(pool.lit).toBe(2);
    expect(pool.lights.filter(l => l.intensity > 0).every(l => l.position.x >= 1000)).toBe(true);
    pool.update(0, 5000, 1, [heads([[0, 5000 + pool.params.rangeM + 1]])], 0, 0);
    expect(pool.lit).toBe(0);
    pool.dispose();
  });

  it("is deterministic: the same lamps in another order light the same lamps", () => {
    const pts = Array.from({ length: 20 }, (_, i) => [(i * 37) % 90 - 45, (i * 53) % 90 - 45] as [number, number]);
    const lit = (order: [number, number][]): string => {
      const pool = new LampLightPool(5);
      pool.setNight(1);
      pool.update(0, 0, 1, [heads(order)], 0, 0);
      const out = pool.lights.filter(l => l.intensity > 0).map(l => `${l.position.x},${l.position.z}`).sort().join(" ");
      pool.dispose();
      return out;
    };
    expect(lit(pts)).toBe(lit([...pts].reverse()));
  });

  it("keeps a fixed number of point lights", () => {
    const pool = new LampLightPool(POOL);
    const before = pool.group.children.length;
    pool.setNight(1);
    pool.update(0, 0, 1, [heads([[1, 1]])], 0, 0);
    pool.setNight(0);
    pool.update(0, 0, 1, [heads([[1, 1]])], 0, 0);
    expect(pool.group.children.length).toBe(before);
    expect(before).toBe(POOL);
    expect(pool.lit).toBe(0);
    pool.dispose();
  });

  it("gives a lamp a stable identity from its place", () => {
    expect(lampId(10.01, -5)).toBe(lampId(10.01, -5));
    expect(lampId(10, -5)).not.toBe(lampId(10, 5));
    expect(lampId(10, -5)).not.toBe(lampId(-5, 10));
  });
});

describe("AgentLayer.vehiclePoses (what feeds the car pool)", () => {
  const agent = (id: number, kind: string, x: number, z: number, heading = 0) => ({ id, kind, x, y: 0, z, heading, pitch: 0, speed: 8, mode: "go" });
  const state = (x: number, tick: number): SimState => ({ version: 23, tick, players: {}, ext: { agents: { nextId: 9, list: [
    agent(1, "robotaxi", x, -20, 0.5),
    agent(2, "errandRobot", 4, -10),
    agent(3, "person", 5, -12),
    agent(4, "robotaxi", x + 6, -40, 1.5),
  ] } } }) as unknown as SimState;
  const registry = (): ModelRegistry<THREE.Object3D> =>
    new ModelRegistry<THREE.Object3D>({ load: async () => new THREE.Group(), fallback: () => new THREE.Group(), clone: root => root.clone(), available: new Set() });

  it("lists the road vehicles drawn, at their interpolated pose and grounded height", () => {
    const layer = new AgentLayer(registry());
    layer.setSupportHeight(() => 0.37);
    try {
      layer.update(state(0, 1), state(4, 2), 0.5, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
      const out = new Float32Array(8 * VEHICLE_STRIDE);
      const n = layer.vehiclePoses(out);
      expect(n).toBe(2); // two robotaxis: not the errand robot, not the person
      const ids = [out[4], out[VEHICLE_STRIDE + 4]];
      expect(ids).toEqual([1, 4]);
      expect(out[0]).toBeCloseTo(2, 5); // half way from x = 0 to x = 4
      expect(out[1]).toBeCloseTo(0.37, 5);
      expect(out[2]).toBeCloseTo(-20, 5);
      expect(out[3]).toBeCloseTo(0.5, 5);
    } finally { layer.dispose(); }
  });

  it("leaves out the agent it is told to skip, in any camera mode (the player's own taxi)", () => {
    const layer = new AgentLayer(registry());
    try {
      layer.update(state(0, 1), state(4, 2), 0.5, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
      const out = new Float32Array(8 * VEHICLE_STRIDE);
      expect(layer.vehiclePoses(out)).toBe(2);
      expect(layer.vehiclePoses(out, 1)).toBe(1);
      expect(out[4]).toBe(4);
      expect(layer.vehiclePoses(out, 4)).toBe(1);
      expect(out[4]).toBe(1);
      expect(layer.vehiclePoses(out, null)).toBe(2);
      expect(layer.vehiclePoses(out, 999)).toBe(2);
    } finally { layer.dispose(); }
  });

  it("leaves out the hidden agent, stops at the buffer's size, and is empty after dispose", () => {
    const layer = new AgentLayer(registry());
    layer.update(state(0, 1), state(4, 2), 0.5, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
    layer.setHiddenAgent(1);
    const out = new Float32Array(VEHICLE_STRIDE);
    expect(layer.vehiclePoses(out)).toBe(1);
    expect(out[4]).toBe(4);
    layer.setHiddenAgent(null);
    expect(layer.vehiclePoses(out)).toBe(1); // the buffer holds one
    layer.dispose();
    expect(layer.vehiclePoses(out)).toBe(0);
  });
});

describe("poolSize (?carlights= and ?lamplights=)", () => {
  it("keeps whole numbers from 0 to the most, and floors the rest", () => {
    expect(poolSize(0, 24)).toBe(0);
    expect(poolSize(1, 24)).toBe(1);
    expect(poolSize(7.9, 24)).toBe(7);
    expect(poolSize(MAX_POOL_SIZE, 24)).toBe(MAX_POOL_SIZE);
  });

  it("clamps a value that is too big or negative, so a URL cannot allocate a huge pool", () => {
    expect(poolSize(1e9, 24)).toBe(MAX_POOL_SIZE);
    expect(poolSize(Infinity, 24)).toBe(MAX_POOL_SIZE);
    expect(poolSize(MAX_POOL_SIZE + 1, 24)).toBe(MAX_POOL_SIZE);
    expect(poolSize(-5, 24)).toBe(0);
    expect(poolSize(-Infinity, 24)).toBe(0);
  });

  it("uses the default when the value is missing or not a number", () => {
    expect(poolSize(undefined, 24)).toBe(24);
    expect(poolSize(null, 24)).toBe(24);
    expect(poolSize(NaN, 24)).toBe(24);
  });

  it("leaves room in ClusteredLighting's 256 point lights for two full pools", () => {
    expect(2 * MAX_POOL_SIZE).toBeLessThanOrEqual(256 - 8);
  });
});
