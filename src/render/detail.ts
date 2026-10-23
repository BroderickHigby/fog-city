// Generated PBR detail for the high tier (gfx.ts): the texture sets that
// assets/textures/generate.py writes to public/models/textures/ (albedo, tangent-space normal,
// ORM), mapped in world space on the ground, the road ribbons and the sidewalk bands. The
// materials keep their vertex colours (the palette the default tier draws, and the far tiles
// match); the albedo map is applied as detail normalised by its own mean colour, so a road stays
// the road's colour and only gains aggregate, cracks, patches and stains. Normal and roughness
// come from the maps; AO darkens the cavities. Everything fades out with distance before it can
// shimmer.
//
// World-space mapping: u = x / sizeM, v = z / sizeM, so +u is east and +v south. The maps are
// OpenGL-convention (+Y up the texture) and three flips images on upload, so +Y is +v: the
// tangent frame is T = +x, B = +z in world space.

import * as THREE from "three";
import type { Assets } from "../io/assets.ts";

export interface TextureSetInfo {
  sizeM: number;
  meanLinear: [number, number, number];
  albedo: string;
  normal: string;
  orm: string;
  source: string;
  licence: string;
}

export interface TextureIndex {
  version: number;
  textures: Record<string, TextureSetInfo>;
}

export interface DetailSet {
  name: string;
  info: TextureSetInfo;
  albedo: THREE.Texture;
  normal: THREE.Texture;
  orm: THREE.Texture;
}

export const TEXTURE_DIR = "models/textures/";

