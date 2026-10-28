import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { afterEach, describe, expect, it } from "vitest";
import { Actors, disposeTree, makeBoxCar, type CarPose } from "../../src/render/actors.ts";
import type { BodyFeel } from "../../src/render/body-motion.ts";
import { NightLights } from "../../src/render/lights.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";

const disposables: Array<{ dispose(): void }> = [];
afterEach(() => { for (const value of disposables.splice(0).reverse()) value.dispose(); });

const level: BodyFeel = { speed: 0, lateral: 0, yawRate: 0, grounded: true, hits: 0, personBumps: 0, impactSpeed: 0, landingSpeed: 0 };
const pose = (feel?: Partial<BodyFeel>, at: Partial<CarPose> = {}): CarPose =>
  ({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, steer: 0, speed: feel?.speed ?? 0, ...at, ...(feel ? { feel: { ...level, ...feel } } : {}) });

async function glb(): Promise<THREE.Object3D> {
  const bytes = readFileSync(new URL("../../public/models/civilian-car.glb", import.meta.url));
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const root = await new Promise<THREE.Object3D>((resolve, reject) => new GLTFLoader().parse(data, "", (g) => resolve(g.scene), reject));
  disposables.push({ dispose: () => disposeTree(root) });
  return root;
}

/** Both car models the renderer can draw: the authored glb and the procedural stand-in. */
async function views(): Promise<Array<[string, Actors]>> {
  const prototype = await glb();
  const file = new ModelRegistry<THREE.Object3D>({ load: async () => prototype, fallback: () => new THREE.Group(), clone: (r) => r.clone(true), available: null });
  await file.get("player-car");
  const fallback = new ModelRegistry<THREE.Object3D>({ load: async () => new THREE.Group(), fallback: () => makeBoxCar(0xffffff), clone: (r) => r.clone(true), available: new Set() });
  return [["civilian-car.glb", file], ["box car", fallback]].map(([name, reg]) => {
    const a = new Actors(reg as ModelRegistry<THREE.Object3D>, new NightLights());
    disposables.push(a);
    return [name as string, a] as [string, Actors];
  });
}

function carOf(view: Actors, id: string, at: CarPose): THREE.Object3D {
  const before = new Set(view.group.children);
  view.setCar(id, at);
  return view.group.children.find((c) => !before.has(c))!;
}

/** Lowest world y over the bounding-box corners of every mesh under `root` that is not a wheel. */
function lowestBodyY(car: THREE.Object3D): number {
  car.updateWorldMatrix(true, true);
  let low = Infinity;
  const p = new THREE.Vector3();
  car.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (let up: THREE.Object3D | null = mesh; up; up = up.parent) if (typeof up.userData.wheel === "string") return;
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox!;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      low = Math.min(low, p.set(x, y, z).applyMatrix4(mesh.matrixWorld).y);
    }
  });
  return low;
}

function wheelMatrices(car: THREE.Object3D): number[][] {
  car.updateWorldMatrix(true, true);
  const out: number[][] = [];
  car.traverse((n) => { if (typeof n.userData.wheel === "string") out.push(n.matrixWorld.toArray()); });
  return out;
}

