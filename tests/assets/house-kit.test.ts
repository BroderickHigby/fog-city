// The San Francisco house kit's prototypes (house-kit-spec.md K6, K7, K8; world QA W-49, W-50,
// W-38, W-33): public/models/house-kit/*.glb, its contract house-kit.json, and the layout maths
// in assets/blender/runtime/house-kit.ts. These are the Assets half of those defects: the
// renderer instances them at the anchors the pipeline writes (not yet), so the gate's
// drawn-house metrics (H.bays.anchorShare, H.stoops.blankBandOver2_5m, H.roofs.shapedShare,
// C.stairs.*) do not move until those land.

import { validateBytes } from "gltf-validator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apply, bayLayout, rooflineLayout, roofLayout, stairLayout, stoopLayout, type KitDoc } from "../../assets/blender/runtime/house-kit.ts";
import { ROOT, readJson } from "../helpers.ts";
import { readPng } from "./png.ts";
import { box, loadModel, node, nodePositions, sceneNodes, triangleCount, type V3 } from "./glb.ts";

const KIT = readJson<KitDoc>("public/models/house-kit/house-kit.json");
const PROTOS = Object.entries(KIT.prototypes);
const file = (key: string): string => KIT.prototypes[key]!.file; // "house-kit/x.glb"

/** Positions of a node with the _SLOT value of each vertex. */
async function slotted(f: string, nodeName: string): Promise<Array<{ p: V3; slot: number }>> {
  const { doc } = await loadModel(f);
  const n = node(doc, nodeName);
  const prim = n.getMesh()!.listPrimitives()[0]!;
  const slot = prim.getAttribute("_SLOT")!;
  const pos = nodePositions(n);
  const el: number[] = [];
  return pos.map((p, i) => {
    slot.getElement(i, el);
    return { p, slot: el[0]! };
  });
}

/** Unit normals of the storey's glass triangles (all three vertices in slot 2). */
async function glassNormals(f: string): Promise<V3[]> {
  const { doc } = await loadModel(f);
  const prim = node(doc, "storey").getMesh()!.listPrimitives()[0]!;
  const pos = prim.getAttribute("POSITION")!;
  const slot = prim.getAttribute("_SLOT")!;
  const idx = prim.getIndices()!;
  const el: number[] = [];
  const P = (i: number): V3 => (pos.getElement(i, el), [el[0]!, el[1]!, el[2]!]);
  const S = (i: number): number => (slot.getElement(i, el), el[0]!);
  const out: V3[] = [];
  for (let t = 0; t < idx.getCount(); t += 3) {
    const k = [idx.getScalar(t), idx.getScalar(t + 1), idx.getScalar(t + 2)];
    if (!k.every((i) => S(i) === 2)) continue;
    const [a, b, c] = k.map(P) as [V3, V3, V3];
    const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n);
    if (l > 1e-9 && Math.abs(n[1] / l) < 0.2) out.push([n[0] / l, n[1] / l, n[2] / l]);
  }
  return out;
}

/** World-frame corners of a unit-block instance (x -0.5..0.5, y -1..0, z -1..0). */
function blockCorners(m: number[]): V3[] {
  const out: V3[] = [];
  for (const x of [-0.5, 0.5]) for (const y of [-1, 0]) for (const z of [-1, 0]) out.push(apply(m, [x, y, z]));
  return out;
}

describe("house-kit.json", () => {
  it("lists 3 to 5 bay types, a parametric stoop, rooftop props, roofline profiles and stair parts, each file present", () => {
    const kinds = PROTOS.map(([, p]) => p.kind);
    const bays = kinds.filter((k) => k === "bay").length;
    expect(bays).toBeGreaterThanOrEqual(3);
    expect(bays).toBeLessThanOrEqual(5);
    for (const k of ["stoop", "roof", "roofline", "stairs"]) expect(kinds, k).toContain(k);
    expect(kinds.filter((k) => k === "roof").length).toBeGreaterThanOrEqual(2); // water tanks and mechanical boxes
    expect(kinds.filter((k) => k === "roofline").length).toBeGreaterThanOrEqual(2); // parapet and cornice
    for (const [key, p] of PROTOS) expect(p.file, key).toBe(`house-kit/${key}.glb`);
    expect(KIT.slots.map((s) => s.name)).toEqual(["body", "trim", "glass", "roof", "stone", "dark"]);
  });
});

