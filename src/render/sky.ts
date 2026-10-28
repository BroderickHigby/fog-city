// Sky dome, sun/moon, and the lighting presets for golden hour and night.
// The sky is a gradient (zenith -> horizon, warmer towards the sun) with a sun glow and
// disc, stars at night, and a fog band at the horizon blended in display space with exactly
// the scene fog colour, so distant buildings dissolve into the horizon instead of cutting
// out against it. The same sky function lights the Bay's reflections (water.ts).

import * as THREE from "three";
import { fcUniforms } from "./materials.ts";

export interface LightingPreset {
  name: "day" | "golden" | "noon" | "twilight" | "night";
  /** Direction towards the sun (or moon), compass azimuth and elevation in degrees. */
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  envIntensity: number;
  zenith: number;
  horizonWarm: number;
  horizonCool: number;
  /** Sun glow and disc strength in the sky (linear multipliers). */
  sunGlow: number;
  sunDisc: number;
  fogColor: number;
  sunFogColor: number;
  sunFogStrength: number;
  fog: { density: number; falloff: number; baseY: number; distK: number };
  exposure: number;
  stars: number;
  water: number;
  /** High cloud layer shared by the visible sky, IBL and water reflections. */
  cloudCoverage?: number;
  cloudOpacity?: number;
  /**
   * How bright the clouds' lit tops are (1 = daylight white) and how much warm city glow lights
   * their undersides. Night clouds are dim moonlit grey with an orange underglow, never white
   * (a white cloud on a black sky reads as a photo negative).
   */
  cloudLight?: number;
  cloudGlow?: number;
  /** Dusk can raise city lights gradually without switching the simulation clock. */
  nightFactor?: number;
  /**
   * The GPU engine's Preetham sky (three's SkyMesh): haze (turbidity), Rayleigh and Mie scattering,
   * Mie anisotropy and the exposure that brings its radiance into scene range; `skyNightColor` is
   * the flat sky it fades to as `nightFactor` rises. Per time of day as in Slop New York's
   * lighting.js presets, so the blend keys in daylight.ts move the haze, not only the sun.
   * Presets that omit them get the golden-hour values (skyHaze).
   */
  skyTurbidity?: number;
  skyRayleigh?: number;
  skyMie?: number;
  skyMieG?: number;
  skyExposure?: number;
  skyNightColor?: number;
}

/** Sky settings the GPU engine reads: a preset's own, else the golden-hour defaults. */
export interface SkyHaze { turbidity: number; rayleigh: number; mie: number; mieG: number; exposure: number; nightColor: number }
export function skyHaze(p: LightingPreset): SkyHaze {
  return {
    turbidity: p.skyTurbidity ?? 8, rayleigh: p.skyRayleigh ?? 2.8, mie: p.skyMie ?? 0.008, mieG: p.skyMieG ?? 0.88,
    exposure: p.skyExposure ?? 0.148, nightColor: p.skyNightColor ?? 0x101723,
  };
}

/** Warm afternoon light across the Bay, with a directional key and restrained fill. */
export const GOLDEN: LightingPreset = {
  name: "golden",
  sunAzimuthDeg: 276,
  sunElevationDeg: 24,
  sunColor: 0xffd2a3,
  sunIntensity: 5.8,
  hemiSky: 0x9abbe6,
  hemiGround: 0xc88a62,
  // A restrained sky/bounce fill keeps shaded SF asphalt and tree crowns readable;
  // the directional sun still supplies over three times the hemisphere intensity.
  hemiIntensity: 1.7,
  envIntensity: 0.62,
  zenith: 0x4779ae,
  horizonWarm: 0xe9d1b5,
  horizonCool: 0xbacddd,
  sunGlow: 0.8,
  sunDisc: 18,
  fogColor: 0xc4ced4,
  sunFogColor: 0xe8d5b8,
  sunFogStrength: 0.62,
  fog: { density: 0.0002, falloff: 1 / 95, baseY: 0, distK: 1 / 16000 },
  exposure: 1.04,
  stars: 0,
  water: 1,
  cloudCoverage: 0.35,
  cloudOpacity: 0.68,
  nightFactor: 0,
  // Slop New York's golden hour (lighting.js:44-47, 94-97 midday, 69-72 twilight, 119-122 midnight).
  skyTurbidity: 8,
  skyRayleigh: 2.8,
  skyMie: 0.008,
  skyMieG: 0.88,
  skyExposure: 0.148,
  // The flat sky it fades to as the night factor rises: a dusk indigo until the real night key.
  skyNightColor: 0x1c2748,
};

