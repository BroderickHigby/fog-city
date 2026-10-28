// Original warning diamond and real combat timing for confirmed hostile robots.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { SimState } from "../sim/contract.ts";
import { hostileMarkers, HOSTILE_MARKER_LIMIT } from "../presentation/hostile-robots.ts";
import { retireRenderTree } from "./renderer-warmup.ts";
export { hostileMarkers, HOSTILE_MARKER_LIMIT, HOSTILE_MARKER_RANGE } from "../presentation/hostile-robots.ts";
export type { HostileMarker } from "../presentation/hostile-robots.ts";

/** About 1–2.3 m wide: bounded world geometry remains readable at 35–80 m. */
export function hostileMarkerSize(distance: number): number { return Math.max(1, Math.min(2.3, distance * .029)); }

function joined(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const result = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!result) throw new Error("Hostile marker geometry could not be combined");
  return result;
}

/** Original diamond + exclamation mark. Opaque, normal depth testing, no screen overlay. */
export class HostileMarkerLayer {
  readonly root = new THREE.Group();
  private readonly scene: THREE.Scene;
  private meshes: THREE.InstancedMesh[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly facing = new THREE.Quaternion();
  private readonly forward = new THREE.Vector3();
  private count = 0;
  private windups = 0;
  private disposed = false;

  constructor(scene: THREE.Scene) { this.scene = scene; this.root.name = "hostile-markers"; this.root.visible = false; }

  private allocate(): void {
    if (this.meshes.length) return;
    const diamond = new THREE.PlaneGeometry(Math.SQRT1_2, Math.SQRT1_2).rotateZ(Math.PI / 4);
    const exclamation = joined([new THREE.PlaneGeometry(.12, .35).translate(0, .08, 0), new THREE.PlaneGeometry(.12, .12).translate(0, -.23, 0)]);
    // Two side chevrons appear only during a real pending combat wind-up.
    const cue = joined([new THREE.PlaneGeometry(.12, .46).rotateZ(-.35).translate(-.66, 0, 0), new THREE.PlaneGeometry(.12, .46).rotateZ(.35).translate(.66, 0, 0)]);
    const dark = new THREE.MeshBasicMaterial({ color: 0x111820, depthTest: true, depthWrite: true, toneMapped: false });
    const amber = new THREE.MeshBasicMaterial({ color: 0xffbb35, depthTest: true, depthWrite: true, toneMapped: false });
    const white = new THREE.MeshBasicMaterial({ color: 0xfff4d9, depthTest: true, depthWrite: true, toneMapped: false });
    this.meshes = [new THREE.InstancedMesh(diamond, dark, HOSTILE_MARKER_LIMIT), new THREE.InstancedMesh(diamond, amber, HOSTILE_MARKER_LIMIT),
      new THREE.InstancedMesh(exclamation, dark, HOSTILE_MARKER_LIMIT), new THREE.InstancedMesh(cue, white, HOSTILE_MARKER_LIMIT)];
    const names = ["hostile-outline", "hostile-face", "hostile-exclamation", "hostile-windup"];
    this.meshes.forEach((mesh, index) => {
      mesh.name = names[index]!; mesh.count = 0; mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.castShadow = false; mesh.receiveShadow = false;
      this.root.add(mesh);
    });
    this.scene.add(this.root);
  }

  update(state: Readonly<SimState>, playerId: string, camera: THREE.Camera): void {
    if (this.disposed) return;
    const rows = hostileMarkers(state, playerId);
    this.count = rows.length; this.windups = 0; this.root.visible = rows.length > 0;
    if (!rows.length) { for (const mesh of this.meshes) mesh.count = 0; return; }
    this.allocate();
    camera.getWorldQuaternion(this.facing);
    this.forward.set(0, 0, 1).applyQuaternion(this.facing);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!, size = hostileMarkerSize(row.distance);
      for (let part = 0; part < 4; part++) {
        if (part === 3 && !row.windup) continue;
        // Physical separation toward the camera prevents coplanar fighting; walls still occlude all layers.
        const depth = part * .008, extent = part === 1 ? .83 : 1;
        this.position.set(row.x, row.y + row.height + .3 + size * .5, row.z).addScaledVector(this.forward, depth);
        const pulse = part === 3 ? 1 + .12 * Math.sin(row.windup!.progress * Math.PI * 4) : 1;
        this.scale.set(size * extent * pulse, size * extent * pulse, 1);
        this.matrix.compose(this.position, this.facing, this.scale);
        this.meshes[part]!.setMatrixAt(part === 3 ? this.windups++ : index, this.matrix);
      }
    }
    this.meshes.forEach((mesh, index) => { mesh.count = index === 3 ? this.windups : rows.length; mesh.instanceMatrix.needsUpdate = true; });
  }

  info(): { targets: number; windups: number; drawCalls: number; triangles: number } {
    if (this.disposed || !this.root.visible) return { targets: 0, windups: 0, drawCalls: 0, triangles: 0 };
    return { targets: this.count, windups: this.windups, drawCalls: this.windups ? 4 : 3, triangles: this.count * 8 + this.windups * 4 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.root.visible = false;
    void retireRenderTree(this.root, () => {
      const geometries = new Set(this.meshes.map(mesh => mesh.geometry)), materials = new Set(this.meshes.map(mesh => mesh.material as THREE.Material));
      for (const mesh of this.meshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      this.root.clear(); this.meshes = [];
    });
  }
}
