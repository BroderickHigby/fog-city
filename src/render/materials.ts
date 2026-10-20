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
import { FACADES } from "./tile-geometry.ts";

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
// Buildings: vertex colours, procedural windows from (uv, _facade), lit at night.

function facadeTable(): string {
  const rows = FACADES.map(
    (f) => `vec4(${f.colW.toFixed(3)}, ${f.floorH.toFixed(3)}, ${f.lit.toFixed(3)}, ${f.shopH.toFixed(3)})`,
  ).join(",\n    ");
  const wins = FACADES.map((f) => `vec4(${f.win.map((v) => v.toFixed(3)).join(", ")})`).join(",\n    ");
  return /* glsl */ `
  const int FC_FACADES = ${FACADES.length};
  const vec4 FC_GRID[${FACADES.length}] = vec4[](
    ${rows}
  );
  const vec4 FC_WIN[${FACADES.length}] = vec4[](
    ${wins}
  );`;
}

const BUILDING_VERTEX_PARS = /* glsl */ `
attribute float _facade;
varying vec2 vFcUv;
varying float vFcFacade;
`;

const BUILDING_FRAGMENT_PARS = /* glsl */ `
varying vec2 vFcUv;
varying float vFcFacade;
uniform float fcNight;
${facadeTable()}
float fcHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float fcBand( float lo, float hi, float x, float w ) {
  return smoothstep( lo - w, lo + w, x ) - smoothstep( hi - w, hi + w, x );
}
`;

/** Computes window coverage, adjusts albedo/roughness, adds night emission. */
const BUILDING_FRAGMENT = /* glsl */ `
  float fcWin = 0.0;
  float fcLit = 0.0;
  vec3 fcLightCol = vec3( 1.0, 0.72, 0.42 );
  int fcStyle = int( vFcFacade + 0.5 );
  if ( fcStyle > 0 && fcStyle < FC_FACADES ) {
    vec4 grid = FC_GRID[ fcStyle ];
    vec4 win = FC_WIN[ fcStyle ];
    vec2 cell = vec2( grid.x, grid.y );
    bool shop = grid.w > 0.0 && vFcUv.y < grid.w && vFcUv.y > 0.0;
    if ( shop ) { cell = vec2( grid.x * 2.0, grid.w ); win = vec4( 0.08, 0.92, 0.12, 0.8 ); }
    vec2 g = vFcUv / cell;
    vec2 f = fract( g );
    vec2 id = floor( g );
    vec2 fw = fwidth( g );
    float w = fcBand( win.x, win.y, f.x, fw.x * 0.75 ) * fcBand( win.z, win.w, f.y, fw.y * 0.75 );
    float avg = ( win.y - win.x ) * ( win.w - win.z );
    float far = smoothstep( 0.18, 0.5, max( fw.x, fw.y ) );
    w = mix( w, avg, far );
    // No windows below the first storey line on non-shop facades, or under ground.
    if ( !shop && vFcUv.y < max( grid.w, 0.8 ) ) w = 0.0;
    if ( vFcUv.y < 0.0 ) w = 0.0;
    fcWin = w;
    float h = fcHash( id + vec2( float( fcStyle ) * 17.0, 0.0 ) );
    // Occupancy comes in clusters (a flat, an office floor), not salt and pepper.
    float cluster = fcHash( floor( id / vec2( 5.0, 3.0 ) ) + 7.3 );
    float litFrac = shop ? 0.75 : grid.z * ( 0.35 + 1.3 * cluster );
    float on = step( 1.0 - litFrac, h );
    fcLit = mix( on, litFrac * 0.55, far ) * w;
    float tone = fcHash( id * 1.7 + 3.1 );
    fcLightCol = tone > 0.82 ? vec3( 0.75, 0.86, 1.0 ) : ( tone > 0.55 ? vec3( 1.0, 0.85, 0.6 ) : vec3( 1.0, 0.7, 0.4 ) );
    if ( shop ) fcLightCol = vec3( 1.0, 0.82, 0.55 );
    // Glass reads darker and bluer by day; the environment map supplies reflections.
    vec3 glass = mix( vec3( 0.035, 0.05, 0.065 ), vec3( 0.06, 0.07, 0.08 ), tone );
    diffuseColor.rgb = mix( diffuseColor.rgb, glass, w * 0.9 );
  }
`;

const BUILDING_ROUGHNESS = /* glsl */ `
  roughnessFactor = mix( roughnessFactor, 0.12, fcWin );
`;

const BUILDING_EMISSIVE = /* glsl */ `
  totalEmissiveRadiance += fcLightCol * fcLit * fcNight * 1.7;
`;

function patchBuildingShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  injectUniforms(shader);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${BUILDING_VERTEX_PARS}`)
    .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vFcUv = uv;\n  vFcFacade = _facade;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${BUILDING_FRAGMENT_PARS}`)
    .replace("#include <color_fragment>", `#include <color_fragment>\n${BUILDING_FRAGMENT}`)
    .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${BUILDING_ROUGHNESS}`)
    .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${BUILDING_EMISSIVE}`);
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

export interface SharedMaterials {
  building: THREE.MeshStandardMaterial;
  ground: THREE.MeshStandardMaterial;
  road: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  lampPole: THREE.MeshStandardMaterial;
  lampHead: THREE.MeshStandardMaterial;
  /** Every shared material, for disposal. */
  all: THREE.Material[];
}

export function createSharedMaterials(): SharedMaterials {
  installFog();
  const building = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0, name: "fc:building" });
  building.onBeforeCompile = patchBuildingShader;
  building.customProgramCacheKey = () => "fc:building:v1";

  const ground = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0, name: "fc:ground" });
  ground.onBeforeCompile = patchGrainShader(0.22, 0.08);
  ground.customProgramCacheKey = () => "fc:ground:v1";

  const road = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, name: "fc:road" });
  road.onBeforeCompile = patchGrainShader(0.16, 0.35);
  road.customProgramCacheKey = () => "fc:road:v1";
  road.polygonOffset = true;
  road.polygonOffsetFactor = -1;
  road.polygonOffsetUnits = -2;

  const foliage = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, name: "fc:foliage" });
  const lampPole = new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.6, metalness: 0.5, name: "fc:lamp-pole" });
  const lampHead = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.4, metalness: 0.1, emissive: 0xffb466, emissiveIntensity: 0, name: "fc:lamp-head" });
  return { building, ground, road, foliage, lampPole, lampHead, all: [building, ground, road, foliage, lampPole, lampHead] };
}

/** Material names a tile glb may use; the loader swaps these for the shared ones. */
export function sharedByName(m: SharedMaterials, name: string): THREE.Material | null {
  switch (name) {
    case "building":
      return m.building;
    case "ground":
      return m.ground;
    case "road":
      return m.road;
    case "foliage":
      return m.foliage;
    default:
      return null;
  }
}

/** Display-space RGB of a hex colour, for uniforms mixed after tone mapping (like fogColor). */
export function displayRgb(hex: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
}