async function textureFrom(bytes: Uint8Array, srgb: boolean, anisotropy: number): Promise<THREE.Texture> {
  const blob = new Blob([bytes as BlobPart], { type: "image/webp" });
  const bitmap = await createImageBitmap(blob, { imageOrientation: "flipY" });
  const t = new THREE.Texture(bitmap as unknown as HTMLImageElement);
  // createImageBitmap already flipped it (ImageBitmap uploads ignore flipY).
  t.flipY = false;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Load the named sets (or every set) from the texture index. A set that fails to load is left out. */
export async function loadDetailSets(
  bytes: (path: string) => Promise<Uint8Array>,
  names: readonly string[] | null,
  anisotropy: number,
): Promise<Map<string, DetailSet>> {
  const index = JSON.parse(new TextDecoder().decode(await bytes(`${TEXTURE_DIR}textures.json`))) as TextureIndex;
  const out = new Map<string, DetailSet>();
  const wanted = names ?? Object.keys(index.textures);
  await Promise.all(
    wanted.map(async (name) => {
      const info = index.textures[name];
      if (!info) return;
      try {
        const [a, n, o] = await Promise.all([info.albedo, info.normal, info.orm].map((f) => bytes(`${TEXTURE_DIR}${f}`)));
        out.set(name, {
          name,
          info,
          albedo: await textureFrom(a!, true, anisotropy),
          normal: await textureFrom(n!, false, anisotropy),
          orm: await textureFrom(o!, false, anisotropy),
        });
      } catch (err) {
        console.warn(`detail textures: ${name} not loaded:`, err);
      }
    }),
  );
  return out;
}

/** Bytes for a texture path, from the packed build or a plain fetch. */
export function textureBytes(assets: Assets | undefined): (path: string) => Promise<Uint8Array> {
  if (assets) return (p) => assets.bytes(p);
  return async (p) => {
    const r = await fetch(p);
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
}

/** One material's detail: its set, how strongly each map applies, and how far it reaches. */
export interface DetailOptions {
  /** Albedo detail strength (0 = vertex colour only, 1 = full normalised detail). */
  albedo: number;
  normalScale: number;
  /** Roughness from the ORM map's G channel, blended over the material's own (0..1). */
  roughness: number;
  /** AO from the ORM map's R channel (0..1). */
  ao: number;
  /** Metres from the camera where the detail has faded out. */
  farM: number;
  /**
   * Only where the vertex colour is grey (urban ground, not lawns or sand): the ground's paving.
   * Fragments whose colour is saturated get `alt` (a second set: grass) instead, when given.
   */
  greyOnly?: boolean;
}

const PARS = /* glsl */ `
uniform sampler2D fcDetA;
uniform sampler2D fcDetN;
uniform sampler2D fcDetO;
uniform vec4 fcDetInfo;   // 1/sizeM, albedo strength, normal scale, far metres
uniform vec3 fcDetMean;
uniform vec2 fcDetRA;     // roughness blend, ao strength
uniform float fcDetGrey;  // 1: detail only on grey (paved) fragments
uniform sampler2D fcDetA2;
uniform sampler2D fcDetN2;
uniform sampler2D fcDetO2;
uniform vec4 fcDetInfo2;  // second set (lawns): 1/sizeM, on (0/1), unused, unused
uniform vec3 fcDetMean2;
varying vec3 fcDetWorld;
`;

const COLOR = /* glsl */ `
  vec2 fcDuv = fcDetWorld.xz * fcDetInfo.x;
  float fcDfade = 1.0 - smoothstep( fcDetInfo.w * 0.45, fcDetInfo.w, distance( fcDetWorld, cameraPosition ) );
  float fcDmax = max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) );
  float fcDsat = ( fcDmax - min( diffuseColor.r, min( diffuseColor.g, diffuseColor.b ) ) ) / max( fcDmax, 1e-3 );
  float fcDpaved = fcDetGrey > 0.5 ? 1.0 - smoothstep( 0.14, 0.24, fcDsat ) : 1.0;
  float fcDlawn = fcDetInfo2.y * ( 1.0 - fcDpaved );
  vec3 fcDo = vec3( 1.0, 0.85, 0.0 );
  vec3 fcDn = vec3( 0.0, 0.0, 1.0 );
  if ( fcDfade > 0.0 ) {
    vec3 fcDa = texture2D( fcDetA, fcDuv ).rgb / fcDetMean;
    vec3 fcDo1 = texture2D( fcDetO, fcDuv ).rgb;
    vec3 fcDn1 = texture2D( fcDetN, fcDuv ).xyz * 2.0 - 1.0;
    float k = fcDfade * fcDpaved;
    diffuseColor.rgb *= mix( vec3( 1.0 ), fcDa, k * fcDetInfo.y );
    fcDo = mix( fcDo, fcDo1, k );
    fcDn = mix( fcDn, fcDn1, k );
    if ( fcDlawn > 0.0 ) {
      vec2 fcDuv2 = fcDetWorld.xz * fcDetInfo2.x;
      float k2 = fcDfade * fcDlawn;
      diffuseColor.rgb *= mix( vec3( 1.0 ), texture2D( fcDetA2, fcDuv2 ).rgb / fcDetMean2, k2 );
      fcDo = mix( fcDo, texture2D( fcDetO2, fcDuv2 ).rgb, k2 );
      fcDn = mix( fcDn, texture2D( fcDetN2, fcDuv2 ).xyz * 2.0 - 1.0, k2 );
    }
    diffuseColor.rgb *= mix( 1.0, fcDo.r, fcDetRA.y * fcDfade );
  }
`;

const ROUGH = /* glsl */ `
  roughnessFactor = mix( roughnessFactor, fcDo.g, fcDetRA.x * fcDfade );
`;

const NORMAL = /* glsl */ `
  {
    vec3 fcT = normalize( ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
    vec3 fcB = normalize( ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
    // Re-orthogonalise against the surface normal (the ground slopes).
    fcT = normalize( fcT - normal * dot( normal, fcT ) );
    fcB = normalize( fcB - normal * dot( normal, fcB ) );
    vec2 fcDxy = fcDn.xy * fcDetInfo.z * fcDfade;
    normal = normalize( normal * max( fcDn.z, 0.2 ) + fcT * fcDxy.x + fcB * fcDxy.y );
  }
`;

/**
 * Wrap a material's shader patch with world-space PBR detail. The material keeps working (and
 * compiles, with the detail off) until `set` arrives: call `apply` then and it recompiles once.
 */
export class DetailMaterial {
  readonly uniforms = {
    fcDetA: { value: null as THREE.Texture | null },
    fcDetN: { value: null as THREE.Texture | null },
    fcDetO: { value: null as THREE.Texture | null },
    fcDetInfo: { value: new THREE.Vector4(0.25, 0, 0, 100) },
    fcDetMean: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    fcDetRA: { value: new THREE.Vector2(0, 0) },
    fcDetGrey: { value: 0 },
    fcDetA2: { value: null as THREE.Texture | null },
    fcDetN2: { value: null as THREE.Texture | null },
    fcDetO2: { value: null as THREE.Texture | null },
    fcDetInfo2: { value: new THREE.Vector4(0.25, 0, 0, 0) },
    fcDetMean2: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
  };
  private on = false;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly basePatch: ((s: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => void) | null;
  private readonly baseKey: string;

  constructor(material: THREE.MeshStandardMaterial) {
    this.material = material;
    this.basePatch = material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile ? null : material.onBeforeCompile.bind(material);
    this.baseKey = material.customProgramCacheKey();
  }

  /** Turn the detail on with `set` (and `alt` for lawns on the ground). */
  apply(set: DetailSet, o: DetailOptions, alt?: DetailSet): void {
    const u = this.uniforms;
    u.fcDetA.value = set.albedo;
    u.fcDetN.value = set.normal;
    u.fcDetO.value = set.orm;
    u.fcDetInfo.value.set(1 / set.info.sizeM, o.albedo, o.normalScale, o.farM);
    u.fcDetMean.value.set(...set.info.meanLinear);
    u.fcDetRA.value.set(o.roughness, o.ao);
    u.fcDetGrey.value = o.greyOnly ? 1 : 0;
    if (alt) {
      u.fcDetA2.value = alt.albedo;
      u.fcDetN2.value = alt.normal;
      u.fcDetO2.value = alt.orm;
      u.fcDetInfo2.value.set(1 / alt.info.sizeM, 1, 0, 0);
      u.fcDetMean2.value.set(...alt.info.meanLinear);
    } else {
      // Bind the first set's maps so the samplers are never empty.
      u.fcDetA2.value = set.albedo;
      u.fcDetN2.value = set.normal;
      u.fcDetO2.value = set.orm;
      u.fcDetInfo2.value.set(1 / set.info.sizeM, 0, 0, 0);
    }
    if (this.on) return;
    this.on = true;
    const base = this.basePatch;
    const uniforms = this.uniforms;
    this.material.onBeforeCompile = (shader, renderer) => {
      base?.(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 fcDetWorld;")
        .replace("#include <project_vertex>", "#include <project_vertex>\n  fcDetWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${PARS}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${COLOR}`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${ROUGH}`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${NORMAL}`);
    };
    const key = this.baseKey;
    this.material.customProgramCacheKey = () => `${key}+detail`;
    this.material.needsUpdate = true;
  }
}
