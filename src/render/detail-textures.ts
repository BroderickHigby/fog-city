// Scanned surface detail for the node renderer: CC0 material scans (public/textures/detail/,
// sources.json there) that add brightness variation, roughness and fine relief to building walls
// and to everything that moves (robots, robotaxis, cars). Colour stays the game's own: a scan only
// modulates brightness relative to its measured mean, so palettes and liveries do not shift.
//
// The scans load before any city material is built (SceneRenderer.create), because the node
// renderer stops compiling shaders after boot. When they are absent, fail to load, or the tier
// asks for none (low), no material changes: the shaders are exactly the ones without detail.
import * as THREE from "three";
import { abs, dot, float, max, pow, texture, vec3 } from "three/tsl";
import type Node from "three/src/nodes/core/Node.js";

export type DetailName = "metal" | "grain" | "stucco" | "concrete";
export const DETAIL_NAMES: readonly DetailName[] = ["metal", "grain", "stucco", "concrete"];
export const DETAIL_ROOT = "textures/detail/";
export const DETAIL_SIZE_PX = 1024;

/** Each scan's real size (metres per tile) and its measured means (sources.json). */
export const DETAIL_SCANS: Readonly<Record<DetailName, { sizeM: number; lum: number; rough: number; height: number }>> = Object.freeze({
  metal: { sizeM: 0.5, lum: lum([0.04941, 0.03394, 0.01247]), rough: 0.5892, height: 0.4681 },
  grain: { sizeM: 2, lum: lum([0.17494, 0.04693, 0.03662]), rough: 0.9243, height: 0.3973 },
  stucco: { sizeM: 1.8, lum: lum([0.42506, 0.41993, 0.40122]), rough: 0.8876, height: 0.7726 },
  concrete: { sizeM: 2.7, lum: lum([0.26637, 0.23707, 0.16183]), rough: 0.7369, height: 0.7788 },
});

function lum(rgb: readonly [number, number, number]): number { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }

export interface DetailTextures {
  /** 0 to 1: how strongly the scans show (gfx.ts TIER_DETAIL.surfaceDetail). */
  readonly level: number;
  readonly maps: Readonly<Record<DetailName, { albedo: THREE.Texture; rh: THREE.Texture }>>;
}

let active: DetailTextures | null = null;
/** The scans materials built from now on use; null builds them without detail. */
export function setDetailTextures(d: DetailTextures | null): void { active = d; }
export function detailTextures(): DetailTextures | null { return active; }
export function detailTexturesLoaded(): readonly DetailName[] { return active ? DETAIL_NAMES : []; }

type BytesProvider = (path: string) => Promise<Uint8Array>;

async function decode(bytes: Uint8Array, colour: boolean, anisotropy: number): Promise<THREE.Texture> {
  if (bytes.byteLength === 0 || bytes.byteLength > 4_000_000) throw new Error("detail scan size is invalid");
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/webp" }),
    { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
  if (bitmap.width !== DETAIL_SIZE_PX || bitmap.height !== DETAIL_SIZE_PX) { bitmap.close(); throw new Error("detail scan must be 1024 by 1024"); }
  const t = new THREE.Texture(bitmap);
  t.flipY = false; // flipped once while decoding
  t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = anisotropy; t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

/** Loads every scan, or none: a single failure leaves the city without detail. Never rejects. */
export async function loadDetailTextures(bytes: BytesProvider, level: number, anisotropy = 8): Promise<DetailTextures | null> {
  if (!(level > 0) || typeof createImageBitmap !== "function") return null;
  const owned: THREE.Texture[] = [];
  try {
    const entries = await Promise.all(DETAIL_NAMES.map(async (name) => {
      const [albedo, rh] = await Promise.all([
        bytes(`${DETAIL_ROOT}${name}_albedo.webp`).then((b) => decode(b, true, anisotropy)),
        bytes(`${DETAIL_ROOT}${name}_rh.webp`).then((b) => decode(b, false, anisotropy)),
      ]);
      owned.push(albedo, rh);
      return [name, { albedo, rh }] as const;
    }));
    return { level: Math.min(1, level), maps: Object.fromEntries(entries) as DetailTextures["maps"] };
  } catch (error) {
    for (const t of owned) disposeTexture(t);
    console.warn("[fog-city] detail scans unavailable; surfaces stay as they are.", error);
    return null;
  }
}

function disposeTexture(t: THREE.Texture): void {
  t.dispose();
  (t.image as { close?: () => void } | undefined)?.close?.();
}

export function disposeDetailTextures(d: DetailTextures | null): void {
  if (!d) return;
  for (const name of DETAIL_NAMES) { disposeTexture(d.maps[name].albedo); disposeTexture(d.maps[name].rh); }
  if (active === d) active = null;
}

type V3 = Node<"vec3">;
type V4 = Node<"vec4">;

/** Relative luminance of an RGB node. */
export const luma = (c: V3): Node<"float"> => dot(c, vec3(0.2126, 0.7152, 0.0722));

/**
 * Samples a tiling scan from three axis projections of `p` (metres), blended by the surface
 * normal `n`: no UVs needed, so it works on every model as it stands.
 */
export function triplanar(map: THREE.Texture, p: V3, n: V3, sizeM: number): V4 {
  const w = pow(abs(n), vec3(4)), sum = max(w.x.add(w.y).add(w.z), float(0.0001));
  const k = 1 / sizeM;
  return texture(map, p.yz.mul(k)).mul(w.x.div(sum))
    .add(texture(map, p.xz.mul(k)).mul(w.y.div(sum)))
    .add(texture(map, p.xy.mul(k)).mul(w.z.div(sum)));
}
