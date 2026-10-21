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
    const top = box(prims(body, "tint_top").flatMap((p) => positions(p)));
    expect(outerWorn.size[0]).toBeGreaterThan(top.size[0] + 0.015); // sleeves over the arms
    expect(outerWorn.size[2]).toBeGreaterThan(top.size[2] + 0.02); // the body over the tee
    expect(outerRest.size[0]).toBeLessThan(top.size[0]);
    expect(outerRest.size[2]).toBeLessThan(top.size[2]);
    // the rib hem sits at the hips, the collar round the neck
    expect(outerWorn.min[1]).toBeGreaterThan(0.85);
    expect(outerWorn.min[1]).toBeLessThan(1.0);
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
