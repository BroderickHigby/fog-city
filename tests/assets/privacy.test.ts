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

/** Reviewed generic assets; never a directory-wide exception for private reference photos. */
const LICENSED = new Map([
  ["public/models/generic-player.glb", {
    sha256: "ea960ae908ab57b4ed60d0e961c1781bcd1f4204770941ac0eb111ee78dc231b",
    license: "assets/imports/rocketbox/LICENSE.md",
  }],
  // Reviewed adult Rocketbox imports from Microsoft-Rocketbox@0943055db6ec570bcef9f2c8b41c9e5467c808f9.
  // Every FBX's pinned upstream hash matches source-files.json; these approvals are literal
  // output hashes, never derived from that mutable manifest or a directory-wide exception.
  ["public/models/crowd/Female_Adult_01.glb", {
    sha256: "15f947a96bc013260204467dbf04a14a3bc6e3fc2ba230c9da3ef41c7ecd256d",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Female_Adult_03.glb", {
    sha256: "2728933dda49db2685f971016004cbaeeb6160cc1632e03934b6d3e48b1dee3d",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Female_Adult_05.glb", {
    sha256: "559e19d4fb0dd224399c6e45fc6ad0bca1eb3860b65aedfb7e5f9f0d3cd73c88",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Female_Adult_07.glb", {
    sha256: "d954e06fbdfb60ba50ba9ce91aeeb427849103eb7bd2a48a88afd57f4dd2b131",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Female_Adult_09.glb", {
    sha256: "ed013ffcb646fedd6c3b27eee1ca3ef5dd402b89918ec661dd2c4279c1f40389",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Female_Adult_11.glb", {
    sha256: "a76ce1aa97db2410e368915bd58b444349e1f7b426fcf34ab96f5380a8d47cc2",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Male_Adult_02.glb", {
    sha256: "63bd02082bdd8d3dac63f7ae1cb4f6c008aa64beda774d5cc3ba388aa163e5a4",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Male_Adult_04.glb", {
    sha256: "92cd8e66a1397c8b23c5daa38da1b22fabf03b1c94ad686f350f708445db30ab",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Male_Adult_06.glb", {
    sha256: "f17dfcf69ade30b086ffb41cd7980e604b4bf828059740f02e9da50d980a6764",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Male_Adult_08.glb", {
    sha256: "d3dbac870fbf05c65fadca583a9c42bd282f7fae1f617a1c879b748670343263",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Male_Adult_10.glb", {
    sha256: "0225013f137b8ba4759be815accf22a79f9b8cbed9b26b41925ec98f46abdc8b",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
  }],
  ["public/models/crowd/Male_Adult_12.glb", {
    sha256: "ecea52827cb058947ccf6059677261353d26618b3c309d55b0c8180847067acc",
    license: "assets/imports/rocketbox-crowd/LICENSE.md",
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

  it("every reviewed library human retains the pinned upstream MIT notice inside its GLB", () => {
    for (const [rel, approved] of LICENSED) {
      const notice = readFileSync(join(ROOT, approved.license), "utf8");
      // Verified against the upstream LICENSE.md at the pinned Rocketbox source commit.
      expect(createHash("sha256").update(notice).digest("hex"), approved.license)
        .toBe("17474e386e0b9e1a700cc3d06b2b0882a2c376d9c6b49c7f8274409b8f8d2352");
      const glb = readFileSync(join(ROOT, rel));
      const document = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as { asset: { copyright?: string } };
      expect(document.asset.copyright, rel).toBe(notice);
    }
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
