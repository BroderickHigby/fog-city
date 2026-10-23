// Tunnel bores, portals and the ground cut (W-02 render half) and quay faces (W-35 render half),
// src/render/structures.ts, on the committed sf data: the Broadway Tunnel and the Embarcadero.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { tileId, tileIndexOf, toLocal } from "../../src/geo/project.ts";
import { makeDrawnGroundFn } from "../../src/render/ground.ts";
import { groundCutMaterial } from "../../src/render/materials.ts";
import {
  MAX_BORE_CUTS,
  PORTAL_HEADWALL_M,
  QUAY_FOOT_Y,
  QUAY_INSET_M,
  QUAY_MIN_Y,
  boreCuts,
  boreMesh,
  inBoreCut,
  quayFaces,
  shoreByTile,
  type TunnelLike,
} from "../../src/render/structures.ts";
import type { BoundaryFile, TileCollider } from "../../src/sim/index.ts";
import { readJson, worldExists } from "../helpers.ts";

const SF = worldExists("sf");
type Tile = TileCollider & { tunnels?: TunnelLike[] };
const tile = (id: string): Tile => readJson<Tile>(`public/tiles/sf/${id}.collider.json`);

describe("a made-up bore", () => {
  // 100 m east-west, road from y 10 to 12, 8 m wide, 5 m ceiling; the hill covers it except at its ends.
  const t: TunnelLike = { id: "b", clearanceM: 5, path: [0, 25, 50, 75, 100].map((x) => [x, 10 + x * 0.02, 0, 8]) };
  const hill = (x: number): number => (x < 5 || x > 95 ? 8 : 40);

  it("walls and a ceiling all along, a headwall at each portal", () => {
    const m = boreMesh([t], (x) => hill(x))!;
    const p = m.positions;
    // 4 pieces x 3 quads + 2 portals x 3 quads.
    expect(m.indices.length / 6).toBe(4 * 3 + 2 * 3);
    let top = -Infinity;
    for (let i = 1; i < p.length; i += 3) top = Math.max(top, p[i]!);
    expect(top).toBeCloseTo(12 + 5 + PORTAL_HEADWALL_M, 6);
    // Under a hill at both ends: no portals.
    expect(boreMesh([t], () => 40)!.indices.length / 6).toBe(4 * 3);
  });

  it("cuts the ground over the bore below its ceiling, never past the portals", () => {
    const cuts = boreCuts([t]);
    expect(cuts).toHaveLength(1); // a straight bore is one piece
    expect(inBoreCut(cuts, 2, 12, 0)).toBe(true); // hillside at the portal, under the ceiling
    expect(inBoreCut(cuts, 50, 30, 0)).toBe(false); // the hill over the bore
    expect(inBoreCut(cuts, 50, 12, 4.5)).toBe(true); // just past the wall
    expect(inBoreCut(cuts, 50, 12, 6)).toBe(false); // beside it
    expect(inBoreCut(cuts, -1, 10, 0)).toBe(false); // the street before the portal
    expect(inBoreCut(cuts, 101, 12, 0)).toBe(false);
    // The shader gets them as uniforms.
    const data = new Float32Array(8);
    const c = cuts[0]!;
    data.set([c.ax, c.az, c.bx, c.bz, c.halfW, c.ya, c.yb, 0]);
    const mat = groundCutMaterial(data, 1);
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain("discard");
    expect((shader.uniforms.fcCuts!.value as THREE.Vector4[])[1]!.x).toBeCloseTo(c.halfW, 6);
  });
});

