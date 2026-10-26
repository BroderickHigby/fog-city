// Weather presentation (render-only): what the sim's weather (src/sim/fog, read through
// weatherView at the camera) looks like. The marine layer thickens the height fog and greys
// it; rain flattens and darkens the sky and light and falls as streaks around the camera
// (none under shelter); wet roads lose roughness and darken; the sim's puddles are drawn as
// mirror-dark discs; the King tide lays a water sheet over the flooded promenade.
// Nothing here is read back by the sim.
import * as THREE from "three";
import type { LightingPreset } from "./sky.ts";
import { fcUniforms } from "./materials.ts";

/** The weather the renderer draws; a subset of the sim's WeatherView. */
export interface WeatherLook {
  fog: number;
  rain: number;
  wetness: number;
  tide: number;
  sheltered: boolean;
  puddles: readonly { id: string; x: number; y: number; z: number; radius: number }[];
}

export const CLEAR_WEATHER: WeatherLook = Object.freeze({ fog: 0, rain: 0, wetness: 0, tide: 0, sheltered: false, puddles: Object.freeze([]) });

/** Fog density at full marine layer, as a multiple of the preset's clear-day density. */
export const FOG_THICK = 6;
/** The marine layer's own grey, by day; at night the preset's fog colour is kept darker. */
const MARINE_GREY = new THREE.Color(0xa7b0b8);
const RAIN_GREY = new THREE.Color(0x8d969e);

const _c = new THREE.Color();
const _d = new THREE.Color();
const toward = (hex: number, target: THREE.Color, t: number, keep = 1): number =>
  _c.setHex(hex).lerp(_d.copy(target).multiplyScalar(keep), Math.max(0, Math.min(1, t))).getHex();
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** The preset as the weather changes it: thicker grey fog, a duller sun, a flatter, darker sky in rain. */
export function weatherLight(base: LightingPreset, w: Pick<WeatherLook, "fog" | "rain">): LightingPreset {
  const fog = clamp01(w.fog), rain = clamp01(w.rain);
  if (fog === 0 && rain === 0) return base;
  const night = base.nightFactor ?? (base.name === "night" ? 1 : 0);
  // Grey toward the marine layer by day; at night only toward a dim version of it.
  const keep = 1 - 0.75 * night;
  const overcast = Math.max(fog * 0.8, rain);
  return {
    ...base,
    fog: { ...base.fog, density: base.fog.density * (1 + (FOG_THICK - 1) * fog + 1.5 * rain) },
    fogColor: toward(toward(base.fogColor, MARINE_GREY, fog * 0.75, keep), RAIN_GREY, rain * 0.6, keep),
    sunFogStrength: base.sunFogStrength * (1 - 0.6 * overcast),
    sunIntensity: base.sunIntensity * (1 - 0.6 * fog) * (1 - 0.65 * rain),
    sunGlow: base.sunGlow * (1 - 0.8 * overcast),
    sunDisc: base.sunDisc * (1 - overcast),
    hemiIntensity: base.hemiIntensity * (1 - 0.15 * rain),
    envIntensity: base.envIntensity * (1 - 0.2 * rain),
    horizonWarm: toward(base.horizonWarm, RAIN_GREY, overcast * 0.7, keep),
    horizonCool: toward(base.horizonCool, RAIN_GREY, overcast * 0.6, keep),
    zenith: toward(base.zenith, RAIN_GREY, rain * 0.55, keep * 0.85),
    cloudCoverage: (base.cloudCoverage ?? 0) + (0.95 - (base.cloudCoverage ?? 0)) * rain,
    cloudOpacity: (base.cloudOpacity ?? 0) + (0.9 - (base.cloudOpacity ?? 0)) * rain,
    exposure: base.exposure * (1 - 0.1 * rain),
  };
}

/** Quantised weather for environment-map keys: a new IBL only when the sky visibly changes. */
export function weatherKey(w: Pick<WeatherLook, "fog" | "rain">): string {
  return `${Math.round(clamp01(w.fog) * 4)}${Math.round(clamp01(w.rain) * 4)}`;
}

// ------------------------------------------------------------------------------- rain

/** Rain streaks in a box this wide and tall, centred on the camera. */
export const RAIN_BOX_M = 36;
export const RAIN_STREAKS = 5000;
const RAIN_FALL_MPS = 9;
const RAIN_STREAK_M = 0.45;

