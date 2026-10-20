// The look-dev renders for the art sign-off (assets/blender/lookdev/*.png): the wave-2 set
// exists, each is a real image under 2 MB.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../helpers.ts";
import { readPng } from "./png.ts";

const DIR = join(ROOT, "assets", "blender", "lookdev");
const pngs = readdirSync(DIR).filter((f) => f.endsWith(".png")).sort();

describe("look-dev renders", () => {
  it("include the wave-2 sign-off set", () => {
    for (const f of [
      "05-porter-turntable.png",
      "06-trundle-turntable.png",
      "07-moat-van-turntable.png",
      "08-prop-lineup.png",
      "humanoid-variants.png",
      "humanoid-turntable.png",
      "humanoid-clips.png",
    ]) {
      expect(pngs).toContain(f);
    }
  });

  it.each(pngs)("%s is a drawn image under 2 MB with its script beside it", (f) => {
    expect(statSync(join(DIR, f)).size).toBeLessThan(2 * 1024 * 1024);
    const img = readPng(new Uint8Array(readFileSync(join(DIR, f))));
    expect(img.width).toBeGreaterThanOrEqual(960);
    // not blank: the pixel values vary
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < img.data.length; i += 97) {
      lo = Math.min(lo, img.data[i]!);
      hi = Math.max(hi, img.data[i]!);
    }
    expect(hi - lo).toBeGreaterThan(80);
    expect(readdirSync(DIR)).toContain(f.replace(/\.png$/, ".py").replace(/-/g, "_"));
  });
});
