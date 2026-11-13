// Scanned surface detail (src/render/detail-textures.ts): files, sources, tiers and the no-detail fallback.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOT } from "../helpers.ts";
import { DETAIL_NAMES, DETAIL_ROOT, DETAIL_SCANS, detailTextures, detailTexturesLoaded, loadDetailTextures, setDetailTextures } from "../../src/render/detail-textures.ts";
import { TIER_DETAIL } from "../../src/render/gfx.ts";

afterEach(() => setDetailTextures(null));

describe("detail scans", () => {
  it("ships every scan as a small WebP pair with a CC0 source", () => {
    const sources = JSON.parse(readFileSync(join(ROOT, "public", DETAIL_ROOT, "sources.json"), "utf8")) as { textures: Record<string, { licence: string; source: string; sizeM: number; roughMean: number; heightMean: number }> };
    let total = 0;
    for (const name of DETAIL_NAMES) {
      for (const part of ["albedo", "rh"]) {
        const file = join(ROOT, "public", DETAIL_ROOT, `${name}_${part}.webp`);
        expect(existsSync(file), file).toBe(true);
        const bytes = readFileSync(file);
        expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
        total += bytes.byteLength;
      }
      const s = sources.textures[name]!;
      expect(s.licence).toMatch(/^CC0 1\.0/);
      expect(s.source).toMatch(/^https:\/\/polyhaven\.com\/a\//);
      expect(s.sizeM).toBe(DETAIL_SCANS[name].sizeM);
      expect(s.roughMean).toBe(DETAIL_SCANS[name].rough);
      expect(s.heightMean).toBe(DETAIL_SCANS[name].height);
    }
    // The whole set stays small next to the city's tiles.
    expect(total).toBeLessThan(2_000_000);
  });

  it("shows at high and standard and never at low", () => {
    expect(TIER_DETAIL.high.surfaceDetail).toBe(1);
    expect(TIER_DETAIL.standard.surfaceDetail).toBeGreaterThan(0);
    expect(TIER_DETAIL.low.surfaceDetail).toBe(0);
  });

  it("loads nothing at level 0 or without image decoding, and leaves materials without detail", async () => {
    const bytes = vi.fn(async () => new Uint8Array(1));
    expect(await loadDetailTextures(bytes, 0)).toBeNull();
    expect(bytes).not.toHaveBeenCalled();
    // Node has no createImageBitmap: the loader declines instead of failing the boot.
    expect(await loadDetailTextures(bytes, 1)).toBeNull();
    expect(detailTextures()).toBeNull();
    expect(detailTexturesLoaded()).toEqual([]);
  });
});
