import { readFileSync } from "node:fs";
import * as THREE from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlayerBodies, PLAYER_BODY_FILE } from "../../src/render/player-body.ts";
import { CROWD_FILES } from "../../src/render/crowd-humans.ts";

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

function soles(root: THREE.Object3D, side?: string, support?: (x: number, z: number) => number): number {
  root.updateMatrixWorld(true);
  let low = Infinity;
  const point = new THREE.Vector3();
  root.traverse(object => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const indices = mesh.geometry.getAttribute("skinIndex"), weights = mesh.geometry.getAttribute("skinWeight");
    const feet = new Set(mesh.skeleton.bones.flatMap((bone, i) => /_Foot$|_Toe/.test(bone.name) && (!side || bone.name.startsWith(`Bip01_${side}_`)) ? [i] : []));
    for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) {
      let weight = 0;
      for (let j = 0; j < 4; j++) if (feet.has(indices.getComponent(i, j))) weight += weights.getComponent(i, j);
      if (weight < 0.5) continue;
      mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
      low = Math.min(low, point.y - (support?.(point.x, point.z) ?? 0));
    }
  });
  return low;
}

it.each([PLAYER_BODY_FILE, ...CROWD_FILES])("%s keeps real shoe vertices above its support throughout clips and transitions", async file => {
  const bodies = await PlayerBodies.load(bytes, false, file);
  try {
    let peak = 0;
    for (const speed of [0, 1.39, 3.5, 8, 0, 3.5, 0]) {
      for (let frame = 0; frame < 90; frame++) {
        bodies.begin(); bodies.add("p", 0, 2, 0, 0, speed, 1 / 30); bodies.end();
        const root = bodies.rootOf("p")!;
        const low = soles(root) - 2;
        expect(low, `${file} speed ${speed} frame ${frame}`).toBeGreaterThan(-0.002);
        peak = Math.max(peak, low);
        expect(root.position.toArray()).toEqual([0, 2, 0]);
      }
    }
    // A running stride still has its natural airborne phase; grounding never pins both feet.
    expect(peak).toBeGreaterThan(0.04);
  } finally { bodies.dispose(); }
}, 60_000);

it("keeps the player's planted running toes forward while retaining the lifted heel's pitch", async () => {
  const bodies = await PlayerBodies.load(bytes, false);
  try {
    let airborneHeel = 0;
    for (const speed of [3.5, 8]) for (let frame = 0; frame < 180; frame++) {
      bodies.begin(); bodies.add("p", 0, 0, 0, 0, speed, 1 / 60); bodies.end();
      const root = bodies.rootOf("p")!; root.updateMatrixWorld(true);
      for (const side of ["L", "R"]) {
        const foot = root.getObjectByName(`Bip01_${side}_Foot`)!;
        const toe = root.getObjectByName(`Bip01_${side}_Toe0`)!;
        const from = foot.getWorldPosition(new THREE.Vector3());
        const direction = toe.getWorldPosition(new THREE.Vector3()).sub(from);
        if (soles(root, side) < 0.035 && direction.z < -0.05) {
          expect(Math.abs(Math.atan2(direction.x, -direction.z)), `${speed}m/s ${side} frame ${frame}`).toBeLessThan(12 * Math.PI / 180);
        }
        if (from.y > 0.2 && direction.y < -0.1) airborneHeel++;
      }
    }
    expect(airborneHeel).toBeGreaterThan(20);
  } finally { bodies.dispose(); }
});


it.each([PLAYER_BODY_FILE, ...CROWD_FILES])("%s clears uphill/downhill support under each shoe without changing the world root", async file => {
  const bodies = await PlayerBodies.load(bytes, false, file);
  try {
    for (const [gx, gz] of [[0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]]) {
      const floor = (x: number, z: number): number => 2 + x * gx! + z * gz!;
      const references = new Set<number>();
      bodies.setSupportHeight((x, referenceY, z) => {
        references.add(referenceY);
        return floor(x, z);
      });
      for (const speed of [0, 3.5, 8, 0]) for (let frame = 0; frame < 45; frame++) {
        bodies.begin(); bodies.add("p", 0, 2, 0, 0, speed, 1 / 30); bodies.end();
        const root = bodies.rootOf("p")!;
        expect(soles(root, undefined, floor), `${file} slope ${gx},${gz} speed ${speed} frame ${frame}`).toBeGreaterThan(-0.002);
        expect(root.position.toArray()).toEqual([0, 2, 0]);
        if (speed === 0 && frame > 10) expect(soles(root, undefined, floor)).toBeLessThan(0.025);
        if (file === PLAYER_BODY_FILE && speed >= 3.5) for (const side of ["L", "R"]) {
          const foot = root.getObjectByName(`Bip01_${side}_Foot`)!;
          const toe = root.getObjectByName(`Bip01_${side}_Toe0`)!;
          const direction = toe.getWorldPosition(new THREE.Vector3()).sub(foot.getWorldPosition(new THREE.Vector3()));
          if (soles(root, side, floor) < 0.035 && direction.z < -0.05) {
            expect(Math.abs(Math.atan2(direction.x, -direction.z))).toBeLessThan(12 * Math.PI / 180);
          }
        }
      }
      expect([...references]).toEqual([2]);
    }
    bodies.setSupportHeight(() => undefined);
    bodies.begin(); bodies.add("p", 0, 2, 0, 0, 0, 1 / 30); bodies.end();
    expect(soles(bodies.rootOf("p")!) - 2).toBeGreaterThan(-0.002);
  } finally { bodies.dispose(); }
}, 60_000);
