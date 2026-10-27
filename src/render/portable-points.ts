// A CPU-updated point pool on either renderer. Native WebGPU Points are fixed at
// one pixel; instanced sprite corners preserve the authored particle size instead.
import * as THREE from "three";
import { PointsNodeMaterial } from "three/webgpu";
import { attribute, materialOpacity, materialPointSize } from "three/tsl";
import { isGpuMaterialsEnabled } from "./node-materials.ts";
import { injectUniforms } from "./materials.ts";

export interface PortablePoints {
  readonly object: THREE.Points | THREE.Sprite;
  readonly material: THREE.PointsMaterial | PointsNodeMaterial;
  /** Call after the existing position/needsUpdate/drawRange writes. No array copy. */
  sync(): void;
  /** Releases drawing resources; the caller still owns the supplied CPU geometry. */
  dispose(): void;
}

/**
 * Soft particles: each point samples `map` (a round alpha sprite) turned by its own angle, and
 * scales its size and opacity per particle. `attribute` names a vec3 on the source geometry:
 * (size multiplier, opacity multiplier, rotation in radians), written with the positions.
 */
export interface SoftPointOptions {
  map: THREE.Texture;
  attribute: string;
}

/** WebGL PointsMaterial: per-point size, opacity and a rotated map lookup (gl_PointCoord). */
function patchSoftPoints(material: THREE.PointsMaterial, name: string): void {
  material.onBeforeCompile = (shader) => {
    injectUniforms(shader); // Keep the city fog uniforms the default hook would add.
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec3 ${name};\nvarying float vFcAlpha;\nvarying vec2 vFcSpin;`)
      .replace("gl_PointSize = size;", `gl_PointSize = size * ${name}.x;\n\tvFcAlpha = ${name}.y;\n\tvFcSpin = vec2( cos( ${name}.z ), sin( ${name}.z ) );`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vFcAlpha;\nvarying vec2 vFcSpin;")
      .replace("#include <map_particle_fragment>", [
        "vec2 fcPc = vec2( gl_PointCoord.x, 1.0 - gl_PointCoord.y ) - 0.5;",
        "vec2 fcUv = vec2( vFcSpin.x * fcPc.x - vFcSpin.y * fcPc.y, vFcSpin.y * fcPc.x + vFcSpin.x * fcPc.y ) + 0.5;",
        "diffuseColor *= texture2D( map, fcUv );",
        "diffuseColor.a *= vFcAlpha;",
      ].join("\n"));
  };
  material.customProgramCacheKey = () => `fc:soft-points:${name}`;
}

/** Existing pools use a zero-based active prefix and retain their own CPU update API. */
export function createPortablePoints(source: THREE.BufferGeometry, options: THREE.PointsMaterialParameters, soft?: SoftPointOptions): PortablePoints {
  const params = soft ? { ...options, map: soft.map } : options;
  if (!isGpuMaterialsEnabled()) {
    const material = new THREE.PointsMaterial(params), object = new THREE.Points(source, material);
    if (soft) patchSoftPoints(material, soft.attribute);
    return { object, material, sync() {}, dispose() { material.dispose(); } };
  }
  const position = source.getAttribute("position") as THREE.BufferAttribute;
  const mirror = (from: THREE.BufferAttribute): THREE.InstancedBufferAttribute => {
    const to = new THREE.InstancedBufferAttribute(from.array, from.itemSize, from.normalized).setUsage(from.usage);
    to.gpuType = from.gpuType;
    return to;
  };
  const positions = mirror(position);
  const material = new PointsNodeMaterial(params);
  material.alphaToCoverage = false;
  material.positionNode = attribute("fcParticlePosition", "vec3");
  const object = new THREE.Sprite(material);
  // Sprite's built-in corners include real 0..1 UVs. Do not attach instance data
  // to its globally shared geometry or fabricate UVs on the original point cloud.
  object.geometry = object.geometry.clone();
  object.geometry.setAttribute("fcParticlePosition", positions);
  const pairs: Array<{ from: THREE.BufferAttribute; to: THREE.InstancedBufferAttribute; version: number }> = [{ from: position, to: positions, version: -1 }];
  if (soft) {
    const from = source.getAttribute(soft.attribute) as THREE.BufferAttribute, to = mirror(from);
    object.geometry.setAttribute("fcParticlePuff", to);
    pairs.push({ from, to, version: -1 });
    const puff = attribute("fcParticlePuff", "vec3");
    material.sizeNode = materialPointSize.mul(puff.x);
    material.opacityNode = materialOpacity.mul(puff.y);
    material.rotationNode = puff.z; // Turns the sprite's corners, and so its map, per particle.
  }
  object.count = 0;
  object.frustumCulled = false; // These dynamic impact pools already bypass culling.
  let previousCount = -1, disposed = false;
  return {
    object, material,
    sync() {
      if (disposed) return;
      const count = Math.min(position.count, Math.max(0, Math.floor(source.drawRange.count)));
      object.count = count;
      const resized = count !== previousCount;
      for (const pair of pairs) {
        if (pair.from.version === pair.version && !resized) continue;
        pair.to.clearUpdateRanges();
        if (count > 0) { pair.to.addUpdateRange(0, count * pair.to.itemSize); pair.to.needsUpdate = true; }
        pair.version = pair.from.version;
      }
      previousCount = count;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      object.geometry.dispose(); material.dispose();
    },
  };
}