describe.skipIf(!SF)("the Broadway Tunnel (W-02 render half)", () => {
  const ids = ["t-4_-1", "t-5_-1"];
  const tiles = ids.map(tile);
  const ground = makeDrawnGroundFn(tiles);
  const bores = tiles.flatMap((t) => (t.tunnels ?? []).filter((u) => u.edge === "c3186101" || u.edge === "c3186201"));

  it("both bores are drawn with two portals each, and the ground over the portals is cut", () => {
    expect(bores.length).toBe(4);
    let portals = 0;
    for (const b of bores) {
      const m = boreMesh([b], ground)!;
      const pieces = b.path.length - 1;
      expect(m.indices.length / 6).toBeGreaterThanOrEqual(3 * pieces);
      portals += (m.indices.length / 6 - 3 * pieces) / 3;
    }
    // East (x -1553) and west (x -2139) portals, for each bore.
    expect(portals).toBe(4);
    // Somewhere over each bore near a portal the drawn ground is under its ceiling: the cut opens it.
    for (const t of tiles) {
      const cuts = boreCuts((t.tunnels ?? []).filter((u) => u.edge === "c3186101" || u.edge === "c3186201"));
      expect(cuts.length).toBeGreaterThan(0);
      expect(cuts.length).toBeLessThanOrEqual(MAX_BORE_CUTS);
      let opened = 0;
      for (const b of (t.tunnels ?? []).filter((u) => u.edge === "c3186101")) {
        for (const v of b.path) if (ground(v[0], v[2]) < v[1] + b.clearanceM && inBoreCut(cuts, v[0], ground(v[0], v[2]), v[2])) opened++;
      }
      expect(opened, t.tileId).toBeGreaterThan(0);
      // Under Russian Hill's top the ground is kept.
      const deep = (t.tunnels ?? []).find((u) => u.edge === "c3186101")!.path.find((v) => ground(v[0], v[2]) > v[1] + 25);
      if (deep) expect(inBoreCut(cuts, deep[0], ground(deep[0], deep[2]), deep[2])).toBe(false);
    }
  });
});

describe.skipIf(!SF)("quay faces along the Embarcadero (W-35 render half)", () => {
  const boundary = readJson<BoundaryFile>("public/tiles/sf/boundary.json");
  const byTile = shoreByTile(boundary.shore as Parameters<typeof shoreByTile>[0]);

  it("every shore piece whose land stands 1.5 m or more gets a face from the land down under the sea", () => {
    let faces = 0;
    for (const [lat, lon] of [
      [37.793, -122.3925], // Pier 14
      [37.7985, -122.3985], // Pier 7
      [37.8087, -122.4098], // Pier 39
    ] as const) {
      const p = toLocal(lat, lon);
      const t = tileIndexOf(p.x, p.z);
      const tiles: TileCollider[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const id = tileId(t.ix + dx, t.iz + dz);
        if (worldExists("sf")) {
          try {
            tiles.push(tile(id));
          } catch {
            // open water: no file
          }
        }
      }
      const ground = makeDrawnGroundFn(tiles);
      const segs = byTile.get(tileId(t.ix, t.iz)) ?? [];
      expect(segs.length).toBeGreaterThan(5);
      const m = quayFaces(segs, ground);
      const high = segs.filter((s) => {
        const L = Math.hypot(s.bx - s.ax, s.bz - s.az);
        const lx = (s.bz - s.az) / L;
        const lz = -(s.bx - s.ax) / L;
        return Math.max(ground(s.ax + lx * QUAY_INSET_M, s.az + lz * QUAY_INSET_M), ground(s.bx + lx * QUAY_INSET_M, s.bz + lz * QUAY_INSET_M)) >= QUAY_MIN_Y;
      });
      expect(high.length).toBeGreaterThan(0);
      expect(m!.indices.length / 6).toBe(high.length);
      const pos = m!.positions;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 1; i < pos.length; i += 3) {
        lo = Math.min(lo, pos[i]!);
        hi = Math.max(hi, pos[i]!);
      }
      expect(lo).toBe(QUAY_FOOT_Y);
      expect(hi).toBeGreaterThanOrEqual(QUAY_MIN_Y);
      faces += high.length;
    }
    expect(faces).toBeGreaterThan(30);
  });
});