describe("the car body on its own pivot", () => {
  it("splits the body from the wheels in both models and leaves the rest pose exactly as drawn", async () => {
    for (const [name, view] of await views()) {
      const car = carOf(view, "p1", pose());
      const pivots: THREE.Object3D[] = [];
      car.traverse((n) => { if (n.name === "chassis") pivots.push(n); });
      expect(pivots, name).toHaveLength(1);
      const pivot = pivots[0]!;
      let wheelInPivot = false, meshInPivot = false;
      pivot.traverse((n) => { if (typeof n.userData.wheel === "string") wheelInPivot = true; if ((n as THREE.Mesh).isMesh) meshInPivot = true; });
      expect(wheelInPivot, name).toBe(false);
      expect(meshInPivot, name).toBe(true);
      const rest = wheelMatrices(car), restLow = lowestBodyY(car);
      view.update(1 / 60); // no feel supplied: the old callers' cars stay put
      expect(pivot.position.toArray()).toEqual([0, 0, 0]);
      expect(pivot.quaternion.toArray()).toEqual([0, 0, 0, 1]);
      expect(wheelMatrices(car)).toEqual(rest);
      expect(lowestBodyY(car)).toBe(restLow);
      expect(view.bodyMotion("p1")).toEqual({ pitch: 0, roll: 0, heave: 0, shown: 0 });
    }
  });

  it("tilts and bobs only the body: hard braking pitches it nose down, the wheels do not move", async () => {
    for (const [name, view] of await views()) {
      const car = carOf(view, "p1", pose({ speed: 30 }));
      const rest = wheelMatrices(car);
      for (let i = 0; i < 90; i++) { view.setCar("p1", pose({ speed: 30 - 11 * i / 60 })); view.update(1 / 60); }
      const m = view.bodyMotion("p1")!;
      expect(m.pitch, name).toBeLessThan(-0.04);
      const pivot = car.getObjectByName("chassis")!;
      expect(pivot.quaternion.x, name).toBeLessThan(0); // rotation.x < 0 on a -z car: nose down
      // The wheels spin and steer as before (the car's own motion); their world position is the car's.
      const now = wheelMatrices(car);
      for (let w = 0; w < rest.length; w++) {
        for (const i of [12, 13, 14]) expect(now[w]![i], name).toBeCloseTo(rest[w]![i]!, 9);
      }
    }
  });

  it("leans the body away from a turn and keeps the pitch/roll signs of CarPose", async () => {
    for (const [name, view] of await views()) {
      const car = carOf(view, "p1", pose({ speed: 20 }));
      for (let i = 0; i < 90; i++) { view.setCar("p1", pose({ speed: 20, yawRate: 0.4 })); view.update(1 / 60); }
      expect(view.bodyMotion("p1")!.roll, name).toBeLessThan(-0.05); // right turn: roll + = right side down, so < 0
      car.updateWorldMatrix(true, true);
      // The roof (a body point 1+ m up) moves toward the outside of the turn: left, -x on a -z car.
      const roof = new THREE.Vector3(0, 1.5, 0).applyMatrix4(car.getObjectByName("chassis")!.matrixWorld);
      expect(roof.x, name).toBeLessThan(0);
    }
  });

  it("never lowers the body into the road, whatever the sim throws at it", async () => {
    for (const [name, view] of await views()) {
      const car = carOf(view, "p1", pose({ speed: 0 }));
      const rest = lowestBodyY(car);
      expect(rest, name).toBeGreaterThan(0.1);
      let low = rest, hits = 0, lands = 0;
      for (let i = 0; i < 1200; i++) {
        const t = i / 60;
        // Full throttle, full brake, a slalom at the grip limit, hits and drops all through it.
        const speed = 28 + 26 * Math.sin(t * 1.7), yawRate = 0.7 * Math.sin(t * 3.1);
        if (i % 97 === 0) hits++;
        if (i % 131 === 0) lands += 6;
        view.setCar("p1", pose({ speed, lateral: 5 * Math.sin(t * 2.3), yawRate, hits, impactSpeed: 4 + (i % 40), landingSpeed: lands % 11, grounded: i % 131 > 12 }));
        view.update(1 / 60);
        low = Math.min(low, lowestBodyY(car));
      }
      expect(low, name).toBeGreaterThanOrEqual(0.03 - 1e-6);
    }
  });

  it("a respawn starts the body level", async () => {
    for (const [name, view] of await views()) {
      carOf(view, "p1", pose({ speed: 20 }));
      for (let i = 0; i < 30; i++) { view.setCar("p1", pose({ speed: 20 - 11 * i / 60, hits: i > 20 ? 1 : 0, impactSpeed: 12 })); view.update(1 / 60); }
      expect(Math.abs(view.bodyMotion("p1")!.pitch), name).toBeGreaterThan(0.01);
      view.setCar("p1", pose({ speed: 0 }, { x: 900, z: -400 })); // 8 m+ away in one frame
      expect(view.bodyMotion("p1")!.pitch, name).toBe(0);
      expect(view.bodyMotion("p1")!.heave, name).toBe(0);
    }
  });
});
