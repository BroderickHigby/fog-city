// The Bay: one large plane at y = 0 that follows the camera. Cheap reflective look without a
// mirror pass: wave normals from a sum of directional sines (in world space, so moving the
// plane never swims), Fresnel between the water body colour and the analytic sky
// (sky.ts: SKY_GLSL) in the reflected direction, a sun glint, and the scene's height fog.

import * as THREE from "three";
import { fcUniforms } from "./materials.ts";
import { SKY_GLSL, skyUniforms } from "./sky.ts";

const VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
uniform float uDepthDrop;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  // Shade at y = 0, but rasterise depth as if the surface sat uDepthDrop lower, so land
  // drawn at y ~ 0 (tiles with no heightfield) always wins without polygon offset.
  gl_Position = projectionMatrix * ( viewMatrix * ( wp - vec4( 0.0, uDepthDrop, 0.0, 0.0 ) ) );
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
${SKY_GLSL}
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uBodyLight;
uniform vec3 uCityGlow;
varying vec3 vWorld;

float fcWHash( vec2 p ) {
  p = fract( p * vec2( 233.34, 851.73 ) );
  p += dot( p, p + 23.45 );
  return fract( p.x * p.y );
}
// Value noise with its analytic gradient: (value, d/dx, d/dy).
vec3 fcWNoiseD( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  vec2 du = 6.0 * f * ( 1.0 - f );
  float a = fcWHash( i );
  float b = fcWHash( i + vec2( 1.0, 0.0 ) );
  float c = fcWHash( i + vec2( 0.0, 1.0 ) );
  float d = fcWHash( i + vec2( 1.0, 1.0 ) );
  float k = a - b - c + d;
  return vec3( a + ( b - a ) * u.x + ( c - a ) * u.y + k * u.x * u.y,
               du * ( vec2( b - a, c - a ) + k * u.yx ) );
}
float fcWNoise( vec2 p ) {
  return fcWNoiseD( p ).x;
}

void main() {
  vec3 toFrag = vWorld - cameraPosition;
  float dist = length( toFrag );
  vec3 V = toFrag / max( dist, 1e-3 );
  vec2 p = vWorld.xz;
  float t = uTime;
  // Height gradient of: two long swells + three octaves of drifting noise chop. Each
  // octave fades out once a wave is smaller than a few pixels (a cheap low-pass), so
  // far water calms down instead of aliasing.
  float px = dist * 0.0025;
  vec2 g = vec2( 0.0 );
  vec2 k1 = vec2( 0.034, 0.021 );
  vec2 k2 = vec2( -0.031, 0.082 );
  g += 0.30 * k1 * cos( dot( p, k1 ) + t * 0.55 );
  g += 0.14 * k2 * cos( dot( p, k2 ) + t * 0.9 );
  g += 0.22 * 0.11 * fcWNoiseD( p * 0.11 + vec2( t * 0.11, t * 0.07 ) ).yz * ( 1.0 - smoothstep( 4.0, 9.0, px ) );
  g += 0.10 * 0.29 * fcWNoiseD( p * 0.29 - vec2( t * 0.21, -t * 0.13 ) ).yz * ( 1.0 - smoothstep( 1.5, 3.5, px ) );
  g += 0.04 * 0.83 * fcWNoiseD( p * 0.83 + vec2( -t * 0.35, t * 0.3 ) ).yz * ( 1.0 - smoothstep( 0.5, 1.2, px ) );
  float fade = 1.0 - smoothstep( 300.0, 2500.0, dist );
  vec3 N = normalize( vec3( -g.x * fade, 1.0, -g.y * fade ) );
  float cosT = max( dot( N, -V ), 0.0 );
  float fres = 0.02 + 0.98 * pow( 1.0 - cosT, 5.0 );
  vec3 R = reflect( V, N );
  R.y = max( R.y, 0.015 );
  vec3 sky = fcSkyRadiance( normalize( R ) );
  vec3 body = mix( uDeep, uShallow, 0.35 + 0.35 * N.x ) * uBodyLight;
  vec3 col = mix( body, sky, clamp( fres, 0.0, 1.0 ) );
  // At night the shore lights smear into a warm band where the water reflects the horizon.
  col += uCityGlow * pow( 1.0 - clamp( R.y * 6.0, 0.0, 1.0 ), 3.0 ) * ( 0.4 + 0.6 * fres ) * ( 0.6 + 0.8 * fcWNoise( p * vec2( 0.05, 0.6 ) + uTime * 0.2 ) );
  float sd = max( dot( normalize( R ), uSunDirSky ), 0.0 );
  col += uSunColorSky * ( pow( sd, 900.0 ) * 60.0 + pow( sd, 90.0 ) * 0.6 ) * fade;
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class Water {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private bodyLight: { value: number };
  private cityGlow = { value: new THREE.Color(0, 0, 0) };

  constructor(size = 14000) {
    this.bodyLight = { value: 1 };
    this.material = new THREE.ShaderMaterial({
      name: "fc:water",
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]) as Record<string, THREE.IUniform>,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      fog: true,
    });
    Object.assign(this.material.uniforms, skyUniforms, fcUniforms, {
      uTime: fcUniforms.fcTime,
      uDeep: { value: new THREE.Color(0x163238) },
      uShallow: { value: new THREE.Color(0x2c4a4a) },
      uBodyLight: this.bodyLight,
      uDepthDrop: { value: 0.12 },
      uCityGlow: this.cityGlow,
    });
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = "bay";
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  setBodyLight(v: number): void {
    this.bodyLight.value = v;
  }

  /** Warm reflected shore light (linear RGB); black by day. */
  setCityGlow(hex: number, strength: number): void {
    this.cityGlow.value.setHex(hex).multiplyScalar(strength);
  }

  /** Follow the camera in 50 m steps (waves are in world space, so steps never show). */
  follow(camera: THREE.Camera): void {
    const x = Math.round(camera.position.x / 50) * 50;
    const z = Math.round(camera.position.z / 50) * 50;
    if (this.mesh.position.x !== x || this.mesh.position.z !== z) {
      this.mesh.position.set(x, 0, z);
      this.mesh.updateMatrix();
      this.mesh.updateMatrixWorld();
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
