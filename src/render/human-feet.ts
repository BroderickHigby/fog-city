// Render-only contact correction on the authored skeleton. The public body root remains at
// its supplied support height; a child receives only the clearance its posed shoes need.
import * as THREE from "three";

const CLEARANCE_M = 0.004;
const MAX_CORRECTION_M = 0.25;
const TOE_YAW_RAD = 8 * Math.PI / 180;
export type HumanSupportHeight = (x: number, referenceY: number, z: number) => number | undefined;
interface ShoeMesh { mesh: THREE.SkinnedMesh; vertices: number[] }
interface Shoe { bone: THREE.Object3D; toe: THREE.Object3D; meshes: ShoeMesh[] }

/** Contact vertices from the actual weighted shoes, posed independently on every clone. */
export class HumanFeet {
  private readonly shoes: Shoe[] = [];
  private readonly point = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly inverse = new THREE.Matrix4();
  private readonly rootRotation = new THREE.Quaternion();
  private readonly inverseRootRotation = new THREE.Quaternion();
  private readonly parentRotation = new THREE.Quaternion();
  private readonly rotation = new THREE.Quaternion();
  private readonly correction = new THREE.Quaternion();
  private readonly baseY: number;
  private readonly root: THREE.Object3D;
  private readonly content: THREE.Object3D;

  constructor(root: THREE.Object3D, content: THREE.Object3D) {
    this.root = root;
    this.content = content;
    this.baseY = content.position.y;
    root.updateMatrixWorld(true);
    for (const side of ["L", "R"]) {
      const bone = content.getObjectByName(`Bip01_${side}_Foot`);
      const toe = content.getObjectByName(`Bip01_${side}_Toe0`);
      if (!bone || !toe) continue;
      const meshes: ShoeMesh[] = [];
      content.traverse(object => {
        const mesh = object as THREE.SkinnedMesh;
        if (!mesh.isSkinnedMesh) return;
        const indices = mesh.geometry.getAttribute("skinIndex"), weights = mesh.geometry.getAttribute("skinWeight");
        if (!indices || !weights) return;
        const bones = new Set(mesh.skeleton.bones.flatMap((b, i) => b.name.startsWith(`Bip01_${side}_`) && /_Foot$|_Toe/.test(b.name) ? [i] : []));
        const candidates: number[] = [];
        for (let i = 0; i < indices.count; i++) {
          let weight = 0;
          for (let k = 0; k < 4; k++) if (bones.has(indices.getComponent(i, k))) weight += weights.getComponent(i, k);
          if (weight < 0.5) continue;
          candidates.push(i);
        }
        // Include every strongly shoe-weighted vertex. A rest-pose hull misses vertices when
        // toe joints bend or clips blend, which is exactly when a shoe used to cut the floor.
        // Membership is cached once; runtime never scans the full body geometry.
        if (candidates.length) meshes.push({ mesh, vertices: candidates });
      });
      if (meshes.length) this.shoes.push({ bone, toe, meshes });
    }
  }

  private low(shoe: Shoe, support?: HumanSupportHeight): number {
    let height = Infinity;
    for (const { mesh, vertices } of shoe.meshes) for (const index of vertices) {
      mesh.getVertexPosition(index, this.point).applyMatrix4(mesh.matrixWorld);
      const floor = support?.(this.point.x, this.root.matrixWorld.elements[13]!, this.point.z);
      if (floor !== undefined && Number.isFinite(floor)) height = Math.min(height, this.point.y - floor);
      else {
        this.point.applyMatrix4(this.inverse);
        height = Math.min(height, this.point.y);
      }
    }
    return height;
  }

  update(running: boolean, support?: HumanSupportHeight): void {
    this.content.position.y = this.baseY;
    this.root.updateMatrixWorld(true);
    this.inverse.copy(this.root.matrixWorld).invert();
    if (running) {
      this.root.getWorldQuaternion(this.rootRotation);
      this.inverseRootRotation.copy(this.rootRotation).invert();
      this.axis.set(0, 1, 0).applyQuaternion(this.rootRotation);
      for (const shoe of this.shoes) {
        const low = this.low(shoe, support);
        if (low >= 0.12) continue;
        shoe.toe.getWorldPosition(this.direction);
        shoe.bone.getWorldPosition(this.point);
        this.direction.sub(this.point).applyQuaternion(this.inverseRootRotation);
        // A lifted heel naturally points down and sometimes behind. Correct only the planted
        // shoe's sideways yaw, leaving its pitch, the shin, knee and airborne heel kick intact.
        if (this.direction.z >= -0.05) continue;
        const yaw = Math.atan2(this.direction.x, -this.direction.z);
        const target = Math.max(-TOE_YAW_RAD, Math.min(TOE_YAW_RAD, yaw));
        const u = Math.max(0, Math.min(1, (0.12 - low) / 0.08));
        const weight = u * u * (3 - 2 * u);
        if (Math.abs(yaw - target) < 1e-5) continue;
        this.correction.setFromAxisAngle(this.axis, (yaw - target) * weight);
        shoe.bone.getWorldQuaternion(this.rotation).premultiply(this.correction);
        shoe.bone.parent!.getWorldQuaternion(this.parentRotation);
        shoe.bone.quaternion.copy(this.parentRotation.invert().multiply(this.rotation));
        shoe.bone.updateMatrixWorld(true);
      }
    }
    let low = Infinity;
    for (const shoe of this.shoes) low = Math.min(low, this.low(shoe, support));
    if (Number.isFinite(low) && low < CLEARANCE_M) {
      this.content.position.y += Math.min(MAX_CORRECTION_M, CLEARANCE_M - low);
      this.content.updateMatrixWorld(true);
    }
  }
}
