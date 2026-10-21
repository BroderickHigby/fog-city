// W-02: tunnels were draped over the hills (the Broadway Tunnel climbed 49 m over Russian Hill,
// through 31 houses). Every tunnel edge is flagged and carries a bore ribbon on the straight
// portal-to-portal line with a ceiling; no footprint stands in a bore below its ceiling; outside
// the portals the road is at grade and clear like any street.

import { describe, expect, it, vi } from "vitest";
import { distToSegment, pointInRing, type P2 } from "../../pipeline/lib/geom.ts";
import type { Tunnel } from "../../pipeline/lib/structures.ts";
import { readJson } from "../helpers.ts";
import { loadSfPack } from "./util.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe("sf world: tunnels (W-02)", () => {
  const { pack, roads, buildings, heightAt } = loadSfPack();
  const pieces = pack.tiles.flatMap((t) => t.tunnels ?? []);
  /** A tunnel edge's bores (an edge can hold two: the Presidio Parkway), each its pieces in order, joined. */
  const boresOf = (edge: string): Array<Tunnel["path"]> => {
    const byBore = new Map<string, Tunnel[]>();
    for (const p of pieces.filter((q) => q.edge === edge && q.kind === "tunnel")) {
      const k = p.id.split("~")[0]!;
      (byBore.get(k) ?? byBore.set(k, []).get(k)!).push(p);
    }
    return [...byBore.values()].map((ps) => ps.sort((a, b) => Number(a.id.split("~")[1]) - Number(b.id.split("~")[1])).flatMap((p, i) => (i === 0 ? p.path : p.path.slice(1))));
  };
  const tunnelEdges = roads.edges.filter((e) => e.tunnel);

  it("the Broadway Tunnel (both bores), the Stockton Tunnel and the Toll Plaza tunnel are flagged tunnel edges", () => {
    const names = new Set(tunnelEdges.map((e) => e.name));
    for (const n of ["Robert C Levy Tunl", "Stockton Tunl", "Toll Plaza Tunnel"]) expect(names.has(n), n).toBe(true);
    expect(tunnelEdges.filter((e) => e.name === "Robert C Levy Tunl").length).toBe(2);
  });

  it("the MacArthur Tunnel (both directions), the Presidio Parkway's tunnels and the Yerba Buena Island tunnel (both decks) have bores, named in the report", () => {
    const report = readJson<{ tunnels: { bores: Array<{ edge: string; name: string }> } }>("public/tiles/sf/report.json");
    const byName = new Map<string, Set<string>>();
    for (const b of report.tunnels.bores) {
      const e = roads.edges.find((q) => q.id === b.edge)!;
      expect(e.tunnel, b.edge).toBe(true);
      expect(boresOf(b.edge).length, b.edge).toBeGreaterThan(0);
      (byName.get(b.name) ?? byName.set(b.name, new Set()).get(b.name)!).add(e.name);
    }
    expect([...(byName.get("MacArthur Tunnel") ?? [])].sort()).toEqual(["Hwy 1 Northbound", "Hwy 1 Southbound"]);
    expect(byName.get("Yerba Buena Island Tunnel")?.has("I-80 Eastbound")).toBe(true);
    expect(byName.get("Yerba Buena Island Tunnel")?.has("I-80 Westbound")).toBe(true);
    const presidio = new Set([...byName].filter(([n]) => n.startsWith("Presidio Parkway")).flatMap(([, v]) => [...v]));
    expect([...presidio].sort()).toEqual(["Hwy 101 Northbound", "Hwy 101 Southbound"]);
  });

  it("every tunnel edge has a bore ribbon with a ceiling, on a straight line between portals at the ground", () => {
    expect(tunnelEdges.length).toBeGreaterThanOrEqual(4);
    for (const e of tunnelEdges) for (const p of boresOf(e.id)) {
      expect(p.length, e.id).toBeGreaterThanOrEqual(2);
      for (const t of pieces.filter((q) => q.edge === e.id)) expect(t.clearanceM, t.id).toBeGreaterThanOrEqual(4.5);
      const [x0, y0, z0] = p[0]!;
      const [x1, y1, z1] = p[p.length - 1]!;
      // Portals at the ground (within the cover the bore search allows at a portal's foot),
      // unless the bore goes on into the next edge (the source splits some tunnels at a node).
      const joined = (x: number, y: number, z: number): boolean =>
        pieces.some((q) => q.edge !== e.id && q.path.some(([qx, qy, qz]) => Math.hypot(qx - x, qz - z) < 0.05 && Math.abs(qy - y) < 0.05));
      if (!joined(x0, y0, z0)) expect(Math.abs(y0 - heightAt(x0, z0)), `${e.id} first portal`).toBeLessThan(1);
      if (!joined(x1, y1, z1)) expect(Math.abs(y1 - heightAt(x1, z1)), `${e.id} last portal`).toBeLessThan(1);
      // Straight: every vertex within 5 cm of the line between the portals (by arc length), and
      // no steeper than 6% (8% on a ramp: Yerba Buena Island's on-ramp joins its freeway in the bore).
      let L = 0;
      for (let i = 1; i < p.length; i++) L += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![2] - p[i - 1]![2]);
      expect(Math.abs(y1 - y0) / L, e.id).toBeLessThanOrEqual(e.kind === "ramp" ? 0.0801 : 0.0601);
      let s = 0;
      for (let i = 0; i < p.length; i++) {
        if (i) s += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![2] - p[i - 1]![2]);
        expect(Math.abs(p[i]![1] - (y0 + ((y1 - y0) * s) / L)), `${e.id} vertex ${i}`).toBeLessThan(0.05);
      }
    }
  });

  it("the Broadway Tunnel runs under Russian Hill, not over it: the bore is 20 m or more under the hilltop", () => {
    for (const e of tunnelEdges.filter((q) => q.name === "Robert C Levy Tunl")) {
      const cover = Math.max(...boresOf(e.id).flat().map(([x, y, z]) => heightAt(x, z) - y));
      expect(cover, e.id).toBeGreaterThan(20);
    }
  });

  it("no footprint stands in a bore below its ceiling, and the at-grade ends are clear for a car", () => {
    const bad: string[] = [];
    for (const e of tunnelEdges) {
      const bores = boresOf(e.id);
      const clearance = pieces.find((q) => q.edge === e.id)!.clearanceM;
      // The footprints near the edge at all.
      let ex0 = Infinity, ez0 = Infinity, ex1 = -Infinity, ez1 = -Infinity;
      for (const [x, z] of e.points) {
        ex0 = Math.min(ex0, x - 5); ex1 = Math.max(ex1, x + 5);
        ez0 = Math.min(ez0, z - 5); ez1 = Math.max(ez1, z + 5);
      }
      const local = buildings.filter((b) => b.footprint.some(([x, z]) => x >= ex0 - 200 && x <= ex1 + 200 && z >= ez0 - 200 && z <= ez1 + 200));
      // Bore samples every metre, in every bore of the edge.
      const inBore: Array<[number, number, number]> = [];
      for (const p of bores) for (let i = 1; i < p.length; i++) {
        const [ax, ay, az] = p[i - 1]!;
        const [bx, by, bz] = p[i]!;
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
        for (let k = 0; k <= n; k++) inBore.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, az + ((bz - az) * k) / n]);
      }
      for (const [x, y, z] of inBore) {
        for (const b of local) {
          if (!pointInRing(x, z, b.footprint)) continue;
          const bottom = b.underY ?? -Infinity;
          if (bottom < y + clearance && b.topY > y) bad.push(`${e.id}: ${b.id} in the bore at ${x.toFixed(1)},${z.toFixed(1)}`);
        }
      }
      // The edge outside the bore (at grade): a car's half width from any footprint whose roof is
      // over the road.
      const borePts: P2[][] = bores.map((p) => p.map(([x, , z]): P2 => [x, z]));
      const nearBore = (x: number, z: number): boolean => {
        for (const q of borePts) for (let i = 1; i < q.length; i++) if (distToSegment(x, z, q[i - 1]!, q[i]!).d < 0.5) return true;
        return false;
      };
      for (let i = 1; i < e.points.length; i++) {
        const [ax, az] = e.points[i - 1]!;
        const [bx, bz] = e.points[i]!;
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
        for (let k = 0; k <= n; k++) {
          const x = ax + ((bx - ax) * k) / n;
          const z = az + ((bz - az) * k) / n;
          if (nearBore(x, z)) continue;
          const y = heightAt(x, z);
          for (const b of local) {
            if (b.topY <= y + 0.5 || (b.underY !== undefined && b.underY >= y + 4.5)) continue;
            let d = pointInRing(x, z, b.footprint) ? 0 : Infinity;
            for (let j = 0; j < b.footprint.length && d > 0.95; j++) d = Math.min(d, distToSegment(x, z, b.footprint[j]!, b.footprint[(j + 1) % b.footprint.length]!).d);
            if (d <= 0.95) bad.push(`${e.id}: ${b.id} at grade at ${x.toFixed(1)},${z.toFixed(1)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
