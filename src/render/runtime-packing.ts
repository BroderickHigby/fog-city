import * as THREE from "three";
import { mergePacked, packGeometry, surfaceOf } from "./agent-packing.ts";
import { lightChannel } from "./lights.ts";

export type RuntimeRigidAnimation = "fixed" | "left-leg" | "right-leg" | "left-wing" | "right-wing" | "rotor" | "wheel" | "sign" | "left-arm" | "right-arm";
export interface RuntimeRigidPart {
  geometry: THREE.BufferGeometry;
  pivot: readonly [number, number, number];
  animation: RuntimeRigidAnimation;
  rest?: THREE.Matrix4;
  material?: THREE.Material | THREE.Material[];
  draws?: number;
}

export interface RuntimeAuthoredPackingOptions {
  /** Return a renderer-owned material, for example a clone with the live bus livery. */
  material?: (source: THREE.Material) => THREE.Material;
  omit?: (mesh: THREE.Mesh) => boolean;
  joint?: (mesh: THREE.Mesh, root: THREE.Object3D) => { object: THREE.Object3D; animation: RuntimeRigidAnimation } | null;
}

/** Only surfaces reproduced exactly by the existing packed PBR shader can share a draw. */
function canPack(material: THREE.Material): material is THREE.MeshStandardMaterial {
  const standard = material as THREE.MeshStandardMaterial;
  if (!standard.isMeshStandardMaterial || (standard as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial ||
      standard.transparent || standard.opacity !== 1 || standard.alphaTest !== 0 || standard.wireframe ||
      standard.side !== THREE.FrontSide || standard.blending !== THREE.NormalBlending ||
      !standard.depthTest || !standard.depthWrite || !standard.colorWrite || standard.flatShading) return false;
  // Texture coordinates and image sampling must stay with their original material.
  if (Object.values(standard).some(value => value instanceof THREE.Texture)) return false;
  // Named game lights have their own vertex channel. Unnamed custom emission needs its material.
  if (standard.emissive.getHex() !== 0 && lightChannel(standard.name) === 0) return false;
  return true;
}

/** A cheap, owned geometry view: source attributes are shared and never modified or disposed. */
function geometryView(source: THREE.BufferGeometry, start = 0, count = source.index?.count ?? source.getAttribute("position").count): THREE.BufferGeometry {
  const view = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) view.setAttribute(name, attribute);
  const available = source.index?.count ?? source.getAttribute("position").count;
  if (start === 0 && count === available) view.setIndex(source.index);
  else {
    const indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) indices[i] = source.index ? source.index.getX(start + i) : start + i;
    view.setIndex(new THREE.BufferAttribute(indices, 1));
  }
  for (const group of source.groups) view.addGroup(group.start, group.count, group.materialIndex);
  view.boundingBox = source.boundingBox?.clone() ?? null;
  view.boundingSphere = source.boundingSphere?.clone() ?? null;
  return view;
}

function packSurface(source: THREE.BufferGeometry, material: THREE.MeshStandardMaterial, transform: THREE.Matrix4): THREE.BufferGeometry {
  const geometry = packGeometry(source, surfaceOf(material), transform, false);
  const authoredColor = material.vertexColors ? source.getAttribute("color") : undefined;
  if (authoredColor) {
    const packedColor = geometry.getAttribute("color");
    for (let i = 0; i < packedColor.count; i++) packedColor.setXYZ(i,
      packedColor.getX(i) * authoredColor.getX(i),
      packedColor.getY(i) * authoredColor.getY(i),
      packedColor.getZ(i) * authoredColor.getZ(i));
  }
  return geometry;
}

/**
 * Keep every authored triangle, packing material-compatible primitives per rigid joint.
 * Textured/custom surfaces retain their own material/UV draw; wheel pivots remain distinct.
 * Returned geometries are owned by the caller. Original geometry and materials are untouched.
 */