/** Backwards-compatible default: a clear SF afternoon, rather than an almost-set sun. */
export const DAY: LightingPreset = { ...GOLDEN, name: "day" };

export const NOON: LightingPreset = {
  ...GOLDEN,
  name: "noon",
  sunAzimuthDeg: 215,
  sunElevationDeg: 61,
  sunColor: 0xfff5e8,
  sunIntensity: 6.6,
  hemiSky: 0xaad2ff,
  hemiGround: 0xb89678,
  hemiIntensity: 1.76,
  envIntensity: 0.67,
  zenith: 0x3977b6,
  horizonWarm: 0xd4e2e9,
  horizonCool: 0xc2d6e6,
  fogColor: 0xc9d9e3,
  sunFogColor: 0xe8e4d6,
  sunFogStrength: 0.35,
  fog: { density: 0.00016, falloff: 1 / 110, baseY: 0, distK: 1 / 18000 },
  cloudCoverage: 0.25,
  cloudOpacity: 0.62,
  exposure: 1.0,
  skyTurbidity: 6.5,
  skyRayleigh: 2.4,
  skyMie: 0.006,
  skyMieG: 0.86,
  skyExposure: 0.142,
};

export const TWILIGHT: LightingPreset = {
  ...GOLDEN,
  name: "twilight",
  sunAzimuthDeg: 285,
  sunElevationDeg: 2,
  sunColor: 0xffb780,
  sunIntensity: 0.85,
  hemiSky: 0x7895bf,
  hemiGround: 0x6d574c,
  hemiIntensity: 0.55,
  envIntensity: 0.42,
  zenith: 0x233b6a,
  horizonWarm: 0xc78e77,
  horizonCool: 0x717f9f,
  sunGlow: 0.5,
  sunDisc: 10,
  fogColor: 0x848d9e,
  sunFogColor: 0xc89d88,
  sunFogStrength: 0.52,
  exposure: 1.05,
  stars: 0.15,
  water: 0.65,
  cloudCoverage: 0.4,
  cloudOpacity: 0.55,
  cloudLight: 0.45,
  cloudGlow: 0.012,
  nightFactor: 0.45,
  skyTurbidity: 9.5,
  skyRayleigh: 3.4,
  skyMie: 0.01,
  skyMieG: 0.9,
  skyExposure: 0.115,
};

export const NIGHT: LightingPreset = {
  name: "night",
  sunAzimuthDeg: 140,
  sunElevationDeg: 38,
  sunColor: 0xaabce4,
  sunIntensity: 1.0,
  hemiSky: 0x263a62,
  // The ground bounce is the street lights' warm spill: people and robots stay readable.
  hemiGround: 0x4a3a2c,
  hemiIntensity: 0.72,
  envIntensity: 0.3,
  zenith: 0x071326,
  horizonWarm: 0x343344,
  horizonCool: 0x27384c,
  sunGlow: 0.18,
  sunDisc: 4,
  fogColor: 0x303647,
  sunFogColor: 0x52627b,
  sunFogStrength: 0.22,
  fog: { density: 0.00026, falloff: 1 / 100, baseY: 0, distK: 1 / 13500 },
  exposure: 1.25,
  stars: 1,
  water: 0.25,
  cloudCoverage: 0.22,
  cloudOpacity: 0.38,
  cloudLight: 0.035,
  cloudGlow: 0.03,
  nightFactor: 1,
  skyTurbidity: 4,
  skyRayleigh: 1.5,
  skyMie: 0.004,
  skyMieG: 0.8,
  skyExposure: 0.022,
  skyNightColor: 0x101723,
};

export const LIGHTING_PRESETS = Object.freeze({ golden: GOLDEN, noon: NOON, twilight: TWILIGHT, night: NIGHT });

