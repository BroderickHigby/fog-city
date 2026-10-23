import { readFileSync } from "node:fs";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Actors, MAX_PLAYERS_DRAWN } from "../../src/render/actors.ts";
import { NightLights } from "../../src/render/lights.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import { PLAYER_BODY_FILE, PlayerBodies } from "../../src/render/player-body.ts";

const bytes = new Uint8Array(readFileSync(new URL(`../../public/${PLAYER_BODY_FILE}`, import.meta.url)));
// Geometry/skeleton unit tests stub image upload; browser tests load the actual embedded textures.
beforeEach(() => {
  vi.stubGlobal("self", globalThis);
  vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
    const texture = new THREE.Texture<HTMLImageElement>();
    queueMicrotask(() => loaded?.(texture));
    return texture;
  });
});
const disposables: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function registry(): ModelRegistry<THREE.Object3D> {
  return new ModelRegistry<THREE.Object3D>({
    load: async () => new THREE.Group(), fallback: () => new THREE.Group(),
    clone: model => model.clone(), available: new Set(),
  });
}
function body(root: THREE.Object3D, id: string): THREE.Object3D {
  const value = root.getObjectByName(`player-body:${id}`);
  expect(value, `human body for ${id}`).toBeDefined();
  return value!;
}
function skin(root: THREE.Object3D): THREE.SkinnedMesh {
  let found: THREE.SkinnedMesh | undefined;
  root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) found ??= object as THREE.SkinnedMesh; });
  expect(found, "actual GLB must contain skinned geometry").toBeDefined();
  return found!;
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const pose = { x: 10, y: 3, z: -5, heading: Math.PI / 2, speed: 0 };

