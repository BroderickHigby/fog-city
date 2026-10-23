// The Bay and the Pacific: one large plane at the sea level (manifest.water.y, 0) that follows
// the camera out past the far plane. Cheap reflective look without a
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
varying vec4 vRefl;
uniform float uDepthDrop;
uniform mat4 uReflMat;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vRefl = uReflMat * wp;
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
uniform float uWave;
uniform sampler2D uRefl;
uniform float uReflOn;
varying vec3 vWorld;
varying vec4 vRefl;

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
  g *= uWave;
  float fade = 1.0 - smoothstep( 300.0, 2500.0, dist );
  vec3 N = normalize( vec3( -g.x * fade, 1.0, -g.y * fade ) );
  float cosT = max( dot( N, -V ), 0.0 );
  float fres = 0.02 + 0.98 * pow( 1.0 - cosT, 5.0 );
  vec3 R = reflect( V, N );
  R.y = max( R.y, 0.015 );
  vec3 sky = fcSkyRadiance( normalize( R ) );
  // High tier near the showcase: the city mirrored in the water (a planar reflection pass),
  // rippled by the same wave normal; the analytic sky elsewhere.
  if ( uReflOn > 0.5 ) {
    vec2 ruv = vRefl.xy / vRefl.w + N.xz * 0.07 * fade;
    vec3 mirrored = texture2D( uRefl, clamp( ruv, vec2( 0.001 ), vec2( 0.999 ) ) ).rgb;
    sky = mix( sky, mirrored, uReflOn * ( 1.0 - smoothstep( 1500.0, 3500.0, dist ) ) );
  }
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

/** The water shader's material: the sea's (depthDrop 0.12, full waves) or a lake's. */
function waterMaterial(name: string, bodyLight: { value: number }, cityGlow: { value: THREE.Color }, depthDrop: number, wave: number): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]) as Record<string, THREE.IUniform>,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    fog: true,
  });
  Object.assign(material.uniforms, skyUniforms, fcUniforms, {
    uTime: fcUniforms.fcTime,
    uDeep: { value: new THREE.Color(0x163238) },
    uShallow: { value: new THREE.Color(0x2c4a4a) },
    uBodyLight: bodyLight,
    uDepthDrop: { value: depthDrop },
    uCityGlow: cityGlow,
    uWave: { value: wave },
    uRefl: { value: null },
    uReflOn: { value: 0 },
    uReflMat: { value: new THREE.Matrix4() },
  });
  return material;
}

const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

/**
 * A planar reflection of the scene in the water at height `level` (the high tier, gfx.ts): a
 * mirrored camera renders the scene into a half-resolution target, with an oblique near plane at
 * the water so nothing under it shows. Costs one more scene render per frame.
 */
export class WaterReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly camera = new THREE.PerspectiveCamera();
  readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();

  constructor(width: number, height: number) {
    this.target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), { type: THREE.HalfFloatType });
    this.target.texture.name = "fc:water-reflection";
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }

  /** Render `scene` as seen in a mirror at y = level, hiding `hide` meanwhile. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, main: THREE.PerspectiveCamera, level: number, hide: THREE.Object3D): void {
    const cam = this.camera;
    const m = main.matrixWorld.elements;
    // Position, a point ahead and the up vector, mirrored in the plane y = level.
    this.pos.set(m[12]!, 2 * level - m[13]!, m[14]!);
    this.look.set(m[12]! - m[8]!, 2 * level - (m[13]! - m[9]!), m[14]! - m[10]!);
    this.up.set(m[4]!, -m[5]!, m[6]!);
    cam.position.copy(this.pos);
    cam.up.copy(this.up);
    cam.lookAt(this.look);
    cam.near = main.near;
    cam.far = main.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(main.projectionMatrix);
    cam.projectionMatrixInverse.copy(main.projectionMatrixInverse);
    this.matrix.copy(BIAS).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    // Oblique near plane at the water (Lengyel): nothing below it renders.
    this.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, level, 0)).applyMatrix4(cam.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = cam.projectionMatrix.elements;
    this.q.set((Math.sign(this.clip.x) + p[8]!) / p[0]!, (Math.sign(this.clip.y) + p[9]!) / p[5]!, -1, (1 + p[10]!) / p[14]!);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    p[2] = this.clip.x;
    p[6] = this.clip.y;
    p[10] = this.clip.z + 1 - 0.003;
    p[14] = this.clip.w;
    const was = hide.visible;
    hide.visible = false;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    renderer.shadowMap.autoUpdate = shadowAuto;
    hide.visible = was;
  }

  dispose(): void {
    this.target.dispose();
  }
}

export class Water {
  readonly mesh: THREE.Mesh;
  /** The inland lakes' material (W-11): the sea's shader with calmer waves, drawn at each lake's level (ground-extras.ts). */
  readonly lakeMaterial: THREE.ShaderMaterial;
  private material: THREE.ShaderMaterial;
  private bodyLight: { value: number };
  private cityGlow = { value: new THREE.Color(0, 0, 0) };

  constructor(size = 14000) {
    this.bodyLight = { value: 1 };
    this.material = waterMaterial("fc:water", this.bodyLight, this.cityGlow, 0.12, 1);
    this.lakeMaterial = waterMaterial("fc:lake", this.bodyLight, this.cityGlow, 0, 0.35);
    // Lakes sit a few centimetres over their flattened ground: win the depth test far away too.
    this.lakeMaterial.polygonOffset = true;
    this.lakeMaterial.polygonOffsetFactor = -2;
    this.lakeMaterial.polygonOffsetUnits = -4;
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

  /** Use (or stop using, with null) a planar reflection for the sea (the lakes keep the sky). */
  setReflection(r: WaterReflection | null, on: number): void {
    const u = this.material.uniforms;
    u.uRefl!.value = r ? r.target.texture : null;
    u.uReflOn!.value = r ? on : 0;
    if (r) u.uReflMat!.value = r.matrix;
  }

  get seaLevel(): number {
    return this.level;
  }

  /** Warm reflected shore light (linear RGB); black by day. */
  setCityGlow(hex: number, strength: number): void {
    this.cityGlow.value.setHex(hex).multiplyScalar(strength);
  }

  private level = 0;

  /** The sea's height (manifest.water.y). */
  setLevel(y: number): void {
    this.level = y;
    this.mesh.position.y = y;
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld();
  }

  /** Follow the camera in 50 m steps (waves are in world space, so steps never show). */
  follow(camera: THREE.Camera): void {
    const x = Math.round(camera.position.x / 50) * 50;
    const z = Math.round(camera.position.z / 50) * 50;
    if (this.mesh.position.x !== x || this.mesh.position.z !== z) {
      this.mesh.position.set(x, this.level, z);
      this.mesh.updateMatrix();
      this.mesh.updateMatrixWorld();
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.lakeMaterial.dispose();
  }
}
