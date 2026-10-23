// Private likeness reference photos must never enter the repository. The runtime avatar is
// now a generic, licensed library human. Its embedded JPEG textures are allowed only at
// an exact reviewed hash, with the upstream licence retained; other photo signatures fail.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROOT } from "../helpers.ts";

const PHOTO_FILE = /\.(jpe?g|heic|heif)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Reviewed generic asset; never a directory-wide exception for private reference photos. */
const LICENSED = new Map([
  ["public/models/generic-player.glb", {
    sha256: "3439b2b3fe4438c124c3d187d83457cb50e5ea860dd96e1bc37c6556c462cf28",
    license: "assets/imports/rocketbox/LICENSE.md",
  }],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

/** HEIF/HEIC/AVIF container brands (ISO BMFF "ftyp" box). */
const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "avif", "avis"];

/** Why these bytes look like a photo, or null. */
export function photoSignature(b: Uint8Array): string | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  // a JPEG file, whatever its name: SOI + a marker
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "starts with a JPEG header";
  // a JPEG inside another file: SOI followed by a JFIF/Exif APP segment or the standard first
  // quantisation table (long enough patterns that chance matches in binary data do not occur)
  for (const [marker, tag] of [
    [0xe0, "JFIF\0"],
    [0xe1, "Exif\0"],
  ] as const) {
    let i = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff, marker]));
    while (i >= 0) {
      if (buf.subarray(i + 6, i + 6 + tag.length).toString("latin1") === tag) return `embedded JPEG (${tag.trim()}) at byte ${i}`;
      i = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff, marker]), i + 1);
    }
  }
  const dqt = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]));
  if (dqt >= 0) return `embedded JPEG (quantisation table) at byte ${dqt}`;
  for (const brand of HEIF_BRANDS) {
    const at = buf.indexOf(Buffer.from(`ftyp${brand}`, "latin1"));
    if (at >= 0) return `HEIF/AVIF data (ftyp ${brand}) at byte ${at}`;
  }
  // a GLB that declares a JPEG image
  if (b.length > 20 && buf.readUInt32LE(0) === 0x46546c67) {
    const len = buf.readUInt32LE(12);
    const json = buf.subarray(20, 20 + len).toString("utf8");
    if (/image\/jpe?g|\.jpe?g"/i.test(json)) return "GLB with a JPEG image";
  }
  return null;
}

const IMAGE_FILE = /\.(png|webp|gif|bmp|tiff?|avif|ktx2|exr|hdr)$/i;
/** The Assets track's folders, where every image must be the output of a script in the repo. */
const ASSET_DIRS = /^(assets|public\/models|public\/audio)\//;
/** Images drawn by a script elsewhere (repo-relative image path -> the script that writes it). */
const GENERATED: Record<string, string> = {
  "public/models/humanoid-impostor.png": "assets/blender/models/humanoid_impostor.py",
  "assets/imports/civilian-car/preview.png": "assets/imports/civilian-car/generate.py",
};

/** The script in the repository that draws this image, or null. */
function generatorOf(rel: string): string | null {
  if (GENERATED[rel]) return GENERATED[rel]!;
  // a look-dev render: its script beside it, the name with underscores (assets/blender/README.md)
  const m = /^(assets\/blender\/lookdev)\/([^/]+)\.png$/.exec(rel);
  if (m) return `${m[1]}/${m[2]!.replace(/-/g, "_")}.py`;
  return null;
}

describe("privacy: the likeness reference photos never enter the repository", () => {
  const files = walk(ROOT);

  it("no .jpg, .jpeg, .heic or .heif file anywhere outside node_modules", () => {
    const photos = files.filter((f) => PHOTO_FILE.test(f)).map((f) => relative(ROOT, f));
    expect(photos).toEqual([]);
  });

  it("no unapproved file under assets/ or public/ carries JPEG or HEIF bytes", () => {
    const found: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).split("\\").join("/");
      if (!/^(assets|public)\//.test(rel)) continue;
      const approved = LICENSED.get(rel);
      if (approved) {
        expect(createHash("sha256").update(readFileSync(f)).digest("hex"), rel).toBe(approved.sha256);
        expect(existsSync(join(ROOT, approved.license)), rel).toBe(true);
        continue;
      }
      const why = photoSignature(new Uint8Array(readFileSync(f)));
      if (why) found.push(`${rel}: ${why}`);
    }
    expect(found).toEqual([]);
  });

  it("every image in assets/, public/models/ and public/audio/ is drawn by a script in the repository", () => {
    const orphans: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).split("\\").join("/");
      if (!ASSET_DIRS.test(rel) || !IMAGE_FILE.test(rel)) continue;
      const script = generatorOf(rel);
      const ok = script !== null && existsSync(join(ROOT, script)) && (rel.startsWith("assets/blender/lookdev/") || readFileSync(join(ROOT, script), "utf8").includes(rel.split("/").pop()!));
      if (!ok) orphans.push(rel);
    }
    expect(orphans).toEqual([]);
    expect(generatorOf("assets/blender/lookdev/photo-crop.png")).toBe("assets/blender/lookdev/photo_crop.py");
    expect(generatorOf("public/models/face.png")).toBeNull();
  });

  it("recognises what it looks for", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, ...Buffer.from("Exif\0\0", "latin1"), 0, 0]);
    expect(photoSignature(jpeg)).toMatch(/JPEG/);
    const inside = new Uint8Array(64);
    inside.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0", "latin1")], 20);
    expect(photoSignature(inside)).toMatch(/embedded JPEG/);
    const heic = new Uint8Array(32);
    heic.set(Buffer.from("....ftypheic", "latin1"), 0);
    expect(photoSignature(heic)).toMatch(/HEIF/);
    expect(photoSignature(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull(); // a PNG
  });
});
