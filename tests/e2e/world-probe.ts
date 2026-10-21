// Page-side probes of what the renderer draws, for the world-continuity gate's browser specs
// (car-pose, far-ring, world-tour). They read the scene graph that `?debug=1` exposes as
// window.__fogcityView (src/main.ts) with plain JavaScript (no three.js import: vectors and
// boxes come from the scene's own objects), and never assert on pixels or frame rate.
//
// A vertical probe returns the topmost drawn surface over (x, z) as the renderer draws it (a far
// cell counts only outside the tiles in the scene: its shader discards it inside them): its
// height, the mesh's name and its ancestors' names, the material's name, and the colour class of
// the surface there (the interpolated vertex colour, else the material colour): "green", "sand",
// "water", "grey".

import type { Page } from "@playwright/test";

export interface ProbeHit {
  y: number;
  mesh: string;
  /** Names of the mesh and its ancestors, nearest first. */
  path: string[];
  material: string;
  colour: "green" | "sand" | "water" | "grey" | "none";
}

/** The query string the probes need (the renderer exposed on window). */
export const PROBE_QUERY = "&debug=1";

/** Topmost drawn surface at each point; `only` keeps meshes whose name or an ancestor's name contains one of its strings. */
export async function probeDown(page: Page, pts: ReadonlyArray<readonly [number, number]>, only?: string | readonly string[]): Promise<Array<ProbeHit | null>> {
  return page.evaluate(
    ({ pts, only }) => {
      type V3 = { x: number; y: number; z: number; fromBufferAttribute(a: unknown, i: number): V3; applyMatrix4(m: unknown): V3 };
      type Obj = {
        name: string;
        visible: boolean;
        parent: Obj | null;
        isMesh?: boolean;
        isInstancedMesh?: boolean;
        matrixWorld: { elements: number[] };
        geometry?: { attributes: Record<string, { count: number; itemSize: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number }>; index: { count: number; getX(i: number): number } | null; userData: Record<string, unknown> };
        material?: { name?: string; color?: { r: number; g: number; b: number } } | Array<{ name?: string; color?: { r: number; g: number; b: number } }>;
        traverse(fn: (o: Obj) => void): void;
        updateMatrixWorld(force: boolean): void;
        userData: Record<string, unknown>;
      };
      const view = (window as unknown as { __fogcityView?: { scene: Obj } }).__fogcityView;
      if (!view) throw new Error("window.__fogcityView is missing: boot with ?debug=1");
      const scene = view.scene;
      scene.updateMatrixWorld(true);
      const toS = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
      const classify = (r: number, g: number, b: number): ProbeHit["colour"] => {
        const R = toS(r);
        const G = toS(g);
        const B = toS(b);
        const max = Math.max(R, G, B);
        const min = Math.min(R, G, B);
        const s = max > 0 ? (max - min) / max : 0;
        let h = 0;
        if (max > min) {
          if (max === R) h = 60 * (((G - B) / (max - min)) % 6);
          else if (max === G) h = 60 * ((B - R) / (max - min) + 2);
          else h = 60 * ((R - G) / (max - min) + 4);
        }
        if (h < 0) h += 360;
        if (s >= 0.18 && h >= 65 && h <= 170) return "green";
        if (s >= 0.15 && h >= 25 && h < 65 && max >= 0.5) return "sand";
        if (s >= 0.1 && h >= 180 && h <= 250) return "water";
        return "grey";
      };
      // The far layer discards its fragments inside every tile in the scene (src/render/far-layer.ts,
      // a mask per tile set when the tile's group is added): a far mesh is no hit there.
      const tilesIn = new Set<string>();
      scene.traverse((o) => {
        if (o.name.startsWith("tile:")) tilesIn.add(o.name.slice(5));
      });
      const farMeshes = new Set<Obj>();
      const meshes: Obj[] = [];
      scene.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh || !o.geometry?.attributes.position) return;
        for (let p: Obj | null = o; p; p = p.parent) if (!p.visible) return;
        const names: string[] = [];
        for (let p: Obj | null = o; p; p = p.parent) if (p.name) names.push(p.name);
        if (only && !names.some((n) => only.some((o) => n.includes(o)))) return;
        if (names.some((n) => n === "far" || n.startsWith("far:"))) farMeshes.add(o);
        meshes.push(o);
      });
      // World-space positions and xz boxes, cached per mesh and matrix.
      const world = (m: Obj): { P: Float32Array; box: number[] } => {
        const key = m.matrixWorld.elements.join(",");
        const c = m.geometry!.userData.__probe as { key: string; P: Float32Array; box: number[] } | undefined;
        if (c && c.key === key) return c;
        const pos = m.geometry!.attributes.position!;
        const e = m.matrixWorld.elements;
        const P = new Float32Array(pos.count * 3);
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const z = pos.getZ(i);
          const wx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
          const wy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
          const wz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
          P[i * 3] = wx;
          P[i * 3 + 1] = wy;
          P[i * 3 + 2] = wz;
          box[0] = Math.min(box[0]!, wx);
          box[1] = Math.min(box[1]!, wz);
          box[2] = Math.max(box[2]!, wx);
          box[3] = Math.max(box[3]!, wz);
        }
        const out = { key, P, box };
        m.geometry!.userData.__probe = out;
        return out;
      };
      return pts.map(([x, z]) => {
        let best: ProbeHit | null = null;
        const tileHere = `t${Math.floor(x / 500)}_${Math.floor(z / 500)}`;
        for (const m of meshes) {
          if (farMeshes.has(m) && tilesIn.has(tileHere)) continue;
          const { P, box } = world(m);
          if (x < box[0]! || x > box[2]! || z < box[1]! || z > box[3]!) continue;
          const g = m.geometry!;
          const idx = g.index;
          const n = idx ? idx.count : g.attributes.position!.count;
          const col = g.attributes.color;
          for (let t = 0; t + 2 < n; t += 3) {
            const ia = idx ? idx.getX(t) : t;
            const ib = idx ? idx.getX(t + 1) : t + 1;
            const ic = idx ? idx.getX(t + 2) : t + 2;
            const ax = P[ia * 3]!, ay = P[ia * 3 + 1]!, az = P[ia * 3 + 2]!;
            const bx = P[ib * 3]!, by = P[ib * 3 + 1]!, bz = P[ib * 3 + 2]!;
            const cx = P[ic * 3]!, cy = P[ic * 3 + 1]!, cz = P[ic * 3 + 2]!;
            if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || z < Math.min(az, bz, cz) || z > Math.max(az, bz, cz)) continue;
            const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (Math.abs(d) < 1e-12) continue;
            const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
            const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
            const l3 = 1 - l1 - l2;
            if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
            const y = l1 * ay + l2 * by + l3 * cy;
            if (best && y <= best.y) continue;
            const mat = Array.isArray(m.material) ? m.material[0] : m.material;
            let colour: ProbeHit["colour"] = "none";
            if (col) {
              const r = l1 * col.getX(ia) + l2 * col.getX(ib) + l3 * col.getX(ic);
              const gg = l1 * col.getY(ia) + l2 * col.getY(ib) + l3 * col.getY(ic);
              const b = l1 * col.getZ(ia) + l2 * col.getZ(ib) + l3 * col.getZ(ic);
              colour = classify(r, gg, b);
            } else if (mat?.color) colour = classify(mat.color.r, mat.color.g, mat.color.b);
            const path: string[] = [];
            for (let p: Obj | null = m; p; p = p.parent) if (p.name) path.push(p.name);
            best = { y, mesh: m.name, path, material: mat?.name ?? "", colour };
          }
        }
        return best;
      });
    },
    { pts: pts.map((p) => [p[0], p[1]] as [number, number]), only: only === undefined ? null : typeof only === "string" ? [only] : [...only] },
  );
}

