// Sky dome, sun/moon, and the lighting presets for golden hour and night.
// The sky is a gradient (zenith -> horizon, warmer towards the sun) with a sun glow and
// disc, stars at night, and a fog band at the horizon blended in display space with exactly
// the scene fog colour, so distant buildings dissolve into the horizon instead of cutting
// out against it. The same sky function lights the Bay's reflections (water.ts).

import * as THREE from "three";
import { fcUniforms } from "./materials.ts";

export interface LightingPreset {
  name: "day" | "noon" | "night";
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
}

export const DAY: LightingPreset = {
  name: "day",
  sunAzimuthDeg: 284,
  sunElevationDeg: 8,
  sunColor: 0xffc58e,
  sunIntensity: 3.2,
  hemiSky: 0xb7c6de,
  hemiGround: 0x6d5c4b,
  hemiIntensity: 0.55,
  envIntensity: 0.55,
  zenith: 0x3f6ea8,
  horizonWarm: 0xf6c99a,
  horizonCool: 0xc9c3cf,
  sunGlow: 1.0,
  sunDisc: 22,
  fogColor: 0xc4c0c2,
  sunFogColor: 0xf7d2a8,
  sunFogStrength: 0.85,
  fog: { density: 0.00025, falloff: 1 / 120, baseY: 0, distK: 1 / 14000 },
  exposure: 1.0,
  stars: 0,
  water: 1,
};

/**
 * Midday with the fog burnt off (the high tier's daytime look, ?tod=noon): a high sun from the
 * south-south-west, short shadows, a clear blue sky, neutral light.
 */
export const NOON: LightingPreset = {
  name: "noon",
  sunAzimuthDeg: 200,
  sunElevationDeg: 58,
  sunColor: 0xfff3e2,
  sunIntensity: 3.4,
  hemiSky: 0xbcd2ee,
  hemiGround: 0x7a6b5a,
  hemiIntensity: 0.6,
  envIntensity: 0.65,
  zenith: 0x2f69b8,
  horizonWarm: 0xd9e2ea,
  horizonCool: 0xb9cde3,
  sunGlow: 0.6,
  sunDisc: 18,
  fogColor: 0xc9d3dc,
  sunFogColor: 0xf3eadb,
  sunFogStrength: 0.35,
  fog: { density: 0.00018, falloff: 1 / 130, baseY: 0, distK: 1 / 16000 },
  exposure: 0.92,
  stars: 0,
  water: 1.1,
};

export const NIGHT: LightingPreset = {
  name: "night",
  sunAzimuthDeg: 140,
  sunElevationDeg: 38,
  sunColor: 0x9fb4e0,
  sunIntensity: 0.32,
  hemiSky: 0x24324f,
  hemiGround: 0x3a2a1e,
  hemiIntensity: 0.3,
  envIntensity: 0.22,
  zenith: 0x050a16,
  horizonWarm: 0x34292a,
  horizonCool: 0x262024,
  sunGlow: 0.25,
  sunDisc: 6,
  fogColor: 0x2e2729,
  sunFogColor: 0x3f4758,
  sunFogStrength: 0.25,
  fog: { density: 0.0003, falloff: 1 / 110, baseY: 0, distK: 1 / 12000 },
  exposure: 1.05,
  stars: 1,
  water: 0.22,
};

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
      uniforms: { ...skyUniforms, fcSunDir: fcUniforms.fcSunDir, fcSunFog: fcUniforms.fcSunFog },
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
  const f = skyUniforms.uFogDisplay.value;
  f.set(((p.fogColor >> 16) & 255) / 255, ((p.fogColor >> 8) & 255) / 255, (p.fogColor & 255) / 255);
  const sd = skyUniforms.uSunDirSky.value;
  fcUniforms.fcSunDir.value.set(sd.x, sd.y, sd.z, p.sunFogStrength);
  const sf = fcUniforms.fcSunFog.value;
  sf.set(((p.sunFogColor >> 16) & 255) / 255, ((p.sunFogColor >> 8) & 255) / 255, (p.sunFogColor & 255) / 255);
}
