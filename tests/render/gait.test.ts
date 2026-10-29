// The player's walk/jog/run blend (src/render/gait.ts): the clip numbers are measured from the
// shipped bank, the speed-to-blend and speed-to-playback mapping keeps a planted foot at the
// ground's pace, a jog's swing knee peaks near 90-100 degrees, and a blend change never pops a foot.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAIT_CLIPS, JOG_TO_RUN, MIXAMO_GAIT, WALK_TO_JOG, gaitClipTime, gaitFrequency, gaitWeights, kneeLimitStrength, limitKnee, type GaitClip } from "../../src/render/gait.ts";
import { MIXAMO_DODGE_FILE, MIXAMO_MOTION_FILE, PLAYER_BODY_FILE, PlayerBodies } from "../../src/render/player-body.ts";

const glb = new Uint8Array(readFileSync(new URL(`../../public/${PLAYER_BODY_FILE}`, import.meta.url)));
const bankBytes = new Uint8Array(readFileSync(new URL(`../../public/${MIXAMO_MOTION_FILE}`, import.meta.url)));
const dodgeBytes = new Uint8Array(readFileSync(new URL(`../../public/${MIXAMO_DODGE_FILE}`, import.meta.url)));
const bytes = async (path: string): Promise<Uint8Array> => {
  if (path === PLAYER_BODY_FILE) return glb;
  if (path === MIXAMO_MOTION_FILE) return bankBytes;
  if (path === MIXAMO_DODGE_FILE) return dodgeBytes;
  throw new Error(`not in this test: ${path}`);
};
const bank: THREE.AnimationClip[] = JSON.parse(new TextDecoder().decode(bankBytes)).clips.map((c: Parameters<typeof THREE.AnimationClip.parse>[0]) => THREE.AnimationClip.parse(c));
const durations = Object.fromEntries(GAIT_CLIPS.map(c => [c, bank.find(clip => clip.name === c)!.duration])) as Record<GaitClip, number>;
const stride = (c: GaitClip): number => MIXAMO_GAIT[c].speed * durations[c] / MIXAMO_GAIT[c].cycles;

/** The player's skeleton from the model's node tree (no mesh needed). */
function skeleton(): THREE.Group {
  const doc = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
  const nodes: THREE.Bone[] = doc.nodes.map((n: { name: string; translation?: number[]; rotation?: number[]; scale?: number[] }) => {
    const b = new THREE.Bone();
    b.name = THREE.PropertyBinding.sanitizeNodeName(n.name);
    if (n.translation) b.position.fromArray(n.translation);
    if (n.rotation) b.quaternion.fromArray(n.rotation);
    if (n.scale) b.scale.fromArray(n.scale);
    return b;
  });
  doc.nodes.forEach((n: { children?: number[] }, i: number) => n.children?.forEach(j => nodes[i]!.add(nodes[j]!)));
  const scene = new THREE.Group();
  for (const i of doc.scenes[0].nodes as number[]) scene.add(nodes[i]!);
  return scene;
}

const at = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());
/** Knee flexion from thigh, calf and foot positions, degrees (0 = straight). */
function kneeDeg(root: THREE.Object3D, side: "L" | "R"): number {
  const hip = at(root.getObjectByName(`Bip01_${side}_Thigh`)!), knee = at(root.getObjectByName(`Bip01_${side}_Calf`)!), ankle = at(root.getObjectByName(`Bip01_${side}_Foot`)!);
  return knee.clone().sub(hip).normalize().angleTo(ankle.clone().sub(knee).normalize()) * 180 / Math.PI;
}
/** A foot relative to the pelvis, in the body's own frame (it faces -z). */
function footRel(root: THREE.Object3D, side: "L" | "R"): THREE.Vector3 {
  const r = at(root.getObjectByName(`Bip01_${side}_Foot`)!).sub(at(root.getObjectByName("Bip01_Pelvis")!));
  return r.applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()).invert());
}