const RAIN_VERTEX = /* glsl */ `
attribute float fcEnd;
uniform vec3 fcRainCam;
uniform float fcRainTime;
uniform float fcRainBox;
varying float vFcEnd;
void main() {
  vec3 p = position;
  // Fall and wrap inside the box, which moves with the camera in whole box steps per axis
  // so the streaks stay put in the world as the camera moves.
  p.y = mod( p.y - fcRainTime * ${RAIN_FALL_MPS.toFixed(1)} - fcRainCam.y, fcRainBox ) + fcRainCam.y - fcRainBox * 0.5;
  p.xz = mod( p.xz - fcRainCam.xz + fcRainBox * 0.5, fcRainBox ) + fcRainCam.xz - fcRainBox * 0.5;
  // A streak runs from its head down along the fall, slightly slanted by the wind.
  p += fcEnd * vec3( 0.04, -${RAIN_STREAK_M.toFixed(2)}, 0.02 );
  vFcEnd = fcEnd;
  gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
}
`;

const RAIN_FRAGMENT = /* glsl */ `
uniform float fcRainOpacity;
uniform vec3 fcRainColor;
varying float vFcEnd;
void main() {
  gl_FragColor = vec4( fcRainColor, fcRainOpacity * ( 1.0 - 0.6 * vFcEnd ) );
}
`;

