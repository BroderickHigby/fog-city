// Render-only SF street foliage: London-plane style broadleaf and Monterey cypress.
// Source placements remain the existing street-tree instance matrices. The approach follows
// Slop New York's MIT-licensed foliage design (leaf sprays, coverage-preserving alpha mips,
// instanced distance tiers), implemented here for Fog City's WebGL renderer.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { fcUniforms, injectUniforms } from "./materials.ts";

export const FOLIAGE_NEAR_LIMIT = 192;
export const FOLIAGE_FAR_LIMIT = 4096;
export const FOLIAGE_NEAR_M = 110;
export const FOLIAGE_FAR_M = 1400;
const REPICK_M = 12;
const ALPHA_CUTOFF = 0.42;
type Species = 0 | 1;
interface Placement { matrix: THREE.Matrix4; x: number; z: number; species: Species; tint: THREE.Color }
interface TileTrees { placements: Placement[]; originals: Array<{ mesh: THREE.InstancedMesh; visible: boolean }> }
interface Tier { bark: THREE.InstancedMesh; leaves: THREE.InstancedMesh; capacity: number }
interface Prototype { bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry }

function rng(seed: number): () => number {
  let n = seed >>> 0;
  return () => { n = Math.imul(n, 1664525) + 1013904223 >>> 0; return n / 4294967296; };
}

/** Box filtered alpha with coverage restored per level; keeps fine leaves visible at distance. */
export function foliageMipmaps(base: Uint8Array, size: number): Array<{ data: Uint8Array; width: number; height: number }> {
  if (base.length !== size * size * 4 || size < 1 || (size & (size - 1)) !== 0) throw new Error("Foliage texture must be square and power-of-two");
  const cutoff = ALPHA_CUTOFF * 255;
  let target = 0;
  for (let i = 3; i < base.length; i += 4) if (base[i]! >= cutoff) target++;
  target /= size * size;
  const levels = [{ data: base, width: size, height: size }];
  for (let previous = base, width = size; width > 1;) {
    const nextWidth = width / 2, next = new Uint8Array(nextWidth * nextWidth * 4);
    for (let y = 0; y < nextWidth; y++) for (let x = 0; x < nextWidth; x++) {
      const to = (y * nextWidth + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += previous[((y * 2 + dy) * width + x * 2 + dx) * 4 + channel]!;
        next[to + channel] = Math.round(sum / 4);
      }
    }
    let low = 0, high = 8;
    for (let pass = 0; pass < 14; pass++) {
      const scale = (low + high) / 2;
      let covered = 0;
      for (let i = 3; i < next.length; i += 4) if (next[i]! * scale >= cutoff) covered++;
      if (covered / (nextWidth * nextWidth) < target) low = scale; else high = scale;
    }
    const coverageError = (scale: number): number => {
      let covered = 0;
      for (let i = 3; i < next.length; i += 4) if (next[i]! * scale >= cutoff) covered++;
      return Math.abs(covered / (nextWidth * nextWidth) - target);
    };
    const scale = coverageError(low) < coverageError(high) ? low : high;
    for (let i = 3; i < next.length; i += 4) next[i] = Math.min(255, Math.round(next[i]! * scale));
    levels.push({ data: next, width: nextWidth, height: nextWidth });
    previous = next; width = nextWidth;
  }
  return levels;
}