describe.each(PROTOS)("house-kit %s", (key, spec) => {
  it("is valid glTF with no warnings, within budget, one material, every vertex slotted and coloured", async () => {
    const m = await loadModel(spec.file);
    const report = await validateBytes(m.bytes, { maxIssues: 50 });
    expect(report.issues.numErrors, JSON.stringify(report.issues.messages.slice(0, 3))).toBe(0);
    expect(report.issues.numWarnings, JSON.stringify(report.issues.messages.slice(0, 3))).toBe(0);
    expect(triangleCount(m.doc)).toBeLessThanOrEqual(spec.budget);
    expect((m.json.materials ?? []).map((x) => x.name)).toEqual(["house_kit"]);
    expect(m.doc.getRoot().listTextures()).toHaveLength(0);
    for (const n of sceneNodes(m.doc)) {
      const mesh = n.getMesh();
      if (!mesh) continue;
      const prims = mesh.listPrimitives();
      expect(prims, `${key} ${n.getName()}: one draw call per node`).toHaveLength(1);
      const slot = prims[0]!.getAttribute("_SLOT");
      expect(slot, `${n.getName()} _SLOT`).toBeTruthy();
      expect(prims[0]!.getAttribute("COLOR_0"), `${n.getName()} COLOR_0`).toBeTruthy();
      const el: number[] = [];
      for (let i = 0; i < slot!.getCount(); i++) {
        slot!.getElement(i, el);
        expect(Number.isInteger(el[0]!) && el[0]! >= 0 && el[0]! < KIT.slots.length).toBe(true);
      }
    }
    // no words, signs or brands
    for (const n of m.json.nodes ?? []) expect(n.name ?? "").not.toMatch(/sign|text|logo|label/i);
  });
});

describe("bay windows (K6, W-49)", () => {
  const bays = PROTOS.filter(([, p]) => p.kind === "bay");

  it.each(bays)("%s: one 3.2 m storey of glazed faces projecting 0.6-1.0 m from the wall (a turret up to 1.6 m), a cap", async (key, spec) => {
    const st = await slotted(spec.file, "storey");
    const b = box(st.map((v) => v.p));
    expect(b.min[1]).toBeCloseTo(0, 5);
    expect(b.max[1]).toBeCloseTo(KIT.storeyM, 5);
    const depth = -b.min[2];
    if (spec.corner) {
      // a corner turret wraps the building's corner: nothing over the house's own quadrant
      expect(depth).toBeLessThanOrEqual(1.6);
      expect(st.filter((v) => v.p[0] < -0.3 && v.p[2] > 0.3)).toHaveLength(0);
    } else {
      expect(b.max[2]).toBeLessThanOrEqual(0.1); // nothing behind the wall plane
      expect(depth).toBeGreaterThanOrEqual(0.6);
      expect(depth).toBeLessThanOrEqual(1.1); // 1.0 m plus the sill's projection
    }
    // glass on at least three faces facing different ways
    const facings = new Set((await glassNormals(spec.file)).map(([x, , z]) => Math.round((Math.atan2(x, -z) * 180) / Math.PI / 10)));
    expect(facings.size).toBeGreaterThanOrEqual(3);
    const glass = st.filter((v) => v.slot === 2).map((v) => v.p);
    expect(Math.min(...glass.map((p) => p[1]))).toBeGreaterThan(0.5); // sills above the floor line
    const cap = await slotted(spec.file, "cap");
    expect(box(cap.map((v) => v.p)).min[1]).toBeGreaterThanOrEqual(-0.01);
    expect(Math.abs(box(cap.map((v) => v.p)).max[1] - (spec.capM as number))).toBeLessThan(0.05);
  });

  it("are laid out one per 7.5 m of front, from the second floor, under the roof line", () => {
    const front = 7.0;
    const plan = bayLayout(KIT, { proto: "bay-italianate", frontM: front, storeys: 3, storeyM: 3.2, roofM: 10.5 });
    const storeys = plan.filter((i) => i.node === "storey");
    expect(storeys).toHaveLength(2); // storeys 1 and 2
    expect(Math.min(...storeys.map((i) => i.matrix[13]!))).toBeCloseTo(3.2, 5);
    const cap = plan.find((i) => i.node === "cap")!;
    expect(cap.matrix[13]! + (KIT.prototypes["bay-italianate"]!.capM as number)).toBeLessThanOrEqual(10.5 + KIT.rules.rooflineMaxAboveM);
    // a 15.5 m front takes two; a 4 m front none; a low roof drops the top storey of the bay
    expect(bayLayout(KIT, { proto: "bay-edwardian", frontM: 15.5, storeys: 3, storeyM: 3.2, roofM: 10.5 }).filter((i) => i.node === "cap")).toHaveLength(2);
    expect(bayLayout(KIT, { proto: "bay-edwardian", frontM: 4.0, storeys: 3, storeyM: 3.2, roofM: 10.5 })).toHaveLength(0);
    expect(bayLayout(KIT, { proto: "bay-italianate", frontM: 7, storeys: 3, storeyM: 3.2, roofM: 9.8 }).filter((i) => i.node === "storey")).toHaveLength(1);
    // over a raised parlour floor (1.6 m) the bays start on the first floor, still clear of the sidewalk
    const raised = bayLayout(KIT, { proto: "bay-italianate", frontM: 7, storeys: 3, storeyM: 3.2, roofM: 11.8, floorM: 1.6 }).filter((i) => i.node === "storey");
    expect(raised.map((i) => Math.round(i.matrix[13]! * 1000) / 1000)).toEqual([1.6, 4.8, 8.0]);
    // the storey module is scaled to the facade's storey height
    const tall = bayLayout(KIT, { proto: "bay-edwardian", frontM: 7, storeys: 3, storeyM: 3.6, roofM: 12 });
    expect(tall.find((i) => i.node === "storey")!.matrix[5]).toBeCloseTo(3.6 / 3.2, 6);
  });
});

