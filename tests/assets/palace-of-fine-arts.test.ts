import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { validateBytes } from "gltf-validator";
import { allPositions, box, loadModel, materialTriangles, node, sceneNodes, triangleCount } from "./glb.ts";

const file = "palace-of-fine-arts.glb";

describe("Palace of Fine Arts architectural asset", () => {
  it("is a self-contained valid GLB within the static landmark budgets", async () => {
    const { bytes, doc } = await loadModel(file);
    const report = await validateBytes(bytes, { maxIssues: 30 });
    expect(report.issues.numErrors, JSON.stringify(report.issues.messages)).toBe(0);
    expect(bytes.byteLength).toBeLessThan(3_000_000);
    expect(triangleCount(doc)).toBeGreaterThan(20_000);
    expect(triangleCount(doc)).toBeLessThan(40_000);
    expect(doc.getRoot().listTextures()).toHaveLength(0);
    expect(doc.getRoot().listAnimations()).toHaveLength(0);
    const draws = sceneNodes(doc).reduce((sum, n) => sum + (n.getMesh()?.listPrimitives().length ?? 0), 0);
    expect(draws).toBeLessThanOrEqual(8);
  });

  it("keeps the surveyed silhouette, model origin and original stone palette", async () => {
    const { doc, json } = await loadModel(file);
    const b = box(allPositions(doc));
    expect(Math.abs(b.min[1])).toBeLessThan(.03);
    expect(b.max[1]).toBeCloseTo(49.3776, 1);
    expect(b.min[0]).toBeGreaterThan(-113); expect(b.max[0]).toBeLessThan(111);
    expect(b.min[2]).toBeGreaterThan(-43); expect(b.max[2]).toBeLessThan(38);
    expect(node(doc, "palace_of_fine_arts").getExtras().openRotunda).toBe(true);
    expect(node(doc, "rotunda").getMesh()).not.toBeNull();
    expect(node(doc, "colonnades").getMesh()).not.toBeNull();
    expect(doc.getRoot().listMaterials()).toHaveLength(5);
    for (const m of doc.getRoot().listMaterials()) {
      expect(m.getMetallicFactor(), m.getName()).toBe(0);
      expect(m.getBaseColorFactor()[0], m.getName()).toBeGreaterThan(m.getBaseColorFactor()[1]!);
    }
    for (const m of json.materials ?? []) expect(m.alphaMode ?? "OPAQUE").toBe("OPAQUE");
    expect(materialTriangles(doc, "palace_coffer_recess").length).toBeGreaterThan(440);
  });

  it("has open ground-level passages through the rotunda rather than a solid proxy", async () => {
    const { doc } = await loadModel(file);
    const triangles = doc.getRoot().listMaterials().flatMap(m => materialTriangles(doc, m.getName()));
    const coordinates = new Float32Array(triangles.flat(2));
    const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(coordinates, 3));
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.updateMatrixWorld(true);
    try {
      for (const [origin, direction, distance] of [
        [[0, 1.8, -35], [0, 0, 1], 70],
        [[-35, 1.8, 0], [1, 0, 0], 70],
        [[0, 1, 0], [0, -1, 0], 2],
      ] as const) {
        const ray = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction), 0, distance);
        expect(ray.intersectObject(mesh)).toHaveLength(0);
      }
      const ceiling = new THREE.Raycaster(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 1, 0)).intersectObject(mesh)[0];
      expect(ceiling?.point.y).toBeGreaterThan(45);
    } finally {
      geometry.dispose(); material.dispose();
    }
  });
});
