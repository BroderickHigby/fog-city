// Night lights. Every model material whose name starts with `light_` is exported at full
// emissive strength (assets/blender/README.md, "Night lights"). The renderer scales it: near 0
// by day, up at night, for landmarks (tower outline, clock faces, sculpture glow), the player
// car and the agents (head and tail lights, robot faces, status lights, destination signs).
// Nodes that exist only to glow at night (glTF extras {"nightLight": true}) are hidden by day.
//
// The scaling functions are pure (tests/render/lights.test.ts). NightLights applies them to
// three.js materials; agents get the same numbers through a shader uniform per channel
// (agent-packing.ts), with each material's own level baked in as a ratio (channelRatio).
// Changing an intensity never adds a light or recompiles a shader.

import type * as THREE from "three";

/** emissiveIntensity by day, for every light material. */
export const LIGHT_DAY_INTENSITY = 0;

/** emissiveIntensity at full night, per light material (base name, without a ".001" suffix). */
export const LIGHT_NIGHT_INTENSITY: Readonly<Record<string, number>> = Object.freeze({
  light_headlight: 2.4,
  light_taillight: 0.9,
  light_status: 1.6,
  light_face: 1.4,
  light_eyes: 1.4,
  light_destination_sign: 1.8,
  light_tower_outline: 2.6,
  light_clock_face: 1.6,
  light_sculpture_glow: 1.3,
});

/** For a light material not in the table. */
export const LIGHT_NIGHT_DEFAULT = 1.5;

/** "light_headlight.001" -> "light_headlight". */
export function lightBaseName(name: string): string {
  return name.replace(/\.\d+$/, "");
}

export function isLightMaterial(name: string): boolean {
  return lightBaseName(name).startsWith("light_");
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/** emissiveIntensity for a light material at `night` (0 = day .. 1 = night); 0 for any other material. */
export function lightIntensity(name: string, night: number): number {
  if (!isLightMaterial(name)) return 0;
  const k = LIGHT_NIGHT_INTENSITY[lightBaseName(name)] ?? LIGHT_NIGHT_DEFAULT;
  return LIGHT_DAY_INTENSITY + (k - LIGHT_DAY_INTENSITY) * clamp01(night);
}

/** Is a nightLight-only node shown at `night`? */
export function nightNodeVisible(night: number): boolean {
  return clamp01(night) >= 0.5;
}

/**
 * Which light channel a material drives on the packed agent shader:
 * 0 not a light, 1 head/running lights, 2 tail (brake) lights, 3 status (faces, eyes, rings, signs).
 */
export type LightChannel = 0 | 1 | 2 | 3;

export function lightChannel(name: string): LightChannel {
  if (!isLightMaterial(name)) return 0;
  const base = lightBaseName(name);
  if (/tail|brake/.test(base)) return 2;
  if (/head/.test(base)) return 1;
  return 3;
}

/** The per-channel night intensities the agent shader reads (x head, y tail, z status). */
export function channelIntensities(night: number): [number, number, number] {
  return [lightIntensity("light_headlight", night), lightIntensity("light_taillight", night), lightIntensity("light_status", night)];
}

/**
 * A light material's brightness relative to its agent channel: the packed agent shader drives
 * a whole channel with one intensity (light_headlight's, light_taillight's or light_status's),
 * so agent-packing.ts pre-scales each material's emissive colour by this ratio and every
 * material keeps its own night level (light_face 1.4, light_destination_sign 1.8, ...):
 * channelRatio(name) * channelIntensities(night)[channel - 1] === lightIntensity(name, night).
 * 0 for a material that is not a light.
 */
export function channelRatio(name: string): number {
  const ch = lightChannel(name);
  if (ch === 0) return 0;
  const k = channelIntensities(1)[ch - 1]!;
  return k > 0 ? lightIntensity(name, 1) / k : 1;
}

/**
 * Applies the scaling to real three.js materials and nightLight nodes. Track a model once it is
 * in the scene; clones share materials with their prototype, so a material is tracked once.
 */
export class NightLights {
  private readonly materials = new Set<THREE.Material & { emissiveIntensity: number }>();
  private readonly nodes = new Set<THREE.Object3D>();
  private night = 0;

  get count(): number {
    return this.materials.size;
  }

  track(root: THREE.Object3D): void {
    root.traverse((o) => {
      if ((o.userData as { nightLight?: unknown }).nightLight === true) {
        this.nodes.add(o);
        o.visible = nightNodeVisible(this.night);
      }
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const lit = m as THREE.Material & { emissiveIntensity?: number };
        if (typeof lit.emissiveIntensity !== "number" || !isLightMaterial(m.name)) continue;
        this.materials.add(lit as THREE.Material & { emissiveIntensity: number });
        lit.emissiveIntensity = lightIntensity(m.name, this.night);
      }
    });
  }

  untrack(root: THREE.Object3D): void {
    root.traverse((o) => {
      this.nodes.delete(o);
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        this.materials.delete(m as THREE.Material & { emissiveIntensity: number });
      }
    });
  }

  setNight(night: number): void {
    this.night = night;
    for (const m of this.materials) m.emissiveIntensity = lightIntensity(m.name, night);
    const show = nightNodeVisible(night);
    for (const o of this.nodes) o.visible = show;
  }
}