describe("gait clip calibration", () => {
  it.each(GAIT_CLIPS)("the %s clip's stride count, left mid-stance and planted-foot speed are what gait.ts says", name => {
    const clip = bank.find(c => c.name === name)!;
    const g = MIXAMO_GAIT[name];
    const rig = skeleton();
    const mixer = new THREE.AnimationMixer(rig);
    mixer.clipAction(clip).play();
    const n = 1200, dt = clip.duration / n, period = clip.duration / g.cycles;
    const rows: Array<Record<"L" | "R", THREE.Vector3>> = [];
    for (let i = 0; i < n; i++) {
      mixer.setTime(i * dt);
      rig.updateMatrixWorld(true);
      rows.push({ L: footRel(rig, "L"), R: footRel(rig, "R") });
    }
    for (const side of ["L", "R"] as const) {
      // Mid-stance: the foot passes under the hip moving back (only a planted foot does).
      const events: Array<{ phase: number; speed: number }> = [];
      for (let i = 0; i < n; i++) {
        const a = rows[i]![side], b = rows[(i + 1) % n]![side];
        if (a.z < 0 && b.z >= 0) events.push({ phase: (i * dt) / period, speed: (b.z - a.z) / dt });
      }
      expect(events, `${name} ${side}`).toHaveLength(g.cycles);
      for (const e of events) {
        const offset = side === "L" ? g.anchor : g.anchor + 0.5;
        const d = Math.abs(((e.phase - offset) % 1 + 1.5) % 1 - 0.5);
        expect(d, `${name} ${side} mid-stance at ${e.phase.toFixed(3)}`).toBeLessThan(0.06);
        expect(e.speed / g.speed, `${name} ${side} planted foot ${e.speed.toFixed(2)} m/s`).toBeGreaterThan(0.88);
        expect(e.speed / g.speed).toBeLessThan(1.12);
      }
    }
    mixer.uncacheRoot(rig);
  });
});

describe("speed to blend and playback", () => {
  it("blends walk, then jog, then run by ground speed: weights sum to 1 and never jump", () => {
    for (const v of [0, 0.5, 1.39, WALK_TO_JOG[0]]) expect(gaitWeights(v)).toEqual({ walk: 1, jog: 0, run: 0 });
    for (const v of [JOG_TO_RUN[1], 3.5, 4.92, 8]) expect(gaitWeights(v)).toEqual({ walk: 0, jog: 0, run: 1 });
    expect(gaitWeights(WALK_TO_JOG[1]).jog).toBe(1);
    let prev = gaitWeights(0);
    for (let v = 0.01; v <= 9; v += 0.01) {
      const w = gaitWeights(v);
      expect(w.walk + w.jog + w.run).toBeCloseTo(1, 12);
      for (const c of GAIT_CLIPS) expect(Math.abs(w[c] - prev[c])).toBeLessThan(0.03);
      prev = w;
    }
  });

  it("keeps a planted foot at the ground's pace from a walk to a brisk run, then caps the cadence", () => {
    for (const v of [1.2, 1.4, 1.9, 2.2, 2.6, 3.0, 3.5, 4.0, 4.39]) {
      const w = gaitWeights(v);
      const blended = GAIT_CLIPS.reduce((s, c) => s + w[c] * stride(c), 0);
      expect(gaitFrequency(v, w, durations) * blended, `${v} m/s`).toBeCloseTo(v, 6);
    }
    const spm = (v: number): number => gaitFrequency(v, gaitWeights(v), durations) * 120;
    // A walk near 110 steps a minute; the 3.5 m/s default pace a jogger's 155-175 (the old jog
    // clip at 1.17x stepped 164 with a 1.5 m stride: the feet covered 2 m/s of a 3.5 m/s pace).
    expect(spm(1.4)).toBeGreaterThan(100);
    expect(spm(1.4)).toBeLessThan(115);
    expect(spm(3.5)).toBeGreaterThan(155);
    expect(spm(3.5)).toBeLessThan(175);
    // 11 mph and the 8 m/s sprint: capped at the run clip's 1.2x, never a 270-step flutter.
    expect(spm(4.92)).toBeLessThanOrEqual(206);
    expect(spm(8)).toBeLessThanOrEqual(206);
    expect(spm(8)).toBeGreaterThan(195);
    // A jogger's cadence all the way from the jog to 11 mph: short quick steps at the slow end
    // (the jog clip), longer ones as the run takes over, never a shuffle or a flutter.
    for (let v = 2.0; v <= 4.92; v += 0.05) {
      expect(spm(v), `${v.toFixed(2)} m/s`).toBeGreaterThan(150);
      expect(spm(v), `${v.toFixed(2)} m/s`).toBeLessThan(207);
    }
  });

  it("plays every clip at the same stride phase: phase 0 is each clip's left mid-stance", () => {
    for (const c of GAIT_CLIPS) {
      const g = MIXAMO_GAIT[c];
      expect(gaitClipTime(c, 0, durations[c])).toBeCloseTo(g.anchor * durations[c] / g.cycles, 9);
      expect(gaitClipTime(c, g.cycles, durations[c])).toBeCloseTo(gaitClipTime(c, 0, durations[c]), 9);
      expect(gaitClipTime(c, -0.25, durations[c])).toBeGreaterThanOrEqual(0);
    }
  });

  it("softens only swing knee flexion, only at jogging speeds", () => {
    expect(kneeLimitStrength(1.4)).toBe(0);
    expect(kneeLimitStrength(3.5)).toBe(1);
    expect(kneeLimitStrength(4.4)).toBe(1);
    expect(kneeLimitStrength(8)).toBe(0);
    const rad = (d: number): number => d * Math.PI / 180;
    expect(limitKnee(rad(30), 1)).toBe(rad(30));
    expect(limitKnee(rad(110), 0)).toBe(rad(110));
    expect(limitKnee(rad(110), 1) * 180 / Math.PI).toBeCloseTo(93.2, 1);
  });
});

