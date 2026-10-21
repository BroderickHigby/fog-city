// The humanoid line (assets/blender/models/humanoid.py): the crowd meshes and their
// vertex-animation textures, decoded with the reference decoder the renderer uses
// (assets/blender/runtime/humanoid-vat.ts), and the skinned player body.

import type { Document } from "@gltf-transform/core";
import { validateBytes } from "gltf-validator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VatData, clipFrame, impostorCell, paletteTable, quatRotate, variantWeights, type HumanoidVatMeta, type Vec3 } from "../../assets/blender/runtime/humanoid-vat.ts";
import { ROOT, readJson } from "../helpers.ts";
import { readPng } from "./png.ts";
import { allPositions, box, loadModel, mean, node, sceneNodes, triangleCount, type V3 } from "./glb.ts";

const meta = readJson<HumanoidVatMeta>("public/models/humanoid-vat.json");
const reference = readJson<Record<string, { variant: string; vertices: number[]; samples: Array<{ clip: string; frame: number; positions: Vec3[] }> }>>(
  "tests/assets/fixtures/humanoid-vat-reference.json",
);

const CROWD_CLIPS = ["walk", "idle", "dive", "wet_shake", "sit", "talk"];
const CHILD_CLIPS = ["walk", "idle", "sit", "talk"];
const BUDGET: Record<string, number> = { "0": 4000, "1": 1000 };
const SLOT = Object.fromEntries(meta.slots.map((s, i) => [s, i])) as Record<string, number>;

const vats = new Map<string, VatData>();
function vat(model: string, lod: string): VatData {
  const key = `${model}/${lod}`;
  let v = vats.get(key);
  if (!v) {
    const l = meta.models[model]!.lods[lod]!;
    v = new VatData(l, new Uint8Array(readFileSync(join(ROOT, "public", "models", l.file))));
    vats.set(key, v);
  }
  return v;
}

interface CrowdMesh {
  rest: V3[];
  slot: number[];
  vid: number[];
  tris: number;
  extras: Record<string, unknown>;
}

async function crowdMesh(name: string): Promise<CrowdMesh> {
  const { doc } = await loadModel("humanoid-crowd.glb");
  const n = node(doc, name);
  const prim = n.getMesh()!.listPrimitives()[0]!;
  const read = (attr: string): number[][] => {
    const a = prim.getAttribute(attr);
    if (!a) throw new Error(`${name}: no ${attr}`);
    const out: number[][] = [];
    for (let i = 0; i < a.getCount(); i++) out.push(a.getElement(i, []));
    return out;
  };
  return {
    rest: read("POSITION") as V3[],
    slot: read("_SLOT").map((v) => v[0]!),
    vid: read("_VID").map((v) => v[0]!),
    tris: prim.getIndices()!.getCount() / 3,
    extras: n.getExtras(),
  };
}

function framePositions(v: VatData, frame: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < v.lod.vertexCount; i++) out.push(v.position(i, frame));
  return out;
}

const clip = (model: string, name: string) => {
  const c = meta.clips[model]!.find((x) => x.name === name);
  if (!c) throw new Error(`no clip ${model}/${name}`);
  return c;
};