describe("generic online player avatar", () => {
  it("loads actual human geometry and animates independent skeletons without moving the world pose", async () => {
    const humans = await PlayerBodies.load(async path => { expect(path).toBe(PLAYER_BODY_FILE); return bytes; }, true);
    disposables.push(humans);
    humans.begin();
    humans.add("p1", 10, 3, -5, Math.PI / 2, 0, 0);
    humans.add("p2", 12, 3, -5, 0, 0, 0, new THREE.Color("red"));
    humans.end();
    const first = body(humans.group, "p1"), second = body(humans.group, "p2");
    const firstSkin = skin(first), secondSkin = skin(second);
    const humanGeometry = new Set<THREE.BufferGeometry>();
    first.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) humanGeometry.add((object as THREE.SkinnedMesh).geometry); });
    expect([...humanGeometry].reduce((count, geometry) => count + geometry.getAttribute("position").count, 0)).toBeGreaterThan(3000);
    expect(firstSkin.skeleton.bones.length).toBe(80);
    expect(firstSkin.geometry).toBe(secondSkin.geometry);
    expect(firstSkin.skeleton).not.toBe(secondSkin.skeleton);
    expect(firstSkin.skeleton.bones[0]).not.toBe(secondSkin.skeleton.bones[0]);
    const thigh = first.getObjectByName("Bip01_L_Thigh")!, otherThigh = second.getObjectByName("Bip01_L_Thigh")!;
    const before = thigh.quaternion.clone(), otherBefore = otherThigh.quaternion.clone();
    humans.begin();
    humans.add("p1", 10, 3, -5, Math.PI / 2, 1.39, 0.4);
    humans.end();
    expect(thigh.quaternion.angleTo(before)).toBeGreaterThan(0.01);
    expect(otherThigh.quaternion.angleTo(otherBefore)).toBeLessThan(1e-6);
    expect(first.position.toArray()).toEqual([10, 3, -5]);
    expect(first.rotation.y).toBe(-Math.PI / 2);
    expect(first.visible).toBe(true);
    expect(second.visible).toBe(false);
    expect(humans.drawn).toBe(1);
    expect(firstSkin.castShadow).toBe(true);
    // Removing one player disposes its skeleton without discarding the shared model geometry.
    const firstDispose = vi.spyOn(firstSkin.skeleton, "dispose");
    const geometryDispose = vi.spyOn(firstSkin.geometry, "dispose");
    humans.remove(new Set(["p2"]));
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(humans.group.getObjectByName("player-body:p1")).toBeUndefined();
  });

  it("keeps shoe soles on the model ground plane through idle and walking", async () => {
    const humans = await PlayerBodies.load(async () => bytes, false);
    disposables.push(humans);
    for (const speed of [0, 1.39]) {
      for (let frame = 0; frame < 4; frame++) {
        humans.begin();
        humans.add("p1", 0, 0, 0, 0, speed, 0.25);
        humans.end();
        const root = body(humans.group, "p1");
        root.updateMatrixWorld(true);
        const soles: number[] = [];
        root.traverse(object => {
          const mesh = object as THREE.SkinnedMesh;
          if (!mesh.isSkinnedMesh) return;
          const indices = mesh.geometry.getAttribute("skinIndex");
          const weights = mesh.geometry.getAttribute("skinWeight");
          const feet = new Set(mesh.skeleton.bones.map((bone, i) => /_Foot$|_Toe/.test(bone.name) ? i : -1));
          const point = new THREE.Vector3();
          for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) {
            let footWeight = 0;
            for (let k = 0; k < 4; k++) if (feet.has(indices.getComponent(i,k))) footWeight += weights.getComponent(i,k);
            if (footWeight < 0.5) continue;
            mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
            soles.push(point.y);
          }
        });
        expect(soles.length).toBeGreaterThan(50);
        expect(Math.min(...soles)).toBeGreaterThan(-0.06);
        expect(Math.min(...soles)).toBeLessThan(0.12);
        expect(Math.max(...soles)).toBeGreaterThan(0.02);
      }
    }
  });

  it("replaces the fallback once loaded, hides first-person bodies and removes departed players", async () => {
    const pending = deferred<Uint8Array>();
    const load = vi.fn(() => pending.promise);
    const actors = new Actors(registry(), new NightLights(), false, load);
    disposables.push(actors);
    actors.setFoot("p1", pose);
    actors.update(1 / 60);
    expect(actors.walkers).toBe(1);
    expect(actors.walkersFromFile).toBe(0);
    pending.resolve(bytes);
    await vi.waitFor(() => expect(actors.group.getObjectByName("players:bodies")).toBeDefined());
    actors.setFoot("p2", { ...pose, x: 12 });
    actors.update(1 / 60);
    expect(load).toHaveBeenCalledExactlyOnceWith(PLAYER_BODY_FILE);
    expect(actors.walkers).toBe(2);
    expect(actors.walkersFromFile).toBe(2);
    expect((actors.group.getObjectByName("players:people:body") as THREE.InstancedMesh).count).toBe(0);
    actors.hideFor("p1", "person");
    actors.update(1 / 60);
    expect(body(actors.group, "p1").visible).toBe(false);
    expect(body(actors.group, "p2").visible).toBe(true);
    expect(actors.walkersFromFile).toBe(1);
    actors.hideFor(null);
    actors.setFoot("p1", null); // Back in the car: no walker remains for p1.
    actors.update(1 / 60);
    expect(body(actors.group, "p1").visible).toBe(false);
    expect(actors.walkers).toBe(1);
    actors.remove(new Set(["p1"]));
    expect(actors.group.getObjectByName("player-body:p2")).toBeUndefined();
    actors.update(1 / 60);
    expect(actors.walkers).toBe(0);
    expect(actors.walkersFromFile).toBe(0);
  });

  it("preserves the 16-player drawing budget and gives a hidden player's slot to the next visible player", async () => {
    const actors = new Actors(registry(), new NightLights(), false, async () => bytes);
    disposables.push(actors);
    await vi.waitFor(() => expect(actors.group.getObjectByName("players:bodies")).toBeDefined());
    for (let id = 1; id <= 24; id++) actors.setFoot(`p${id}`, { ...pose, x: id * 2 });
    actors.update(1 / 60);
    expect(MAX_PLAYERS_DRAWN).toBe(16);
    expect(actors.walkers).toBe(MAX_PLAYERS_DRAWN);
    expect(actors.walkersFromFile).toBe(MAX_PLAYERS_DRAWN);
    expect(body(actors.group, "p16").visible).toBe(true);
    expect(actors.group.getObjectByName("player-body:p17")).toBeUndefined();
    actors.hideFor("p1", "person");
    actors.update(1 / 60);
    expect(actors.walkers).toBe(MAX_PLAYERS_DRAWN);
    expect(actors.walkersFromFile).toBe(MAX_PLAYERS_DRAWN);
    expect(body(actors.group, "p1").visible).toBe(false);
    expect(body(actors.group, "p17").visible).toBe(true);
    expect(actors.group.getObjectByName("player-body:p18")).toBeUndefined();
  });

  it("keeps a visible fallback if the model cannot load", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const actors = new Actors(registry(), new NightLights(), false, async () => { throw new Error("offline"); });
    disposables.push(actors);
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    actors.setFoot("p1", pose);
    actors.update(1 / 60);
    expect(actors.walkers).toBe(1);
    expect(actors.walkersFromFile).toBe(0);
    expect(actors.group.getObjectByName("players:bodies")).toBeUndefined();
  });

  it("disposes a model that finishes loading after the scene has gone away", async () => {
    const pending = deferred<Uint8Array>();
    const actors = new Actors(registry(), new NightLights(), false, () => pending.promise);
    disposables.push(actors);
    actors.dispose();
    const disposedGeometry = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    pending.resolve(bytes);
    await vi.waitFor(() => expect(disposedGeometry).toHaveBeenCalled());
    expect(actors.group.getObjectByName("players:bodies")).toBeUndefined();
    expect(actors.walkersFromFile).toBe(0);
    expect(() => actors.dispose()).not.toThrow();
  });
});