describe("stoops and entries (K7, W-50)", () => {
  it("climb from the sidewalk to the door in equal risers of 0.15-0.19 m, solid to below the sidewalk, with sheared cheek walls", () => {
    for (const rise of [1.0, 1.3, 1.62, 2.1, 2.5, 2.9]) {
      const plan = stoopLayout(KIT, { riseM: rise, x: 0 });
      expect(plan.riserM, `rise ${rise}`).toBeGreaterThanOrEqual(0.15);
      expect(plan.riserM).toBeLessThanOrEqual(0.19);
      expect(plan.risers * plan.riserM).toBeCloseTo(rise, 6);
      const steps = plan.instances.filter((i) => i.node === "step" || i.node === "landing");
      expect(steps).toHaveLength(plan.risers); // the landing and risers - 1 treads
      const tops = steps.map((i) => Math.max(...blockCorners(i.matrix).map((c) => c[1]))).sort((a, b) => b - a);
      expect(tops[0]).toBeCloseTo(rise, 6);
      for (let k = 1; k < tops.length; k++) expect(tops[k - 1]! - tops[k]!).toBeCloseTo(plan.riserM, 6);
      for (const s of steps) expect(Math.min(...blockCorners(s.matrix).map((c) => c[1]))).toBeLessThan(0);
      // treads step out from the wall, never behind it
      for (const s of steps) expect(Math.max(...blockCorners(s.matrix).map((c) => c[2]))).toBeLessThanOrEqual(1e-9);
      // the cheeks stand 0.9 m above the treads they flank
      const cheeks = plan.instances.filter((i) => i.node === "cheek");
      expect(cheeks).toHaveLength(4);
      const sloped = cheeks.filter((c) => c.matrix[9] !== 0);
      for (const c of sloped) {
        const atLanding = apply(c.matrix, [0, 0, 0])[1];
        const atFoot = apply(c.matrix, [0, 0, -1])[1];
        expect(atLanding).toBeCloseTo(rise + 0.9, 6);
        expect(atFoot).toBeCloseTo(plan.riserM + 0.9, 6);
      }
      expect(plan.instances.filter((i) => i.node === "door")).toHaveLength(1);
    }
  });

  it("the door sits at the threshold; a door at street level has no stoop", async () => {
    const d = box(nodePositions(node((await loadModel(file("stoop"))).doc, "door")));
    expect(d.min[1]).toBeCloseTo(0, 5);
    expect(d.max[1]).toBeGreaterThan(2.4);
    expect(d.max[2]).toBeLessThan(0.15); // set into the wall, not behind it
    const flat = stoopLayout(KIT, { riseM: 0.05, x: 2 });
    expect(flat.instances.map((i) => i.node)).toEqual(["door"]);
    // a plinth up to 2.9 m above the sidewalk is a stoop, so no front keeps a blank band over 2.5 m
    const tall = stoopLayout(KIT, { riseM: 2.9, x: 0 });
    expect(tall.reachM).toBeLessThan(6.0); // fits a SF front setback and sidewalk
  });
});