describe("humanoid-vat.json", () => {
  it("names the slots, the twelve shape keys and both models, the child flagged", () => {
    expect(meta.slots.slice(0, 5)).toEqual(["skin", "hair", "top", "bottom", "shoes"]);
    expect(meta.morphs).toHaveLength(12);
    expect(meta.morphs).toEqual(expect.arrayContaining(["vest", "hoodie", "lanyard", "skirt", "hair_long", "build_heavy", "older"]));
    expect(meta.models.adult!.child).toBe(false);
    expect(meta.models.child!.child).toBe(true);
    expect(Object.keys(meta.models.adult!.lods)).toEqual(["0", "1"]);
  });

  it("has the clip library: walk, idle, dive, wet shake, sit, talk (the child never dives or gets wet)", () => {
    expect(meta.clips.adult!.map((c) => c.name)).toEqual(CROWD_CLIPS);
    expect(meta.clips.child!.map((c) => c.name)).toEqual(CHILD_CLIPS);
    for (const model of ["adult", "child"]) {
      let next = 0;
      for (const c of meta.clips[model]!) {
        expect(c.startFrame, `${model}/${c.name}`).toBe(next);
        expect(c.frameCount).toBe(c.loop ? Math.round(c.durationS * c.fps) : Math.round(c.durationS * c.fps) + 1);
        next += c.frameCount;
      }
      for (const lod of Object.values(meta.models[model]!.lods)) expect(lod.frames).toBe(next);
    }
    expect(clip("adult", "dive").rootMotion![0]).toBeLessThan(-1);
    expect(clip("adult", "walk").speedMps).toBeGreaterThan(1.1);
    expect(clip("adult", "walk").speedMps).toBeLessThan(1.6);
    expect(clip("adult", "sit").seatHeightM).toBeCloseTo(0.45, 2);
  });

  it("has 6-8 adult body variants and a separate child variant, all with known keys", () => {
    const adults = meta.variants.filter((v) => !v.child);
    const kids = meta.variants.filter((v) => v.child);
    expect(adults.length).toBeGreaterThanOrEqual(6);
    expect(adults.length).toBeLessThanOrEqual(8);
    expect(kids.length).toBeGreaterThanOrEqual(1);
    for (const v of kids) expect(v.model).toBe("child");
    for (const v of adults) expect(v.model).toBe("adult");
    for (const v of meta.variants) {
      for (const k of Object.keys(v.weights)) expect(meta.morphs, `${v.id}.${k}`).toContain(k);
      for (const o of v.outfits) expect(Object.keys(meta.palette.outfits)).toContain(o);
      expect(v.heightScale[0]).toBeLessThanOrEqual(v.heightScale[1]);
    }
    // a range of builds, ages and presentations
    const used = new Set(meta.variants.flatMap((v) => Object.keys(v.weights)));
    for (const k of ["build_slim", "build_broad", "build_heavy", "curvy", "older", "hair_long", "vest", "hoodie", "lanyard", "skirt"]) {
      expect(used, k).toContain(k);
    }
    expect(meta.palette.skinTones.length).toBeGreaterThanOrEqual(6);
  });

  it("builds one palette row per outfit, hair colour and skin tone", () => {
    const p = paletteTable(meta);
    expect(p.rows).toHaveLength(Object.keys(meta.palette.outfits).length * Object.keys(meta.palette.hair).length * meta.palette.skinTones.length);
    const r = p.rowOf("vest_navy", "grey", 3);
    expect(p.rows[r]![SLOT.skin!]).toBe(meta.palette.skinTones[3]);
    expect(p.rows[r]![SLOT.hair!]).toBe(meta.palette.hair.grey);
    expect(p.rows[r]![SLOT.outer!]).toBe(meta.palette.outfits.vest_navy!.outer);
  });
});

