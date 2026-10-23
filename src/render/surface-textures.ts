// Optional, shared 1K material scans. Geometry, its colours and all existing procedural
// shaders remain authoritative; a failed scan simply leaves that material untouched.
import * as THREE from "three";
import type { SharedMaterials } from "./materials.ts";

export type SurfaceName = "asphalt" | "concrete";
export const SURFACE_TEXTURE_ROOT = "textures/surfaces/";
export const SURFACE_TEXTURE_FILES = ["asphalt_albedo.webp", "asphalt_normal.webp", "asphalt_orm.webp",
  "concrete_albedo.webp", "concrete_normal.webp", "concrete_orm.webp"] as const;

const SCANS = {
  asphalt: { sizeM: 3, mean: [0.11198, 0.11036, 0.09824], strength: 0.55 },
  concrete: { sizeM: 1.8, mean: [0.21601, 0.17802, 0.13617], strength: 0.65 },
} as const;
type SurfaceMaterials = Pick<SharedMaterials, "ground" | "road" | "roadUv" | "freewayUv">;
type BytesProvider = (path: string) => Promise<Uint8Array>;
type Scan = { albedo: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture };

export interface SurfaceTextureResult {
  loaded: readonly SurfaceName[];
  failed: readonly SurfaceName[];
  disposed: boolean;
}
export interface SurfaceTextures {
  /** Resolves even if optional files are unavailable. Never rejects a scene's startup. */
  readonly ready: Promise<SurfaceTextureResult>;
  readonly loaded: readonly SurfaceName[];
  readonly state: "loading" | "ready" | "disposed";
  /** Safe during loading; pending images are released without changing materials. */
  dispose(): void;
  /** Share a loaded scan with a newly streamed material; disposal unregisters it. */
  register(material: THREE.MeshStandardMaterial, kind: SurfaceName): void;
}

const PARS = /* glsl */ `
uniform sampler2D fcSurfaceAlbedo;
uniform sampler2D fcSurfaceNormal;
uniform sampler2D fcSurfaceOrm;
uniform vec3 fcSurfaceMean;
uniform float fcSurfaceRepeatM;
uniform float fcSurfaceNormalStrength;
`;

function colour(kind: SurfaceName): string {
  return /* glsl */ `
  // A metre-based, continuous projection works on tile geometry without TEXCOORD_0 and
  // avoids mistaking a ribbon's normalized kerb-to-kerb U coordinate for real metres.
  vec2 fcSurfaceUv = vFcWorld.xz / fcSurfaceRepeatM;
  float fcSurfaceMax = max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) );
  float fcSurfaceMin = min( diffuseColor.r, min( diffuseColor.g, diffuseColor.b ) );
  float fcSurfaceChroma = ( fcSurfaceMax - fcSurfaceMin ) / max( fcSurfaceMax, 0.001 );
  vec3 fcSurfaceCross = cross( dFdx( vFcWorld ), dFdy( vFcWorld ) );
  float fcSurfaceUp = abs( fcSurfaceCross.y ) / max( length( fcSurfaceCross ), 0.00001 );
  float fcSurfaceWeight = smoothstep( 0.65, 0.95, fcSurfaceUp )
    * smoothstep( -0.2, 0.45, vFcWorld.y )
    ${kind === "asphalt" ? `* ( 1.0 - smoothstep( 0.12, 0.20, fcSurfaceMax ) )
    * ( 1.0 - smoothstep( 0.23, 0.42, fcSurfaceChroma ) );` : `* ( 1.0 - smoothstep( 0.27, 0.46, fcSurfaceChroma ) )
    * smoothstep( 0.10, 0.22, fcSurfaceMax );`}
  // Albedo's sRGB texture format already decodes into scene-linear RGB on sampling.
  // Dividing by the measured scan mean preserves SF's vertex palette and distant LODs.
  vec3 fcSurfaceRelative = clamp( texture2D( fcSurfaceAlbedo, fcSurfaceUv ).rgb / fcSurfaceMean,
    vec3( 0.25 ), vec3( 2.0 ) );
  diffuseColor.rgb *= mix( vec3( 1.0 ), fcSurfaceRelative, fcSurfaceWeight * 0.85 );
  vec3 fcSurfaceData = texture2D( fcSurfaceOrm, fcSurfaceUv ).rgb;
  `;
}

