// Working street lights at night (high tier): a fixed set of real point lights that follow the
// camera to the nearest lamp heads, so the ground, facades, people, cars and robots under a lamp
// are lit by it, not only painted with a glow decal. The set never changes size (no shader
// recompiles); by day its lights sit at intensity 0.
import * as THREE from "three";

/** Point lights in the rig: the lamps nearest the camera. */
export const STREET_LIGHTS = 8;
/** Lamps farther than this from the camera are not lit (the decal pools carry them). */
export const STREET_LIGHT_RANGE_M = 140;
/** A lamp's reach and its candela-like intensity at full night (warm LED, about 7 m up). */
export const STREET_LIGHT_REACH_M = 30;
export const STREET_LIGHT_NIGHT_INTENSITY = 90;
export const STREET_LIGHT_COLOR = 0xffc08a;
/** Re-pick when the camera has moved this far, or this often. */
const REPICK_M = 4;
const REPICK_S = 0.5;

export class StreetLightRig {
  readonly group = new THREE.Group();
  readonly lights: THREE.PointLight[] = [];
  private night = 0;
  private lastX = Infinity;
  private lastZ = Infinity;
  private sinceS = Infinity;
  private readonly picks = new Float32Array(STREET_LIGHTS * 4);

  constructor() {
    this.group.name = "street-lights";
    for (let i = 0; i < STREET_LIGHTS; i++) {
      const light = new THREE.PointLight(STREET_LIGHT_COLOR, 0, STREET_LIGHT_REACH_M, 2);
      light.name = `street-light:${i}`;
      light.castShadow = false;
      this.lights.push(light);
      this.group.add(light);
    }
  }

  setNight(night: number): void {
    this.night = Math.max(0, Math.min(1, night));
    this.sinceS = Infinity; // re-apply intensities on the next update
  }

  /** Lamps currently lit (for tests and the debug handle). */
  get lit(): number {
    let n = 0;
    for (const l of this.lights) if (l.intensity > 0) n++;
    return n;
  }

  /** Per frame: move the lights to the lamp heads nearest (x, z). */
  update(x: number, z: number, dt: number, heads: Iterable<Float32Array>): void {
    this.sinceS += dt;
    if (this.night <= 0) {
      for (const l of this.lights) l.intensity = 0;
      return;
    }
    if (this.sinceS < REPICK_S && Math.hypot(x - this.lastX, z - this.lastZ) < REPICK_M) return;
    this.sinceS = 0;
    this.lastX = x;
    this.lastZ = z;
    // Keep the STREET_LIGHTS nearest by squared distance (insertion into a short sorted list).
    const p = this.picks;
    let n = 0;
    const range2 = STREET_LIGHT_RANGE_M * STREET_LIGHT_RANGE_M;
    for (const h of heads) {
      for (let i = 0; i + 2 < h.length; i += 3) {
        const dx = h[i]! - x, dz = h[i + 2]! - z, d2 = dx * dx + dz * dz;
        if (d2 > range2) continue;
        if (n === STREET_LIGHTS && d2 >= p[(n - 1) * 4 + 3]!) continue;
        let at = n < STREET_LIGHTS ? n++ : n - 1;
        while (at > 0 && p[(at - 1) * 4 + 3]! > d2) {
          p.copyWithin(at * 4, (at - 1) * 4, at * 4);
          at--;
        }
        p[at * 4] = h[i]!; p[at * 4 + 1] = h[i + 1]!; p[at * 4 + 2] = h[i + 2]!; p[at * 4 + 3] = d2;
      }
    }
    for (let i = 0; i < STREET_LIGHTS; i++) {
      const l = this.lights[i]!;
      if (i >= n) { l.intensity = 0; continue; }
      l.position.set(p[i * 4]!, p[i * 4 + 1]! - 0.3, p[i * 4 + 2]!);
      // Fade the farthest picks so a light handing over to another lamp does not pop.
      const fade = 1 - Math.max(0, Math.min(1, (Math.sqrt(p[i * 4 + 3]!) - STREET_LIGHT_RANGE_M * 0.7) / (STREET_LIGHT_RANGE_M * 0.3)));
      l.intensity = STREET_LIGHT_NIGHT_INTENSITY * this.night * fade;
    }
  }

  dispose(): void {
    for (const l of this.lights) l.dispose();
    this.group.removeFromParent();
  }
}
