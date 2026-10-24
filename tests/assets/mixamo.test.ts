import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnimationClip } from "three";
import { expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string): Buffer => readFileSync(new URL(path, root));

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