export function sunDirection(p: Pick<LightingPreset, "sunAzimuthDeg" | "sunElevationDeg">, out = new THREE.Vector3()): THREE.Vector3 {
  const az = (p.sunAzimuthDeg * Math.PI) / 180;
  const el = (p.sunElevationDeg * Math.PI) / 180;
  // Compass azimuth: clockwise from north (-z); east is +x.
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

/** Uniforms shared by the sky and the water (linear colours unless noted). */
export const skyUniforms = {
  uSkyZenith: { value: new THREE.Color() },
  uSkyHorizonWarm: { value: new THREE.Color() },
  uSkyHorizonCool: { value: new THREE.Color() },
  uSunDirSky: { value: new THREE.Vector3(0, 1, 0) },
  uSunColorSky: { value: new THREE.Color() },
  uSunGlow: { value: 1 },
  uSunDisc: { value: 1 },
  uStars: { value: 0 },
  uCloudCoverage: { value: 0 },
  uCloudOpacity: { value: 0 },
  /** The clouds' lit colour and their warm city underglow (linear). */
  uCloudLight: { value: new THREE.Color(0.86, 0.9, 0.94) },
  uCloudGlow: { value: new THREE.Color(0, 0, 0) },
  /** Display-space fog colour (same as the scene fog's uniform). */
  uFogDisplay: { value: new THREE.Vector3() },
};

/** GLSL: sky radiance (linear, HDR) for a world direction. Needs skyUniforms. */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizonWarm;
uniform vec3 uSkyHorizonCool;
uniform vec3 uSunDirSky;
uniform vec3 uSunColorSky;
uniform float uSunGlow;
uniform float uSunDisc;
uniform float uStars;
uniform float uCloudCoverage;
uniform float uCloudOpacity;
uniform vec3 uCloudLight;
uniform vec3 uCloudGlow;
float fcSkyHash( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}
float fcSkyNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( fcSkyHash( i ), fcSkyHash( i + vec2( 1.0, 0.0 ) ), f.x ),
    mix( fcSkyHash( i + vec2( 0.0, 1.0 ) ), fcSkyHash( i + vec2( 1.0 ) ), f.x ), f.y );
}
vec3 fcSkyRadiance( vec3 d ) {
  float y = clamp( d.y, -1.0, 1.0 );
  vec2 hz = normalize( d.xz + vec2( 1e-5 ) );
  vec2 sz = normalize( uSunDirSky.xz + vec2( 1e-5 ) );
  float toward = dot( hz, sz ) * 0.5 + 0.5;
  vec3 horizon = mix( uSkyHorizonCool, uSkyHorizonWarm, toward * toward );
  float t = pow( 1.0 - max( y, 0.0 ), 5.0 );
  vec3 sky = mix( uSkyZenith, horizon, t );
  if ( y < 0.0 ) sky = horizon * mix( 1.0, 0.6, smoothstep( 0.0, -0.4, y ) );
  float sd = max( dot( d, uSunDirSky ), 0.0 );
  sky += uSunColorSky * uSunGlow * ( 0.10 * pow( sd, 6.0 ) + 0.35 * pow( sd, 48.0 ) );
  sky += uSunColorSky * uSunDisc * smoothstep( 0.99965, 0.9999, sd );
  // Thin wind-stretched high cloud: four fixed noise samples, no ray marching or
  // animated texture. Fine structure and partial transmission avoid opaque oval puffs.
  // Shared radiance keeps the visible sky, IBL and reflected Bay coherent.
  if ( uCloudCoverage > 0.0 && y > 0.02 ) {
    vec2 cp = d.xz / max( y, 0.02 ) * 3.2;
    cp = mat2( 0.819, -0.574, 0.574, 0.819 ) * cp;
    cp = cp * vec2( 1.35, 5.5 ) + vec2( 4.7, 11.2 );
    float broad = fcSkyNoise( cp * 0.17 + 7.8 );
    float fine = fcSkyNoise( cp * 4.13 - 3.7 );
    float field = fcSkyNoise( cp ) * 0.52 + fcSkyNoise( cp * 2.07 + 11.1 ) * 0.29 + fine * 0.19;
    float density = clamp( ( field - ( 0.57 - uCloudCoverage * 0.24 ) ) * 2.8, 0.0, 1.0 );
    density *= density * mix( 0.25, 1.0, smoothstep( 0.25, 0.8, broad ) );
    float cloud = ( 1.0 - exp( -density * 1.4 ) ) * uCloudOpacity * 0.62;
    cloud *= smoothstep( 0.14, 0.30, y );
    vec3 shade = mix( horizon * 0.82, uCloudLight, smoothstep( 0.25, 0.8, field ) );
    vec3 litCloud = shade + uSunColorSky * ( 0.025 + 0.04 * pow( sd, 8.0 ) ) * ( 0.75 + fine * 0.25 );
    // City glow on the undersides: strongest low in the sky, over the lit city.
    litCloud += uCloudGlow * ( 1.0 - smoothstep( 0.15, 0.7, y ) ) * ( 0.6 + 0.4 * ( 1.0 - field ) );
    sky = mix( sky, litCloud, cloud );
  }
  return sky;
}
`;

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize( ( modelMatrix * vec4( position, 0.0 ) ).xyz );
  vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position = p.xyww; // on the far plane
}
`;

