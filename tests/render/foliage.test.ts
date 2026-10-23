import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createFoliagePrototype, createLeafTexture, FoliageLayer, foliageMipmaps, FOLIAGE_NEAR_LIMIT } from "../../src/render/foliage.ts";

function tile(count = 1): { group: THREE.Group; trees: THREE.InstancedMesh } {
  const group = new THREE.Group(); group.name = "tile:sample"; group.position.set(100, 2, -50);
  const trees = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), count);
  trees.name = "street-trees-0";
  for (let i = 0; i < count; i++) trees.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 0.1, 0, 0));
  group.add(trees);
  return { group, trees };
}

describe("SF foliage", () => {
  it("uses leafy alpha-tested geometry with a complete mip chain and bounded geometry", () => {
    const texture = createLeafTexture();
    expect(texture.mipmaps.map(mip => mip.width)).toEqual([256, 128, 64, 32, 16, 8, 4, 2, 1]);
    const data = texture.image.data as Uint8Array;
    expect(data.some((value, index) => index % 4 === 3 && value === 0)).toBe(true);
    expect(data.some((value, index) => index % 4 === 3 && value === 255)).toBe(true);
    for (const species of [0, 1] as const) for (const far of [false, true]) {
      const model = createFoliagePrototype(species, far);
      const triangles = (model.bark.index!.count + model.leaves.index!.count) / 3;
      expect(triangles).toBeLessThan(1000);
      expect(model.leaves.getAttribute("uv")).toBeDefined();
      const top = Math.max(model.bark.boundingBox!.max.y, model.leaves.boundingBox!.max.y);
      expect(top).toBeCloseTo(species === 0 ? 6.6 : 10.5, 3);
      model.bark.dispose(); model.leaves.dispose();
    }
    const coverage = (data: Uint8Array): number => {
      let n = 0; for (let i = 3; i < data.length; i += 4) if (data[i]! >= 0.42 * 255) n++;
      return n / (data.length / 4);
    };
    const target = coverage(data);
    for (const mip of texture.mipmaps) if (mip.width >= 8) {
      expect(Math.abs(coverage((mip as THREE.CompressedTextureMipmap).data as Uint8Array) - target)).toBeLessThan(0.08);
    }
    texture.dispose();
    expect(() => foliageMipmaps(new Uint8Array(4), 3)).toThrow();
  });

  it("replaces named street tree instances and preserves world positions", () => {
    const source = tile(); const layer = new FoliageLayer();
    layer.addTile(source.group); layer.update(100, -50);
    expect(source.trees.visible).toBe(false);
    expect(layer.info).toEqual({ near: 1, far: 0, draws: 2 });
    const bark = layer.group.getObjectByName("sf:foliage:0:0:bark") as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4(); bark.getMatrixAt(0, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([100, 2, -50]);
    layer.removeTile("sample"); layer.update(100, -50);
    expect(source.trees.visible).toBe(true); expect(layer.info.near).toBe(0);
    layer.dispose();
  });

  it("replaces baked land-cover trees at their recorded crown width and height without moving their roots", () => {
    const group = new THREE.Group(); group.name = "tile:baked"; group.position.set(250, 0, -250);
    const layer = new FoliageLayer();
    const expected: THREE.InstancedMesh[] = [];
    for (const [species, name] of ["foliage-broadleaf", "foliage-conifer"].entries()) {
      const tree = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
      tree.name = name;
      tree.setMatrixAt(0, new THREE.Matrix4().makeScale(4, 12, 4).setPosition(10 + species * 20, 3, 40));
      tree.setColorAt(0, new THREE.Color(0.75, 0.8, 0.9));
      expected.push(tree); group.add(tree);
    }
    const other = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
    other.name = "foliage-unknown"; group.add(other);
    layer.addTile(group); layer.update(260, -210);
    expect(layer.info).toEqual({ near: 2, far: 0, draws: 4 });
    expect(other.visible).toBe(true);
    const boundsAt = (species: number, tier: number) => {
      const bark = layer.group.getObjectByName(`sf:foliage:${species}:${tier}:bark`) as THREE.InstancedMesh;
      const leaves = layer.group.getObjectByName(`sf:foliage:${species}:${tier}:leaves`) as THREE.InstancedMesh;
      const matrix = new THREE.Matrix4(); bark.getMatrixAt(0, matrix);
      expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([260 + species * 20, 3, -210]);
      const tint = new THREE.Color(); leaves.getColorAt(0, tint);
      expect(tint.r).toBeCloseTo(0.75); expect(tint.g).toBeCloseTo(0.8); expect(tint.b).toBeCloseTo(0.9);
      return bark.geometry.boundingBox!.clone().union(leaves.geometry.boundingBox!).applyMatrix4(matrix);
    };
    for (const species of [0, 1]) {
      expect(expected[species]!.visible).toBe(false);
      const bounds = boundsAt(species, 0);
      expect(bounds.max.y).toBeCloseTo(15);
      expect(Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z)).toBeCloseTo(4);
    }
    // Re-indexing a ready tile must not duplicate trees or lose the original visibility.
    layer.addTile(group); layer.update(260, -210);
    expect(layer.info.near).toBe(2);
    layer.update(800, -210);
    expect(layer.info).toEqual({ near: 0, far: 2, draws: 4 });
    for (const species of [0, 1]) {
      const bounds = boundsAt(species, 1);
      expect(bounds.max.y).toBeCloseTo(15);
      expect(Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z)).toBeCloseTo(4);
    }
    layer.dispose();
    for (const tree of expected) expect(tree.visible).toBe(true);
  });

  it("keeps nearest trees detailed, bounds near counts, and restores originals on disposal", () => {
    const source = tile(FOLIAGE_NEAR_LIMIT + 10); const layer = new FoliageLayer();
    layer.addTile(source.group); layer.update(100, -50);
    expect(layer.info.near).toBe(FOLIAGE_NEAR_LIMIT);
    expect(layer.info.far).toBe(10);
    expect(layer.info.draws).toBeLessThanOrEqual(8);
    layer.update(1000, -50); expect(layer.info.near).toBe(0);
    layer.update(2000, -50); expect(layer.info.far).toBe(0);
    const leaf = layer.group.getObjectByName("sf:foliage:0:0:leaves") as THREE.InstancedMesh;
    const shader = { uniforms: {}, vertexShader: "#include <begin_vertex>", fragmentShader: "" };
    (leaf.material as THREE.Material).onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("instanceMatrix[3]");
    expect(shader.uniforms).toHaveProperty("fcFoliageTime");
    expect(shader.uniforms).toHaveProperty("fcFogParams");
    layer.dispose(); expect(source.trees.visible).toBe(true);
    expect(layer.info).toEqual({ near: 0, far: 0, draws: 0 });
    expect(layer.group.children).toHaveLength(0);
  });
});
