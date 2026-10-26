import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { packGeometry } from "../../src/render/agent-packing.ts";
import { interleaveGpuPackedGeometry, prepareGpuScene, setGpuMaterialsEnabled } from "../../src/render/node-materials.ts";

afterEach(() => setGpuMaterialsEnabled(false));

describe("portable node material admission", () => {
  it.each([false, true])("packs static fields within eight buffer bindings (people=%s)", slots => {
    const prototype = packGeometry(new THREE.BoxGeometry(1, 1, 1), {
      color: [.3, .4, .5], roughness: .6, metalness: .2, emissive: [0, 0, 0], channel: 0,
    }, null, slots);
    const geometry = prototype.clone();
    const live = slots
      ? { fcCue: 4, fcColA: 3, fcColB: 3, fcColC: 3, fcColD: 3 }
      : { fcCue: 4, fcCarPaint: 4, fcCarAccent: 3, fcCarMotion: 2 };
    for (const [name, size] of Object.entries(live)) {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(32 * size), size);
      attribute.setUsage(THREE.DynamicDrawUsage); attribute.addUpdateRange(0, size * 3);
      geometry.setAttribute(name, attribute);
    }
    const before = Object.entries(geometry.attributes).map(([name, attribute]) => ({
      name, attribute, values: Array.from(attribute.array),
    }));
    interleaveGpuPackedGeometry(geometry);
    const buffers = new Set(Object.values(geometry.attributes).map(attribute =>
      (attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
        ? (attribute as THREE.InterleavedBufferAttribute).data : attribute));
    // Include the framework's interleaved instance matrix on the WebGL node backend.
    expect(buffers.size + 1).toBeLessThanOrEqual(8);
    for (const { name, attribute, values } of before) {
      const packed = geometry.getAttribute(name);
      for (let row = 0; row < packed.count; row++) {
        for (let component = 0; component < packed.itemSize; component++) {
          expect(packed.getComponent(row, component)).toBe(values[row * packed.itemSize + component]);
        }
      }
      if ((attribute as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) {
        expect(packed).toBe(attribute);
        expect((packed as THREE.InstancedBufferAttribute).updateRanges).toEqual([{ start: 0, count: packed.itemSize * 3 }]);
      }
    }
    expect(Object.values(prototype.attributes).every(attribute =>
      !(attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute)).toBe(true);
    const first = geometry.getAttribute("position");
    interleaveGpuPackedGeometry(geometry);
    expect(geometry.getAttribute("position")).toBe(first);
    geometry.dispose(); prototype.dispose();
  });

  it("retains additive FX state, live opacity and source disposal ownership", () => {
    setGpuMaterialsEnabled(true);
    const source = new THREE.MeshBasicMaterial({
      color: 0xffaa55, transparent: true, opacity: .4, blending: THREE.AdditiveBlending,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), source);
    prepareGpuScene(mesh);
    const admitted = mesh.material;
    expect(admitted).not.toBe(source);
    expect(admitted.blending).toBe(THREE.AdditiveBlending);
    expect(admitted.depthWrite).toBe(false);
    expect(admitted.polygonOffsetFactor).toBe(-2);
    source.opacity = .15; expect(admitted.opacity).toBe(.15);
    admitted.opacity = .8; expect(source.opacity).toBe(.8);
    let disposed = false;
    admitted.addEventListener("dispose", () => { disposed = true; });
    source.dispose(); expect(disposed).toBe(true);
    mesh.geometry.dispose();
  });
});