const SKY_FRAGMENT = /* glsl */ `
${SKY_GLSL}
uniform vec3 uFogDisplay;
uniform float fcLinearOutput;
uniform vec4 fcSunDir;
uniform vec3 fcSunFog;
varying vec3 vDir;
float fcStarHash( vec3 p ) { return fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ); }
void main() {
  vec3 d = normalize( vDir );
  vec3 col = fcSkyRadiance( d );
  if ( uStars > 0.0 && d.y > 0.0 ) {
    vec3 sp = d * 260.0;
    vec3 id = floor( sp );
    vec3 fp = fract( sp ) - 0.5;
    float h = fcStarHash( id );
    float s = step( 0.9975, h ) * smoothstep( 0.32, 0.0, length( fp ) ) * smoothstep( 0.08, 0.45, d.y );
    col += vec3( 0.9, 0.95, 1.0 ) * s * uStars * ( 0.6 + 2.0 * fract( h * 91.7 ) );
  }
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Horizon fog band, in display space like the scene fog.
  float s = pow( max( dot( d, fcSunDir.xyz ), 0.0 ), 6.0 ) * fcSunDir.w;
  vec3 fogc = mix( uFogDisplay, fcSunFog, clamp( s, 0.0, 1.0 ) );
  if ( fcLinearOutput > 0.5 ) fogc = sRGBTransferEOTF( vec4( fogc, 1.0 ) ).rgb;
  float band = 1.0 - smoothstep( -0.02, 0.16, d.y );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogc, band * band * ( 3.0 - 2.0 * band ) );
}
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor(radius = 4500) {
    this.material = new THREE.ShaderMaterial({
      name: "fc:sky",
      uniforms: { ...skyUniforms, fcSunDir: fcUniforms.fcSunDir, fcSunFog: fcUniforms.fcSunFog, fcLinearOutput: fcUniforms.fcLinearOutput },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), this.material);
    this.mesh.name = "sky";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  /** Keep the dome centred on the camera. */
  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
    this.mesh.updateMatrixWorld();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** Write a preset into the shared sky and fog uniforms. */
export function applySkyPreset(p: LightingPreset): void {
  skyUniforms.uSkyZenith.value.setHex(p.zenith);
  skyUniforms.uSkyHorizonWarm.value.setHex(p.horizonWarm);
  skyUniforms.uSkyHorizonCool.value.setHex(p.horizonCool);
  sunDirection(p, skyUniforms.uSunDirSky.value);
  skyUniforms.uSunColorSky.value.setHex(p.sunColor).multiplyScalar(p.sunIntensity * 0.5);
  skyUniforms.uSunGlow.value = p.sunGlow;
  skyUniforms.uSunDisc.value = p.sunDisc;
  skyUniforms.uStars.value = p.stars;
  skyUniforms.uCloudCoverage.value = p.cloudCoverage ?? 0;
  skyUniforms.uCloudOpacity.value = p.cloudOpacity ?? 0;
  skyUniforms.uCloudLight.value.setRGB(0.86, 0.9, 0.94).multiplyScalar(p.cloudLight ?? 1);
  skyUniforms.uCloudGlow.value.setRGB(1, 0.62, 0.38).multiplyScalar(p.cloudGlow ?? 0);
  const f = skyUniforms.uFogDisplay.value;
  f.set(((p.fogColor >> 16) & 255) / 255, ((p.fogColor >> 8) & 255) / 255, (p.fogColor & 255) / 255);
  const sd = skyUniforms.uSunDirSky.value;
  fcUniforms.fcSunDir.value.set(sd.x, sd.y, sd.z, p.sunFogStrength);
  const sf = fcUniforms.fcSunFog.value;
  sf.set(((p.sunFogColor >> 16) & 255) / 255, ((p.sunFogColor >> 8) & 255) / 255, (p.sunFogColor & 255) / 255);
}
