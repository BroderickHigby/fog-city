import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { instancedBufferAttribute } from "three/tsl";
import Info from "three/src/renderers/common/Info.js";
// The pinned renderer's internal lifecycle modules have no matching declarations.
// @ts-expect-error The test deliberately exercises the installed r186 manager.
import Attributes from "three/src/renderers/common/Attributes.js";
// @ts-expect-error The test deliberately exercises the installed r186 binding teardown.
import Bindings from "three/src/renderers/common/Bindings.js";
// @ts-expect-error Internal binding container, used with the actual manager above.
import BindGroup from "three/src/renderers/common/BindGroup.js";
// @ts-expect-error Internal storage binding, used with the actual manager above.
import StorageBuffer from "three/src/renderers/common/StorageBuffer.js";
// @ts-expect-error Internal uniform binding, used with the actual manager above.
import UniformBuffer from "three/src/renderers/common/UniformBuffer.js";
import { AttributeType } from "three/src/renderers/common/Constants.js";
import { disposeRenderObjects, GpuInstanceOwnership } from "../../src/render/gpu-instance-ownership.ts";
import { StreetDetailLayer } from "../../src/render/street-detail.ts";

function fixture() {
  const info = new Info();
  const backend = {
    createAttribute: vi.fn(), createStorageAttribute: vi.fn(), destroyAttribute: vi.fn(),
    createUniformBuffer: vi.fn(), destroyUniformBuffer: vi.fn(), createBindings: vi.fn(), deleteBindGroupData: vi.fn(),
  };
  const attributes = new Attributes(backend, info);
  const bindings = new Bindings(backend, null, {}, attributes, {}, info);
  const originalCreate = backend.createAttribute;
  const ownership = new GpuInstanceOwnership({ backend, _attributes: attributes } as never);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, 4);
  mesh.setColorAt(0, new THREE.Color(0x996644));
  return { info, backend, attributes, bindings, ownership, mesh, geometry, material, originalCreate };
}

function uploadColor(f: ReturnType<typeof fixture>, mesh = f.mesh) {
  // InstanceNode creates a node-level wrapper sharing the original color array.
  const node = instancedBufferAttribute(mesh.instanceColor!, "vec3", 3, 0) as unknown as {
    setup(builder: unknown): void; attribute: THREE.InterleavedBufferAttribute;
  };
  node.setup({ getTypeLength: () => 3 } as never);
  f.attributes.update(node.attribute, AttributeType.VERTEX);
  return node.attribute;
}

