// Minimal PNG decoding for screenshots (8-bit greyscale/RGB/RGBA, non-interlaced: what
// browsers produce), so tests and the shot tool can tell a drawn frame from a blank one
// without an image dependency.

import { inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  /** 1 (grey), 2 (grey+alpha), 3 (RGB) or 4 (RGBA). */
  channels: number;
  /** Row-major, `channels` bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(buf: Uint8Array): Image {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIGNATURE[i]) throw new Error("not a PNG");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let off = 8; off + 8 <= buf.length; ) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      const depth = body[8]!;
      const colorType = body[9]!;
      const interlace = body[12]!;
      channels = CHANNELS[colorType] ?? 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${colorType}, interlace ${interlace}`);
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height) throw new Error("PNG has no IHDR");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("PNG data is truncated");
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!;
      const a = i >= channels ? data[dst + i - channels]! : 0;
      const b = y > 0 ? data[dst - stride + i]! : 0;
      const c = i >= channels && y > 0 ? data[dst - stride + i - channels]! : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      data[dst + i] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}

export interface ImageStats {
  /** Mean luma, 0..255. */
  mean: number;
  /** Standard deviation of luma: near 0 for a blank or single-colour frame. */
  std: number;
  /** Distinct colours after quantising each channel to 4 bits (max 4096). */
  colors: number;
}

/** Luma statistics over every `stride`-th pixel (stride 1 = all of them). */
export function imageStats(img: Image, stride = 1): ImageStats {
  const { data, channels } = img;
  const seen = new Set<number>();
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let p = 0; p < img.width * img.height; p += stride) {
    const o = p * channels;
    const r = data[o]!;
    const g = channels >= 3 ? data[o + 1]! : r;
    const b = channels >= 3 ? data[o + 2]! : r;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += l;
    sum2 += l * l;
    n++;
    seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  const mean = n ? sum / n : 0;
  return { mean, std: n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0, colors: seen.size };
}

/** A frame that shows something: not one flat colour. */
export function looksDrawn(s: ImageStats): boolean {
  return s.std >= 4 && s.colors >= 8;
}
