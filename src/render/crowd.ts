// The high tier's crowd (gfx.ts "characters"): the assets track's humanoid (humanoid-crowd.glb
// meshes adult_lod0 and adult_lod1, animated by the vertex-animation textures in
// humanoid-vat-adult-lod<n>.bin and humanoid-vat.json; assets/blender/README.md "Humanoid line")
// in place of person.ts's placeholder rig. One instanced draw call per LOD: LOD0 for the near
// tier, LOD1 for the mid tier. Each person walks (rate scaled to their speed so the planted foot
// stays put) or idles, desynchronised by a phase from their id, in a variant body, an outfit and
// hair the variant suggests, and a skin tone picked uniformly, never tied to the variant
// (README, "Skin tone is independent of the variant").
//
// Render-only and deterministic for a given id: the sim never sees any of it.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { addVatAttributes, createHumanoidVat, setVatInstance, type HumanoidVat } from "../../assets/blender/runtime/humanoid-vat-three.ts";
import type { HumanoidVatMeta } from "../../assets/blender/runtime/humanoid-vat.ts";
import { rand01 } from "./hash.ts";

export const CROWD_FILES = {
  meta: "models/humanoid-vat.json",
  glb: "models/humanoid-crowd.glb",
} as const;

/** Below this speed (m/s) a person idles instead of walking. */
const IDLE_BELOW = 0.25;

interface Lod {
  vat: HumanoidVat;
  mesh: THREE.InstancedMesh;
  count: number;
}

export class CrowdRig {
  readonly group = new THREE.Group();
  private readonly lods: Lod[];
  private readonly walk: number;
  private readonly idle: number;
  private readonly walkSpeed: number;
  private readonly walkDuration: number;
  private readonly idleDuration: number;
  private readonly adults: Array<{ index: number; outfits: string[]; hair: string[]; scale: [number, number] }>;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  private constructor(meta: HumanoidVatMeta, lods: Lod[]) {
    this.lods = lods;
    const vat = lods[0]!.vat;
    this.walk = vat.clipIndex("walk");
    this.idle = vat.clipIndex("idle");
    const clips = meta.clips.adult ?? [];
    const walk = clips.find((c) => c.name === "walk");
    this.walkSpeed = (walk as { speedMps?: number } | undefined)?.speedMps ?? 1.34;
    this.walkDuration = walk?.durationS ?? 1;
    this.idleDuration = clips.find((c) => c.name === "idle")?.durationS ?? 3;
    this.adults = meta.variants
      .map((v, index) => ({ v, index }))
      .filter(({ v }) => !(v as { child?: boolean }).child)
      .map(({ v, index }) => {
        const vv = v as unknown as { outfits?: string[]; hair?: string[]; heightScale?: [number, number] };
        return { index, outfits: vv.outfits ?? [], hair: vv.hair ?? [], scale: vv.heightScale ?? [0.95, 1.05] };
      });
    this.group.name = "agents:crowd";
    for (const l of lods) this.group.add(l.mesh);
  }

  /** Load the crowd: the JSON, the GLB's adult meshes and both LODs' textures. `capacity` per LOD. */
  static async load(bytes: (path: string) => Promise<Uint8Array>, capacity: [number, number], shadows: boolean): Promise<CrowdRig> {
    const meta = JSON.parse(new TextDecoder().decode(await bytes(CROWD_FILES.meta))) as HumanoidVatMeta;
    const glbBytes = await bytes(CROWD_FILES.glb);
    const gltf = await new GLTFLoader().parseAsync(glbBytes.slice().buffer as ArrayBuffer, "");
    const lods: Lod[] = [];
    for (const [k, key] of (["0", "1"] as const).entries()) {
      const lod = meta.models.adult?.lods[key];
      if (!lod) throw new Error(`humanoid-vat.json has no adult LOD ${key}`);
      let geometry: THREE.BufferGeometry | null = null;
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && (mesh.name === lod.mesh || mesh.parent?.name === lod.mesh)) geometry ??= mesh.geometry;
      });
      if (!geometry) throw new Error(`humanoid-crowd.glb has no mesh ${lod.mesh}`);
      const bin = await bytes(`models/${lod.file}`);
      const vat = createHumanoidVat(meta, "adult", key, bin.slice().buffer as ArrayBuffer);
      const mesh = new THREE.InstancedMesh(geometry, vat.material, capacity[k]!);
      mesh.name = `agents:crowd:lod${key}`;
      addVatAttributes(mesh);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      mesh.customDepthMaterial = vat.depthMaterial;
      mesh.customDistanceMaterial = vat.distanceMaterial;
      lods.push({ vat, mesh, count: 0 });
    }
    return new CrowdRig(meta, lods);
  }

  setTime(seconds: number): void {
    for (const l of this.lods) l.vat.uniforms.vatTime.value = seconds;
  }

  begin(): void {
    for (const l of this.lods) l.count = 0;
  }

  /** One person: `lod` 0 near, 1 mid; `speed` m/s along the ground. */
  add(id: string, lod: 0 | 1, x: number, y: number, z: number, heading: number, speed: number): void {
    const l = this.lods[lod]!;
    if (l.count >= l.mesh.instanceMatrix.count) return;
    const i = l.count++;
    const pick = <T>(arr: readonly T[], salt: string): T => arr[Math.floor(rand01(`${id}:${salt}`) * arr.length) % arr.length]!;
    const variant = pick(this.adults, "variant");
    const scale = variant.scale[0] + (variant.scale[1] - variant.scale[0]) * rand01(`${id}:height`);
    this.q.setFromAxisAngle(this.up, -heading);
    this.m.compose(this.v.set(x, y, z), this.q, this.s.set(scale, scale, scale));
    l.mesh.setMatrixAt(i, this.m);
    const walking = speed > IDLE_BELOW;
    const duration = walking ? this.walkDuration : this.idleDuration;
    const palette = l.vat.palette;
    const skin = Math.floor(rand01(`${id}:skin`) * palette.skins) % palette.skins;
    const outfit = variant.outfits.length > 0 ? pick(variant.outfits, "outfit") : palette.outfits[0]!;
    const hair = variant.hair.length > 0 ? pick(variant.hair, "hair") : palette.hair[0]!;
    let row = palette.rowOf(outfit, hair, skin);
    if (row < 0) row = 0;
    setVatInstance(l.mesh, i, {
      clip: walking ? this.walk : this.idle,
      // A phase from the id: neighbours never step in time.
      startTime: -rand01(`${id}:phase`) * duration,
      rate: walking ? Math.max(0.5, Math.min(2.2, speed / this.walkSpeed)) : 1,
      variant: variant.index,
      palette: row,
      wet: 0,
    });
  }

  end(): void {
    for (const l of this.lods) {
      l.mesh.count = l.count;
      l.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  get drawCalls(): number {
    return this.lods.reduce((n, l) => n + (l.count > 0 ? 1 : 0), 0);
  }

  get triangles(): number {
    return this.lods.reduce((n, l) => n + l.count * (l.vat.lod.triangles ?? 0), 0);
  }

  dispose(): void {
    for (const l of this.lods) {
      l.vat.dispose();
      l.mesh.dispose();
    }
  }
}
