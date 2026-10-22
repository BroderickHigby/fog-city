// The player's default look, founder-default (assets/blender/README.md, "founder-default"): a
// stylised likeness of the project owner, matched by eye to reference photos that are kept
// outside the repository. player.glb carries it: the quiff (node hair_quiff), the face and its
// smile key, the build and height, the bomber (key jacket), and the look's palette row.

import type { Document, Node, Primitive } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { box, loadModel, node, sceneNodes, triangleCount, type V3 } from "./glb.ts";

interface Look {
  label: string;
  palette: Record<string, string>;
  morphs: Record<string, number>;
}

const SLOTS = ["skin", "hair", "top", "bottom", "shoes", "outer", "accent", "sole", "eyes", "badge", "face_white", "face_dark"];

async function player(): Promise<{ doc: Document; rig: Node; body: Node; extras: Record<string, unknown> }> {
  const { doc } = await loadModel("player.glb");
  const rig = node(doc, "player");
  return { doc, rig, body: node(doc, "player_body"), extras: rig.getExtras() };
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexLinear(hex: string): number[] {
  return [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
}

/** Rest positions of a primitive, optionally with morph target `k` added at weight w. */
function positions(p: Primitive, k = -1, w = 1): V3[] {
  const pos = p.getAttribute("POSITION")!;
  const d = k >= 0 ? p.listTargets()[k]!.getAttribute("POSITION")! : null;
  const out: V3[] = [];
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, a);
    if (d) d.getElement(i, b);
    out.push([a[0]! + (d ? w * b[0]! : 0), a[1]! + (d ? w * b[1]! : 0), a[2]! + (d ? w * b[2]! : 0)]);
  }
  return out;
}

/** Triangles of a primitive, as vertex indices. */
function triangles(p: Primitive): Array<[number, number, number]> {
  const idx = p.getIndices()!;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < idx.getCount(); i += 3) out.push([idx.getScalar(i), idx.getScalar(i + 1), idx.getScalar(i + 2)]);
  return out;
}

/** Depths (z) where the line x = x0, y = y0 (running along z) crosses the triangles. */
function crossings(pos: V3[], tris: Array<[number, number, number]>, x0: number, y0: number): number[] {
  const out: number[] = [];
  for (const [i, j, k] of tris) {
    const a = pos[i]!;
    const b = pos[j]!;
    const c = pos[k]!;
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[1] - c[1]) * (x0 - c[0]) + (c[0] - b[0]) * (y0 - c[1])) / d;
    const l2 = ((c[1] - a[1]) * (x0 - c[0]) + (a[0] - c[0]) * (y0 - c[1])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    out.push(l1 * a[2] + l2 * b[2] + l3 * c[2]);
  }
  return out;
}

/** The highest y on the line x = x0 over the triangles (their outline seen along z). */
function outlineTop(pos: V3[], tris: Array<[number, number, number]>, x0: number): number {
  let best = -Infinity;
  for (const t of tris) {
    for (let e = 0; e < 3; e++) {
      const u = pos[t[e]!]!;
      const v = pos[t[(e + 1) % 3]!]!;
      if ((u[0] - x0) * (v[0] - x0) <= 0 && u[0] !== v[0]) best = Math.max(best, u[1] + ((v[1] - u[1]) * (x0 - u[0])) / (v[0] - u[0]));
    }
  }
  return best;
}

function prims(body: Node, material: string): Primitive[] {
  return body.getMesh()!.listPrimitives().filter((p) => p.getMaterial()?.getName() === material);
}

function worldPoints(n: Node): V3[] {
  const m = n.getWorldMatrix() as unknown as number[];
  return n.getMesh()!.listPrimitives().flatMap((p) =>
    positions(p).map((v): V3 => [
      m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]!,
      m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]!,
      m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]!,
    ]),
  );
}

