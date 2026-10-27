// The robots' finish reads the same up close as at mid distance: no glazed roughness, no
// over-bright base colour, light surfaces untouched (src/render/agent-packing.ts robotFinish).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { AGENT_RIGS } from "../../src/render/agent-layer.ts";
import { ROBOT_MAX_ALBEDO, ROBOT_MIN_ROUGHNESS, extractParts, robotFinish, type PackedModel } from "../../src/render/agent-packing.ts";
import { ROOT } from "../helpers.ts";

async function packed(file: string, kind: "errandRobot" | "sidewalkBot"): Promise<PackedModel> {
  const buf = readFileSync(join(ROOT, "public/models", file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const gltf = await new Promise<{ scene: THREE.Object3D }>((res, rej) => new GLTFLoader().parse(ab, "", res, rej));
  return extractParts(gltf.scene, AGENT_RIGS[kind]);
}

/** Per vertex: [roughness, brightest colour channel, light channel]. */
function surfaces(m: PackedModel): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const p of m.parts) {
    const g = p.geometry;
    if (!g) continue;
    const pbr = g.getAttribute("fcPbr"), col = g.getAttribute("color"), emit = g.getAttribute("fcEmit");
    for (let i = 0; i < pbr.count; i++) out.push([pbr.getX(i), Math.max(col.getX(i), col.getY(i), col.getZ(i)), emit.getW(i)]);
  }
  return out;
}

describe("robot finish", () => {
  for (const [file, kind] of [["errand-robot.glb", "errandRobot"], ["sidewalk-bot.glb", "sidewalkBot"]] as const) {
    it(`${kind}: no glazed or over-bright surface, lights kept`, async () => {
      const m = await packed(file, kind);
      const before = surfaces(m);
      // The model as authored is glossier and brighter than the floor and the cap.
      expect(before.some(([r, , ch]) => ch === 0 && r < ROBOT_MIN_ROUGHNESS)).toBe(true);
      robotFinish(m);
      const after = surfaces(m);
      after.forEach(([r, c, ch], i) => {
        if (ch > 0.5) {
          expect([r, c]).toEqual([before[i]![0], before[i]![1]]);
          return;
        }
        // Packed attributes are Float32.
        expect(r).toBeGreaterThanOrEqual(Math.fround(ROBOT_MIN_ROUGHNESS));
        expect(r).toBe(Math.fround(Math.max(before[i]![0], ROBOT_MIN_ROUGHNESS)));
        expect(c).toBeLessThanOrEqual(ROBOT_MAX_ALBEDO + 1e-6);
      });
    });
  }
});
