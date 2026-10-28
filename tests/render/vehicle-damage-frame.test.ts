import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { AgentLayer } from "../../src/render/agent-layer.ts";
import { ImpactLayer } from "../../src/render/impact-layer.ts";
import { Actors, makeBoxCar } from "../../src/render/actors.ts";
import { NightLights } from "../../src/render/lights.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import type { SimState } from "../../src/sim/contract.ts";

const dents = { front: .5, rear: .5, left: .5, right: .5 };
const state = (x: number): SimState => ({ version: 19, tick: x + 1, players: {}, ext: { agents: { nextId: 2,
  list: [{ id: 1, kind: "robotaxi", x, y: 0, z: -6, heading: 0, pitch: 0, speed: 10, mode: "go", dents }] } } }) as unknown as SimState;
const absent = () => false;
function scuffs(layer: ImpactLayer): THREE.InstancedMesh { return layer.root.getObjectByName("impact-scuffs") as THREE.InstancedMesh; }

describe("vehicle damage follows the displayed body", () => {
  it("attaches the actual scuff geometry to the displayed interpolated frame and body bounds", () => {
    const frame = new THREE.Matrix4().makeTranslation(2, .2, -6), bounds = new THREE.Box3(new THREE.Vector3(-.9, .25, -2.3), new THREE.Vector3(.9, 1.5, 2.3));
    const copy = vi.fn((_id: number, out: THREE.Matrix4, box: THREE.Box3) => { out.copy(frame); box.copy(bounds); return true; });
    const scene = new THREE.Scene(), layer = new ImpactLayer(scene, { agent: copy, player: absent });
    try {
      layer.update(state(0), state(4), .5, 1 / 60, 0, 0);
      expect(copy).toHaveBeenCalledOnce();
      const mesh = scuffs(layer), local = new THREE.Matrix4(), inverse = frame.clone().invert();
      expect(mesh.count).toBe(4);
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, local); local.premultiply(inverse);
        const center = new THREE.Vector3().setFromMatrixPosition(local);
        expect(Math.abs(center.x)).toBeLessThanOrEqual(.92);
        expect(Math.abs(center.z)).toBeLessThanOrEqual(2.32);
        expect(center.y).toBeGreaterThan(bounds.min.y);
        expect(center.y).toBeLessThan(bounds.max.y);
      }
    } finally { layer.dispose(); }
  });

  it("follows pitch, roll, ground support and scale, and omits hidden or removed vehicles", () => {
    const frame = new THREE.Matrix4().compose(new THREE.Vector3(20, 7, -30), new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, .7, -.1, "YXZ")), new THREE.Vector3(.8, .8, .8));
    const bounds = new THREE.Box3(new THREE.Vector3(-1, .2, -2), new THREE.Vector3(1, 1.5, 2));
    let visible = true;
    const layer = new ImpactLayer(new THREE.Scene(), { player: absent,
      agent: (_id, matrix, box) => { matrix.copy(frame); box.copy(bounds); return visible; } });
    try {
      layer.update(state(0), state(4), .5, 1 / 60, 0, 0);
      const mesh = scuffs(layer), matrix = new THREE.Matrix4(), inverse = frame.clone().invert();
      mesh.getMatrixAt(0, matrix); matrix.premultiply(inverse);
      expect(matrix.elements[12]).toBeCloseTo(0, 5);
      expect(matrix.elements[14]).toBeCloseTo(-2, 2);
      expect(matrix.elements[1]).toBeCloseTo(0, 5); expect(matrix.elements[2]).toBeCloseTo(0, 5);
      visible = false; layer.update(state(4), state(4), 1, 1 / 60, 0, 0);
      expect(mesh.count).toBe(0);
    } finally { layer.dispose(); }
  });

  it("copies current ambient frames after interpolation and support without changing snapshots", async () => {
    const registry = new ModelRegistry<THREE.Object3D>({ load: async () => new THREE.Group(), fallback: () => new THREE.Group(), clone: root => root.clone(), available: new Set() });
    const layer = new AgentLayer(registry), previous = state(0), current = state(4), before = JSON.stringify([previous, current]);
    layer.setSupportHeight(() => .37);
    try {
      layer.update(previous, current, .5, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
      const matrix = new THREE.Matrix4(), bounds = new THREE.Box3();
      expect(layer.copyVehicleFrame(1, matrix, bounds)).toBe(true);
      expect(matrix.elements[12]).toBe(2); expect(matrix.elements[13]).toBe(.37);
      expect(bounds.isEmpty()).toBe(false);
      layer.setHiddenAgent(1); expect(layer.copyVehicleFrame(1, matrix, bounds)).toBe(false);
      expect(layer.copyVehicleFrame(999, matrix, bounds)).toBe(false);
      expect(JSON.stringify([previous, current])).toBe(before);
    } finally { layer.dispose(); }
  });

  it("copies the fitted player car frame and clears it on removal", () => {
    const registry = new ModelRegistry<THREE.Object3D>({ load: async () => new THREE.Group(), fallback: () => new THREE.Group(), clone: root => root.clone(), available: new Set() });
    const actors = new Actors(registry, new NightLights()), matrix = new THREE.Matrix4(), bounds = new THREE.Box3();
    try {
      actors.setCar("p1", { x: 8, y: 3, z: -5, heading: .4, pitch: .1, roll: .07, speed: 0, steer: 0 });
      expect(actors.copyCarFrame("p1", matrix, bounds)).toBe(true);
      expect(matrix.elements[12]).toBe(8); expect(matrix.elements[13]).toBe(3);
      expect(bounds.isEmpty()).toBe(false);
      actors.hideFor("p1"); expect(actors.copyCarFrame("p1", matrix, bounds)).toBe(false);
      actors.remove(new Set()); expect(actors.copyCarFrame("p1", matrix, bounds)).toBe(false);
    } finally { actors.dispose(); }
  });

  it("follows the chassis tilt of the player's car, so scuffs stay on the body in a nose dive", () => {
    const registry = new ModelRegistry<THREE.Object3D>({ load: async () => new THREE.Group(), fallback: () => makeBoxCar(0xffffff), clone: root => root.clone(), available: new Set() });
    const actors = new Actors(registry, new NightLights()), level = new THREE.Matrix4(), tilted = new THREE.Matrix4(), bounds = new THREE.Box3();
    const feel = (speed: number) => ({ speed, lateral: 0, yawRate: 0, grounded: true, hits: 0, personBumps: 0, impactSpeed: 0, landingSpeed: 0 });
    const at = { x: 8, y: 3, z: -5, heading: .4, pitch: .1, roll: .07, steer: 0 };
    try {
      actors.setCar("p1", { ...at, speed: 30, feel: feel(30) });
      actors.update(1 / 60);
      const car = actors.group.children.find(c => c.name === "box-car")!;
      expect(actors.copyCarFrame("p1", level, bounds)).toBe(true);
      expect(level.equals(car.matrixWorld)).toBe(true); // level body: exactly the root's frame
      const lamp = car.getObjectByName("headlight")!;
      const restLocal = lamp.position.clone();
      const restWorld = lamp.getWorldPosition(new THREE.Vector3());
      for (let i = 0; i < 60; i++) { const v = 30 - 11 * i / 60; actors.setCar("p1", { ...at, speed: v, feel: feel(v) }); actors.update(1 / 60); }
      expect(actors.bodyMotion("p1")!.pitch).toBeLessThan(-.04);
      expect(actors.copyCarFrame("p1", tilted, bounds)).toBe(true);
      const drawn = lamp.getWorldPosition(new THREE.Vector3());
      // The frame puts the body's rest point where the body is drawn now, not where the root alone would.
      expect(restLocal.clone().applyMatrix4(tilted).distanceTo(drawn)).toBeLessThan(1e-9);
      expect(restLocal.clone().applyMatrix4(level).distanceTo(restWorld)).toBeLessThan(1e-9);
      expect(drawn.distanceTo(restWorld)).toBeGreaterThan(.05); // a nose dive moves the front by centimetres
      expect(restLocal.clone().applyMatrix4(car.matrixWorld).distanceTo(drawn)).toBeGreaterThan(.05); // the root alone misses it
    } finally { actors.dispose(); }
  });

  it("keeps damage attached throughout a distant vehicle's four-tick interpolation window", () => {
    const registry = new ModelRegistry<THREE.Object3D>({ load: async () => new THREE.Group(), fallback: () => new THREE.Group(), clone: root => root.clone(), available: new Set() });
    const vehicles = new AgentLayer(registry), damage = new ImpactLayer(new THREE.Scene(), {
      player: absent, agent: (id, matrix, bounds) => vehicles.copyVehicleFrame(id, matrix, bounds),
    });
    const snapshot = (tick: number): SimState => {
      const out = state(0); out.tick = tick;
      out.players = { p1: { mode: "vehicle", car: { x: 0, z: 0 } } } as unknown as SimState["players"];
      const car = out.ext.agents!.list[0]!;
      car.id = 3; car.x = 300 + Math.floor((tick + 3) / 4) * 4; car.z = 0; car.heading = Math.PI / 2;
      return out;
    };
    const frame = new THREE.Matrix4(), bounds = new THREE.Box3(), matrix = new THREE.Matrix4();
    try {
      for (let tick = 1; tick < 12; tick++) for (const alpha of [0, .5]) {
        const prev = snapshot(tick - 1), curr = snapshot(tick);
        vehicles.update(prev, curr, alpha, { x: 290, z: 0, fx: 1, fz: 0 }, 1 / 120, tick / 60);
        expect(vehicles.copyVehicleFrame(3, frame, bounds)).toBe(true);
        damage.update(prev, curr, alpha, 1 / 120, 290, 0);
        const inverse = frame.clone().invert(), mesh = scuffs(damage);
        expect(mesh.count).toBe(4);
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix); matrix.premultiply(inverse);
          expect(Math.abs(matrix.elements[12]!)).toBeLessThanOrEqual(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)) + 1e-4);
          expect(Math.abs(matrix.elements[14]!)).toBeLessThanOrEqual(Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)) + 1e-4);
        }
      }
    } finally { vehicles.dispose(); damage.dispose(); }
  });
});
