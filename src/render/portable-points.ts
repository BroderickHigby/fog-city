// A CPU-updated point pool on either renderer. Native WebGPU Points are fixed at
// one pixel; instanced sprite corners preserve the authored particle size instead.
import * as THREE from "three";
import { PointsNodeMaterial } from "three/webgpu";
import { attribute } from "three/tsl";
import { isGpuMaterialsEnabled } from "./node-materials.ts";

export interface PortablePoints {
  readonly object: THREE.Points | THREE.Sprite;
  readonly material: THREE.PointsMaterial | PointsNodeMaterial;
  /** Call after the existing position/needsUpdate/drawRange writes. No array copy. */
  sync(): void;
  /** Releases drawing resources; the caller still owns the supplied CPU geometry. */
  dispose(): void;
}

/** Existing pools use a zero-based active prefix and retain their own CPU update API. */
export function createPortablePoints(source: THREE.BufferGeometry, options: THREE.PointsMaterialParameters): PortablePoints {
  if (!isGpuMaterialsEnabled()) {
    const material = new THREE.PointsMaterial(options), object = new THREE.Points(source, material);
    return { object, material, sync() {}, dispose() { material.dispose(); } };
  }
  const position = source.getAttribute("position") as THREE.BufferAttribute;
  const positions = new THREE.InstancedBufferAttribute(position.array, 3, position.normalized).setUsage(position.usage);
  positions.gpuType = position.gpuType;
  const material = new PointsNodeMaterial(options);
  material.alphaToCoverage = false;
  material.positionNode = attribute("fcParticlePosition", "vec3");
  const object = new THREE.Sprite(material);
  // Sprite's built-in corners include real 0..1 UVs. Do not attach instance data
  // to its globally shared geometry or fabricate UVs on the original point cloud.
  object.geometry = object.geometry.clone();
  object.geometry.setAttribute("fcParticlePosition", positions);
  object.count = 0;
  object.frustumCulled = false; // These dynamic impact pools already bypass culling.
  let version = -1, previousCount = -1, disposed = false;
  return {
    object, material,
    sync() {
      if (disposed) return;
      const count = Math.min(position.count, Math.max(0, Math.floor(source.drawRange.count)));
      object.count = count;
      if (position.version !== version || count !== previousCount) {
        positions.clearUpdateRanges();
        if (count > 0) { positions.addUpdateRange(0, count * 3); positions.needsUpdate = true; }
        version = position.version; previousCount = count;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      object.geometry.dispose(); material.dispose();
    },
  };
}