function rainGeometry(): THREE.BufferGeometry {
  const pos = new Float32Array(RAIN_STREAKS * 6);
  const end = new Float32Array(RAIN_STREAKS * 2);
  // A fixed low-discrepancy scatter (no Math.random: the same streaks every run).
  for (let i = 0; i < RAIN_STREAKS; i++) {
    const x = ((i * 0.7548776662) % 1) * RAIN_BOX_M;
    const y = ((i * 0.5698402910) % 1) * RAIN_BOX_M;
    const z = ((i * 0.3611030) % 1 + (i % 7) / 7) % 1 * RAIN_BOX_M;
    pos.set([x, y, z, x, y, z], i * 6);
    end[i * 2 + 1] = 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("fcEnd", new THREE.BufferAttribute(end, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

// ------------------------------------------------------------------------------- tide

export interface TideStrip {
  /** The centre line the flooded strip lies to the left of, local metres. */
  line: readonly (readonly [number, number])[];
  nearM: number;
  farM: number;
  /** False where the strip is a pier or shed rather than promenade. */
  floods: (x: number, z: number) => boolean;
}

const TIDE_STEP_M = 4;
const TIDE_CROSS = 3;

/**
 * The flooded promenade as a triangle mesh: quads every TIDE_STEP_M along the line and
 * TIDE_CROSS across the strip, left of travel, kept where `floods` holds at the quad's centre.
 * Vertex y is the ground there; the shader adds the tide depth.
 */
export function tideGeometry(strip: TideStrip, ground: (x: number, z: number) => number): THREE.BufferGeometry {
  const positions: number[] = [];
  const quad = (pts: readonly (readonly [number, number])[]): void => {
    const [a, b, c, d] = pts as [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]];
    for (const p of [a, b, c, a, c, d]) positions.push(p[0], ground(p[0], p[1]), p[1]);
  };
  for (let s = 0; s + 1 < strip.line.length; s++) {
    const [x0, z0] = strip.line[s]!, [x1, z1] = strip.line[s + 1]!;
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) continue;
    const dx = (x1 - x0) / len, dz = (z1 - z0) / len;
    // Left of travel, seen from above with north up: (dz, -dx).
    const lx = dz, lz = -dx;
    const steps = Math.max(1, Math.ceil(len / TIDE_STEP_M));
    for (let i = 0; i < steps; i++) {
      const t0 = (i / steps) * len, t1 = ((i + 1) / steps) * len;
      for (let j = 0; j < TIDE_CROSS; j++) {
        const o0 = strip.nearM + ((strip.farM - strip.nearM) * j) / TIDE_CROSS;
        const o1 = strip.nearM + ((strip.farM - strip.nearM) * (j + 1)) / TIDE_CROSS;
        const at = (t: number, o: number): [number, number] => [x0 + dx * t + lx * o, z0 + dz * t + lz * o];
        const mid = at((t0 + t1) / 2, (o0 + o1) / 2);
        if (!strip.floods(mid[0], mid[1])) continue;
        quad([at(t0, o0), at(t1, o0), at(t1, o1), at(t0, o1)]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------------------- layer

export const PUDDLES_MAX = 96;
/** Puddles show only on a road at least this wet (the sim keeps them while wetness >= 0.3). */
const PUDDLE_WET_MIN = 0.3;

export class WeatherLayer {
  readonly root = new THREE.Group();
  private readonly rain: THREE.LineSegments;
  private readonly rainUniforms = {
    fcRainCam: { value: new THREE.Vector3() },
    fcRainTime: { value: 0 },
    fcRainBox: { value: RAIN_BOX_M },
    fcRainOpacity: { value: 0 },
    fcRainColor: { value: new THREE.Color(0xb8c4cf) },
  };
  private readonly puddles: THREE.InstancedMesh;
  private readonly puddleMaterial: THREE.MeshStandardMaterial;
  private readonly tideMaterial: THREE.MeshStandardMaterial;
  private tide: THREE.Mesh | null = null;
  private tideDepth = -1;
  private readonly strip: TideStrip | null;
  private readonly ground: (x: number, z: number) => number;

  constructor(strip: TideStrip | null, ground: (x: number, z: number) => number) {
    this.strip = strip;
    this.ground = ground;
    this.root.name = "weather";
    const rainMaterial = new THREE.ShaderMaterial({
      uniforms: this.rainUniforms, vertexShader: RAIN_VERTEX, fragmentShader: RAIN_FRAGMENT,
      transparent: true, depthWrite: false, fog: false,
    });
    this.rain = new THREE.LineSegments(rainGeometry(), rainMaterial);
    this.rain.name = "weather:rain";
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rain.renderOrder = 10;
    this.puddleMaterial = new THREE.MeshStandardMaterial({
      color: 0x1d2328, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.85, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const disc = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    this.puddles = new THREE.InstancedMesh(disc, this.puddleMaterial, PUDDLES_MAX);
    this.puddles.name = "weather:puddles";
    this.puddles.count = 0;
    this.puddles.frustumCulled = false;
    this.puddles.receiveShadow = true;
    this.tideMaterial = new THREE.MeshStandardMaterial({
      color: 0x2f4a55, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.78, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this.root.add(this.rain, this.puddles);
  }

  /** Rain streaks drawn this frame, puddles drawn, and the tide sheet's depth (for tests and the debug handle). */
  get info(): { rain: boolean; puddles: number; tideM: number } {
    return { rain: this.rain.visible, puddles: this.puddles.count, tideM: this.tide?.visible ? this.tideDepth : 0 };
  }

  update(w: WeatherLook, camera: THREE.Camera, time: number, night: number): void {
    fcUniforms.fcWet.value = clamp01(w.wetness);
    // Rain: hidden under shelter, fainter at night (streaks are lit by the street, not the sky).
    const rain = w.sheltered ? 0 : clamp01(w.rain);
    this.rain.visible = rain > 0;
    if (rain > 0) {
      this.rainUniforms.fcRainCam.value.copy(camera.position);
      this.rainUniforms.fcRainTime.value = time;
      this.rainUniforms.fcRainOpacity.value = rain * (0.32 - 0.14 * night);
    }
    // Puddles.
    let n = 0;
    if (w.wetness >= PUDDLE_WET_MIN) {
      const m = new THREE.Matrix4();
      for (const p of w.puddles) {
        if (n >= PUDDLES_MAX) break;
        m.makeScale(p.radius, 1, p.radius * 0.8).setPosition(p.x, p.y + 0.02, p.z);
        this.puddles.setMatrixAt(n++, m);
      }
      this.puddleMaterial.opacity = 0.55 + 0.35 * clamp01((w.wetness - PUDDLE_WET_MIN) / (1 - PUDDLE_WET_MIN));
    }
    if (n !== this.puddles.count || n > 0) this.puddles.instanceMatrix.needsUpdate = true;
    this.puddles.count = n;
    // King tide: build the sheet once, lift it by the depth when it changes by a centimetre.
    if (this.strip && w.tide > 0) {
      if (!this.tide) {
        this.tide = new THREE.Mesh(tideGeometry(this.strip, this.ground), this.tideMaterial);
        this.tide.name = "weather:tide";
        this.tide.receiveShadow = true;
        this.root.add(this.tide);
      }
      if (Math.abs(w.tide - this.tideDepth) > 0.01) {
        this.tideDepth = w.tide;
        this.tide.position.y = w.tide;
      }
      this.tide.visible = true;
    } else if (this.tide) {
      this.tide.visible = false;
      this.tideDepth = -1;
    }
  }

  dispose(): void {
    this.rain.geometry.dispose();
    (this.rain.material as THREE.Material).dispose();
    this.puddles.geometry.dispose();
    this.puddles.dispose();
    this.puddleMaterial.dispose();
    this.tide?.geometry.dispose();
    this.tideMaterial.dispose();
    this.root.removeFromParent();
  }
}