const NORMAL = /* glsl */ `
  // Project the world-X axis onto the surface in view space. The bitangent faces
  // world +Z, including X/Z's mirrored handedness on an upward-facing ground plane.
  vec3 fcSurfaceX = mat3( viewMatrix ) * vec3( 1.0, 0.0, 0.0 );
  vec3 fcSurfaceT = fcSurfaceX - normal * dot( normal, fcSurfaceX );
  fcSurfaceT /= max( length( fcSurfaceT ), 0.00001 );
  vec3 fcSurfaceB = cross( normal, fcSurfaceT );
  fcSurfaceB /= max( length( fcSurfaceB ), 0.00001 );
  fcSurfaceB *= dot( fcSurfaceB, mat3( viewMatrix ) * vec3( 0.0, 0.0, 1.0 ) ) < 0.0 ? -1.0 : 1.0;
  vec3 fcSurfaceN = texture2D( fcSurfaceNormal, fcSurfaceUv ).xyz * 2.0 - 1.0;
  fcSurfaceN.xy *= fcSurfaceNormalStrength * fcSurfaceWeight;
  normal = normalize( fcSurfaceT * fcSurfaceN.x + fcSurfaceB * fcSurfaceN.y
    + normal * max( fcSurfaceN.z, 0.2 ) );
`;

