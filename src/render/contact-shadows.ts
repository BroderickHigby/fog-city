import * as THREE from "three";
import { injectUniforms } from "./materials.ts";
import { isGpuMaterialsEnabled } from "./node-materials.ts";
import { createContactNodeMaterial } from "./gpu-special.ts";

/** Soft grounding for player bodies without a shadow map or another scene render. */
export class ContactShadows {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly scale = new THREE.Vector3();
  private count = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const material = isGpuMaterialsEnabled() ? createContactNodeMaterial() : new THREE.MeshBasicMaterial({
      name: "fc:contact-shadow", color: 0x101522, opacity: 0.32,
      transparent: true, depthWrite: false, polygonOffset: true,
      polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    if (!isGpuMaterialsEnabled()) material.onBeforeCompile = (shader) => {
      injectUniforms(shader);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vContactUv;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvContactUv = uv;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vContactUv;")
        .replace("#include <alphamap_fragment>", `#include <alphamap_fragment>
          vec2 contact = vContactUv * 2.0 - 1.0;
          diffuseColor.a *= 1.0 - smoothstep(0.12, 1.0, dot(contact, contact));`);
    };
    material.customProgramCacheKey = () => "fc:contact-shadow:v1";
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = "player-contact-shadows";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The batch covers distant players; individual stale bounds must not cull it.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  begin(): void { this.count = 0; }

  add(x: number, y: number, z: number, heading: number, width: number, length: number, pitch = 0, roll = 0): void {
    if (this.count >= this.capacity || ![x, y, z, heading, width, length, pitch, roll].every(Number.isFinite) || width <= 0 || length <= 0) return;
    this.position.set(x, y + 0.035, z);
    this.rotation.setFromEuler(this.euler.set(pitch, -heading, -roll, "YXZ"));
    this.scale.set(width, 1, length);
    this.matrix.compose(this.position, this.rotation, this.scale);
    this.mesh.setMatrixAt(this.count++, this.matrix);
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