describe("native instance buffer ownership", () => {
  it("destroys transferred storage and generated color buffers, with real r186 accounting and UBO teardown", () => {
    const f = fixture(), array = f.mesh.instanceMatrix.array;
    f.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    f.mesh.instanceMatrix.addUpdateRange(0, 16);
    const matrix = new THREE.Matrix4().makeTranslation(7, 0, 3); f.mesh.setMatrixAt(0, matrix);
    const geometryDisposal = vi.fn(), materialDisposal = vi.fn();
    f.geometry.addEventListener("dispose", geometryDisposal); f.material.addEventListener("dispose", materialDisposal);
    f.ownership.adopt(f.mesh);
    expect(f.mesh.instanceMatrix.array).toBe(array);
    expect(f.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 16 }]);
    expect(f.mesh.instanceMatrix.usage).toBe(THREE.DynamicDrawUsage);
    expect(new THREE.Matrix4().fromArray(array, 0).equals(matrix)).toBe(true);
    const group = new BindGroup("fixture", [new StorageBuffer("matrix", f.mesh.instanceMatrix), new UniformBuffer("object", new Float32Array(64))]);
    f.bindings._createBindings([group]); uploadColor(f);
    const retired = () => { f.mesh.removeEventListener("dispose", retired); f.bindings._destroyBindings([group]); };
    f.mesh.addEventListener("dispose", retired);
    expect(f.info.memory.storageAttributes).toBe(1); expect(f.info.memory.uniformBuffers).toBe(1); expect(f.info.memory.attributes).toBe(1);
    const root = new THREE.Group(); root.add(f.mesh); disposeRenderObjects(root);
    expect(f.backend.destroyAttribute).toHaveBeenCalledTimes(2);
    expect(f.backend.destroyUniformBuffer).toHaveBeenCalledTimes(1);
    expect(f.info.memory.total).toBe(0);
    expect(f.info.memory.storageAttributes).toBe(0); expect(f.info.memory.attributes).toBe(0); expect(f.info.memory.uniformBuffers).toBe(0);
    expect(geometryDisposal).not.toHaveBeenCalled(); expect(materialDisposal).not.toHaveBeenCalled();
    f.mesh.dispose(); expect(f.backend.destroyAttribute).toHaveBeenCalledTimes(2);
    f.ownership.dispose(); expect(f.backend.createAttribute).toBe(f.originalCreate);
  });

  it("preserves resources across temporary reparenting and repeated admission", () => {
    const f = fixture(); f.ownership.adopt(f.mesh);
    const matrix = f.mesh.instanceMatrix;
    f.attributes.update(matrix, AttributeType.STORAGE); uploadColor(f);
    const before = f.info.memory.total, a = new THREE.Group(), b = new THREE.Group();
    a.add(f.mesh); b.add(f.mesh); b.remove(f.mesh); a.add(f.mesh); f.ownership.adopt(f.mesh);
    expect(f.mesh.instanceMatrix).toBe(matrix); expect(f.info.memory.total).toBe(before);
    expect(f.backend.destroyAttribute).not.toHaveBeenCalled();
    f.mesh.dispose(); expect(f.info.memory.total).toBe(0); f.ownership.dispose();
  });

  it("retains shared color buffers until their last object owner retires and preserves writer stride", () => {
    const f = fixture(), other = new THREE.InstancedMesh(f.geometry, f.material, 4);
    other.instanceColor = f.mesh.instanceColor;
    f.ownership.adopt(f.mesh); f.ownership.adopt(other);
    uploadColor(f); uploadColor(f, other);
    const sharedAttributes = f.info.memory.attributes;
    const color = f.mesh.instanceColor!, array = color.array;
    other.setColorAt(2, new THREE.Color(.2, .4, .6));
    expect(color.itemSize).toBe(3); expect(color.array).toBe(array);
    expect(Array.from(array.slice(6, 9))).toEqual([expect.closeTo(.2), expect.closeTo(.4), expect.closeTo(.6)]);
    f.mesh.dispose(); expect(f.info.memory.attributes).toBe(sharedAttributes); expect(f.backend.destroyAttribute).not.toHaveBeenCalled();
    other.dispose(); expect(f.info.memory.total).toBe(0); expect(f.backend.destroyAttribute).toHaveBeenCalledTimes(sharedAttributes);
    f.ownership.dispose();
  });

  it("owns instance colors created after admission and leaves prototype attributes untouched", () => {
    const f = fixture(); f.mesh.instanceColor = null; f.ownership.adopt(f.mesh);
    const position = f.geometry.getAttribute("position"); f.attributes.update(position, AttributeType.VERTEX);
    const prototypeBytes = f.info.memory.total;
    f.mesh.setColorAt(0, new THREE.Color(.3, .4, .5)); uploadColor(f);
    f.mesh.dispose();
    expect(f.info.memory.total).toBe(prototypeBytes); expect(f.attributes.has(position)).toBe(true);
    f.attributes.delete(position); expect(f.info.memory.total).toBe(0); f.ownership.dispose();
  });

  it("retires ordinary and nested cell objects on a permanent drop without disposing shared materials", () => {
    const group = new THREE.Group(), nested = new THREE.Group(), geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
    const patch = new THREE.Mesh(geometry, material), sign = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const retired = vi.fn(), sharedDisposed = vi.fn(), cellOwnerDisposed = vi.fn();
    patch.addEventListener("dispose", retired); sign.addEventListener("dispose", retired); material.addEventListener("dispose", sharedDisposed);
    nested.add(sign); group.add(patch, nested);
    const cell = { built: { meshes: [patch, nested], furniture: { dispose: cellOwnerDisposed } } };
    const prototype = StreetDetailLayer.prototype as unknown as { drop(cell: unknown): void };
    prototype.drop.call({ group }, cell);
    expect(retired).toHaveBeenCalledTimes(2); expect(cellOwnerDisposed).toHaveBeenCalledTimes(1);
    expect(sharedDisposed).not.toHaveBeenCalled(); expect(group.children).toHaveLength(0); expect(cell.built).toBeNull();
  });
});
