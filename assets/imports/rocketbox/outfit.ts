// Dresses generic-player.glb in long trousers and a solid YC-orange shirt. Runs once on
// convert.py's output. It repaints the body atlas (the shorts' own cloth, colour and normal
// map, carried down over the bare calves; the striped polo made one orange that keeps its
// folds) and widens the calves to the shorts' hem. Rig, clips, face and hair stay as converted.
// ImageMagick 7 (`magick`) decodes and re-encodes the two images.
//   node assets/imports/rocketbox/outfit.ts public/models/generic-player.glb
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SIZE = 1024;
/** Y Combinator's logo orange, #f26522. */
const SHIRT_RGB = [0xf2, 0x65, 0x22] as const;
const OUTFIT = "long trousers, YC orange shirt";
// m002 body atlas regions, left half; the right half mirrors them about the centre column.
/**
 * Shorts rows HEM_FROM..HEM_TOP are stretched over rows HEM_FROM..CALF_TOP, so the knee hem
 * (the shorts' last rows) is painted over with plain cloth.
 */
const HEM_FROM = 150, HEM_TOP = 200;
/** Rows CALF_TOP..CALF_BOTTOM (the bare lower leg) take shorts rows CLOTH_TOP..CLOTH_BOTTOM: plain cloth at the knee, the hem at the ankle. */
const CALF_TOP = 256, CALF_BOTTOM = 447, CALF_WIDTH = 312;
const CLOTH_TOP = 110, CLOTH_BOTTOM = 250;
/** The shorts island's own columns, which cloth the wider calf island. */
const SHORTS_LEFT = 10, SHORTS_RIGHT = 278;
/** The polo's front/back panel and both sleeves (the cuff ends at 634; forearm skin follows). */
const SHIRT_RECTS = [[332, 692, 28, 868], [0, 318, 448, 634], [706, 1024, 448, 634]] as const;
/** A 9-pixel grey closing removes the 3 to 5 pixel stripes but keeps the larger folds. */
const STRIPE_RADIUS = 4;
/**
 * Leg radius the bare calves gain at the knee so the trouser falls from the shorts' hem (about
 * 8.5 cm against the calf's 6), faded in over the lowest ANKLE_FADE of the calf from none at the shoe.
 */
const KNEE_GAIN_M = 0.022, ANKLE_FADE = 0.35;

type Glb = { json: any; views: Buffer[] };

function readGlb(bytes: Buffer): Glb {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  if (json.buffers.length !== 1) throw new Error("expected one GLB buffer");
  const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + bytes.readUInt32LE(20 + jsonLength));
  const views = json.bufferViews.map((v: { byteOffset?: number; byteLength: number }) => bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
  return { json, views };
}

/** Repacks every buffer view in order (4-byte aligned) around the replaced images. */
function writeGlb({ json, views }: Glb): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  views.forEach((view, i) => {
    const pad = (4 - offset % 4) % 4;
    if (pad) parts.push(Buffer.alloc(pad));
    offset += pad;
    json.bufferViews[i].byteOffset = offset;
    json.bufferViews[i].byteLength = view.length;
    parts.push(view);
    offset += view.length;
  });
  parts.push(Buffer.alloc((4 - offset % 4) % 4));
  const bin = Buffer.concat(parts);
  json.buffers[0].byteLength = bin.length;
  let text = Buffer.from(JSON.stringify(json), "utf8");
  text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (length: number, type: string): Buffer => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(length, 0);
    b.write(type, 4, "ascii");
    return b;
  };
  return Buffer.concat([header, chunk(text.length, "JSON"), text, chunk(bin.length, "BIN\0"), bin]);
}

const decode = (image: Buffer): Buffer => execFileSync("magick", ["-", "-depth", "8", "rgb:-"], { input: image, maxBuffer: 1 << 26 });
const encode = (pixels: Buffer, format: "jpeg" | "png"): Buffer => execFileSync("magick", [
  "-size", `${SIZE}x${SIZE}`, "-depth", "8", "rgb:-", "-strip",
  ...(format === "jpeg" ? ["-sampling-factor", "4:2:0", "-quality", "92", "jpeg:-"] : ["-define", "png:compression-level=9", "PNG24:-"]),
], { input: pixels, maxBuffer: 1 << 26 });