describe.each(["adult", "child"].flatMap((m) => ["0", "1"].map((l) => [m, l] as const)))("%s LOD%s", (model, lodKey) => {
  const lod = meta.models[model]!.lods[lodKey]!;

  it("texture sizes match the clip table and the vertex count", () => {
    const bytes = readFileSync(join(ROOT, "public", "models", lod.file)).byteLength;
    expect(lod.width).toBeLessThanOrEqual(2048);
    expect(lod.width * lod.rowsPerFrame).toBeGreaterThanOrEqual(lod.vertexCount);
    const frames = meta.clips[model]!.reduce((s, c) => s + c.frameCount, 0);
    expect(lod.position.height).toBe(frames * lod.rowsPerFrame);
    expect(lod.rotation.height).toBe(frames * lod.rowsPerFrame);
    expect(lod.morph.height).toBe(meta.morphs.length * 2 * lod.rowsPerFrame);
    expect(lod.position.byteLength).toBe(lod.width * lod.position.height * 8);
    expect(lod.rotation.byteLength).toBe(lod.width * lod.rotation.height * 4);
    expect(lod.morph.byteLength).toBe(lod.width * lod.morph.height * 8);
    expect(lod.rotation.byteOffset).toBe(lod.position.byteOffset + lod.position.byteLength);
    expect(lod.morph.byteOffset).toBe(lod.rotation.byteOffset + lod.rotation.byteLength);
    expect(bytes).toBe(lod.morph.byteOffset + lod.morph.byteLength);
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
  });

  it(`its crowd mesh is in bake order, within ${BUDGET[lodKey]} triangles`, async () => {
    const m = await crowdMesh(lod.mesh);
    expect(m.rest).toHaveLength(lod.vertexCount);
    expect(m.vid).toEqual(Array.from({ length: lod.vertexCount }, (_, i) => i));
    expect(m.tris).toBe(lod.triangles);
    expect(m.tris).toBeLessThanOrEqual(BUDGET[lodKey]!);
    expect(Math.min(...m.slot)).toBe(0);
    expect(Math.max(...m.slot)).toBeLessThan(meta.slots.length);
    for (const s of m.slot) expect(Number.isInteger(s)).toBe(true);
    expect(m.extras.vat).toBe(lod.file);
    if (model === "child") {
      expect(m.extras.child).toBe(true);
      expect(m.extras.noTouch).toBe(true);
    }
  });

  it("idle frame 0 is the rest body: real height, standing on the ground, facing -Z", async () => {
    const v = vat(model, lodKey);
    const m = await crowdMesh(lod.mesh);
    const P = framePositions(v, clip(model, "idle").startFrame);
    const b = box(P);
    const [lo, hi] = model === "adult" ? [1.7, 1.85] : [1.1, 1.25];
    expect(b.max[1]).toBeGreaterThan(lo);
    expect(b.max[1]).toBeLessThan(hi);
    expect(Math.abs(b.min[1])).toBeLessThan(0.02);
    // close to the rest mesh (idle only sways; the arms hang relaxed, elbows soft)
    const err = Math.max(...P.map((p, i) => Math.hypot(p[0] - m.rest[i]![0], p[1] - m.rest[i]![1], p[2] - m.rest[i]![2])));
    expect(err).toBeLessThan(0.2);
    // the face is at the front: the eyes are in front of (more -Z than) the hair
    const eyes = mean(P.filter((_, i) => m.slot[i] === SLOT.eyes));
    const hair = mean(P.filter((_, i) => m.slot[i] === SLOT.hair));
    expect(eyes[2]).toBeLessThan(hair[2] - 0.03);
    // the toes point -Z: each shoe reaches further forward of its ankle than behind it
    const shoes = P.filter((_, i) => m.slot[i] === SLOT.sole);
    const sb = box(shoes);
    expect(-sb.min[2]).toBeGreaterThan(sb.max[2]);
  });

  it("keeps the feet on the ground through the walk, and every loop closes without a pop", () => {
    const v = vat(model, lodKey);
    const walk = clip(model, "walk");
    for (let f = 0; f < walk.frameCount; f++) {
      const minY = Math.min(...framePositions(v, walk.startFrame + f).map((p) => p[1]));
      expect(Math.abs(minY), `walk frame ${f}`).toBeLessThan(0.025);
    }
    for (const c of meta.clips[model]!.filter((x) => x.loop)) {
      const step = (a: number, b: number) => {
        let worst = 0;
        for (let i = 0; i < v.lod.vertexCount; i += 3) {
          const p = v.position(i, a);
          const q = v.position(i, b);
          worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
        }
        return worst;
      };
      let inner = 0;
      for (let f = 0; f + 1 < c.frameCount; f++) inner = Math.max(inner, step(c.startFrame + f, c.startFrame + f + 1));
      const wrap = step(c.startFrame + c.frameCount - 1, c.startFrame);
      expect(wrap, `${c.name} wrap vs ${inner}`).toBeLessThanOrEqual(inner * 1.5 + 0.005);
    }
  });

  it("stores unit rotation quaternions with w >= 0 (the raw RGBA8 bytes, before any normalising)", () => {
    // Read the texture bytes directly: VatData.rotation() normalises, so it cannot show a bad bake.
    const bytes = readFileSync(join(ROOT, "public", "models", lod.file));
    const { byteOffset, height } = lod.rotation;
    let worst = 0;
    let checked = 0;
    for (let row = 0; row < height; row += 3) {
      for (let x = 0; x < lod.width; x += 11) {
        const o = byteOffset + (row * lod.width + x) * 4;
        const q = [0, 1, 2, 3].map((c) => (bytes[o + c]! / 255) * 2 - 1);
        // 8 bits per channel: each component is within 1/255 of the true value
        worst = Math.max(worst, Math.abs(Math.hypot(...q) - 1));
        expect(q[3]!, `w at texel ${x},${row}`).toBeGreaterThan(-1.5 / 255);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(0.02);
    // and the decoder hands back the normalised quaternion
    const v = vat(model, lodKey);
    expect(Math.abs(Math.hypot(...v.rotation(0, 0)) - 1)).toBeLessThan(1e-6);
  });
});

describe("humanoid clips, decoded", () => {
  it("sit puts the seat at the clip's seat height and the feet on the ground", async () => {
    for (const model of ["adult", "child"]) {
      const v = vat(model, "0");
      const m = await crowdMesh(`${model}_lod0`);
      const c = clip(model, "sit");
      const P = framePositions(v, c.startFrame);
      // the thighs and seat of the trousers: rest height between the knees and the hips
      const H = box(m.rest).max[1];
      const seat = P.filter((_, i) => m.slot[i] === SLOT.bottom && m.rest[i]![1] > 0.3 * H && m.rest[i]![1] < 0.53 * H);
      expect(Math.abs(box(seat).min[1] - c.seatHeightM!), model).toBeLessThan(0.02);
      const soles = P.filter((_, i) => m.slot[i] === SLOT.sole);
      expect(Math.abs(box(soles).min[1]), model).toBeLessThan(0.02);
      // seated: the head is far lower than standing
      expect(box(P).max[1]).toBeLessThan(box(m.rest).max[1] * 0.86);
    }
  });

  it("dive leaves the body on its side to the left, then back on its feet at the root motion", () => {
    const v = vat("adult", "0");
    const c = clip("adult", "dive");
    const mid = box(framePositions(v, c.startFrame + Math.round(0.85 * c.fps)));
    expect(mid.max[1]).toBeLessThan(0.75); // lying down
    expect(mid.center[0]).toBeLessThan(-0.6); // to the left (-X)
    const end = box(framePositions(v, c.startFrame + c.frameCount - 1));
    expect(end.max[1]).toBeGreaterThan(1.7); // standing again
    expect(Math.abs((end.min[0] + end.max[0]) / 2 - c.rootMotion![0])).toBeLessThan(0.15);
  });

  it("clipFrame loops and clamps", () => {
    const walk = clip("adult", "walk");
    expect(clipFrame(walk, walk.durationS + 0.5 / walk.fps).f0).toBe(walk.startFrame);
    expect(clipFrame(walk, (walk.frameCount - 0.5) / walk.fps).f1).toBe(walk.startFrame);
    const dive = clip("adult", "dive");
    const end = clipFrame(dive, 99);
    expect(end.f0).toBe(dive.startFrame + dive.frameCount - 1);
    expect(end.f1).toBe(end.f0);
  });

  it.each(["adult", "child"])("a variant decoded from the textures matches its own exact skinning (%s)", (model) => {
    const ref = reference[model]!;
    const v = vat(model, "0");
    const w = variantWeights(meta, ref.variant);
    expect(w.some((x) => x > 0)).toBe(true);
    const errs: number[] = [];
    for (const s of ref.samples) {
      const c = clip(model, s.clip);
      const f = c.startFrame + s.frame;
      ref.vertices.forEach((vi, j) => {
        const { position } = v.decodeFrames(f, f, 0, w, vi);
        const e = s.positions[j]!;
        errs.push(Math.hypot(position[0] - e[0], position[1] - e[1], position[2] - e[2]));
      });
    }
    errs.sort((a, b) => a - b);
    const p95 = errs[Math.floor(errs.length * 0.95)]!;
    // measured 2026-10-20: median 0.2 mm, p95 0.6 mm, max 11 mm (adult); the bound leaves room
    expect(p95, `p95 ${p95}`).toBeLessThan(0.005);
    expect(errs[errs.length - 1]!).toBeLessThan(0.03);
  });

  it("quatRotate turns a vector like a rotation matrix would", () => {
    const s = Math.SQRT1_2;
    const r = quatRotate([0, s, 0, s], [1, 0, 0]); // 90 degrees about +Y
    expect(r[0]).toBeCloseTo(0, 6);
    expect(r[2]).toBeCloseTo(-1, 6);
  });
});

// ----------------------------------------------------------------------------- impostor

describe("humanoid-impostor.png", () => {
  it("is the atlas the JSON describes: 8 views x idle and walk, slot ids and coverage in every cell", () => {
    const imp = meta.impostor!;
    expect(imp).toBeTruthy();
    expect(imp.columns).toBe(8);
    expect(imp.rows).toEqual(["idle", "walk"]);
    const png = readPng(new Uint8Array(readFileSync(join(ROOT, "public", "models", imp.file))));
    expect(png.channels).toBe(4);
    expect(png.width).toBe(imp.columns * imp.cell[0]);
    expect(png.height).toBe(imp.rows.length * imp.cell[1]);
    expect(imp.width).toBe(png.width);
    expect(imp.height).toBe(png.height);
    const slots = new Set<number>();
    for (let r = 0; r < imp.rows.length; r++) {
      for (let c = 0; c < imp.columns; c++) {
        let covered = 0;
        for (let y = r * imp.cell[1]; y < (r + 1) * imp.cell[1]; y++) {
          for (let x = c * imp.cell[0]; x < (c + 1) * imp.cell[0]; x++) {
            const i = (y * png.width + x) * 4;
            const a = png.data[i + 3]!;
            expect(a === 0 || a === 255).toBe(true);
            if (!a) continue;
            covered++;
            expect(png.data[i]! % 16).toBe(8);
            slots.add(png.data[i]! >> 4);
          }
        }
        // a person fills a good part of the cell, and nothing spills across cells
        expect(covered, `cell ${r},${c}`).toBeGreaterThan(imp.cell[0] * imp.cell[1] * 0.08);
      }
    }
    for (const s of ["skin", "hair", "top", "bottom", "shoes"]) expect(slots, s).toContain(SLOT[s]);
    for (const s of slots) expect(s).toBeLessThan(meta.slots.length);
  });
});

describe("impostorCell", () => {
  it("picks the column from where the camera is round the person", () => {
    const imp = meta.impostor!;
    expect(impostorCell(imp, 0, -1, "idle").column).toBe(0); // camera in front (-Z)
    expect(impostorCell(imp, 1, 0, "idle").column).toBe(2); // on the person's right
    expect(impostorCell(imp, 0, 1, "walk").column).toBe(4); // behind
    expect(impostorCell(imp, -1, 0, "walk").column).toBe(6); // on the left
    const c = impostorCell(imp, 0.1, -1, "walk");
    expect(c.column).toBe(0);
    expect(c.uv).toEqual([0, 0, 1 / 8, 0.5]);
  });
});

// ------------------------------------------------------------------------------- player

async function playerDoc(): Promise<{ doc: Document; json: Record<string, unknown> }> {
  const m = await loadModel("player.glb");
  const bytes = m.bytes;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = dv.getUint32(12, true);
  return { doc: m.doc, json: JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as Record<string, unknown> };
}

describe("player.glb", () => {
  it("is valid glTF 2.0, its skinned mesh a scene root beside the rig (no validator warnings)", async () => {
    const m = await loadModel("player.glb");
    const report = await validateBytes(m.bytes, { maxIssues: 50 });
    expect(report.issues.numErrors).toBe(0);
    expect(report.issues.numWarnings, JSON.stringify(report.issues.messages.slice(0, 3))).toBe(0);
    const roots = m.doc.getRoot().listScenes()[0]!.listChildren();
    expect(roots.map((n) => n.getName())).toEqual(["player", "player_body"]);
    expect(roots[1]!.getSkin()).toBeTruthy();
    // the rig root stays at identity: nothing to move until the game places it
    expect(roots[0]!.getTranslation()).toEqual([0, 0, 0]);
    expect(roots[0]!.getRotation()).toEqual([0, 0, 0, 1]);
  });

  it("is a skinned body of 20 named bones with the twelve shape keys and the tint materials", async () => {
    const { doc, json } = await playerDoc();
    const skins = doc.getRoot().listSkins();
    expect(skins).toHaveLength(1);
    const joints = skins[0]!.listJoints().map((j) => j.getName());
    for (const b of ["hips", "spine", "chest", "neck", "head", "upper_arm_L", "forearm_R", "hand_R", "thigh_L", "shin_R", "foot_L"]) expect(joints).toContain(b);
    expect(joints).toHaveLength(20);
    const meshes = json.meshes as Array<{ extras?: { targetNames?: string[] }; primitives: Array<{ targets?: unknown[] }> }>;
    expect(meshes[0]!.extras?.targetNames).toEqual(meta.morphs);
    for (const p of meshes[0]!.primitives) expect(p.targets).toHaveLength(meta.morphs.length);
    const mats = doc.getRoot().listMaterials().map((m) => m.getName());
    for (const s of ["skin", "hair", "top", "bottom", "shoes", "outer", "accent", "sole"]) expect(mats).toContain(`tint_${s}`);
    expect(triangleCount(doc)).toBeLessThanOrEqual(4000);
    expect(node(doc, "player").getExtras().fcActor).toBe("player");
  });

  it("carries every clip, plus run and aim, at its authored length", async () => {
    const { doc } = await playerDoc();
    const anims = new Map(doc.getRoot().listAnimations().map((a) => [a.getName(), a]));
    for (const [name, dur] of [...meta.clips.adult!.map((c) => [c.name, c.durationS] as const), ["run", 0.7] as const, ["aim", 2.0] as const]) {
      const a = anims.get(name);
      expect(a, name).toBeTruthy();
      const t = Math.max(...a!.listSamplers().map((s) => s.getInput()!.getMax([])[0]!));
      expect(t, name).toBeCloseTo(dur, 2);
    }
  });

  it("stands 1.7-1.85 m tall at rest on the ground, facing -Z", async () => {
    const { doc } = await playerDoc();
    // the skinned mesh's bind pose is its rest pose
    const all = box(allPositions(doc));
    expect(all.max[1]).toBeGreaterThan(1.7);
    expect(all.max[1]).toBeLessThan(1.85);
    expect(Math.abs(all.min[1])).toBeLessThan(0.02);
    const head = sceneNodes(doc).find((n) => n.getName() === "head")!;
    expect(head).toBeTruthy();
    const eyes = doc
      .getRoot()
      .listMeshes()
      .flatMap((m) => m.listPrimitives())
      .filter((p) => p.getMaterial()?.getName() === "eyes");
    const pts: V3[] = [];
    for (const p of eyes) {
      const a = p.getAttribute("POSITION")!;
      for (let i = 0; i < a.getCount(); i++) pts.push(a.getElement(i, [0, 0, 0]) as V3);
    }
    expect(mean(pts)[2]).toBeLessThan(-0.05);
  });
});