export interface WheelPose {
  /** The car model's rotation.x (pitch as drawn), radians. */
  modelPitch: number;
  wheels: Array<{ x: number; z: number; bottom: number }>;
}

/** The drawn pose of one player's car: the model's pitch and each wheel's lowest point (centre - radius). */
export async function carWheels(page: Page, playerId: string): Promise<WheelPose | null> {
  return page.evaluate((id) => {
    type O = { rotation: { x: number }; updateMatrixWorld(f: boolean): void; matrixWorld: { elements: number[] } };
    const view = (window as unknown as { __fogcityView?: { actors: { players: Map<string, { car: O; wheels: Array<{ node: O; radius: number }> }> } } }).__fogcityView;
    const v = view?.actors.players.get(id);
    if (!v) return null;
    v.car.updateMatrixWorld(true);
    return {
      modelPitch: v.car.rotation.x,
      wheels: v.wheels.map((w) => {
        const e = w.node.matrixWorld.elements;
        return { x: e[12]!, z: e[14]!, bottom: e[13]! - w.radius };
      }),
    };
  }, playerId);
}

/** Visible objects named like foliage (foliage, canopy, park trees) whose world position lies within r metres of (x, z). */
export async function foliageNear(page: Page, x: number, z: number, r: number): Promise<number> {
  return page.evaluate(
    ({ x, z, r }) => {
      type O = { name: string; visible: boolean; parent: O | null; matrixWorld: { elements: number[] }; traverse(fn: (o: O) => void): void; geometry?: { boundingSphere: { center: { x: number; z: number }; radius: number } | null; computeBoundingSphere(): void } };
      const view = (window as unknown as { __fogcityView?: { scene: O } }).__fogcityView;
      if (!view) throw new Error("window.__fogcityView is missing: boot with ?debug=1");
      let n = 0;
      view.scene.traverse((o) => {
        if (!/foliage|canopy|park-tree/i.test(o.name)) return;
        for (let p: O | null = o; p; p = p.parent) if (!p.visible) return;
        const e = o.matrixWorld.elements;
        let cx = e[12]!;
        let cz = e[14]!;
        let rad = 0;
        if (o.geometry) {
          if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
          const s = o.geometry.boundingSphere!;
          cx += s.center.x;
          cz += s.center.z;
          rad = s.radius;
        }
        if (Math.hypot(cx - x, cz - z) <= r + rad) n++;
      });
      return n;
    },
    { x, z, r },
  );
}