/**
 * Trousers: the shorts' lower rows stretch over their own hem, and the calves take the shorts
 * cloth stretched down and resampled onto the shorts island. Colour and normal map alike.
 */
function trousers(pixels: Buffer): Buffer {
  const out = Buffer.from(pixels);
  for (const mirror of [false, true]) {
    const col = (x: number): number => mirror ? SIZE - 1 - x : x;
    const sample = (sx: number, sy: number, c: number): number => {
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const at = (x: number, y: number): number => pixels[(y * SIZE + col(x)) * 3 + c]!;
      const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx, bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      return top * (1 - fy) + bottom * fy;
    };
    for (let y = HEM_FROM; y <= CALF_BOTTOM; y++) {
      const calf = y >= CALF_TOP;
      const sy = calf
        ? CLOTH_TOP + (y - CALF_TOP) * (CLOTH_BOTTOM - CLOTH_TOP) / (CALF_BOTTOM - CALF_TOP)
        : HEM_FROM + (y - HEM_FROM) * (HEM_TOP - HEM_FROM) / (CALF_TOP - HEM_FROM);
      for (let x = 0; x < CALF_WIDTH; x++) {
        const sx = calf ? SHORTS_LEFT + x * (SHORTS_RIGHT - SHORTS_LEFT) / (CALF_WIDTH - 1) : x;
        for (let c = 0; c < 3; c++) out[(y * SIZE + col(x)) * 3 + c] = Math.round(sample(sx, sy, c));
      }
    }
  }
  return out;
}

/** One separable square max (or min) pass of the given radius. */
function rank(src: Float32Array, radius: number, max: boolean): Float32Array {
  const pick = max ? Math.max : Math.min;
  const pass = (from: Float32Array, dx: number, dy: number): Float32Array => {
    const to = new Float32Array(from.length);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      let v = from[y * SIZE + x]!;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k * dx, yy = y + k * dy;
        if (xx >= 0 && xx < SIZE && yy >= 0 && yy < SIZE) v = pick(v, from[yy * SIZE + xx]!);
      }
      to[y * SIZE + x] = v;
    }
    return to;
  };
  return pass(pass(src, 1, 0), 0, 1);
}

/** The polo: stripes closed away, then every shirt pixel is the orange scaled by its own fold shading. */
function shirt(pixels: Buffer): Buffer {
  const out = Buffer.from(pixels);
  const luma = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < luma.length; i++) luma[i] = 0.299 * pixels[i * 3]! + 0.587 * pixels[i * 3 + 1]! + 0.114 * pixels[i * 3 + 2]!;
  const folds = rank(rank(luma, STRIPE_RADIUS, true), STRIPE_RADIUS, false);
  const inside: number[] = [];
  for (const [x0, x1, y0, y1] of SHIRT_RECTS) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * SIZE + x;
    if (Math.max(pixels[i * 3]!, pixels[i * 3 + 1]!, pixels[i * 3 + 2]!) >= 20) inside.push(i);
  }
  const lit = inside.map(i => folds[i]!).filter(v => v > 120).sort((a, b) => a - b);
  const reference = lit[lit.length >> 1]!;
  for (const i of inside) {
    let shade = folds[i]! / reference;
    // Dark trim (collar, cuffs) reads as a deeper orange rather than brown.
    if (shade < 0.7) shade = 0.7 - (0.7 - shade) * 0.3;
    shade = Math.min(shade, 1.15);
    SHIRT_RGB.forEach((value, c) => { out[i * 3 + c] = Math.min(255, Math.round(value * shade)); });
  }
  return out;
}

