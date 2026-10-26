// Consolidate the authored Rocketbox primitives at prototype load, never per frame. One skin,
// one geometry and ordinary PBR maps work on legacy WebGL and both node-renderer backends.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export interface AvatarPixels { width: number; height: number; data: Uint8Array | Uint8ClampedArray }
export type AvatarPixelReader = (texture: THREE.Texture) => Promise<AvatarPixels>;
export interface CompactAvatarOptions { readPixels?: AvatarPixelReader; alphaTest?: number }
const GUTTER = 16;
const MAX_IMAGE_SIDE = 512;
interface Rect { x: number; y: number; width: number; height: number }
interface Atlas { texture: THREE.DataTexture; rects: Rect[] }

/** Data textures are also useful to offline callers; browser GLBs carry decoded image sources. */
async function pixels(texture: THREE.Texture): Promise<AvatarPixels> {
  const image = texture.image as { width?: number; height?: number; data?: unknown } | undefined;
  if (!image?.width || !image.height) throw new Error("Crowd atlas needs a decoded texture image");
  if (image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) return { width: image.width, height: image.height, data: image.data };
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(image.width, image.height)
    : typeof document !== "undefined" ? Object.assign(document.createElement("canvas"), { width: image.width, height: image.height }) : null;
  const context = canvas?.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!context) throw new Error("Crowd atlas requires a readable 2D image surface");
  context.drawImage(image as CanvasImageSource, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}
