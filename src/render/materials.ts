// Shared materials, the San Francisco fog, and the day/night switch.
//
// Fog: three's fog chunks are replaced once, globally, with a height fog: density falls off
// exponentially with altitude (thick at street level and over the water, thin on hilltops)
// plus a distance term so everything past ~1.5 km dissolves (which also hides tile
// streaming). It tints toward the sun's colour when looking into the sun. Every material
// gets the extra uniforms through Material.prototype.onBeforeCompile; a material compiled
// without them (all zeros) degrades to plain exponential fog, never to an error.
//
// Night: one uniform (fcNight, 0..1) drives lit windows in the building shader; lamp and
// window materials read it too. Changing it never recompiles anything.

import * as THREE from "three";
import { FACADE_EMISSIVE, FACADE_FRAGMENT, FACADE_FRAGMENT_PARS, FACADE_NORMAL, FACADE_ROUGHNESS, FACADE_VERTEX, FACADE_VERTEX_PARS, facadeDefines } from "./facade-shader.ts";
import { DOOR_W, GARAGE_H, GARAGE_W } from "./house-kit.ts";

export interface FogSettings {
  /** Base density at ground level (1/m). */
  density: number;
  /** Height falloff (1/m): density halves every ln(2)/falloff metres up. */
  falloff: number;
  /** Altitude where density equals `density`. */
  baseY: number;
  /** Distance term: optical depth grows as (d * distK)^2. */
  distK: number;
}