/** An accessor's floats over a private copy of its buffer view; write() puts the copy back. */
function floats(glb: Glb, accessor: number): { data: Float32Array; write(): void } {
  const a = glb.json.accessors[accessor], width = { VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as string]!;
  if (a.componentType !== 5126 || glb.json.bufferViews[a.bufferView].byteStride) throw new Error(`accessor ${accessor}: expected packed floats`);
  const bytes = Buffer.alloc(glb.views[a.bufferView]!.length);
  glb.views[a.bufferView]!.copy(bytes);
  return { data: new Float32Array(bytes.buffer, a.byteOffset ?? 0, a.count * width), write: () => { glb.views[a.bufferView] = bytes; } };
}

/**
 * Widens the calves (the body vertices on the calf island) outward, level, so the trouser leg
 * is as wide as the shorts' hem. Every vertex at a moved position moves with it, so seams stay shut.
 */
function widenCalves(glb: Glb, bodyMaterial: number): void {
  const primitive = glb.json.meshes.flatMap((m: { primitives: unknown[] }) => m.primitives).find((p: { material: number }) => p.material === bodyMaterial);
  const pos = floats(glb, primitive.attributes.POSITION), uv = floats(glb, primitive.attributes.TEXCOORD_0).data, normal = floats(glb, primitive.attributes.NORMAL).data;
  const onCalf = (i: number): boolean => {
    const u = uv[i * 2]! * SIZE, v = uv[i * 2 + 1]! * SIZE;
    return v >= CALF_TOP && v <= CALF_BOTTOM + 1 && (u < CALF_WIDTH || u >= SIZE - CALF_WIDTH);
  };
  const sites = new Map<string, number[]>();
  for (let i = 0; i < pos.data.length / 3; i++) {
    const key = [0, 1, 2].map(c => pos.data[i * 3 + c]!.toFixed(5)).join();
    sites.set(key, [...sites.get(key) ?? [], i]);
  }
  const calfYs = [...sites.values()].filter(ids => ids.some(onCalf)).map(ids => pos.data[ids[0]! * 3 + 1]!);
  const low = Math.min(...calfYs), high = Math.max(...calfYs);
  for (const ids of sites.values()) {
    const calf = ids.filter(onCalf);
    if (!calf.length) continue;
    const s = Math.min(1, (pos.data[ids[0]! * 3 + 1]! - low) / (high - low) / ANKLE_FADE);
    let nx = 0, nz = 0;
    for (const i of calf) { nx += normal[i * 3]!; nz += normal[i * 3 + 2]!; }
    const gain = KNEE_GAIN_M * s * s * (3 - 2 * s) / (Math.hypot(nx, nz) || 1);
    for (const i of ids) {
      pos.data[i * 3] = pos.data[i * 3]! + nx * gain;
      pos.data[i * 3 + 2] = pos.data[i * 3 + 2]! + nz * gain;
    }
  }
  const accessor = glb.json.accessors[primitive.attributes.POSITION];
  accessor.min = [0, 1, 2].map(c => Math.min(...pos.data.filter((_, i) => i % 3 === c)));
  accessor.max = [0, 1, 2].map(c => Math.max(...pos.data.filter((_, i) => i % 3 === c)));
  pos.write();
}

const file = process.argv[2];
if (!file) throw new Error("usage: node assets/imports/rocketbox/outfit.ts <generic-player.glb>");
const glb = readGlb(readFileSync(file));
const body = glb.json.materials.find((m: { name: string }) => m.name === "generic_body");
const imageOf = (texture: number): any => glb.json.images[glb.json.textures[texture].source];
const color = imageOf(body.pbrMetallicRoughness.baseColorTexture.index), normal = imageOf(body.normalTexture.index);
if (color.extras?.outfit) throw new Error(`${file} is already dressed (${color.extras.outfit})`);
glb.views[color.bufferView] = encode(shirt(trousers(decode(glb.views[color.bufferView]!))), "jpeg");
glb.views[normal.bufferView] = encode(trousers(decode(glb.views[normal.bufferView]!)), "png");
widenCalves(glb, glb.json.materials.indexOf(body));
color.extras = { ...color.extras, outfit: OUTFIT };
writeFileSync(file, writeGlb(glb));
console.log(`${file}: ${OUTFIT}`);
