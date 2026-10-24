// The water blaster in the player's hands (src/render/held-blaster.ts): out while spraying,
// pointing down the stream from the right hand, kicking on each shot, and the stream drawn from
// its nozzle (combat-layer.ts). Real models: generic-player.glb and water-blaster.glb.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CombatLayer, NOZZLE_BLEND_M } from "../../src/render/combat-layer.ts";
import { BLASTER_HOLD_S, HeldBlasters, SprayTracker } from "../../src/render/held-blaster.ts";
import { PlayerBodies } from "../../src/render/player-body.ts";
import type { CombatState, Projectile } from "../../src/sim/combat-contract.ts";

const bytes = async (path: string): Promise<Uint8Array> => new Uint8Array(readFileSync(new URL(`../../public/${path}`, import.meta.url)));
beforeEach(() => {
  vi.stubGlobal("self", globalThis);
  vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
    const texture = new THREE.Texture<HTMLImageElement>();
    queueMicrotask(() => loaded?.(texture));
    return texture;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function rig(): Promise<{ bodies: PlayerBodies; blasters: HeldBlasters; draw(cue: Parameters<HeldBlasters["pose"]>[2], dt?: number): THREE.Object3D }> {
  const bodies = await PlayerBodies.load(bytes, false);
  const blasters = await HeldBlasters.load(bytes);
  const draw = (cue: Parameters<HeldBlasters["pose"]>[2], dt = 1 / 60): THREE.Object3D => {
    bodies.begin(); blasters.begin();
    bodies.add("p1", 5, 0, -3, 0, 0, dt);
    const root = bodies.rootOf("p1")!;
    blasters.pose("p1", root, cue, dt);
    bodies.end(); blasters.end();
    return root;
  };
  return { bodies, blasters, draw };
}

describe("the held water blaster", () => {
  it("is put away until the player sprays, and again BLASTER_HOLD_S after the last shot", async () => {
    const { bodies, blasters, draw } = await rig();
    const root = draw(null);
    const wand = (): THREE.Object3D => root.getObjectByName("wand")!;
    expect(wand().visible).toBe(false);
    expect(blasters.nozzle("p1", new THREE.Vector3())).toBeNull();
    draw({ dirX: 0, dirY: 0, dirZ: -1, shot: true });
    expect(wand().visible).toBe(true);
    expect(root.getObjectByName("tank")!.visible).toBe(true);
    draw(null, BLASTER_HOLD_S + 0.1);
    expect(wand().visible).toBe(false);
    blasters.dispose(); bodies.dispose();
  });

  it("points the wand down the stream from the right hand, with the nozzle ahead of the body", async () => {
    const { bodies, blasters, draw } = await rig();
    const dir = new THREE.Vector3(1, -0.2, -1).normalize();
    draw({ dirX: dir.x, dirY: dir.y, dirZ: dir.z, shot: true });
    // Half a second later the kick has settled and the blaster is still out.
    const root = draw({ dirX: dir.x, dirY: dir.y, dirZ: dir.z, shot: false }, 0.5);
    root.updateMatrixWorld(true);
    const wand = root.getObjectByName("wand")!;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(wand.getWorldQuaternion(new THREE.Quaternion()));
    expect(forward.dot(dir)).toBeGreaterThan(0.999);
    const hand = root.getObjectByName("Bip01_R_Hand")!.getWorldPosition(new THREE.Vector3());
    expect(wand.getWorldPosition(new THREE.Vector3()).distanceTo(hand)).toBeLessThan(0.01);
    // The forearm points down the stream.
    const fore = root.getObjectByName("Bip01_R_Forearm")!.getWorldPosition(new THREE.Vector3());
    expect(hand.clone().sub(fore).normalize().dot(dir)).toBeGreaterThan(0.99);
    const nozzle = blasters.nozzle("p1", new THREE.Vector3())!;
    expect(nozzle.distanceTo(hand)).toBeGreaterThan(0.45);
    expect(nozzle.distanceTo(hand)).toBeLessThan(0.75);
    expect(nozzle.clone().sub(hand).normalize().dot(dir)).toBeGreaterThan(0.99);
    expect(nozzle.y).toBeGreaterThan(0.6);
    expect(nozzle.y).toBeLessThan(1.5);
    blasters.dispose(); bodies.dispose();
  });

  it("kicks back along the stream on a shot and settles", async () => {
    const { bodies, blasters, draw } = await rig();
    const dir = { dirX: 0, dirY: 0, dirZ: -1 };
    const root = draw({ ...dir, shot: true }, 1);
    const hand = (): THREE.Vector3 => root.getObjectByName("Bip01_R_Hand")!.getWorldPosition(new THREE.Vector3());
    const offset = (): number => root.getObjectByName("wand")!.getWorldPosition(new THREE.Vector3()).z - hand().z;
    draw({ ...dir, shot: true }, 0);
    expect(offset()).toBeGreaterThan(0.03);
    draw({ ...dir, shot: false }, 0.5);
    expect(offset()).toBeLessThan(0.005);
    blasters.dispose(); bodies.dispose();
  });
});

const water = (id: number, ownerId: string, bornTick: number, vx = 0, vz = -10, distance = 0): Projectile =>
  ({ id, kind: "water", ownerId, x: 0, y: 1.2, z: 0, vx, vy: 0, vz, distance, range: 20, bornTick, volume: 0.1, salt: false, vehicle: false, rustRate: 0.1 }) as Projectile;

describe("SprayTracker", () => {
  it("gives each player the newest shot's direction and a shot flag once per projectile", () => {
    const t = new SprayTracker();
    const a = t.update([water(1, "p1", 10, 0, -10), water(2, "p1", 12, 10, 0)]);
    expect(a.get("p1")).toMatchObject({ dirX: 1, dirZ: 0, shot: true });
    expect(t.update([water(1, "p1", 10), water(2, "p1", 12, 10, 0)]).get("p1")!.shot).toBe(false);
    expect(t.update([]).get("p1")).toBeUndefined();
  });
});

describe("the stream leaves the nozzle", () => {
  it("draws a fresh water shot at the nozzle, joining the sim's path by NOZZLE_BLEND_M", () => {
    const layer = new CombatLayer(new THREE.Scene());
    const nozzle = new THREE.Vector3(3, 1, -2);
    const state = (p: Projectile): CombatState => ({ projectiles: [p] } as unknown as CombatState);
    const at = (p: Projectile): THREE.Vector3 => {
      layer.update(state(p), state(p), 1, (id, out) => (id === "p1" ? out.copy(nozzle) : null));
      const m = new THREE.Matrix4();
      (layer.root.children[0] as THREE.InstancedMesh).getMatrixAt(0, m);
      return new THREE.Vector3().setFromMatrixPosition(m);
    };
    expect(at(water(1, "p1", 0, 0, -10, 0)).distanceTo(nozzle)).toBeLessThan(1e-6);
    expect(at(water(1, "p1", 0, 0, -10, NOZZLE_BLEND_M)).distanceTo(new THREE.Vector3(0, 1.2, 0))).toBeLessThan(1e-6);
    expect(at(water(1, "p2", 0, 0, -10, 0)).distanceTo(new THREE.Vector3(0, 1.2, 0))).toBeLessThan(1e-6);
    layer.dispose();
  });
});