/** Generated leaf spray, including warm twigs and lighter midribs; no image downloads. */
export function createLeafTexture(size = 256): THREE.DataTexture {
  const random = rng(0x1ea5), leaves: Array<{ x: number; y: number; a: number; rx: number; ry: number; shade: number }> = [];
  for (let i = 0; i < 31; i++) {
    const y = 0.12 + random() * 0.76, side = i % 2 ? 1 : -1;
    leaves.push({ x: 0.5 + side * (0.09 + random() * 0.22), y, a: side * (0.5 + random() * 0.75), rx: 0.07 + random() * 0.028, ry: 0.105 + random() * 0.045, shade: 0.73 + random() * 0.38 });
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    let alpha = 0, red = 77, green = 105, blue = 48;
    const stem = Math.abs(u - (0.50 + 0.016 * Math.sin(v * 8)));
    if (v > 0.04 && v < 0.95 && stem < 0.008) { alpha = 1; red = 93; green = 77; blue = 49; }
    for (const leaf of leaves) {
      const dx = u - leaf.x, dy = v - leaf.y, c = Math.cos(leaf.a), s = Math.sin(leaf.a);
      const along = (dx * s + dy * c) / leaf.ry, across = (dx * c - dy * s) / leaf.rx;
      const distance = across * across + along * along;
      if (distance >= 1) continue;
      const coverage = Math.min(1, (1 - distance) * size * 0.075);
      if (coverage < alpha) continue;
      alpha = coverage;
      const fold = across > 0 ? 0.94 : 1.05;
      const vein = Math.abs(across) < 0.032 ? 1.13 : 1;
      red = 86 * leaf.shade * fold * vein;
      green = 117 * leaf.shade * fold * vein;
      blue = 52 * leaf.shade * fold * vein;
    }
    const at = (y * size + x) * 4;
    data[at] = red; data[at + 1] = green; data[at + 2] = blue; data[at + 3] = Math.round(alpha * 255);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = "sf-leaf-spray";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mipmaps = foliageMipmaps(data, size);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function colorGeometry(geometry: THREE.BufferGeometry, color: THREE.Color, shade: number): THREE.BufferGeometry {
  const position = geometry.getAttribute("position"), colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const amount = shade * (0.94 + 0.06 * Math.sin(position.getY(i) * 19 + position.getX(i) * 8));
    colors[i * 3] = color.r * amount; colors[i * 3 + 1] = color.g * amount; colors[i * 3 + 2] = color.b * amount;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function branch(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, detail: number): THREE.BufferGeometry {
  const axis = b.clone().sub(a), length = axis.length();
  const geometry = new THREE.CylinderGeometry(r1, r0, length, detail, 2);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize()));
  geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return colorGeometry(geometry, new THREE.Color(0x6a5841), 0.92);
}

function combine(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error("Could not combine foliage geometry");
  merged.computeBoundingSphere(); merged.computeBoundingBox();
  return merged;
}

/** A tree keeps the original placement height: broadleaf 6.6 m, cypress 10.5 m. */
export function createFoliagePrototype(species: Species, far: boolean): Prototype {
  const random = rng(0x7100 + species * 391 + (far ? 0 : 0));
  const bark: THREE.BufferGeometry[] = [], cards: THREE.BufferGeometry[] = [];
  const height = species === 0 ? 6.6 : 10.5;
  const crownY = species === 0 ? 4.55 : 7.5;
  const radius = species === 0 ? 2.35 : 2.1;
  bark.push(branch(new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(0.13, crownY + 0.8, 0.05), 0.23, 0.07, far ? 5 : 9));
  const limbs = far ? 4 : 11;
  for (let i = 0; i < limbs; i++) {
    const angle = i * 2.39996, reach = radius * (0.57 + random() * 0.33), y = crownY - 1.0 + random() * 1.45;
    const start = new THREE.Vector3(0.08, species === 0 ? 2.1 + i * 0.11 : 3.3 + i * 0.2, 0);
    const end = new THREE.Vector3(Math.cos(angle) * reach, y, Math.sin(angle) * reach);
    bark.push(branch(start, end, far ? 0.055 : 0.075, 0.018, far ? 4 : 6));
  }
  const count = far ? 16 : 112;
  const crownHeight = species === 0 ? 1.8 : 3.0;
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2, vertical = random() * 2 - 1;
    const ring = Math.sqrt(Math.max(0, 1 - vertical * vertical));
    const inward = 0.68 + random() * 0.32;
    const x = Math.cos(angle) * radius * ring * inward, z = Math.sin(angle) * radius * ring * inward;
    const y = crownY + vertical * crownHeight;
    const size = far ? 1.8 : 0.82 + random() * 0.34;
    const geometry = new THREE.PlaneGeometry(size, size * 1.12);
    const normal = new THREE.Vector3(x * 0.55, (y - crownY) * 0.4 + 0.1, z * 0.55).normalize();
    if (normal.lengthSq() < 0.1) normal.set(0, 0, 1);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal));
    geometry.rotateY((random() - 0.5) * 0.8);
    geometry.translate(x, y, z);
    colorGeometry(geometry, new THREE.Color(species === 0 ? 0xb9c597 : 0x9fb291), 0.66 + random() * 0.36);
    cards.push(geometry);
  }
  const result = { bark: combine(bark), leaves: combine(cards) };
  // Bounds include complete cards. Normalize both parts together, preserving planted roots.
  const bounds = result.bark.boundingBox!.clone().union(result.leaves.boundingBox!);
  const scale = height / Math.max(bounds.max.y, 0.1);
  for (const geometry of [result.bark, result.leaves]) { geometry.scale(scale, scale, scale); geometry.computeBoundingSphere(); geometry.computeBoundingBox(); }
  return result;
}

