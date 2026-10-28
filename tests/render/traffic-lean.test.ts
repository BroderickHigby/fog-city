import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { AgentLayer } from "../../src/render/agent-layer.ts";
import { TRAFFIC_BODY } from "../../src/render/body-motion.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import type { SimState } from "../../src/sim/contract.ts";

const registry = (): ModelRegistry<THREE.Object3D> =>
  new ModelRegistry<THREE.Object3D>({ load: async () => new THREE.Group(), fallback: () => new THREE.Group(), clone: (r) => r.clone(), available: new Set() });

interface Car { id: number; x: number; z: number; heading: number; speed: number }
const snap = (tick: number, cars: Car[]): SimState => ({ version: 23, tick, players: {}, ext: { agents: { nextId: 99,
  list: cars.map((c) => ({ kind: "robotaxi", y: 0, pitch: 0, mode: "go", ...c })) } } }) as unknown as SimState;

/** The drawn pose of a vehicle from the layer: pitch (nose up +), roll (right side down +) and height. */
function drawn(layer: AgentLayer, id: number): { pitch: number; roll: number; y: number } {
  const m = new THREE.Matrix4(), b = new THREE.Box3();
  expect(layer.copyVehicleFrame(id, m, b)).toBe(true);
  const e = new THREE.Euler().setFromRotationMatrix(m, "YXZ");
  return { pitch: e.x, roll: -e.z, y: m.elements[13]! };
}

/** Run a car through `frames` ticks of (speed, heading) and return the drawn pose after the last. */
function drive(near: boolean, frames: number, speed: (t: number) => number, heading: (t: number) => number): { pose: ReturnType<typeof drawn>; calls: number; layer: AgentLayer } {
  const layer = new AgentLayer(registry());
  const z = near ? -8 : -400;
  const car = (t: number): Car => ({ id: 7, x: 0, z, heading: heading(t), speed: speed(t) });
  for (let k = 1; k <= frames; k++) {
    const dt = 1 / 60;
    layer.update(snap(k - 1, [car((k - 1) * dt)]), snap(k, [car(k * dt)]), 1, { x: 0, z: 0, fx: 0, fz: -1 }, dt, k * dt);
  }
  return { pose: drawn(layer, 7), calls: layer.info().drawCalls, layer };
}

describe("ambient traffic and robotaxis lean in the agent layer", () => {
  it("squats under throttle, dives under the brakes, leans out of a turn and sits level otherwise", () => {
    const up = drive(true, 90, (t) => 3 * t, () => 0);
    const down = drive(true, 90, (t) => 20 - 6 * t, () => 0);
    const right = drive(true, 90, () => 14, (t) => 0.5 * t);
    const level = drive(true, 90, () => 14, () => 0);
    try {
      expect(up.pose.pitch).toBeGreaterThan(0.012);
      expect(down.pose.pitch).toBeLessThan(-0.02);
      expect(right.pose.roll).toBeLessThan(-0.03);
      expect(Math.abs(level.pose.pitch)).toBeLessThan(1e-9);
      expect(Math.abs(level.pose.roll)).toBeLessThan(1e-9);
      expect(Math.abs(up.pose.pitch)).toBeLessThanOrEqual(TRAFFIC_BODY.pitchMax * 1.1);
    } finally { for (const r of [up, down, right, level]) r.layer.dispose(); }
  });

  it("tilts about the vehicle's origin on the road: a leaning vehicle stays at its ground height", () => {
    const tilt = drive(true, 90, (t) => 20 - 6 * t, (t) => 0.5 * t);
    try {
      expect(tilt.pose.pitch).toBeLessThan(-0.02);
      expect(tilt.pose.y).toBe(0);
    } finally { tilt.layer.dispose(); }
  });

  it("leaves a far vehicle alone (too small to show it, and not worth the cost)", () => {
    const far = drive(false, 90, (t) => 3 * t, (t) => 0.5 * t);
    try { expect(Math.abs(far.pose.pitch)).toBeLessThan(1e-9); expect(Math.abs(far.pose.roll)).toBeLessThan(1e-9); expect(far.pose.y).toBe(0); } finally { far.layer.dispose(); }
  });

  it("adds no draw calls: a leaning fleet draws exactly what a level one does", () => {
    const fleet = (lean: boolean): number => {
      const layer = new AgentLayer(registry());
      const cars = (t: number): Car[] => Array.from({ length: 40 }, (_, i) => ({ id: 10 + i, x: (i % 8) * 4 - 14, z: -10 - Math.floor(i / 8) * 7, heading: lean ? 0.5 * t : 0, speed: lean ? 3 * t : 12 }));
      for (let k = 1; k <= 60; k++) layer.update(snap(k - 1, cars((k - 1) / 60)), snap(k, cars(k / 60)), 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, k / 60);
      const info = layer.info();
      layer.dispose();
      return info.drawCalls * 1e6 + info.drawn;
    };
    expect(fleet(true)).toBe(fleet(false));
  });

  it("forgets a vehicle that left: it starts level when it comes back", () => {
    const layer = new AgentLayer(registry());
    const car = (t: number): Car => ({ id: 7, x: 0, z: -8, heading: 0, speed: 3 * t });
    try {
      for (let k = 1; k <= 60; k++) layer.update(snap(k - 1, [car((k - 1) / 60)]), snap(k, [car(k / 60)]), 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, k / 60);
      expect(drawn(layer, 7).pitch).toBeGreaterThan(0.01);
      // Gone for ten frames, back at the same speed: a fresh spring, no carried tilt.
      for (let k = 61; k <= 70; k++) layer.update(snap(k - 1, []), snap(k, []), 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, k / 60);
      layer.update(snap(70, [car(2)]), snap(71, [car(2.02)]), 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 71 / 60);
      expect(Math.abs(drawn(layer, 7).pitch)).toBeLessThan(0.01);
    } finally { layer.dispose(); }
  });
});