describe("the player's drawn gait", () => {
  const disposables: PlayerBodies[] = [];
  // Geometry/skeleton tests stub image upload (as player-body.test.ts does).
  beforeEach(() => {
    vi.stubGlobal("self", globalThis);
    vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
      const texture = new THREE.Texture<HTMLImageElement>();
      queueMicrotask(() => loaded?.(texture));
      return texture;
    });
  });
  afterEach(() => {
    for (const d of disposables.splice(0)) d.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Draw p1 at a steady speed for `seconds` at 60 Hz; per frame: knee angles and feet (body frame). */
  async function run(speeds: (t: number) => number, seconds: number, hz = 60): Promise<Array<{ v: number; kneeL: number; kneeR: number; L: THREE.Vector3; R: THREE.Vector3 }>> {
    const humans = await PlayerBodies.load(bytes, false);
    disposables.push(humans);
    const out = [];
    for (let i = 0; i < Math.round(seconds * hz); i++) {
      const v = speeds(i / hz);
      humans.begin(); humans.add("p1", 0, 0, 0, 0, v, 1 / hz); humans.end();
      const root = humans.rootOf("p1")!;
      root.updateMatrixWorld(true);
      out.push({ v, kneeL: kneeDeg(root, "L"), kneeR: kneeDeg(root, "R"), L: footRel(root, "L"), R: footRel(root, "R") });
    }
    return out;
  }

  it("at the 3.5 m/s default pace the planted foot keeps the ground's pace and the swing knee peaks near 90-100 degrees", async () => {
    const hz = 120;
    const frames = (await run(() => 3.5, 2.5, hz)).slice(hz);
    const peak = Math.max(...frames.map(f => Math.max(f.kneeL, f.kneeR)));
    expect(peak).toBeGreaterThan(88);
    expect(peak).toBeLessThan(102);
    const planted: number[] = [];
    for (let i = 1; i < frames.length; i++) for (const s of ["L", "R"] as const) {
      const a = frames[i - 1]![s], b = frames[i]![s];
      if (a.z < 0 && b.z >= 0) planted.push((b.z - a.z) * hz);
    }
    expect(planted.length).toBeGreaterThanOrEqual(4);
    for (const v of planted) expect(Math.abs(v / 3.5 - 1), `planted foot ${v.toFixed(2)} m/s`).toBeLessThan(0.12);
  });

  it("leaves the walk's knee alone and the sprint's heel kick high", async () => {
    const walk = (await run(() => 1.4, 2)).slice(60);
    expect(Math.max(...walk.map(f => Math.max(f.kneeL, f.kneeR)))).toBeGreaterThan(55);
    expect(Math.max(...walk.map(f => Math.max(f.kneeL, f.kneeR)))).toBeLessThan(75);
    const sprint = (await run(() => 8, 2)).slice(60);
    expect(Math.max(...sprint.map(f => Math.max(f.kneeL, f.kneeR)))).toBeGreaterThan(105);
  });

  it("speeding up from a walk through the jog to the sprint never pops a foot", async () => {
    const hz = 60;
    // Up at 1 m/s^2 (slower than the sim's 10) so every blend boundary is crossed over many frames.
    const ramp = await run(t => t < 0.5 ? 1.2 : Math.min(8, 1.2 + (t - 0.5)), 8, hz);
    let worst = 0, at = 0;
    for (let i = Math.round(0.6 * hz); i < ramp.length; i++) for (const s of ["L", "R"] as const) {
      // A foot's travel in one frame, against what the stride itself moves it at that speed.
      const step = ramp[i]![s].distanceTo(ramp[i - 1]![s]);
      const allowance = 0.05 + 2.4 * ramp[i]!.v / hz;
      if (step / allowance > worst) { worst = step / allowance; at = ramp[i]!.v; }
    }
    expect(worst, `worst foot step at ${at.toFixed(2)} m/s`).toBeLessThan(1);
  });
});