describe("roofs (K8, W-38)", () => {
  it("roofline segments: 1 m long, projecting out of the wall, never more than 0.1 m above the roof line", async () => {
    for (const [key, p] of PROTOS.filter(([, q]) => q.kind === "roofline")) {
      const b = box(nodePositions(node((await loadModel(p.file)).doc, "segment")));
      expect(b.size[0], key).toBeCloseTo(1.0, 5);
      expect(b.max[1], key).toBeLessThanOrEqual(KIT.rules.rooflineMaxAboveM);
      expect(b.min[2], key).toBeLessThan(-0.05); // projects out of the wall
      expect(b.max[2], key).toBeLessThanOrEqual(0.001); // nothing inside the wall
      const prof = p.profile as number[][];
      expect(Math.max(...prof.map((q) => q[1]!)), key).toBeLessThanOrEqual(0);
    }
    const run = rooflineLayout(KIT, "cornice-italianate", 7.3, 10.2);
    expect(run.filter((s) => s.node === "end").map((s) => s.matrix[12])).toEqual([-3.65, 3.65]);
    const segs = run.filter((s) => s.node === "segment");
    expect(segs).toHaveLength(7);
    const xs = segs.map((s) => s.matrix[12]!);
    expect(xs[0]).toBeCloseTo(-3.65, 6);
    expect(xs[6]! + segs[6]!.matrix[0]!).toBeCloseTo(3.65, 6); // the last ends at the wall's end
    for (const s of segs) expect(s.matrix[13]).toBeCloseTo(10.2, 6);
  });

  it("rooftop props stand on the roof inside its edge, only on buildings of 4 storeys or more", async () => {
    for (const [key, p] of PROTOS.filter(([, q]) => q.kind === "roof")) {
      const b = box((await loadModel(p.file)).doc.getRoot().listNodes().flatMap((n) => nodePositions(n)));
      expect(b.min[1], key).toBeGreaterThanOrEqual(-0.01);
      const fp = p.footprintM as number[];
      expect(b.size[0], key).toBeLessThanOrEqual(fp[0]! + 0.3);
      expect(b.size[2], key).toBeLessThanOrEqual(fp[1]! + 0.3);
    }
    const square = [[-15, -12], [15, -12], [15, 12], [-15, 12]] as Array<[number, number]>;
    const props = roofLayout({ footprint: square, roofM: 24, storeys: 6, year: 1925, hash: 0.2 });
    expect(props.map((i) => i.proto).sort()).toEqual(["roof-mech-box", "roof-mech-box", "roof-penthouse", "roof-water-tank"]);
    for (const i of props) {
      expect(Math.abs(i.matrix[12]!)).toBeLessThanOrEqual(13);
      expect(Math.abs(i.matrix[14]!)).toBeLessThanOrEqual(10);
      expect(i.matrix[13]).toBe(24);
    }
    expect(roofLayout({ footprint: square, roofM: 9, storeys: 3, hash: 0.2 })).toEqual([]);
    // deterministic per building
    expect(roofLayout({ footprint: square, roofM: 24, storeys: 6, year: 1925, hash: 0.2 })).toEqual(props);
  });
});

