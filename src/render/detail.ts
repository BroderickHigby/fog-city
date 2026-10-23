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
   * Only where the vertex colour is not green (urban ground, not lawns): the ground's paving.
   * Fragments whose colour is green-led get `alt` (a second set: grass) instead, when given.
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
uniform sampler2D fcDetA3;
uniform sampler2D fcDetN3;
uniform sampler2D fcDetO3;
uniform vec4 fcDetInfo3;  // third set (pavers under a mask): 1/sizeM, on (0/1), mask half side (m), unused
uniform vec3 fcDetMean3;
uniform sampler2D fcDetMask;
varying vec3 fcDetWorld;
`;

const COLOR = /* glsl */ `
  vec2 fcDuv = fcDetWorld.xz * fcDetInfo.x;
  float fcDfade = 1.0 - smoothstep( fcDetInfo.w * 0.45, fcDetInfo.w, distance( fcDetWorld, cameraPosition ) );
  // Lawn is where green leads (judged on roughly sRGB values: linear exaggerates the tint of dark
  // greys, and the city's blue-grey paving must stay paving); everything else on the ground is paved.
  vec3 fcDs = sqrt( max( diffuseColor.rgb, vec3( 0.0 ) ) );
  float fcDgreen = ( fcDs.g - max( fcDs.r, fcDs.b ) ) / max( fcDs.g, 1e-3 );
  float fcDpaved = fcDetGrey > 0.5 ? 1.0 - smoothstep( 0.04, 0.10, fcDgreen ) : 1.0;
  float fcDlawn = fcDetInfo2.y * ( 1.0 - fcDpaved );
  vec3 fcDo = vec3( 1.0, 0.85, 0.0 );
  vec3 fcDn = vec3( 0.0, 0.0, 1.0 );
  if ( fcDfade > 0.0 ) {
    vec3 fcDa = texture2D( fcDetA, fcDuv ).rgb / fcDetMean;
    vec3 fcDo1 = texture2D( fcDetO, fcDuv ).rgb;
    vec3 fcDn1 = texture2D( fcDetN, fcDuv ).xyz * 2.0 - 1.0;
    if ( fcDetInfo3.y > 0.0 ) {
      vec2 fcMuv = fcDetWorld.xz / ( 2.0 * fcDetInfo3.z ) + 0.5;
      float fcM = all( greaterThan( fcMuv, vec2( 0.0 ) ) ) && all( lessThan( fcMuv, vec2( 1.0 ) ) ) ? texture2D( fcDetMask, fcMuv ).r : 0.0;
      fcM = smoothstep( 0.25, 0.75, fcM );
      if ( fcM > 0.0 ) {
        vec2 fcDuv3 = fcDetWorld.xz * fcDetInfo3.x;
        fcDa = mix( fcDa, texture2D( fcDetA3, fcDuv3 ).rgb / fcDetMean3, fcM );
        fcDo1 = mix( fcDo1, texture2D( fcDetO3, fcDuv3 ).rgb, fcM );
        fcDn1 = mix( fcDn1, texture2D( fcDetN3, fcDuv3 ).xyz * 2.0 - 1.0, fcM );
      }
    }
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
    fcDetA3: { value: null as THREE.Texture | null },
    fcDetN3: { value: null as THREE.Texture | null },
    fcDetO3: { value: null as THREE.Texture | null },
    fcDetInfo3: { value: new THREE.Vector4(0.25, 0, 1, 0) },
    fcDetMean3: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    fcDetMask: { value: null as THREE.Texture | null },
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

  /**
   * A third set where `mask` (an R8 texture over the square of half side `halfM` round the origin)
   * is set: the showcase's plazas and promenades get pavers (showcase.ts). Call after apply().
   */
  setMasked(set: DetailSet, mask: THREE.Texture, halfM: number): void {
    const u = this.uniforms;
    u.fcDetA3.value = set.albedo;
    u.fcDetN3.value = set.normal;
    u.fcDetO3.value = set.orm;
    u.fcDetInfo3.value.set(1 / set.info.sizeM, 1, halfM, 0);
    u.fcDetMean3.value.set(...set.info.meanLinear);
    u.fcDetMask.value = mask;
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
    // The third set's samplers default to the first set's until setMasked() binds pavers.
    if (!u.fcDetA3.value) {
      u.fcDetA3.value = set.albedo;
      u.fcDetN3.value = set.normal;
      u.fcDetO3.value = set.orm;
      u.fcDetMask.value = set.orm;
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

const TRI_PARS = /* glsl */ `
uniform sampler2D fcTriA;
uniform sampler2D fcTriN;
uniform sampler2D fcTriO;
uniform vec4 fcTriInfo;   // 1/sizeM, albedo strength, normal scale, far metres
uniform vec3 fcTriMean;
uniform vec2 fcTriRA;     // roughness blend, ao strength
varying vec3 fcTriW;
varying vec3 fcTriWN;
`;

const TRI_COLOR = /* glsl */ `
  vec3 fcTn = normalize( fcTriWN );
  vec3 fcTw = pow( abs( fcTn ), vec3( 4.0 ) );
  fcTw /= max( fcTw.x + fcTw.y + fcTw.z, 1e-4 );
  float fcTfade = 1.0 - smoothstep( fcTriInfo.w * 0.45, fcTriInfo.w, distance( fcTriW, cameraPosition ) );
  // Planes: x-facing walls read (z, y), z-facing walls (x, y), roofs and floors (x, z). Courses run level.
  vec2 fcTuvX = vec2( fcTriW.z * sign( fcTn.x ), fcTriW.y ) * fcTriInfo.x;
  vec2 fcTuvZ = vec2( -fcTriW.x * sign( fcTn.z ), fcTriW.y ) * fcTriInfo.x;
  vec2 fcTuvY = fcTriW.xz * fcTriInfo.x;
  vec3 fcTo = vec3( 1.0, 0.85, 0.0 );
  vec3 fcTnx = vec3( 0.0, 0.0, 1.0 );
  vec3 fcTny = vec3( 0.0, 0.0, 1.0 );
  vec3 fcTnz = vec3( 0.0, 0.0, 1.0 );
  if ( fcTfade > 0.0 ) {
    vec3 fcTa = texture2D( fcTriA, fcTuvX ).rgb * fcTw.x + texture2D( fcTriA, fcTuvY ).rgb * fcTw.y + texture2D( fcTriA, fcTuvZ ).rgb * fcTw.z;
    fcTo = texture2D( fcTriO, fcTuvX ).rgb * fcTw.x + texture2D( fcTriO, fcTuvY ).rgb * fcTw.y + texture2D( fcTriO, fcTuvZ ).rgb * fcTw.z;
    fcTnx = texture2D( fcTriN, fcTuvX ).xyz * 2.0 - 1.0;
    fcTny = texture2D( fcTriN, fcTuvY ).xyz * 2.0 - 1.0;
    fcTnz = texture2D( fcTriN, fcTuvZ ).xyz * 2.0 - 1.0;
    diffuseColor.rgb *= mix( vec3( 1.0 ), fcTa / fcTriMean, fcTfade * fcTriInfo.y );
    diffuseColor.rgb *= mix( 1.0, fcTo.r, fcTriRA.y * fcTfade );
  }
`;

const TRI_ROUGH = /* glsl */ `
  roughnessFactor = mix( roughnessFactor, fcTo.g, fcTriRA.x * fcTfade );
`;

const TRI_NORMAL = /* glsl */ `
  if ( fcTfade > 0.0 ) {
    // Each plane's tangent-space detail, rotated into world space (whiteout-style blend), then view.
    float k = fcTriInfo.z * fcTfade;
    vec3 wX = vec3( 0.0, fcTnx.y * k, fcTnx.x * k * sign( fcTn.x ) );
    vec3 wZ = vec3( -fcTnz.x * k * sign( fcTn.z ), fcTnz.y * k, 0.0 );
    vec3 wY = vec3( fcTny.x * k, 0.0, fcTny.y * k );
    vec3 fcTd = wX * fcTw.x + wY * fcTw.y + wZ * fcTw.z;
    normal = normalize( normal + ( viewMatrix * vec4( fcTd, 0.0 ) ).xyz );
  }
`;

/**
 * World-space triplanar PBR detail for meshes without UVs (the landmark models): the same maps
 * and the same normalised-albedo rule as DetailMaterial, projected along the three world axes and
 * blended by the surface normal. Ashlar courses stay level on every wall.
 */
export function applyTriplanar(material: THREE.MeshStandardMaterial, set: DetailSet, o: Omit<DetailOptions, "greyOnly">): void {
  const uniforms = {
    fcTriA: { value: set.albedo },
    fcTriN: { value: set.normal },
    fcTriO: { value: set.orm },
    fcTriInfo: { value: new THREE.Vector4(1 / set.info.sizeM, o.albedo, o.normalScale, o.farM) },
    fcTriMean: { value: new THREE.Vector3(...set.info.meanLinear) },
    fcTriRA: { value: new THREE.Vector2(o.roughness, o.ao) },
  };
  const base = material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile ? null : material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    base?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 fcTriW;\nvarying vec3 fcTriWN;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n  fcTriW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n  fcTriWN = normalize( mat3( modelMatrix ) * objectNormal );",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${TRI_PARS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${TRI_COLOR}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${TRI_ROUGH}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${TRI_NORMAL}`);
  };
  material.customProgramCacheKey = () => `${key}+triplanar:${set.name}`;
  material.needsUpdate = true;
}