describe("player.glb: founder-default", () => {
  it("fits the budget: at most 8,000 triangles, the quiff included", async () => {
    const { doc } = await player();
    const tris = triangleCount(doc);
    expect(tris).toBeLessThanOrEqual(8000);
    expect(tris).toBeGreaterThan(4000); // the founder-default head, face, jacket and quiff are there
  });

  it("has the quiff: node hair_quiff on the head bone, tint_hair only, a closed shell", async () => {
    const { doc } = await player();
    const hair = node(doc, "hair_quiff");
    expect(hair.getParentNode()?.getName()).toBe("head");
    expect(hair.getSkin()).toBeNull();
    const ps = hair.getMesh()!.listPrimitives();
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) expect(p.getMaterial()?.getName()).toBe("tint_hair");
    // solid: every edge is shared by exactly two triangles
    for (const p of ps) {
      const idx = p.getIndices()!;
      const edges = new Map<string, number>();
      for (let i = 0; i < idx.getCount(); i += 3) {
        const t = [idx.getScalar(i), idx.getScalar(i + 1), idx.getScalar(i + 2)];
        for (let e = 0; e < 3; e++) {
          const a = t[e]!;
          const b = t[(e + 1) % 3]!;
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      for (const n of edges.values()) expect(n).toBe(2);
    }
  });

  it("stands the quiff up at the front, a few centimetres above the skull, and keeps the back short", async () => {
    const { doc, extras } = await player();
    const heightM = extras.heightM as number;
    const head = node(doc, "head");
    const hz = (head.getWorldMatrix() as unknown as number[])[14]!; // the head joint's z (front is -Z)
    const q = worldPoints(node(doc, "hair_quiff"));
    const top = box(q).max[1];
    expect(top - heightM).toBeGreaterThan(0.025);
    expect(top - heightM).toBeLessThan(0.08);
    // tallest over the front half of the head; lower at the back of the crown
    const front = Math.max(...q.filter((p) => p[2] < hz - 0.03).map((p) => p[1]));
    const back = Math.max(...q.filter((p) => p[2] > hz + 0.05).map((p) => p[1]));
    expect(top - front).toBeLessThan(0.012);
    expect(front - back).toBeGreaterThan(0.015);
    // it lifts off the forehead: the quiff reaches forward of the brows
    const brows = box(prims(node(doc, "player_body"), "tint_hair").flatMap((p) => positions(p)).filter((p) => p[1] < heightM - 0.08));
    expect(box(q).min[2]).toBeLessThan(brows.min[2] + 0.01);
  });

  it("has a height parameter of 1.75-1.95 m, and the top of the skull is at it", async () => {
    const { body, extras } = await player();
    const heightM = extras.heightM as number;
    expect(heightM).toBeGreaterThanOrEqual(1.75);
    expect(heightM).toBeLessThanOrEqual(1.95);
    const skin = prims(body, "tint_skin").flatMap((p) => positions(p));
    expect(Math.abs(box(skin).max[1] - heightM)).toBeLessThan(0.01);
  });

  it("carries the founder-default palette row, and its materials wear it", async () => {
    const { doc, extras } = await player();
    expect(extras.defaultLook).toBe("founder-default");
    const looks = extras.looks as Record<string, Look>;
    const look = looks["founder-default"]!;
    expect(look).toBeTruthy();
    for (const s of SLOTS) expect(look.palette[s], s).toMatch(/^#[0-9a-f]{6}$/);
    // the alternate row: a heather-grey tee instead of the bomber, the same jeans
    const tee = looks["founder-default-tee"]!;
    expect(tee.palette.bottom).toBe(look.palette.bottom);
    expect(tee.palette.top).not.toBe(look.palette.top);
    expect(tee.morphs.jacket ?? 0).toBe(0);
    for (const m of doc.getRoot().listMaterials()) {
      const slot = m.getExtras().tintSlot as string;
      expect(SLOTS, m.getName()).toContain(slot);
      const want = hexLinear(look.palette[slot]!);
      const got = m.getBaseColorFactor();
      for (let c = 0; c < 3; c++) expect(got[c]!, `${m.getName()}[${c}]`).toBeCloseTo(want[c]!, 3);
    }
    // the colouring the likeness depends on: dark hair, light warm skin, black jacket, blue jeans,
    // white soles, light eyes
    const lum = (h: string) => hexLinear(h).reduce((a, b) => a + b, 0) / 3;
    expect(lum(look.palette.hair!)).toBeLessThan(0.03);
    expect(lum(look.palette.outer!)).toBeLessThan(0.02);
    expect(lum(look.palette.sole!)).toBeGreaterThan(0.6);
    expect(lum(look.palette.skin!)).toBeGreaterThan(0.25);
    const [r, , b] = hexLinear(look.palette.skin!);
    expect(r!).toBeGreaterThan(b! * 1.5); // warm
    const jeans = hexLinear(look.palette.bottom!);
    expect(jeans[2]!).toBeGreaterThan(jeans[0]! * 2); // blue
    const eyes = hexLinear(look.palette.eyes!);
    expect(eyes[2]!).toBeGreaterThan(eyes[0]!); // blue-grey
    expect(lum(look.palette.eyes!)).toBeGreaterThan(0.2); // light
  });

  it("defaults to its look: the bomber on and the smile on (glTF default morph weights)", async () => {
    const { body, extras } = await player();
    const names = (body.getMesh()!.getExtras().targetNames as string[]) ?? [];
    const w = body.getMesh()!.getWeights();
    const look = (extras.looks as Record<string, Look>)["founder-default"]!;
    names.forEach((n, i) => expect(w[i] ?? 0, n).toBe(look.morphs[n] ?? 0));
    expect(look.morphs).toEqual({ jacket: 1, smile: 1 });
    // talk's smile curve (extras.morphCurves): weights in 0..1 over the 3 s loop, closing the loop
    const curve = (extras.morphCurves as Record<string, Record<string, number[][]>>).talk!.smile!;
    expect(curve[0]![0]).toBe(0);
    expect(curve[curve.length - 1]![0]).toBeCloseTo(3, 3);
    expect(curve[curve.length - 1]![1]).toBe(curve[0]![1]);
    for (const [, v] of curve) {
      expect(v!).toBeGreaterThanOrEqual(0);
      expect(v!).toBeLessThanOrEqual(1);
    }
  });

  it("wears the bomber at jacket=1 over the torso and arms, and hides it inside the body at 0", async () => {
    const { body } = await player();
    const k = (body.getMesh()!.getExtras().targetNames as string[]).indexOf("jacket");
    const outerRest = box(prims(body, "tint_outer").flatMap((p) => positions(p)));
    const outerWorn = box(prims(body, "tint_outer").flatMap((p) => positions(p, k)));
    // the tee and the bare forearms below its short sleeves (skin between the wrists and the shoulders)
    const forearms = prims(body, "tint_skin").flatMap((p) => positions(p)).filter((p) => p[1] > 0.92 && p[1] < 1.5);
    const top = box([...prims(body, "tint_top").flatMap((p) => positions(p)), ...forearms]);
    expect(outerWorn.size[0]).toBeGreaterThan(top.size[0] + 0.015); // sleeves over the arms
    expect(outerWorn.size[2]).toBeGreaterThan(top.size[2] + 0.02); // the body over the tee
    expect(outerRest.size[0]).toBeLessThan(top.size[0]);
    expect(outerRest.size[2]).toBeLessThan(top.size[2]);
    // the rib hem sits at the hips, the collar round the neck
    expect(outerWorn.min[1]).toBeGreaterThan(0.85);
    expect(outerWorn.min[1]).toBeLessThan(1.0);
  });

  it("rounds the bomber's shoulders off: the sleeves fall away outside the shoulder line", async () => {
    const { body } = await player();
    const k = (body.getMesh()!.getExtras().targetNames as string[]).indexOf("jacket");
    const worn = prims(body, "tint_outer").flatMap((p) => positions(p, k));
    const shoulder = Math.max(...worn.filter((p) => Math.abs(p[0]) >= 0.15 && Math.abs(p[0]) < 0.19).map((p) => p[1]));
    const outside = Math.max(...worn.filter((p) => Math.abs(p[0]) > 0.25).map((p) => p[1]));
    // a boxy sleeve cap (a shoulder pad) stood within 4 cm of the shoulder's top out here
    expect(shoulder - outside).toBeGreaterThan(0.06);
  });

  it("gives the alternate tee short sleeves: bare forearms below a hem on the upper arm", async () => {
    const { doc, body } = await player();
    const elbowY = (node(doc, "forearm_L").getWorldMatrix() as unknown as number[])[13]!;
    const tee = prims(body, "tint_top").flatMap((p) => positions(p)).filter((p) => Math.abs(p[0]) > 0.17);
    expect(Math.min(...tee.map((p) => p[1]))).toBeGreaterThan(elbowY + 0.1); // the hem is above the elbow
    const bare = prims(body, "tint_skin").flatMap((p) => positions(p)).filter((p) => Math.abs(p[0]) > 0.17 && p[1] > 0.95 && p[1] < elbowY + 0.1);
    expect(bare.length).toBeGreaterThan(20);
  });

  it("shows the forehead: the hairline stands high above the brows at the centre, the hair reaches the nape", async () => {
    const { doc, body, extras } = await player();
    const heightM = extras.heightM as number;
    const headZ = (node(doc, "head").getWorldMatrix() as unknown as number[])[14]!;
    const headY = (node(doc, "head").getWorldMatrix() as unknown as number[])[13]!;
    const cap = prims(body, "tint_hair").flatMap((p) => positions(p));
    const brows = cap.filter((p) => p[1] < heightM - 0.08 && p[2] < headZ - 0.08);
    expect(brows.length).toBeGreaterThan(0);
    const browTop = Math.max(...brows.map((p) => p[1]));
    const hair = [...cap, ...worldPoints(node(doc, "hair_quiff"))];
    const centre = hair.filter((p) => Math.abs(p[0]) < 0.012 && p[2] < headZ - 0.06 && p[1] > browTop + 0.005);
    const hairline = Math.min(...centre.map((p) => p[1]));
    // the reference photos show 5-5.5 cm of forehead above the brows; the quiff lifts off it
    expect(hairline - browTop).toBeGreaterThan(0.04);
    expect(hairline - browTop).toBeLessThan(0.065);
    // a short taper: the hair comes down the back of the head to the nape
    const back = cap.filter((p) => p[2] > headZ + 0.06);
    expect(Math.min(...back.map((p) => p[1]))).toBeLessThan(headY + 0.03);
  });

  it("carries the hair down the back of the head to the nape as one surface (no ledge over a bare cap)", async () => {
    const { doc, body, extras } = await player();
    const heightM = extras.heightM as number;
    const headZ = (node(doc, "head").getWorldMatrix() as unknown as number[])[14]!;
    const cap = prims(body, "tint_hair").flatMap((p) => positions(p));
    const q = worldPoints(node(doc, "hair_quiff"));
    // the quiff reaches the nape: its lowest point behind the head is close to the cap's hairline there
    const behind = (p: V3) => p[2] > headZ + 0.04 && Math.abs(p[0]) < 0.03;
    const napeCap = Math.min(...cap.filter(behind).map((p) => p[1]));
    const napeQuiff = Math.min(...q.filter(behind).map((p) => p[1]));
    expect(napeQuiff - napeCap).toBeLessThan(0.012);
    // down the middle of the back, the hair's outline (quiff and cap together) falls without a step:
    // its distance from the skull's centre (12 cm below its top), in 8-degree slices from the top
    // round to the nape. The old quiff ended across the crown in a 12 mm ledge over the bare cap.
    const c: V3 = [0, heightM - 0.12, headZ];
    const mid = [...q, ...cap].filter((p) => Math.abs(p[0]) < 0.01 && p[2] > c[2]);
    const slices = new Map<number, number>();
    for (const p of mid) {
      const ang = (Math.atan2(p[2] - c[2], p[1] - c[1]) * 180) / Math.PI; // 0 = straight up, 90 = straight back
      const r = Math.hypot(p[1] - c[1], p[2] - c[2]);
      const k = Math.floor(ang / 8);
      slices.set(k, Math.max(slices.get(k) ?? 0, r));
    }
    const ks = [...slices.keys()].sort((a, b) => a - b).filter((k) => k >= 0 && k * 8 < 136);
    expect(ks.length).toBeGreaterThan(10);
    for (let i = 1; i < ks.length; i++) {
      const step = Math.abs(slices.get(ks[i]!)! - slices.get(ks[i - 1]!)!) / (ks[i]! - ks[i - 1]!);
      expect(step, `slices ${ks[i - 1]! * 8}-${ks[i]! * 8} deg`).toBeLessThan(0.008);
    }
  });

  it("draws the front of the quiff as one rounded crest, not a row of spikes", async () => {
    const { doc } = await player();
    const hairNode = node(doc, "hair_quiff");
    const headZ = (node(doc, "head").getWorldMatrix() as unknown as number[])[14]!;
    const prim = hairNode.getMesh()!.listPrimitives()[0]!;
    const q = worldPoints(hairNode);
    // the outline of the front of the quiff (in front of the head joint), as seen from the front:
    // its highest point every 3 mm across the crest
    const front = triangles(prim).filter((t) => t.every((i) => q[i]![2] < headZ - 0.03));
    const top: number[] = [];
    for (let x = -0.066; x <= 0.066 + 1e-9; x += 0.003) top.push(outlineTop(q, front, x));
    // its peaks, each with its prominence (the drop to the lower of its two neighbouring dips)
    const prominent: number[] = [];
    for (let i = 1; i < top.length - 1; i++) {
      if (!(top[i]! > top[i - 1]! && top[i]! > top[i + 1]!)) continue;
      const dip = (dir: number) => {
        let m = top[i]!;
        for (let j = i + dir; j >= 0 && j < top.length && top[j]! <= top[i]!; j += dir) m = Math.min(m, top[j]!);
        return top[i]! - m;
      };
      if (Math.min(dip(-1), dip(1)) > 0.001) prominent.push(i);
    }
    // one crest; the old one stood up in a row of tufts along its front edge
    expect(prominent).toHaveLength(1);
  });

  it("shows both ears beside the face from the front, clear of the hair", async () => {
    const { doc, body } = await player();
    const skin = prims(body, "tint_skin").flatMap((p) => positions(p));
    const cap = prims(body, "tint_hair").flatMap((p) => positions(p));
    const c = box(cap).center; // about the middle of the head
    const band = (p: V3) => p[1] > c[1] - 0.04 && p[1] < c[1] + 0.01;
    const face = skin.filter((p) => band(p) && p[2] < c[2] - 0.03);
    const hair = [...cap, ...worldPoints(node(doc, "hair_quiff"))].filter(band);
    for (const sx of [-1, 1]) {
      const ear = Math.max(...skin.filter(band).map((p) => sx * p[0]));
      expect(ear - Math.max(...face.map((p) => sx * p[0])), `ear ${sx}`).toBeGreaterThan(0.008);
      expect(ear - Math.max(...hair.map((p) => sx * p[0])), `hair over ear ${sx}`).toBeGreaterThan(0.004);
    }
  });

  it("carries the hips on the jeans' legs, so no seam shows where the legs met the body's own hips", async () => {
    const { body } = await player();
    const skinNode = body.getSkin()!;
    const thighs = new Set(skinNode.listJoints().flatMap((j, i) => (j.getName().startsWith("thigh_") ? [i] : [])));
    const k = (body.getMesh()!.getExtras().targetNames as string[]).indexOf("jacket");
    // the jeans' surfaces: the legs' (any corner follows a thigh) and the body's own hips
    for (const p of prims(body, "tint_bottom")) {
      const pos = positions(p, k, 1);
      const J = p.getAttribute("JOINTS_0")!;
      const W = p.getAttribute("WEIGHTS_0")!;
      const j: number[] = [];
      const w: number[] = [];
      const thigh = pos.map((_, i) => {
        J.getElement(i, j);
        W.getElement(i, w);
        return j.some((b, n) => thighs.has(b) && w[n]! > 0);
      });
      const tris = triangles(p);
      const legs = tris.filter((t) => t.some((i) => thigh[i]));
      const hips = tris.filter((t) => !t.some((i) => thigh[i]));
      // down the centre line, front and back, between the crotch and the jacket's hem, the
      // outermost surface is the legs' (the body's own hips sit inside them); the old body's hips
      // showed there between the legs, the "briefs" shape
      for (const y of [0.92, 0.95, 0.975]) {
        const l = crossings(pos, legs, 0, y);
        const h = crossings(pos, hips, 0, y);
        expect(l.length, `legs at ${y}`).toBeGreaterThan(0);
        expect(Math.min(...l), `front at ${y}`).toBeLessThan(Math.min(...h) - 0.003);
        expect(Math.max(...l), `back at ${y}`).toBeGreaterThan(Math.max(...h) + 0.003);
      }
    }
  });

  it("gives the alternate tee look fuller bare forearms; the jacket key slims them into its sleeves", async () => {
    const { doc, body } = await player();
    const k = (body.getMesh()!.getExtras().targetNames as string[]).indexOf("jacket");
    const elbowY = (node(doc, "forearm_R").getWorldMatrix() as unknown as number[])[13]!;
    const fore = (w: number) =>
      box(prims(body, "tint_skin").flatMap((p) => positions(p, k, w)).filter((p) => p[0] > 0.15 && p[1] > elbowY - 0.13 && p[1] < elbowY - 0.05));
    const tee = fore(0);
    const jacket = fore(1);
    expect(tee.size[0]).toBeGreaterThan(jacket.size[0] * 1.07);
    expect(tee.size[2]).toBeGreaterThan(jacket.size[2] * 1.07);
  });

  it("tells the renderer to hide the quiff when a crowd hair key replaces it", async () => {
    const { doc, body } = await player();
    const names = body.getMesh()!.getExtras().targetNames as string[];
    const hideWith = node(doc, "hair_quiff").getExtras().hideWith as string[];
    expect(hideWith).toEqual(["hair_none", "hair_long", "hair_bun"]);
    for (const n of hideWith) expect(names).toContain(n);
  });

  it("smiles: the smile key opens the mouth into a grin and brings the teeth forward", async () => {
    const { body } = await player();
    const names = body.getMesh()!.getExtras().targetNames as string[];
    const k = names.indexOf("smile");
    expect(k).toBe(names.length - 1);
    const eyesY = box(prims(body, "eyes").flatMap((p) => positions(p))).center[1];
    const mouth = (w: number) => prims(body, "face_dark").flatMap((p) => positions(p, k, w)).filter((p) => p[1] < eyesY - 0.045);
    const closed = box(mouth(0));
    const open = box(mouth(1));
    expect(open.size[1] - closed.size[1]).toBeGreaterThan(0.008); // the mouth opens
    expect(open.size[0] - closed.size[0]).toBeGreaterThan(0.015); // and widens into a grin
    const teeth = (w: number) => prims(body, "face_white").flatMap((p) => positions(p, k, w)).filter((p) => p[1] < eyesY - 0.045);
    expect(box(teeth(1)).min[2]).toBeLessThan(box(teeth(0)).min[2] - 0.004); // the teeth come forward
  });

  it("uses no image texture: solid colours only", async () => {
    const { doc } = await player();
    expect(doc.getRoot().listTextures()).toHaveLength(0);
    for (const m of doc.getRoot().listMaterials()) {
      expect(m.getBaseColorTexture(), m.getName()).toBeNull();
    }
    for (const n of sceneNodes(doc)) for (const p of n.getMesh()?.listPrimitives() ?? []) expect(p.getAttribute("TEXCOORD_0")).toBeNull();
  });
});