describe("public stairways (W-33)", () => {
  // A Filbert-Steps-like path: 18 m flat approach, 60 m climbing 27 m with two landings, 10 m flat top.
  const profile: Array<[number, number]> = [
    [0, 10],
    [18, 10.4],
    [38, 19.4],
    [41, 19.5],
    [61, 28.5],
    [64, 28.6],
    [84, 37.4],
    [94, 37.6],
  ];

  it("steps the climb in equal risers of about 0.165 m with treads of 0.25 m or more, landings on the flats", () => {
    const plan = stairLayout(KIT, profile, 2.4, true);
    expect(plan.risers).toBeGreaterThan(150);
    expect(plan.maxRiserM).toBeLessThanOrEqual(0.19);
    expect(plan.minGoingM).toBeGreaterThanOrEqual(0.25);
    const landings = plan.instances.filter((i) => i.node === "landing");
    expect(landings).toHaveLength(4);
    // every tread's top is within a riser of the path's own height there (the walker stays on the steps)
    for (const st of plan.instances.filter((i) => i.node === "step")) {
      const s = -st.matrix[14]!; // the tread's start along the path
      let y = profile[0]![1];
      for (let k = 0; k + 1 < profile.length; k++) {
        const [s0, y0] = profile[k]!;
        const [s1, y1] = profile[k + 1]!;
        if (s >= s0 && s <= s1) y = y0 + ((y1 - y0) * (s - s0)) / (s1 - s0);
      }
      expect(Math.abs(st.matrix[13]! - y)).toBeLessThanOrEqual(0.2);
    }
    expect(plan.instances.filter((i) => i.node === "handrail").length).toBeGreaterThan(0);
  });

  it("stair-treads.png tiles one tread per 0.30 m run, the nosing a dark row at the image's bottom", () => {
    const tex = (KIT as unknown as { stairTexture: { file: string; runM: number; sizePx: number } }).stairTexture;
    expect(tex.runM).toBeCloseTo(0.3, 6);
    const png = readPng(readFileSync(join(ROOT, "public/models", tex.file)));
    expect([png.width, png.height]).toEqual([tex.sizePx, tex.sizePx]);
    const lum = (x: number, y: number): number => {
      const i = (y * png.width + x) * png.channels;
      return (png.data[i]! + png.data[i + 1]! + png.data[i + 2]!) / 3;
    };
    const row = (y: number): number => {
      let t = 0;
      for (let x = 0; x < png.width; x++) t += lum(x, y);
      return t / png.width;
    };
    expect(row(png.height - 3)).toBeLessThan(row(png.height / 2) * 0.5);
    expect(Math.abs(row(5) - row(png.height / 2))).toBeLessThan(25);
  });
});

describe("budget per residential tile (house-kit-spec Budget)", () => {
  it("bays, stoops, rooflines and roof props for a dense residential tile add under 400k triangles in under 16 instanced draw calls", async () => {
    // a dense Mission or Pacific Heights tile: 600 houses, half with two bay storeys, 400 stoops
    // of 9 risers, 600 fronts of 7.5 m roofline (half cornices, half parapet copings), 40 roof props
    const tris = async (key: string, n: string): Promise<number> => {
      const { doc } = await loadModel(file(key));
      const nd = node(doc, n);
      const p = nd.getMesh()!.listPrimitives()[0]!;
      return (p.getIndices()?.getCount() ?? 0) / 3;
    };
    const instances: Array<[string, string, number]> = [
      ["bay-italianate", "storey", 300], ["bay-italianate", "cap", 150],
      ["bay-edwardian", "storey", 300], ["bay-edwardian", "cap", 150],
      ["stoop", "step", 400 * 8], ["stoop", "landing", 400], ["stoop", "cheek", 1600], ["stoop", "door", 400],
      ["cornice-italianate", "segment", 300 * 8], ["cornice-italianate", "end", 600], ["parapet-coping", "segment", 300 * 8], ["parapet-coping", "end", 600],
      ["roof-mech-box", "unit", 30], ["roof-water-tank", "tank", 10],
    ];
    let total = 0;
    for (const [k, n, c] of instances) total += (await tris(k, n)) * c;
    expect(total).toBeLessThan(400_000);
    expect(new Set(instances.map(([k, n]) => `${k}/${n}`)).size).toBeLessThan(16);
  });
});
