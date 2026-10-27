import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AnimationClip } from "three";
import { expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string): Buffer => readFileSync(new URL(path, root));

it("rebuilds the motion bank byte-for-byte from the committed source assets", () => {
  const directory = mkdtempSync(join(tmpdir(), "fog-mixamo-rebuild-"));
  try {
    const builds = ["first.json", "second.json"].map(name => {
      const output = join(directory, name);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("assets/imports/mixamo/build.ts", root)), output], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(output);
    });
    expect(builds[0]!.equals(builds[1]!)).toBe(true);
    expect(builds[0]!.equals(read("public/models/mixamo-motion.json"))).toBe(true);
    const bank = JSON.parse(builds[0]!.toString());
    const ids = bank.clips.map((clip: { uuid: string }) => clip.uuid);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it("retains exactly the supplied FBX source files with their archive hashes", () => {
  const manifest = JSON.parse(read("assets/imports/mixamo/source-files.json").toString()) as {
    files: Array<{ file: string; archivePath: string; sha256: string; bytes: number }>;
  };
  expect(manifest.files).toHaveLength(172);
  expect(new Set(manifest.files.map(file => file.file)).size).toBe(172);
  for (const file of manifest.files) {
    expect(file.file).toBe(`assets/mixamo/${file.archivePath}`);
    expect(file.file).not.toContain("..");
    expect(file.file.endsWith(".fbx")).toBe(true);
    const bytes = read(file.file);
    expect(bytes.length, file.file).toBe(file.bytes);
    expect(bytes.subarray(0, 19).toString(), file.file).toBe("Kaydara FBX Binary ");
    expect(createHash("sha256").update(bytes).digest("hex"), fileURLToPath(new URL(file.file, root))).toBe(file.sha256);
  }
});

it("ships four valid in-place clips targeting the existing player rig", () => {
  const bank = JSON.parse(read("public/models/mixamo-motion.json").toString());
  expect(bank.rig).toBe("rocketbox");
  const clips: AnimationClip[] = bank.clips.map((clip: Parameters<typeof AnimationClip.parse>[0]) => AnimationClip.parse(clip));
  expect(clips.map(clip => clip.name)).toEqual(["idle", "walk", "jog", "run"]);
  for (const clip of clips) {
    expect(clip.validate(), clip.name).toBe(true);
    const position = clip.tracks.find(track => track.name === "Bip01_Pelvis.position")!;
    expect(position).toBeDefined();
    for (let i = 0; i < position.values.length; i += 3) {
      expect(position.values[i]).toBeCloseTo(position.values[0]!, 5);
      expect(position.values[i + 2]).toBeCloseTo(position.values[2]!, 5);
    }
    for (const track of clip.tracks) {
      expect([...track.values].every(Number.isFinite), track.name).toBe(true);
      if (!track.name.endsWith(".quaternion")) continue;
      for (let i = 0; i < track.values.length; i += 4) {
        expect(Math.hypot(...track.values.slice(i, i + 4)), track.name).toBeCloseTo(1, 4);
      }
    }
  }
});

it("bends the Rocketbox knee about its own hinge (calf local Z) as closely as the Mixamo knee bends about its own (local X)", async () => {
  // Matching bone directions alone left the Rocketbox knee bending 16-30 degrees (mean) off
  // its hinge, so the shins and feet swung sideways out of the knee's plane. The retarget now
  // keeps the knee as true as the capture's own: only the source's off-axis motion remains.
  const { Quaternion } = await import("three");
  const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
  const { AnimationMixer, QuaternionLinearInterpolant } = await import("three");
  const bank = JSON.parse(read("public/models/mixamo-motion.json").toString());
  const glb = read("public/models/generic-player.glb");
  const doc = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  /** Degrees between a rotation's axis and `axis` (0: x, 2: z), for bends over 40 degrees. */
  const offAxis = (q: InstanceType<typeof Quaternion>, axis: 0 | 2): number | null => {
    if (2 * Math.acos(Math.min(1, Math.abs(q.w))) < 40 * Math.PI / 180) return null;
    return Math.acos(Math.min(1, Math.abs(axis === 0 ? q.x : q.z) / Math.hypot(q.x, q.y, q.z))) * 180 / Math.PI;
  };
  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  for (const [name, file] of [["walk", "Walking.fbx"], ["jog", "Jogging.fbx"], ["run", "Running.fbx"]] as const) {
    const bytes = read(`assets/mixamo/${file}`);
    const source = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
    const clip = AnimationClip.parse(bank.clips.find((c: { name: string }) => c.name === name));
    const rests = new Map(["Left", "Right"].map(long => [long, source.getObjectByName(`mixamorig${long}Leg`)!.quaternion.clone().invert()]));
    for (const [side, long] of [["L", "Left"], ["R", "Right"]] as const) {
      const bind = new Quaternion().fromArray(doc.nodes.find((n: { name: string }) => n.name === `Bip01 ${side} Calf`).rotation).invert();
      const track = clip.tracks.find(t => t.name === `Bip01_${side}_Calf.quaternion`)!;
      const leg = source.getObjectByName(`mixamorig${long}Leg`)!;
      const rest = rests.get(long)!;
      const mixer = new AnimationMixer(source);
      mixer.clipAction(source.animations[0]!).play();
      const ours: number[] = [], theirs: number[] = [];
      const sample = new QuaternionLinearInterpolant(track.times, track.values, 4, new Float32Array(4));
      for (let t = 0; t <= clip.duration; t += 1 / 30) {
        const a = offAxis(bind.clone().multiply(new Quaternion().fromArray(Array.from(sample.evaluate(t)))), 2);
        if (a !== null) ours.push(a);
        mixer.setTime(t);
        const b = offAxis(rest.clone().multiply(leg.quaternion), 0);
        if (b !== null) theirs.push(b);
      }
      expect(ours.length, `${name} ${side}`).toBeGreaterThan(3);
      expect(theirs.length, `${name} ${side}`).toBeGreaterThan(3);
      expect(mean(ours), `${name} ${side}`).toBeLessThan(mean(theirs) + 2);
      mixer.stopAllAction();
    }
  }
}, 30_000);
