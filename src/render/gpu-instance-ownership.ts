import * as THREE from "three";
import { StorageInstancedBufferAttribute, type WebGPURenderer } from "three/webgpu";

type GpuAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
interface AttributeManager { delete(attribute: GpuAttribute): unknown }
interface AttributeBackend { createAttribute(attribute: GpuAttribute): void }
interface ColorOwner { array: THREE.TypedArray; owners: number; attributes: Set<GpuAttribute> }
interface InstanceOwner { mesh: THREE.InstancedMesh; matrix: THREE.BufferAttribute | null; color: ColorOwner | null; release: () => void }

/**
 * Own per-object buffers transferred to the pinned r186 native node renderer.
 * Its binding teardown omits storage attributes, and its shared-geometry teardown
 * cannot own each mesh's generated instance-color attribute wrappers.
 */
export class GpuInstanceOwnership {
  private readonly manager: AttributeManager;
  private readonly backend: AttributeBackend;
  private readonly originalCreate: AttributeBackend["createAttribute"];
  private readonly captureCreate: AttributeBackend["createAttribute"];
  private readonly owners = new Set<InstanceOwner>();
  private readonly byMesh = new WeakMap<THREE.InstancedMesh, InstanceOwner>();
  private readonly colors = new WeakMap<THREE.TypedArray, ColorOwner>();
  private readonly transferred = new WeakSet<THREE.BufferAttribute>();

  constructor(renderer: WebGPURenderer) {
    // Compatibility boundary for Three 0.186.1: manager.delete performs the actual
    // backend destruction AND removes its cache/accounting entry. Calling only
    // BufferAttribute.dispose or backend.destroyAttribute leaves stale state.
    this.manager = (renderer as unknown as { _attributes: AttributeManager })._attributes;
    if (!this.manager?.delete) throw new Error("Native instance-buffer ownership requires the pinned Three attribute manager");
    this.backend = renderer.backend as unknown as AttributeBackend;
    this.originalCreate = this.backend.createAttribute;
    this.captureCreate = attribute => {
      this.originalCreate.call(this.backend, attribute);
      const array = (attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
        ? (attribute as THREE.InterleavedBufferAttribute).data.array : (attribute as THREE.BufferAttribute).array;
      let color = this.colors.get(array);
      // setColorAt can create instanceColor after scene admission. This scan runs
      // only on new buffer creation, never for ordinary per-frame buffer updates.
      if (!color) for (const owner of this.owners) {
        if (!owner.color && owner.mesh.instanceColor?.array === array) { this.ownColor(owner); color = owner.color ?? undefined; }
      }
      color?.attributes.add(attribute);
    };
    this.backend.createAttribute = this.captureCreate;
  }

  adopt(mesh: THREE.InstancedMesh): void {
    if (this.byMesh.has(mesh)) return;
    const source = mesh.instanceMatrix;
    if (!(source as THREE.BufferAttribute & { isStorageInstancedBufferAttribute?: boolean }).isStorageInstancedBufferAttribute) {
      const target = new StorageInstancedBufferAttribute(source.array, 16);
      target.name = source.name; target.normalized = source.normalized; target.meshPerAttribute = source.meshPerAttribute;
      target.setUsage(source.usage); target.gpuType = source.gpuType; target.version = source.version + 1;
      for (const range of source.updateRanges) target.addUpdateRange(range.start, range.count);
      mesh.instanceMatrix = target;
      this.transferred.add(target);
    }
    const owner: InstanceOwner = {
      mesh, matrix: this.transferred.has(mesh.instanceMatrix) ? mesh.instanceMatrix : null, color: null,
      release: () => this.release(owner),
    };
    this.byMesh.set(mesh, owner); this.owners.add(owner);
    this.ownColor(owner);
    mesh.addEventListener("dispose", owner.release);
  }

  private ownColor(owner: InstanceOwner): void {
    if (owner.color || !owner.mesh.instanceColor) return;
    const array = owner.mesh.instanceColor.array;
    let color = this.colors.get(array);
    if (!color) { color = { array, owners: 0, attributes: new Set() }; this.colors.set(array, color); }
    color.owners++; owner.color = color;
  }

  private release(owner: InstanceOwner): void {
    if (!this.owners.delete(owner)) return;
    owner.mesh.removeEventListener("dispose", owner.release);
    this.byMesh.delete(owner.mesh);
    if (owner.matrix) this.manager.delete(owner.matrix);
    if (owner.color && --owner.color.owners === 0) {
      for (const attribute of owner.color.attributes) this.manager.delete(attribute);
      this.colors.delete(owner.color.array); owner.color.attributes.clear();
    }
  }

  dispose(): void {
    for (const owner of this.owners) this.release(owner);
    if (this.backend.createAttribute === this.captureCreate) this.backend.createAttribute = this.originalCreate;
  }
}

/** Permanent object retirement; shared geometry, materials and textures retain their own owners. */
export function disposeRenderObjects(root: THREE.Object3D): void {
  root.traverse(object => object.dispose());
}