/** Shared uniforms injected into every material (values are mutated, never replaced). */
export const fcUniforms = {
  /** x falloff, y baseY, z unused, w distK */
  fcFogParams: { value: new THREE.Vector4(0.012, 0, 0, 1 / 1500) },
  /** xyz direction towards the sun (world), w inscatter strength */
  fcSunDir: { value: new THREE.Vector4(-0.9, 0.12, -0.2, 0.75) },
  /** Display-space colour of fog lit by the sun. */
  fcSunFog: { value: new THREE.Vector3(1, 0.8, 0.6) },
  fcNight: { value: 0 },
  fcTime: { value: 0 },
};

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFcFogRel;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  // World-space vector from the camera to this vertex (view rotation is orthonormal).
  vFcFogRel = transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFcFogRel;
  uniform vec4 fcFogParams;
  uniform vec4 fcSunDir;
  uniform vec3 fcSunFog;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  float fcFogAmount( vec3 rel, float camY ) {
    float dist = length( rel );
    #ifdef FOG_EXP2
      float b = fcFogParams.x;
      float h = camY - fcFogParams.y;
      float t = b * rel.y;
      float base = fogDensity * exp( - clamp( b * h, -20.0, 20.0 ) );
      float optical = abs( t ) > 1e-4 ? base * ( 1.0 - exp( - t ) ) / t * dist : base * dist;
      float dk = dist * fcFogParams.w;
      optical += dk * dk;
      return 1.0 - exp( - max( optical, 0.0 ) );
    #else
      return smoothstep( fogNear, fogFar, dist );
    #endif
  }
  vec3 fcFogTint( vec3 dir ) {
    float s = pow( max( dot( dir, fcSunDir.xyz ), 0.0 ), 6.0 ) * fcSunDir.w;
    return mix( fogColor, fcSunFog, clamp( s, 0.0, 1.0 ) );
  }
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  float fogFactor = fcFogAmount( vFcFogRel, cameraPosition.y );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fcFogTint( normalize( vFcFogRel ) ), fogFactor );
#endif
`;

let patched = false;

/** Replace three's fog chunks and give every material the shared uniforms. Idempotent. */
export function installFog(): void {
  if (patched) return;
  patched = true;
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
  THREE.Material.prototype.onBeforeCompile = function (shader: THREE.WebGLProgramParametersWithUniforms) {
    injectUniforms(shader);
  };
}

export function injectUniforms(shader: { uniforms: Record<string, THREE.IUniform> }): void {
  Object.assign(shader.uniforms, fcUniforms);
}

export function setFog(f: FogSettings, fog: THREE.FogExp2): void {
  fog.density = f.density;
  fcUniforms.fcFogParams.value.set(f.falloff, f.baseY, 0, f.distK);
}

// ---------------------------------------------------------------------------------------
// Buildings: vertex colours, the house kit's procedural facades (facade-shader.ts) from
// (uv, _facade, _wall, _kit), lit windows at night.

function patchBuildingShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  injectUniforms(shader);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${FACADE_VERTEX_PARS}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\n${FACADE_VERTEX}`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${facadeDefines(GARAGE_W, GARAGE_H, DOOR_W)}${FACADE_FRAGMENT_PARS}`)
    .replace("#include <color_fragment>", `#include <color_fragment>\n${FACADE_FRAGMENT}`)
    .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${FACADE_ROUGHNESS}`)
    .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FACADE_NORMAL}`)
    .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${FACADE_EMISSIVE}`);
}

/** Vertex-coloured ground/road material with a little procedural grain so big flat areas are not dead. */
const GRAIN_PARS = /* glsl */ `
varying vec3 vFcWorld;
float fcN( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p );
  float a = fract( sin( dot( i, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
  float b = fract( sin( dot( i + vec2( 1.0, 0.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
  float c = fract( sin( dot( i + vec2( 0.0, 1.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
  float d = fract( sin( dot( i + vec2( 1.0, 1.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
`;

function patchGrainShader(amount: number, scale: number) {
  return (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    injectUniforms(shader);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFcWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\n  vFcWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GRAIN_PARS}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
  float fcG = fcN( vFcWorld.xz * ${scale.toFixed(3)} ) * 0.6 + fcN( vFcWorld.xz * ${(scale * 7.3).toFixed(3)} ) * 0.4;
  diffuseColor.rgb *= 1.0 + ( fcG - 0.5 ) * ${amount.toFixed(3)};`,
      );
  };
}

// Road ribbons that carry TEXCOORD_0 = (0 at the left kerb .. 1 at the right kerb, metres
// along the edge), as the pipeline writes them: kerb strips and dashed lines are drawn from
// the UVs, since such tiles have no marking geometry.
const ROAD_UV_FRAGMENT = (freeway: boolean): string => /* glsl */ `
  {
    vec2 ruv = vFcRoadUv;
    // Metres per unit of u (the ribbon's width) from screen-space derivatives: solve
    // dP = P_u du + P_v dv for P_u. Clamped, since it is noisy at grazing angles.
    vec3 dpx = dFdx( vFcWorld );
    vec3 dpy = dFdy( vFcWorld );
    vec2 dux = dFdx( ruv );
    vec2 duy = dFdy( ruv );
    float det = dux.x * duy.y - duy.x * dux.y;
    float widthM = abs( det ) > 1e-9 ? length( ( dpx * duy.y - dpy * dux.y ) / det ) : 12.0;
    widthM = clamp( widthM, 4.0, 60.0 );
    float fu = fwidth( ruv.x ) * 0.8 + 1e-4;
    float kerbU = 0.35 / widthM;
    float kerb = 1.0 - smoothstep( kerbU - fu, kerbU + fu, min( ruv.x, 1.0 - ruv.x ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.25, 0.245, 0.235 ), kerb * 0.85 );
    float dash = step( fract( ruv.y / ${freeway ? "12.0" : "9.0"} ), 0.42 );
    float halfU = 0.07 / widthM;
    float line = 0.0;
    ${
      freeway
        ? "for ( int k = 1; k < 3; k++ ) { float c = float( k ) / 3.0; line = max( line, 1.0 - smoothstep( halfU, halfU + fu, abs( ruv.x - c ) ) ); }"
        : "line = widthM > 7.0 ? 1.0 - smoothstep( halfU, halfU + fu, abs( ruv.x - 0.5 ) ) : 0.0;"
    }
    float far = smoothstep( 0.02, 0.06, fu );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.72, 0.71, 0.66 ), line * dash * ( 1.0 - far ) );
  }
`;

function patchRoadUvShader(freeway: boolean) {
  const grain = patchGrainShader(0.16, 0.35);
  return (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    grain(shader);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vFcRoadUv;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vFcRoadUv = uv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vFcRoadUv;")
      .replace("#include <color_fragment>", `#include <color_fragment>\n${ROAD_UV_FRAGMENT(freeway)}`);
  };
}

// Sidewalk bands: TEXCOORD_0 = (0 at the kerb .. 1 at the outer edge, metres along the walk
// line). A lighter kerb strip and slab joints every 1.5 m, fading out with distance.
function patchSidewalkShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  patchGrainShader(0.14, 0.5)(shader);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec2 vFcWalkUv;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vFcWalkUv = uv;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying vec2 vFcWalkUv;")
    .replace(
      "#include <color_fragment>",
      `#include <color_fragment>
  {
    float fv = fwidth( vFcWalkUv.y ) + 1e-4;
    float joint = 1.0 - smoothstep( 0.03, 0.03 + fv, abs( fract( vFcWalkUv.y / 1.5 + 0.5 ) - 0.5 ) * 1.5 );
    float fade = 1.0 - smoothstep( 0.05, 0.25, fv );
    diffuseColor.rgb *= 1.0 - joint * 0.28 * fade;
    float fu = fwidth( vFcWalkUv.x ) + 1e-4;
    float kerb = 1.0 - smoothstep( 0.06, 0.06 + fu, vFcWalkUv.x );
    diffuseColor.rgb *= 1.0 + kerb * 0.25;
  }`,
    );
}

/**
 * A tile's ground material when bores run under it (structures.ts boreCuts): the shared ground's
 * look, with fragments over a bore and below its ceiling discarded, so the portals are open.
 * `cuts` holds two vec4 per piece: (ax, az, bx, bz), (half width, ceiling y at a, at b, 0).
 */
export function groundCutMaterial(cuts: Float32Array, count: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0, name: "fc:ground-cut" });
  const grain = patchGrainShader(0.22, 0.08);
  const n = Math.max(1, count);
  const vecs: THREE.Vector4[] = [];
  for (let i = 0; i < 2 * n; i++) vecs.push(new THREE.Vector4(cuts[4 * i] ?? 0, cuts[4 * i + 1] ?? 0, cuts[4 * i + 2] ?? 0, cuts[4 * i + 3] ?? 0));
  m.onBeforeCompile = (shader) => {
    grain(shader);
    shader.uniforms.fcCuts = { value: vecs };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform vec4 fcCuts[${2 * n}];`)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
  for ( int i = 0; i < ${count}; i++ ) {
    vec4 ab = fcCuts[ 2 * i ];
    vec4 wy = fcCuts[ 2 * i + 1 ];
    vec2 d = ab.zw - ab.xy;
    float t = dot( vFcWorld.xz - ab.xy, d ) / max( dot( d, d ), 1e-6 );
    if ( t < 0.0 || t > 1.0 ) continue;
    if ( length( vFcWorld.xz - ab.xy - d * t ) < wy.x && vFcWorld.y < mix( wy.y, wy.z, t ) ) discard;
  }`,
      );
  };
  m.customProgramCacheKey = () => `fc:ground-cut:${count}`;
  return m;
}

export interface SharedMaterials {
  building: THREE.MeshStandardMaterial;
  /** For building meshes shipped without normals (flat shading from screen derivatives). */
  buildingFlat: THREE.MeshStandardMaterial;
  ground: THREE.MeshStandardMaterial;
  /** The curtains under the ground's borders (ground-extras.ts groundSkirt): both sides drawn. */
  groundSkirt: THREE.MeshStandardMaterial;
  road: THREE.MeshStandardMaterial;
  /** Tunnel bores and portals (structures.ts): concrete, both sides. */
  tunnel: THREE.MeshStandardMaterial;
  /** Sidewalk bands (sidewalks.ts): concrete with slab joints, under the road ribbons. */
  sidewalk: THREE.MeshStandardMaterial;
  /** Road and freeway ribbons with kerb-to-kerb UVs (pipeline tiles). */
  roadUv: THREE.MeshStandardMaterial;
  freewayUv: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  lampPole: THREE.MeshStandardMaterial;
  lampHead: THREE.MeshStandardMaterial;
  /** The house kit's merged pieces (bays, stoops, mouldings, roof props, shopfronts): vertex colours. */
  houseKit: THREE.MeshStandardMaterial;
  /** Every shared material, for disposal. */
  all: THREE.Material[];
}

function roadMaterial(name: string, patch: (s: THREE.WebGLProgramParametersWithUniforms) => void): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, name });
  m.onBeforeCompile = patch;
  m.customProgramCacheKey = () => `${name}:v1`;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -2;
  return m;
}

export function createSharedMaterials(): SharedMaterials {
  installFog();
  const building = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0, name: "fc:building" });
  building.onBeforeCompile = patchBuildingShader;
  building.customProgramCacheKey = () => "fc:building:v3";
  const buildingFlat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0, flatShading: true, name: "fc:building-flat" });
  buildingFlat.onBeforeCompile = patchBuildingShader;
  buildingFlat.customProgramCacheKey = () => "fc:building:v3";

  const ground = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0, name: "fc:ground" });
  ground.onBeforeCompile = patchGrainShader(0.22, 0.08);
  ground.customProgramCacheKey = () => "fc:ground:v1";

  const groundSkirt = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide, name: "fc:ground-skirt" });

  const tunnel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, name: "fc:tunnel" });
  const sidewalk = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, name: "fc:sidewalk" });
  sidewalk.onBeforeCompile = patchSidewalkShader;
  sidewalk.customProgramCacheKey = () => "fc:sidewalk:v1";
  sidewalk.polygonOffset = true;
  sidewalk.polygonOffsetFactor = -0.5;
  sidewalk.polygonOffsetUnits = -1;

  const road = roadMaterial("fc:road", patchGrainShader(0.16, 0.35));
  const roadUv = roadMaterial("fc:road-uv", patchRoadUvShader(false));
  const freewayUv = roadMaterial("fc:freeway-uv", patchRoadUvShader(true));

  const foliage = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, name: "fc:foliage" });
  const lampPole = new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.6, metalness: 0.5, name: "fc:lamp-pole" });
  const lampHead = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.4, metalness: 0.1, emissive: 0xffb466, emissiveIntensity: 0, name: "fc:lamp-head" });
  const houseKit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, name: "fc:house-kit" });
  // Bays, mouldings and stoops sit on the wall plane: they win the depth ties with it.
  houseKit.polygonOffset = true;
  houseKit.polygonOffsetFactor = -1;
  houseKit.polygonOffsetUnits = -2;
  return {
    houseKit,
    building,
    buildingFlat,
    ground,
    groundSkirt,
    tunnel,
    sidewalk,
    road,
    roadUv,
    freewayUv,
    foliage,
    lampPole,
    lampHead,
    all: [houseKit, building, buildingFlat, ground, groundSkirt, tunnel, sidewalk, road, roadUv, freewayUv, foliage, lampPole, lampHead],
  };
}