function checkImage(image: AvatarPixels): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1
    || image.width > MAX_IMAGE_SIDE || image.height > MAX_IMAGE_SIDE || image.data.length !== image.width * image.height * 4) {
    throw new Error("Crowd atlas image exceeds the authored 512-pixel layout or has invalid RGBA bytes");
  }
}
function atlas(images: readonly AvatarPixels[], colorSpace: THREE.ColorSpace, name: string): Atlas {
  images.forEach(checkImage);
  const width = Math.max(...images.map(image => image.width)) + GUTTER * 2;
  const height = images.reduce((sum, image) => sum + image.height + GUTTER * 2, 0);
  const data = new Uint8Array(width * height * 4), rects: Rect[] = [];
  let top = 0;
  for (const image of images) {
    const rect = { x: GUTTER, y: top + GUTTER, width: image.width, height: image.height };
    rects.push(rect);
    // Repeat, not edge clamp: a few authored hair UVs deliberately lie just outside [0,1].
    for (let y = -GUTTER; y < image.height + GUTTER; y++) for (let x = -GUTTER; x < width - GUTTER; x++) {
      const sx = ((x % image.width) + image.width) % image.width, sy = ((y % image.height) + image.height) % image.height;
      const from = (sy * image.width + sx) * 4, to = ((rect.y + y) * width + rect.x + x) * 4;
      // Copy texels without allocating a temporary typed-array view for every pixel.
      data[to] = image.data[from]!; data[to + 1] = image.data[from + 1]!;
      data[to + 2] = image.data[from + 2]!; data[to + 3] = image.data[from + 3]!;
    }
    top += image.height + GUTTER * 2;
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = name; texture.colorSpace = colorSpace; texture.flipY = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return { texture, rects };
}
function uv(source: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, rect: Rect, width: number, height: number, constant = false): THREE.BufferAttribute {
  const array = new Float32Array(source.count * 2);
  for (let i = 0; i < source.count; i++) {
    if (!constant && (source.getX(i) * rect.width < -GUTTER + 1 || source.getX(i) * rect.width > rect.width + GUTTER - 1
      || source.getY(i) * rect.height < -GUTTER + 1 || source.getY(i) * rect.height > rect.height + GUTTER - 1)) throw new Error("Crowd UV exceeds its preserved repeat gutter");
    array[i * 2] = (rect.x + (constant ? .5 : source.getX(i) * rect.width)) / width;
    array[i * 2 + 1] = (rect.y + (constant ? .5 : source.getY(i) * rect.height)) / height;
  }
  return new THREE.BufferAttribute(array, 2);
}
function textureTransformIsPlain(texture: THREE.Texture): boolean {
  return !texture.flipY && texture.offset.x === 0 && texture.offset.y === 0 && texture.repeat.x === 1 && texture.repeat.y === 1 && texture.rotation === 0;
}

/** Mutates only this owned prototype, atomically after every image and new resource is ready. */
export async function compactCrowdAvatar(root: THREE.Object3D, options: Readonly<CompactAvatarOptions> = {}): Promise<THREE.SkinnedMesh> {
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh); });
  const first = meshes[0];
  if (!first || meshes.length > 3) throw new Error("Crowd compaction requires the authored body/face/hair skin");
  const materials = meshes.map(mesh => {
    if (Array.isArray(mesh.material) || !(mesh.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) throw new Error("Crowd primitive needs one standard PBR material");
    return mesh.material as THREE.MeshStandardMaterial;
  });
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i]!, material = materials[i]!;
    mesh.updateMatrix(); first.updateMatrix();
    if (mesh.parent !== first.parent || !mesh.matrix.equals(first.matrix) || !mesh.bindMatrix.equals(first.bindMatrix)
      || mesh.skeleton.bones.length !== first.skeleton.bones.length || !mesh.skeleton.bones.every((bone, j) => bone === first.skeleton.bones[j])
      || mesh.skeleton.boneInverses.some((inverse, j) => !inverse.equals(first.skeleton.boneInverses[j]!)) || mesh.morphTargetInfluences?.length) {
      throw new Error("Crowd primitives do not share one unchanged skin and transform");
    }
    if (!mesh.geometry.getAttribute("uv") || !material.map || !textureTransformIsPlain(material.map)
      || material.normalMap && !textureTransformIsPlain(material.normalMap) || material.normalScale.x !== 1 || material.normalScale.y !== 1
      || material.metalness !== 0 || material.roughnessMap || material.metalnessMap || material.alphaMap
      || material.side !== THREE.DoubleSide || material.opacity !== 1 || !material.color.equals(materials[0]!.color)
      || material.vertexColors !== materials[0]!.vertexColors) throw new Error("Crowd primitive uses an unsupported authored material layout");
  }
  const read = options.readPixels ?? pixels;
  const colors = await Promise.all(materials.map(material => read(material.map!)));
  const normals = await Promise.all(materials.map(material => material.normalMap ? read(material.normalMap)
    : Promise.resolve({ width: 1, height: 1, data: new Uint8Array([128, 128, 255, 255]) })));
  let colorAtlas: Atlas | undefined, normalAtlas: Atlas | undefined, roughness: THREE.DataTexture | undefined;
  const copies: THREE.BufferGeometry[] = [];
  let merged: THREE.BufferGeometry | null = null, material: THREE.MeshStandardMaterial | undefined;
  try {
    colorAtlas = atlas(colors, THREE.SRGBColorSpace, "crowd:color-atlas");
    normalAtlas = atlas(normals, THREE.NoColorSpace, "crowd:normal-atlas");
    const rough = new Float32Array(materials.length * 4);
    materials.forEach((m, i) => rough.set([1, m.roughness, 1, 1], i * 4));
    roughness = new THREE.DataTexture(rough, materials.length, 1, THREE.RGBAFormat, THREE.FloatType);
    roughness.name = "crowd:roughness"; roughness.channel = 2; roughness.needsUpdate = true;
    normalAtlas.texture.channel = 1;
    for (let i = 0; i < meshes.length; i++) {
      const geometry = meshes[i]!.geometry.clone(), oldUV = geometry.getAttribute("uv");
      copies.push(geometry);
      geometry.setAttribute("uv", uv(oldUV, colorAtlas.rects[i]!, colorAtlas.texture.image.width, colorAtlas.texture.image.height));
      geometry.setAttribute("uv1", uv(oldUV, normalAtlas.rects[i]!, normalAtlas.texture.image.width, normalAtlas.texture.image.height, !materials[i]!.normalMap));
      const roughUV = new Float32Array(oldUV.count * 2);
      for (let k = 0; k < oldUV.count; k++) roughUV.set([(i + .5) / materials.length, .5], k * 2);
      geometry.setAttribute("uv2", new THREE.BufferAttribute(roughUV, 2));
      geometry.clearGroups();
    }
    merged = mergeGeometries(copies, false);
    if (!merged) throw new Error("Crowd primitive vertex layouts cannot be merged");
    merged.computeBoundingBox(); merged.computeBoundingSphere();
    material = new THREE.MeshStandardMaterial({ name: "crowd:compact", map: colorAtlas.texture, normalMap: normalAtlas.texture,
      roughnessMap: roughness, color: materials[0]!.color.clone(), roughness: 1, metalness: 0, side: THREE.DoubleSide,
      alphaTest: materials.some(m => m.transparent || m.alphaTest > 0) ? options.alphaTest ?? .45 : 0,
      vertexColors: materials[0]!.vertexColors });
    const compact = new THREE.SkinnedMesh(merged, material);
    compact.name = first.name; compact.userData = { ...first.userData, crowdCompact: true, sourcePrimitives: meshes.length };
    compact.position.copy(first.position); compact.quaternion.copy(first.quaternion); compact.scale.copy(first.scale);
    compact.matrix.copy(first.matrix); compact.matrixAutoUpdate = first.matrixAutoUpdate;
    compact.bindMode = first.bindMode; compact.bind(first.skeleton, first.bindMatrix);
    compact.castShadow = first.castShadow; compact.receiveShadow = first.receiveShadow;
    compact.frustumCulled = first.frustumCulled;
    const parent = first.parent!; parent.add(compact);
    for (const mesh of meshes) mesh.removeFromParent();
    const oldGeometry = new Set(meshes.map(mesh => mesh.geometry)), oldMaterial = new Set(materials), oldTextures = new Set<THREE.Texture>();
    for (const m of oldMaterial) for (const value of Object.values(m)) if (value instanceof THREE.Texture) oldTextures.add(value);
    for (const geometry of oldGeometry) geometry.dispose();
    for (const m of oldMaterial) m.dispose();
    const oldImages = new Set<unknown>();
    for (const texture of oldTextures) { oldImages.add(texture.image); texture.dispose(); }
    for (const image of oldImages) if (image && typeof (image as { close?: unknown }).close === "function") (image as ImageBitmap).close();
    for (const skeleton of new Set(meshes.map(mesh => mesh.skeleton))) if (skeleton !== first.skeleton) skeleton.dispose();
    return compact;
  } catch (error) {
    merged?.dispose(); material?.dispose(); colorAtlas?.texture.dispose(); normalAtlas?.texture.dispose(); roughness?.dispose();
    throw error;
  } finally { for (const geometry of copies) geometry.dispose(); }
}