export function packAuthoredRuntimeParts(root: THREE.Object3D, options: RuntimeAuthoredPackingOptions = {}): RuntimeRigidPart[] {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert(), parts: RuntimeRigidPart[] = [];
  const buckets = new Map<THREE.Object3D, { pivot: readonly [number, number, number]; animation: RuntimeRigidAnimation; geometries: THREE.BufferGeometry[] }>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute("position") || options.omit?.(mesh)) return;
    let joint = root;
    for (let parent: THREE.Object3D | null = mesh; parent && parent !== root; parent = parent.parent) {
      // GLTFLoader names the primitive children wheel_FL, wheel_FL_1, etc.; they
      // all belong to the outer wheel group and must rotate about the same pivot.
      if (/^wheel_/i.test(parent.name)) joint = parent;
    }
    const assigned = options.joint?.(mesh, root);
    if (assigned) joint = assigned.object;
    const point = joint === root ? new THREE.Vector3() : new THREE.Vector3().setFromMatrixPosition(inverse.clone().multiply(joint.matrixWorld));
    const pivot: readonly [number, number, number] = [point.x, point.y, point.z];
    const transform = new THREE.Matrix4().makeTranslation(-point.x, -point.y, -point.z).multiply(inverse.clone().multiply(mesh.matrixWorld));
    let bucket = buckets.get(joint);
    if (!bucket) { bucket = { pivot, animation: assigned?.animation ?? (joint === root ? "fixed" : "wheel"), geometries: [] }; buckets.set(joint, bucket); }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const total = mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count;
    const groups = Array.isArray(mesh.material) ? mesh.geometry.groups : [{ start: 0, count: total, materialIndex: 0 }];
    for (const group of groups) {
      const original = materials[group.materialIndex ?? 0];
      if (!original) continue;
      const material = options.material?.(original) ?? original;
      const start = Math.max(group.start, mesh.geometry.drawRange.start);
      const end = Math.min(group.start + group.count, total, mesh.geometry.drawRange.start + mesh.geometry.drawRange.count);
      if (end <= start) continue;
      const geometry = geometryView(mesh.geometry, start, end - start);
      const vertexAlpha = material instanceof THREE.MeshStandardMaterial && material.vertexColors && (geometry.getAttribute("color")?.itemSize ?? 0) > 3;
      if (canPack(material) && !vertexAlpha) {
        bucket.geometries.push(packSurface(geometry, material, transform)); geometry.dispose();
      } else {
        parts.push({ geometry, pivot, animation: bucket.animation, rest: transform.clone(), material, draws: 1 });
      }
    }
  });
  for (const bucket of buckets.values()) {
    if (!bucket.geometries.length) continue;
    const geometry = mergePacked(bucket.geometries);
    for (const source of bucket.geometries) source.dispose();
    parts.push({ geometry, pivot: bucket.pivot, animation: bucket.animation, draws: 1 });
  }
  return parts;
}

/** Freeze distant rigid joints at their rest pose and merge their packed geometry into one draw. */
export function mergeRuntimeRestPose(parts: readonly RuntimeRigidPart[]): RuntimeRigidPart[] {
  const geometries: THREE.BufferGeometry[] = [], result: RuntimeRigidPart[] = [];
  for (const part of parts) {
    const transform = new THREE.Matrix4().makeTranslation(...part.pivot);
    if (part.rest) transform.multiply(part.rest);
    if (part.material) {
      // Preserve texture/custom-material semantics even for callers that choose authored far LOD.
      result.push({ ...part, geometry: geometryView(part.geometry), pivot: [0, 0, 0], animation: "fixed", rest: transform });
    } else {
      const geometry = part.geometry.clone(); geometry.applyMatrix4(transform); geometries.push(geometry);
    }
  }
  if (geometries.length) {
    const geometry = mergePacked(geometries);
    for (const source of geometries) source.dispose();
    result.push({ geometry, pivot: [0, 0, 0], animation: "fixed", draws: 1 });
  }
  return result;
}
