import * as THREE from "three";
import { PointsNodeMaterial } from "three/webgpu";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedMaterials } from "../../src/render/materials.ts";
import { setGpuMaterialsEnabled } from "../../src/render/node-materials.ts";
import { buildTileProps, createNightMaterials } from "../../src/render/props.ts";

afterEach(() => setGpuMaterialsEnabled(false));
const lamps = [{ x: 1000, z: 1000, heading: 0, v: .5 }, { x: 1010, z: 1000, heading: 0, v: .5 }];
function around(x: number): THREE.Frustum {
  return new THREE.Frustum(
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -x + 20), new THREE.Plane(new THREE.Vector3(-1, 0, 0), x + 20),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 20), new THREE.Plane(new THREE.Vector3(0, -1, 0), 20),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -980), new THREE.Plane(new THREE.Vector3(0, 0, -1), 1020),
  );
}

describe("night lamp glow", () => {
  it("uses one node sprite batch with real corner UVs and per-lamp positions", () => {
    setGpuMaterialsEnabled(true);
    const materials = createSharedMaterials(), night = createNightMaterials();
    const texture = new THREE.Texture(); night.glow.map = texture;
    const first = buildTileProps(lamps, [], () => 2, materials, night);
    const second = buildTileProps(lamps, [], () => 2, materials, night);
    const glow = first.group.getObjectByName("lamp-glow") as THREE.Sprite;
    const other = second.group.getObjectByName("lamp-glow") as THREE.Sprite;
    expect(glow.isSprite).toBe(true);
    expect(glow.count).toBe(lamps.length);
    expect(glow.material).toBeInstanceOf(PointsNodeMaterial);
    expect(glow.material).toBe(other.material);
    expect(glow.material.map).toBe(texture);
    expect(glow.material.blending).toBe(THREE.AdditiveBlending);
    expect(glow.material.depthWrite).toBe(false);
    const uv = glow.geometry.getAttribute("uv"), positions = glow.geometry.getAttribute("fcLampPosition");
    expect(Array.from({ length: uv.count }, (_, i) => [uv.getX(i), uv.getY(i)])).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect((positions as THREE.InstancedBufferAttribute).isInstancedBufferAttribute).toBe(true);
    expect(positions.count).toBe(2);
    expect([positions.getX(0), positions.getY(0), positions.getZ(0)]).toEqual([1000, expect.closeTo(8.8), 998.25]);
    expect(first.group.children.filter(object => object.name === "lamp-glow")).toHaveLength(1);
    expect(first.group.children.some(object => (object as THREE.Points).isPoints)).toBe(false);
    expect(first.nightOnly).toContain(glow);
    expect(glow.intersectsFrustum(around(1000))).toBe(true);
    expect(glow.intersectsFrustum(around(0))).toBe(false);
    expect(new THREE.Sprite().geometry.hasAttribute("fcLampPosition")).toBe(false);
    let geometryDisposed = false, materialDisposed = false, textureDisposed = false;
    glow.geometry.addEventListener("dispose", () => { geometryDisposed = true; });
    night.glow.addEventListener("dispose", () => { materialDisposed = true; });
    texture.addEventListener("dispose", () => { textureDisposed = true; });
    first.dispose();
    expect(geometryDisposed).toBe(true);
    expect(materialDisposed).toBe(false);
    expect(textureDisposed).toBe(false);
    expect(other.geometry.getAttribute("fcLampPosition").count).toBe(2);
    second.dispose(); night.glow.dispose(); night.pool.dispose(); texture.dispose();
    materials.all.forEach(material => material.dispose());
  });

  it("keeps the legacy Points path and shared night-only contract", () => {
    const materials = createSharedMaterials(), night = createNightMaterials();
    const props = buildTileProps(lamps, [], () => 2, materials, night);
    const glow = props.group.getObjectByName("lamp-glow") as THREE.Points;
    expect(glow.isPoints).toBe(true);
    expect(glow.material).toBe(night.glow);
    expect(glow.geometry.getAttribute("position").count).toBe(2);
    expect(glow.geometry.hasAttribute("uv")).toBe(false);
    expect(props.nightOnly).toContain(glow);
    props.dispose(); night.glow.dispose(); night.pool.dispose();
    materials.all.forEach(material => material.dispose());
  });
});