function install(material: THREE.MeshStandardMaterial, kind: SurfaceName, scan: Scan): () => void {
  const before = material.onBeforeCompile;
  const cache = material.customProgramCacheKey;
  const spec = SCANS[kind];
  const compile: THREE.Material["onBeforeCompile"] = function (this: THREE.MeshStandardMaterial, shader, renderer) {
    before.call(this, shader, renderer);
    Object.assign(shader.uniforms, {
      fcSurfaceAlbedo: { value: scan.albedo }, fcSurfaceNormal: { value: scan.normal },
      fcSurfaceOrm: { value: scan.orm }, fcSurfaceMean: { value: new THREE.Vector3(...spec.mean) },
      fcSurfaceRepeatM: { value: spec.sizeM }, fcSurfaceNormalStrength: { value: spec.strength },
    });
    // This point is after the original road paint, kerbs, and procedural colour code.
    // Stock map/normalMap stay unset: several canonical surfaces do not have UV attributes.
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${PARS}`)
      .replace("#include <roughnessmap_fragment>", `${colour(kind)}\n#include <roughnessmap_fragment>`)
      .replace("#include <metalnessmap_fragment>", `
  roughnessFactor = mix( roughnessFactor, clamp( fcSurfaceData.g, 0.54, 0.98 ), fcSurfaceWeight );
  #include <metalnessmap_fragment>
  metalnessFactor = mix( metalnessFactor, min( fcSurfaceData.b, 0.05 ), fcSurfaceWeight );`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${NORMAL}`)
      .replace("#include <aomap_fragment>", `#include <aomap_fragment>
  float fcSurfaceAo = mix( 1.0, fcSurfaceData.r, fcSurfaceWeight * 0.4 );
  reflectedLight.indirectDiffuse *= fcSurfaceAo;
  reflectedLight.indirectSpecular *= fcSurfaceAo;`);
  };
  const key = () => `${cache.call(material)}|fc:surface:${kind}:v1`;
  material.onBeforeCompile = compile;
  material.customProgramCacheKey = key;
  material.needsUpdate = true;
  return () => {
    if (material.onBeforeCompile !== compile) return;
    material.onBeforeCompile = before;
    if (material.customProgramCacheKey === key) material.customProgramCacheKey = cache;
    material.needsUpdate = true;
  };
}

function release(texture: THREE.Texture): void {
  texture.dispose();
  const image = texture.image as { close?: () => void } | undefined;
  image?.close?.();
}

async function imageTexture(bytes: Uint8Array, colour: boolean, anisotropy: number): Promise<THREE.Texture> {
  if (bytes.byteLength === 0 || bytes.byteLength > 4_000_000) throw new Error("Surface scan size is invalid");
  const blob = new Blob([bytes as BlobPart], { type: "image/webp" });
  let texture: THREE.Texture;
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
    texture = new THREE.Texture(bitmap);
    texture.flipY = false; // ImageBitmap was flipped exactly once while decoding.
  } else {
    const url = URL.createObjectURL(blob);
    try { texture = await new THREE.TextureLoader().loadAsync(url); }
    finally { URL.revokeObjectURL(url); }
  }
  const image = texture.image as { width: number; height: number };
  if (image.width !== 1024 || image.height !== 1024) {
    release(texture);
    throw new Error("Surface scan must be 1024 by 1024 pixels");
  }
  texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** Start optional scans using Assets.bytes (loose or packed); owns textures, never geometry. */
export function loadSurfaceTextures(
  materials: SurfaceMaterials,
  bytesProvider: BytesProvider,
  options: { anisotropy?: number } = {},
): SurfaceTextures {
  let state: SurfaceTextures["state"] = "loading";
  const loaded: SurfaceName[] = [], failed: SurfaceName[] = [];
  const owned: THREE.Texture[] = [];
  const scans = new Map<SurfaceName, Scan>();
  const bindings = new Map<THREE.MeshStandardMaterial, { kind: SurfaceName; undo?: () => void; dispose: () => void }>();
  const register = (material: THREE.MeshStandardMaterial, kind: SurfaceName): void => {
    if (state === "disposed" || bindings.has(material)) return;
    const dispose = (): void => {
      const binding = bindings.get(material);
      if (!binding) return;
      binding.undo?.();
      material.removeEventListener("dispose", dispose);
      bindings.delete(material);
    };
    const binding = { kind, dispose, undo: undefined as (() => void) | undefined };
    bindings.set(material, binding);
    material.addEventListener("dispose", dispose);
    const scan = scans.get(kind);
    if (scan) binding.undo = install(material, kind, scan);
  };
  register(materials.ground, "concrete");
  for (const material of [materials.road, materials.roadUv, materials.freewayUv]) register(material, "asphalt");
  const anisotropy = Math.max(1, Math.min(8, Math.floor(options.anisotropy ?? 4)));
  const ready = Promise.all((["asphalt", "concrete"] as const).map(async kind => {
    const outcomes = await Promise.allSettled((["albedo", "normal", "orm"] as const).map(async channel => {
      const path = `${SURFACE_TEXTURE_ROOT}${kind}_${channel}.webp`;
      return imageTexture(await bytesProvider(path), channel === "albedo", anisotropy);
    }));
    const textures = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
    if (state === "disposed" || outcomes.some(outcome => outcome.status === "rejected")) {
      textures.forEach(release);
      if (state !== "disposed") failed.push(kind);
      return;
    }
    const scan = { albedo: textures[0]!, normal: textures[1]!, orm: textures[2]! };
    owned.push(...textures);
    scans.set(kind, scan);
    for (const [material, binding] of bindings) if (binding.kind === kind) binding.undo = install(material, kind, scan);
    loaded.push(kind);
  })).then((): SurfaceTextureResult => {
    if (state !== "disposed") state = "ready";
    return { loaded: [...loaded].sort(), failed: [...failed].sort(), disposed: state === "disposed" };
  });
  return {
    ready,
    register,
    get loaded() { return [...loaded].sort(); },
    get state() { return state; },
    dispose() {
      if (state === "disposed") return;
      state = "disposed";
      for (const binding of [...bindings.values()]) binding.dispose();
      scans.clear();
      owned.splice(0).forEach(release);
    },
  };
}