export type TileLayer = "building" | "ground" | "road" | "freeway" | "foliage";

/**
 * Which layer a mesh in a tile glb belongs to, from its material name or its node name
 * ("buildings", "ground"/"terrain", "roads"/"streets", "freeways", "foliage"/"trees").
 * Tiles from this repo's dev-city builder and from the pipeline both use these names.
 */
export function tileLayer(materialName: string, nodeName: string): TileLayer | null {
  for (const n of [materialName.toLowerCase(), nodeName.toLowerCase()]) {
    if (/^buildings?(?![a-z])/.test(n)) return "building";
    if (/^(ground|terrain)(?![a-z])/.test(n)) return "ground";
    if (/^(freeways?|ramps?)(?![a-z])/.test(n)) return "freeway";
    if (/^(roads?|streets?)(?![a-z])/.test(n)) return "road";
    if (/^(foliage|trees?)(?![a-z])/.test(n)) return "foliage";
  }
  return null;
}

/** The shared material for a tile mesh of a given layer, chosen by what its geometry carries. */
export function materialFor(m: SharedMaterials, layer: TileLayer, geo: { hasNormals: boolean; hasUv: boolean }): THREE.Material {
  switch (layer) {
    case "building":
      return geo.hasNormals ? m.building : m.buildingFlat;
    case "ground":
      return m.ground;
    case "road":
      return geo.hasUv ? m.roadUv : m.road;
    case "freeway":
      return geo.hasUv ? m.freewayUv : m.road;
    case "foliage":
      return m.foliage;
  }
}
