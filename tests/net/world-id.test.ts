import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { worldFingerprint } from "../../src/net/world-id.ts";
import { canonicalJson, SIM_VERSION } from "../../src/sim/index.ts";
import { loadWorldFiles } from "../helpers.ts";

describe("world identity on insecure LAN origins", () => {
  it("matches SHA-256 without depending on browser Web Crypto", async () => {
    const files = loadWorldFiles("dev");
    const expected = createHash("sha256").update(canonicalJson({ version: SIM_VERSION, spawn: files.manifest.spawn, tiles: files.tiles, roads: files.roads, boundary: files.boundary })).digest("hex");
    expect(await worldFingerprint(files)).toBe(expected);
    const changed = structuredClone(files);
    changed.manifest.spawn.x += 1;
    expect(await worldFingerprint(changed)).not.toBe(expected);
    const changedGeometry = structuredClone(files);
    changedGeometry.tiles[0]!.buildings[0]!.topY += 1;
    expect(await worldFingerprint(changedGeometry)).not.toBe(expected);
  });
});