function windMaterial<T extends THREE.Material>(material: T): T {
  material.onBeforeCompile = shader => {
    injectUniforms(shader);
    shader.uniforms.fcFoliageTime = fcUniforms.fcTime;
    shader.vertexShader = "uniform float fcFoliageTime;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      float foliagePhase = 0.0;
      #ifdef USE_INSTANCING
        foliagePhase = instanceMatrix[3].x * 0.17 + instanceMatrix[3].z * 0.13;
      #endif
      float foliageWeight = smoothstep(1.8, 7.5, position.y);
      transformed.x += sin(fcFoliageTime * 0.8 + foliagePhase + position.y * 0.7) * 0.035 * foliageWeight;
      transformed.z += cos(fcFoliageTime * 0.63 + foliagePhase) * 0.025 * foliageWeight;`);
  };
  material.customProgramCacheKey = () => "sf-foliage-wind-v1";
  return material;
}

/** One shared set of instanced LODs for all currently streamed tiles: at most eight draws. */
export class FoliageLayer {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, TileTrees>();
  private readonly tiers: Tier[][] = [];
  private readonly leafTexture = createLeafTexture();
  private readonly barkMaterial = windMaterial(new THREE.MeshStandardMaterial({ name: "sf-tree-bark", vertexColors: true, roughness: 0.94, metalness: 0 }));
  private readonly leafMaterial = windMaterial(new THREE.MeshStandardMaterial({ name: "sf-tree-leaves", vertexColors: true, map: this.leafTexture,
    alphaTest: ALPHA_CUTOFF, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.93, metalness: 0 }));
  private readonly depthMaterial = windMaterial(new THREE.MeshDepthMaterial({ map: this.leafTexture, alphaTest: ALPHA_CUTOFF, side: THREE.DoubleSide, depthPacking: THREE.RGBADepthPacking }));
  private dirty = true;
  private lastX = Infinity;
  private lastZ = Infinity;
  private disposed = false;
  private nearCount = 0;
  private farCount = 0;
  /** A pose for a tree at (x, z) other than its placement (a knocked-over tree, impact-layer.ts), or null. */
  private override: ((x: number, z: number, matrix: THREE.Matrix4) => THREE.Matrix4 | null) | null = null;

  constructor(shadows = false) {
    this.group.name = "sf:foliage";
    this.leafMaterial.forceSinglePass = true;
    for (let species = 0; species < 2; species++) {
      const speciesTiers: Tier[] = [];
      for (let far = 0; far < 2; far++) {
        const prototype = createFoliagePrototype(species as Species, far === 1);
        const capacity = far ? FOLIAGE_FAR_LIMIT : FOLIAGE_NEAR_LIMIT;
        const bark = new THREE.InstancedMesh(prototype.bark, this.barkMaterial, capacity);
        const leaves = new THREE.InstancedMesh(prototype.leaves, this.leafMaterial, capacity);
        bark.name = `sf:foliage:${species}:${far}:bark`; leaves.name = `sf:foliage:${species}:${far}:leaves`;
        leaves.customDepthMaterial = this.depthMaterial;
        for (const mesh of [bark, leaves]) { mesh.count = 0; mesh.castShadow = shadows; mesh.receiveShadow = shadows; mesh.frustumCulled = false; }
        speciesTiers.push({ bark, leaves, capacity }); this.group.add(bark, leaves);
      }
      this.tiers.push(speciesTiers);
    }
  }

  addTile(root: THREE.Object3D): void {
    if (this.disposed || !root.name.startsWith("tile:")) return;
    const id = root.name.slice(5);
    this.removeTile(id);
    root.updateWorldMatrix(true, true);
    const record: TileTrees = { placements: [], originals: [] };
    root.traverse(object => {
      const mesh = object as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh || !/^street-trees-[01]$/.test(mesh.name)) return;
      record.originals.push({ mesh, visible: mesh.visible });
      const matrix = new THREE.Matrix4(), tint = new THREE.Color();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix); matrix.premultiply(mesh.matrixWorld);
        const elements = matrix.elements;
        if (!elements.every(Number.isFinite)) continue;
        if (mesh.instanceColor) mesh.getColorAt(i, tint); else tint.setRGB(1, 1, 1);
        record.placements.push({ matrix: matrix.clone(), x: elements[12]!, z: elements[14]!, species: mesh.name.endsWith("1") ? 1 : 0, tint: tint.clone() });
      }
      mesh.visible = false;
    });
    this.tiles.set(id, record); this.dirty = true;
  }

  /** Draw some trees in another pose (knocked over); repicks on the next update. */
  setOverride(fn: ((x: number, z: number, matrix: THREE.Matrix4) => THREE.Matrix4 | null) | null): void {
    this.override = fn;
    this.dirty = true;
  }

  removeTile(id: string): void {
    const record = this.tiles.get(id);
    if (!record) return;
    for (const original of record.originals) original.mesh.visible = original.visible;
    this.tiles.delete(id); this.dirty = true;
  }

  update(cameraX: number, cameraZ: number): void {
    if (this.disposed || !Number.isFinite(cameraX) || !Number.isFinite(cameraZ)) return;
    if (!this.dirty && Math.hypot(cameraX - this.lastX, cameraZ - this.lastZ) < REPICK_M) return;
    this.dirty = false; this.lastX = cameraX; this.lastZ = cameraZ;
    const candidates: Array<Placement & { distance: number }> = [];
    for (const tile of this.tiles.values()) for (const placement of tile.placements) {
      const distance = Math.hypot(cameraX - placement.x, cameraZ - placement.z);
      if (distance <= FOLIAGE_FAR_M) candidates.push({ ...placement, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z);
    const counts = [[0, 0], [0, 0]];
    this.nearCount = 0; this.farCount = 0;
    for (const placement of candidates) {
      const near = placement.distance <= FOLIAGE_NEAR_M && this.nearCount < FOLIAGE_NEAR_LIMIT;
      const tierIndex = near ? 0 : 1;
      const tier = this.tiers[placement.species]![tierIndex]!;
      const count = counts[placement.species]![tierIndex]!;
      if (count >= tier.capacity || (!near && this.farCount >= FOLIAGE_FAR_LIMIT)) continue;
      const matrix = this.override?.(placement.x, placement.z, placement.matrix) ?? placement.matrix;
      tier.bark.setMatrixAt(count, matrix); tier.leaves.setMatrixAt(count, matrix);
      tier.leaves.setColorAt(count, placement.tint); tier.bark.setColorAt(count, placement.tint);
      counts[placement.species]![tierIndex] = count + 1;
      if (near) this.nearCount++; else this.farCount++;
    }
    for (let species = 0; species < 2; species++) for (let tier = 0; tier < 2; tier++) {
      const item = this.tiers[species]![tier]!;
      for (const mesh of [item.bark, item.leaves]) { mesh.count = counts[species]![tier]!; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
    }
  }

  get info(): { near: number; far: number; draws: number } {
    let draws = 0;
    for (const species of this.tiers) for (const tier of species) { if (tier.bark.count) draws++; if (tier.leaves.count) draws++; }
    return { near: this.nearCount, far: this.farCount, draws };
  }

  dispose(): void {
    if (this.disposed) return;
    for (const id of [...this.tiles.keys()]) this.removeTile(id);
    this.disposed = true;
    for (const species of this.tiers) for (const tier of species) for (const mesh of [tier.bark, tier.leaves]) { mesh.dispose(); mesh.geometry.dispose(); }
    this.nearCount = 0; this.farCount = 0;
    for (const species of this.tiers) for (const tier of species) { tier.bark.count = 0; tier.leaves.count = 0; }
    this.leafTexture.dispose(); this.barkMaterial.dispose(); this.leafMaterial.dispose(); this.depthMaterial.dispose();
    this.group.clear(); this.group.removeFromParent();
  }
}
