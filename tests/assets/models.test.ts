// Hero assets (public/models/*.glb, built by assets/blender/build.sh): valid glTF, within
// budget, the named nodes the renderer and sim rely on, front facing -Z, real-world sizes,
// emissive only where the renderer expects night lights, and alpha MASK never BLEND.
// Orientation is checked from geometry (lights, wheels, feet, the real SF footprint), not
// assumed from how the scripts were written.

import Ajv2020 from "ajv/dist/2020.js";
import { validateBytes } from "gltf-validator";
import { describe, expect, it } from "vitest";
import { toLocal } from "../../src/geo/project.ts";
import { readJson } from "../helpers.ts";
import {
  allPositions,
  box,
  loadModel,
  materialPositions,
  materialTriangles,
  mean,
  node,
  nodeMaterials,
  nodePositions,
  sceneNodes,
  triangleCount,
  worldAxis,
  worldOrigin,
  type V3,
} from "./glb.ts";

interface Spec {
  file: string;
  budget: number;
  nodes: string[];
  lights: string[];
}

const HANDS = ["N", "E", "S", "W"].flatMap((f) => [`clock_hour_${f}`, `clock_minute_${f}`]);
const CAR_WHEELS = ["wheel_FL", "wheel_FR", "wheel_RL", "wheel_RR"];
const ROBOT_PARTS = [
  "torso",
  "head",
  "arm_upper_L",
  "arm_upper_R",
  "arm_lower_L",
  "arm_lower_R",
  "leg_upper_L",
  "leg_upper_R",
  "leg_lower_L",
  "leg_lower_R",
  "bag",
  "bag_contents",
];

const SPECS: Spec[] = [
  {
    file: "ferry-building.glb",
    budget: 100_000,
    nodes: ["ferry_building", "building", "tower", "tower_outline_lights", ...HANDS],
    lights: ["light_tower_outline", "light_clock_face"],
  },
  { file: "r-evolution.glb", budget: 40_000, nodes: ["r_evolution", "frame", "shell", "glow", "plinth"], lights: ["light_sculpture_glow"] },
  { file: "player-car.glb", budget: 8_000, nodes: ["player_car", "body", ...CAR_WHEELS], lights: ["light_headlight", "light_taillight"] },
  {
    file: "robotaxi.glb",
    budget: 10_000,
    nodes: ["robotaxi", "body", "sensor_dome", ...CAR_WHEELS],
    lights: ["light_status", "light_headlight", "light_taillight"],
  },
  { file: "errand-robot.glb", budget: 6_000, nodes: ["errand_robot", ...ROBOT_PARTS], lights: ["light_face"] },
  {
    file: "sidewalk-bot.glb",
    budget: 3_000,
    nodes: ["sidewalk_bot", "body", "lid", "cargo", "wheel_L1", "wheel_L2", "wheel_R1", "wheel_R2"],
    lights: ["light_eyes"],
  },
  {
    file: "moat-van.glb",
    budget: 9_000,
    nodes: ["moat_van", "body", "door_rear_L", "door_rear_R", ...CAR_WHEELS],
    lights: ["light_headlight", "light_taillight", "light_accent"],
  },
  {
    file: "muni-bus.glb",
    budget: 12_000,
    nodes: ["muni_bus", "body", "livery_panel", ...CAR_WHEELS],
    lights: ["light_headlight", "light_taillight", "light_destination_sign"],
  },
];

describe.each(SPECS)("$file", (spec) => {
  it("is valid glTF 2.0 (Khronos validator: no errors)", async () => {
    const m = await loadModel(spec.file);
    const report = await validateBytes(m.bytes, { maxIssues: 50 });
    const errors = report.issues.messages.filter((x) => x.severity === 0);
    expect(errors, JSON.stringify(errors.slice(0, 5))).toEqual([]);
    expect(report.issues.numErrors).toBe(0);
  });

  it(`stays within ${spec.budget} triangles`, async () => {
    const { doc } = await loadModel(spec.file);
    const tris = triangleCount(doc);
    expect(tris).toBeGreaterThan(spec.budget * 0.02);
    expect(tris).toBeLessThanOrEqual(spec.budget);
  });

  it("has the named nodes the game drives", async () => {
    const { doc } = await loadModel(spec.file);
    const names = new Set(sceneNodes(doc).map((n) => n.getName()));
    for (const n of spec.nodes) expect(names, n).toContain(n);
  });

  it("is emissive only on light_* materials, and those glow", async () => {
    const { json } = await loadModel(spec.file);
    const mats = json.materials ?? [];
    for (const mat of mats) {
      const e = mat.emissiveFactor ?? [0, 0, 0];
      const glows = e.some((c) => c > 0.05);
      expect(glows, `${mat.name} emissive=${JSON.stringify(e)}`).toBe((mat.name ?? "").startsWith("light_"));
    }
    const names = mats.map((x) => x.name);
    for (const l of spec.lights) expect(names, l).toContain(l);
  });

  it("uses alpha MASK or OPAQUE, never BLEND", async () => {
    const { json } = await loadModel(spec.file);
    for (const mat of json.materials ?? []) expect(mat.alphaMode ?? "OPAQUE", mat.name).not.toBe("BLEND");
  });

  it("stands on the ground (lowest point at y = 0)", async () => {
    const { doc } = await loadModel(spec.file);
    expect(Math.abs(box(allPositions(doc)).min[1])).toBeLessThan(0.03);
  });
});

// ------------------------------------------------------------------------------ vehicles

interface VehicleSpec {
  file: string;
  length: [number, number];
  width: [number, number];
}

describe.each<VehicleSpec>([
  { file: "player-car.glb", length: [4.0, 5.0], width: [1.6, 2.1] },
  { file: "robotaxi.glb", length: [4.4, 5.2], width: [1.8, 2.3] },
  { file: "muni-bus.glb", length: [11.0, 13.0], width: [2.4, 3.3] },
  { file: "moat-van.glb", length: [5.0, 6.0], width: [1.9, 2.3] },
])("$file as a road vehicle", ({ file, length, width }) => {
  it("has a real-world length and width", async () => {
    const { doc } = await loadModel(file);
    const b = box(nodePositions(node(doc, "body")));
    expect(b.size[2]).toBeGreaterThanOrEqual(length[0]);
    expect(b.size[2]).toBeLessThanOrEqual(length[1]);
    expect(b.size[0]).toBeGreaterThanOrEqual(width[0]);
    expect(b.size[0]).toBeLessThanOrEqual(width[1]);
    expect(Math.abs(b.center[0])).toBeLessThan(0.05);
  });

  it("faces -Z: headlights at the -Z end, taillights at the +Z end", async () => {
    const { doc } = await loadModel(file);
    const b = box(nodePositions(node(doc, "body")));
    const head = mean(materialPositions(doc, "light_headlight"));
    const tail = mean(materialPositions(doc, "light_taillight"));
    expect(head[2]).toBeLessThan(b.min[2] + 0.1 * b.size[2]);
    expect(tail[2]).toBeGreaterThan(b.max[2] - 0.1 * b.size[2]);
  });

  it("has hub-centred wheel nodes: front at -Z, left at -X, touching the ground", async () => {
    const { doc } = await loadModel(file);
    for (const name of CAR_WHEELS) {
      const n = node(doc, name);
      const o = worldOrigin(n);
      expect(o[2] < 0, `${name} z=${o[2]}`).toBe(name.includes("_F"));
      expect(o[0] < 0, `${name} x=${o[0]}`).toBe(name.endsWith("L"));
      const local = box(nodePositions(n, "local"));
      // spins about local X: round in Y and Z, centred on the origin
      expect(Math.abs(local.center[1])).toBeLessThan(0.02);
      expect(Math.abs(local.center[2])).toBeLessThan(0.02);
      expect(Math.abs(local.size[1] - local.size[2])).toBeLessThan(0.02);
      expect(Math.abs(o[1] - local.size[1] / 2)).toBeLessThan(0.02);
      expect(n.getExtras().spinAxis).toEqual([1, 0, 0]);
    }
  });
});

describe("robotaxi", () => {
  it("has a sensor dome on the roof that spins about its own vertical axis", async () => {
    const { doc } = await loadModel("robotaxi.glb");
    const dome = node(doc, "sensor_dome");
    const local = box(nodePositions(dome, "local"));
    expect(Math.abs(local.center[0])).toBeLessThan(0.02);
    expect(Math.abs(local.center[2])).toBeLessThan(0.02);
    expect(worldAxis(dome, [0, 1, 0])[1]).toBeGreaterThan(0.999);
    const roof = box(nodePositions(node(doc, "body"))).max[1];
    expect(worldOrigin(dome)[1]).toBeGreaterThan(1.6);
    expect(box(nodePositions(dome)).max[1]).toBeGreaterThanOrEqual(roof - 0.01);
  });

  it("has corner sensor pods and a status light up top", async () => {
    const { doc } = await loadModel("robotaxi.glb");
    const lens = materialPositions(doc, "sensor_lens");
    const b = box(nodePositions(node(doc, "body")));
    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].filter(([sx, sz]) => lens.some((p) => p[0] * sx! > 0.6 && p[2] * sz! > b.size[2] * 0.4));
    expect(corners).toHaveLength(4);
    expect(box(materialPositions(doc, "light_status")).min[1]).toBeGreaterThan(1.6);
  });
});

describe("moat-van", () => {
  it("is graphite with a teal accent, and its rear doors swing outward about hinges at the corners", async () => {
    const { doc } = await loadModel("moat-van.glb");
    const mats = doc.getRoot().listMaterials().map((m) => m.getName());
    expect(mats).toContain("paint_graphite");
    expect(mats).toContain("accent_teal");
    const body = box(nodePositions(node(doc, "body")));
    expect(body.max[1]).toBeGreaterThan(2.2); // a tall van
    for (const side of ["L", "R"]) {
      const door = node(doc, `door_rear_${side}`);
      const ex = door.getExtras();
      expect(ex.hingeAxis).toEqual([0, 1, 0]);
      const o = worldOrigin(door);
      const sign = side === "L" ? -1 : 1;
      expect(o[0] * sign).toBeGreaterThan(0.8); // hinge at its rear corner
      const rearWall = Math.max(...nodePositions(node(doc, "body")).filter((p) => p[1] > 0.8).map((p) => p[2]));
      expect(o[2]).toBeGreaterThan(rearWall - 0.05); // at the back (+Z), on the rear wall
      // swinging by openRad about +Y moves the free edge out behind the van
      const a = ex.openRad as number;
      expect(Math.sign(a)).toBe(sign);
      const local = nodePositions(door, "local");
      const free = local.reduce((f, p) => (Math.abs(p[0]) > Math.abs(f[0]) ? p : f));
      const z = -free[0] * Math.sin(a) + free[2] * Math.cos(a);
      expect(z).toBeGreaterThan(0.5);
    }
  });

  it("carries the castle-and-moat emblem as geometry on both sides, no text", async () => {
    const { doc } = await loadModel("moat-van.glb");
    const teal = materialPositions(doc, "accent_teal");
    const high = teal.filter((p) => p[1] > 1.2);
    expect(high.some((p) => p[0] > 1.0)).toBe(true);
    expect(high.some((p) => p[0] < -1.0)).toBe(true);
    expect(doc.getRoot().listTextures()).toHaveLength(0);
  });
});

describe("muni-bus livery", () => {
  it("has a large side panel on each side with its own material and 0..1 UVs", async () => {
    const { doc } = await loadModel("muni-bus.glb");
    const prims = doc
      .getRoot()
      .listMeshes()
      .flatMap((m) => m.listPrimitives())
      .filter((p) => p.getMaterial()?.getName() === "livery");
    expect(prims.length).toBeGreaterThan(0);
    const uv = prims.flatMap((p) => {
      const a = p.getAttribute("TEXCOORD_0");
      if (!a) return [];
      const out: number[][] = [];
      for (let i = 0; i < a.getCount(); i++) out.push(a.getElement(i, []));
      return out;
    });
    expect(uv.length).toBeGreaterThanOrEqual(8);
    expect(Math.min(...uv.map((u) => u[0]!))).toBeCloseTo(0, 3);
    expect(Math.max(...uv.map((u) => u[0]!))).toBeCloseTo(1, 3);
    expect(Math.min(...uv.map((u) => u[1]!))).toBeCloseTo(0, 3);
    expect(Math.max(...uv.map((u) => u[1]!))).toBeCloseTo(1, 3);
    const pts = materialPositions(doc, "livery");
    const extras = node(doc, "livery_panel").getExtras().livery as { aspect: number; sizeM: [number, number] };
    const glass = materialTriangles(doc, "glass");
    for (const side of [-1, 1]) {
      const b = box(pts.filter((p) => p[0] * side > 0));
      const [len, h] = [b.size[2], b.size[1]];
      // the whole red lower body: tall enough for a headline and a subline
      expect(h, `side ${side} panel height`).toBeGreaterThanOrEqual(0.7);
      expect(len * h, `side ${side} panel area`).toBeGreaterThan(2.8);
      expect(len / h, `side ${side} panel aspect`).toBeLessThan(7);
      expect(Math.abs(len / h - extras.aspect) / extras.aspect).toBeLessThan(0.01);
      expect(Math.abs(len - extras.sizeM[0])).toBeLessThan(0.01);
      expect(Math.abs(h - extras.sizeM[1])).toBeLessThan(0.01);
      // it covers no window or door on its side of the bus
      for (const t of glass.filter((tri) => tri.every((p) => p[0] * side > 1.2))) {
        const g = box(t);
        const overlapZ = Math.min(g.max[2], b.max[2]) - Math.max(g.min[2], b.min[2]);
        const overlapY = Math.min(g.max[1], b.max[1]) - Math.max(g.min[1], b.min[1]);
        expect(overlapZ > 0.01 && overlapY > 0.01, `glass behind the side ${side} panel`).toBe(false);
      }
    }
    // both sides share one texture, so they are the same size
    const sides = [-1, 1].map((side) => box(pts.filter((p) => p[0] * side > 0)));
    expect(Math.abs(sides[0]!.size[2] - sides[1]!.size[2])).toBeLessThan(0.01);
    expect(Math.abs(sides[0]!.size[1] - sides[1]!.size[1])).toBeLessThan(0.01);
    // the placeholder texture has the panel's aspect, so it is not stretched
    const tex = doc.getRoot().listMaterials().find((m) => m.getName() === "livery")?.getBaseColorTexture();
    expect(tex).toBeTruthy();
    const [w, hpx] = tex!.getSize() ?? [0, 1];
    expect(Math.abs(w / hpx - extras.aspect) / extras.aspect).toBeLessThan(0.02);
  });
});

// ------------------------------------------------------------------------- the robots

describe("errand-robot (the Porter)", () => {
  it("is tall and slim (1.8-2.0 m) with the face light strip on the front of its head", async () => {
    const { doc } = await loadModel("errand-robot.glb");
    const all = box(allPositions(doc));
    expect(all.max[1]).toBeGreaterThan(1.8);
    expect(all.max[1]).toBeLessThan(2.0);
    expect(all.size[0]).toBeLessThan(0.65); // slim: shoulder to shoulder, arms down
    const face = materialPositions(doc, "light_face");
    const head = worldOrigin(node(doc, "head"));
    expect(mean(face)[2]).toBeLessThan(head[2] - 0.05);
    expect(mean(face)[1]).toBeGreaterThan(head[1]);
    // one horizontal strip: wide, short
    const fb = box(face);
    expect(fb.size[0]).toBeGreaterThan(4 * fb.size[1]);
  });

  it("has a lantern head: a barrel wider than its collar, a cap and a carrying ring on top", async () => {
    const { doc } = await loadModel("errand-robot.glb");
    const headNode = node(doc, "head");
    const pts = nodePositions(headNode, "local");
    const hb = box(pts);
    expect(hb.size[1]).toBeGreaterThan(0.33); // tall like a lantern
    expect(hb.size[1]).toBeLessThan(0.45);
    const widthAt = (y0: number, y1: number) => box(pts.filter((p) => p[1] > y0 && p[1] < y1)).size[0];
    expect(widthAt(0.14, 0.24)).toBeGreaterThan(1.8 * widthAt(-0.01, 0.04)); // barrel vs neck
    expect(widthAt(hb.max[1] - 0.05, hb.max[1] + 0.01)).toBeLessThan(0.1); // the ring on top
  });

  it("is opaque everywhere: no translucent face plate or torso", async () => {
    const { json } = await loadModel("errand-robot.glb");
    for (const mat of json.materials ?? []) {
      expect(mat.alphaMode ?? "OPAQUE", mat.name).toBe("OPAQUE");
      const m = mat as { pbrMetallicRoughness?: { baseColorFactor?: number[] }; extensions?: Record<string, unknown> };
      expect(m.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1, mat.name).toBe(1);
      expect(Object.keys(m.extensions ?? {}), mat.name).not.toContain("KHR_materials_transmission");
    }
  });

  it("is a joint hierarchy with pivots at the joints", async () => {
    const { doc } = await loadModel("errand-robot.glb");
    const parent = (n: string) => node(doc, n).getParentNode()?.getName();
    expect(parent("head")).toBe("torso");
    expect(parent("bag")).toBe("arm_lower_R");
    for (const s of ["L", "R"]) {
      expect(parent(`arm_upper_${s}`)).toBe("torso");
      expect(parent(`arm_lower_${s}`)).toBe(`arm_upper_${s}`);
      expect(parent(`leg_upper_${s}`)).toBe("torso");
      expect(parent(`leg_lower_${s}`)).toBe(`leg_upper_${s}`);
      const sign = s === "L" ? -1 : 1;
      const shoulder = worldOrigin(node(doc, `arm_upper_${s}`));
      const elbow = worldOrigin(node(doc, `arm_lower_${s}`));
      const hip = worldOrigin(node(doc, `leg_upper_${s}`));
      const knee = worldOrigin(node(doc, `leg_lower_${s}`));
      expect(shoulder[0] * sign).toBeGreaterThan(0.1); // the robot's left is -X
      expect(hip[0] * sign).toBeGreaterThan(0.03);
      expect(shoulder[1]).toBeGreaterThan(1.3);
      expect(shoulder[1]).toBeLessThan(1.6);
      expect(shoulder[1] - elbow[1]).toBeGreaterThan(0.2);
      expect(shoulder[1] - elbow[1]).toBeLessThan(0.4);
      expect(hip[1]).toBeGreaterThan(0.75);
      expect(hip[1]).toBeLessThan(1.05);
      expect(hip[1] - knee[1]).toBeGreaterThan(0.3);
      for (const part of [`arm_upper_${s}`, `arm_lower_${s}`, `leg_upper_${s}`, `leg_lower_${s}`]) {
        const n = node(doc, part);
        expect(box(nodePositions(n)).center[1], part).toBeLessThan(worldOrigin(n)[1]);
      }
    }
    const neck = worldOrigin(node(doc, "head"));
    expect(neck[1]).toBeGreaterThan(1.35);
    expect(neck[1]).toBeLessThan(1.65);
  });

  it("carries the bag below its right hand, clear of the ground", async () => {
    const { doc } = await loadModel("errand-robot.glb");
    const bag = box(nodePositions(node(doc, "bag")));
    const elbow = worldOrigin(node(doc, "arm_lower_R"));
    expect(bag.max[1]).toBeLessThan(elbow[1]);
    expect(bag.min[1]).toBeGreaterThan(0.1);
    expect(bag.center[0]).toBeGreaterThan(0.15);
  });

  it("keeps the groceries in their own child node of the bag (hide it for an empty bag)", async () => {
    const { doc } = await loadModel("errand-robot.glb");
    const bagNode = node(doc, "bag");
    const contents = node(doc, "bag_contents");
    expect(contents.getParentNode()?.getName()).toBe("bag");
    expect(contents.getExtras().bagContents).toBe(true);
    expect(nodeMaterials(bagNode).some((m) => m.startsWith("produce_"))).toBe(false);
    const mats = nodeMaterials(contents);
    expect(mats.length).toBeGreaterThan(0);
    for (const m of mats) expect(m).toMatch(/^produce_/);
    const bag = box(nodePositions(bagNode).filter((p) => p[1] < box(nodePositions(bagNode)).max[1] - 0.15));
    const g = box(nodePositions(contents));
    expect(g.max[1]).toBeGreaterThan(bag.max[1]);
    expect(g.min[1]).toBeGreaterThan(bag.min[1]);
    expect(g.center[0]).toBeGreaterThan(bag.min[0]);
    expect(g.center[0]).toBeLessThan(bag.max[0]);
    expect(g.center[2]).toBeGreaterThan(bag.min[2]);
    expect(g.center[2]).toBeLessThan(bag.max[2]);
  });
});

describe("sidewalk-bot (the Trundle)", () => {
  it("is a knee-high, four-wheeled box with its lights at the front and no flag or antenna", async () => {
    const { doc } = await loadModel("sidewalk-bot.glb");
    const body = box(nodePositions(node(doc, "body")));
    expect(body.max[1]).toBeGreaterThan(0.4);
    expect(body.max[1]).toBeLessThan(0.65);
    expect(box(allPositions(doc)).max[1]).toBeLessThan(0.65); // nothing sticks up
    expect(body.size[2]).toBeGreaterThan(0.6);
    expect(body.size[2]).toBeLessThan(0.85);
    expect(body.size[0]).toBeGreaterThan(0.45);
    expect(body.size[0]).toBeLessThan(0.7);
    const names = sceneNodes(doc).map((n) => n.getName());
    expect(names).not.toContain("flag");
    expect(names.filter((n) => n.startsWith("wheel_")).sort()).toEqual(["wheel_L1", "wheel_L2", "wheel_R1", "wheel_R2"]);
    expect(mean(materialPositions(doc, "light_eyes"))[2]).toBeLessThan(body.min[2] + 0.05);
    for (const s of ["L", "R"]) {
      const front = node(doc, `wheel_${s}1`);
      const rear = node(doc, `wheel_${s}2`);
      expect(worldOrigin(front)[2]).toBeLessThan(worldOrigin(rear)[2]);
      for (const w of [front, rear]) {
        expect(worldOrigin(w)[0] < 0).toBe(s === "L");
        const r = w.getExtras().radius as number;
        expect(r).toBeGreaterThan(0.05);
        expect(Math.abs(worldOrigin(w)[1] - r)).toBeLessThan(0.01); // touches the ground
        expect(w.getExtras().spinAxis).toEqual([1, 0, 0]);
      }
    }
  });

  it("has a bread-bin roll-top lid that rolls back under the top panel to open", async () => {
    const { doc } = await loadModel("sidewalk-bot.glb");
    const lid = node(doc, "lid");
    const ex = lid.getExtras();
    expect(ex.lidAxis).toEqual([1, 0, 0]);
    const a = ex.lidOpenRad as number;
    expect(a).toBeGreaterThan(1.2);
    const body = box(nodePositions(node(doc, "body")));
    const o = worldOrigin(lid);
    const local = nodePositions(lid, "local");
    const closed = box(nodePositions(lid));
    // closed, the lid is the curved front top: its front edge low, its back edge on top
    expect(closed.min[2]).toBeLessThan(body.min[2] + 0.1);
    expect(closed.max[1]).toBeGreaterThan(body.max[1] - 0.06);
    // rotate about local +X by the open angle: it slides back, under the top, inside the walls
    const open = box(local.map(([x, y, z]) => [o[0] + x, o[1] + y * Math.cos(a) - z * Math.sin(a), o[2] + y * Math.sin(a) + z * Math.cos(a)] as V3));
    expect(open.center[2]).toBeGreaterThan(closed.center[2] + 0.15);
    expect(open.max[1]).toBeLessThan(body.max[1]);
    expect(open.min[0]).toBeGreaterThan(body.min[0]);
    expect(open.max[0]).toBeLessThan(body.max[0]);
    expect(open.max[2]).toBeLessThan(body.max[2]);
  });

  it("carries its cargo inside the bin (hide cargo for an empty bin)", async () => {
    const { doc } = await loadModel("sidewalk-bot.glb");
    const cargo = node(doc, "cargo");
    expect(cargo.getExtras().cargo).toBe(true);
    const c = box(nodePositions(cargo));
    const body = box(nodePositions(node(doc, "body")));
    for (const k of [0, 1, 2]) {
      expect(c.min[k]).toBeGreaterThan(body.min[k]);
      expect(c.max[k]).toBeLessThan(body.max[k]);
    }
  });
});

// ---------------------------------------------------------------------- melt and rust

describe.each(["errand-robot.glb", "sidewalk-bot.glb"])("%s melt and rust hooks", (file) => {
  const meshNodes = async () => {
    const { doc } = await loadModel(file);
    return { doc, nodes: sceneNodes(doc).filter((n) => n.getMesh()) };
  };

  it("has seize, slump and melt shape keys on every part", async () => {
    const { nodes } = await meshNodes();
    expect(nodes.length).toBeGreaterThan(3);
    for (const n of nodes) {
      const mesh = n.getMesh()!;
      expect(mesh.getExtras().targetNames, n.getName()).toEqual(["seize", "slump", "melt"]);
      for (const p of mesh.listPrimitives()) expect(p.listTargets(), n.getName()).toHaveLength(3);
    }
  });

  it("sags with each key and ends as a low mound on the ground", async () => {
    const { nodes } = await meshNodes();
    const shape = (k: number | null): V3[] =>
      nodes.flatMap((n) => {
        const m = n.getWorldMatrix() as unknown as number[];
        return n
          .getMesh()!
          .listPrimitives()
          .flatMap((p) => {
            const pos = p.getAttribute("POSITION")!;
            const t = k === null ? null : p.listTargets()[k]!.getAttribute("POSITION")!;
            const out: V3[] = [];
            for (let i = 0; i < pos.getCount(); i++) {
              const v = pos.getElement(i, []);
              const d = t ? t.getElement(i, []) : [0, 0, 0];
              const q = [v[0]! + d[0]!, v[1]! + d[1]!, v[2]! + d[2]!];
              // node transforms at rest are translations (plus scale 1): apply the matrix
              out.push([m[0]! * q[0]! + m[4]! * q[1]! + m[8]! * q[2]! + m[12]!, m[1]! * q[0]! + m[5]! * q[1]! + m[9]! * q[2]! + m[13]!, m[2]! * q[0]! + m[6]! * q[1]! + m[10]! * q[2]! + m[14]!]);
            }
            return out;
          });
      });
    const rest = box(shape(null));
    const seize = box(shape(0));
    const slump = box(shape(1));
    const melt = box(shape(2));
    expect(seize.max[1]).toBeLessThan(rest.max[1]);
    expect(slump.max[1]).toBeLessThan(seize.max[1]);
    expect(melt.max[1]).toBeLessThan(slump.max[1]);
    expect(melt.max[1]).toBeLessThan(0.55);
    expect(melt.size[0]).toBeGreaterThan(rest.size[0] * 0.9); // spread out, not shrunk away
    for (const b of [seize, slump, melt]) expect(b.min[1]).toBeGreaterThan(-0.01); // never below ground
  });

  it("has a rust mask: joints and seams rust first, the night lights never", async () => {
    const { doc } = await loadModel(file);
    const byMat = new Map<string, number[]>();
    for (const n of sceneNodes(doc)) {
      for (const p of n.getMesh()?.listPrimitives() ?? []) {
        const a = p.getAttribute("_RUST_MASK");
        expect(a, `${n.getName()} has _RUST_MASK`).toBeTruthy();
        const name = p.getMaterial()?.getName() ?? "";
        const list = byMat.get(name) ?? [];
        for (let i = 0; i < a!.getCount(); i++) list.push(a!.getScalar(i));
        byMat.set(name, list);
      }
    }
    const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    for (const [name, xs] of byMat) {
      if (name.startsWith("light_")) for (const v of xs) expect(v, name).toBe(2);
      else for (const v of xs) expect(v, name).toBeLessThanOrEqual(2);
    }
    const joints = [...byMat].filter(([n]) => /graphite/.test(n)).flatMap(([, xs]) => xs);
    const shell = [...byMat].filter(([n]) => /^shell_/.test(n)).flatMap(([, xs]) => xs);
    expect(avg(joints)).toBeLessThan(0.1);
    expect(avg(shell)).toBeGreaterThan(0.3);
    expect(Math.min(...shell)).toBeLessThan(0.25); // shell rust starts at the seams
    expect(Math.max(...shell)).toBeGreaterThan(0.85); // and reaches the middle of the panels last
  });

  it("marks its rustable materials", async () => {
    const { json } = await loadModel(file);
    const mats = (json.materials ?? []) as Array<{ name?: string; extras?: { rustable?: boolean } }>;
    expect(mats.filter((m) => m.extras?.rustable).length).toBeGreaterThan(2);
    for (const m of mats) if ((m.name ?? "").startsWith("light_")) expect(m.extras?.rustable).toBeFalsy();
  });
});

// -------------------------------------------------------------------------- landmarks

interface Landmark {
  id: string;
  model: string;
  lat: number;
  lon: number;
  headingDeg: number;
  scale?: number;
  replacesBuildingIds?: string[];
  collider?: Array<[number, number]>;
}

const landmarks = readJson<{ version: number; landmarks: Landmark[] }>("content/landmarks.json");
const byId = (id: string): Landmark => {
  const l = landmarks.landmarks.find((x) => x.id === id);
  if (!l) throw new Error(`no landmark ${id}`);
  return l;
};

/** World (src/geo) metres -> a landmark's model frame (glTF x right, z back). */
function toModel(l: Landmark, x: number, z: number): [number, number] {
  const o = toLocal(l.lat, l.lon);
  const h = (l.headingDeg * Math.PI) / 180;
  const dx = x - o.x;
  const dz = z - o.z;
  // world = Ry(-h) * model  =>  model = Ry(h) * world
  return [dx * Math.cos(h) + dz * Math.sin(h), -dx * Math.sin(h) + dz * Math.cos(h)];
}

const footprint = readJson<{ record: { sf16_bldgid: string; shape: { type: string; coordinates: number[][][][] } } }>(
  "assets/blender/data/ferry-building-footprint.json",
);

describe("content/landmarks.json", () => {
  it("validates against schemas/landmarks.schema.json", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const v = ajv.compile(readJson("schemas/landmarks.schema.json"));
    expect(v(landmarks), ajv.errorsText(v.errors)).toBe(true);
  });

  it("points at models that exist and places both landmarks", () => {
    for (const id of ["ferry-building", "r-evolution"]) {
      const l = byId(id);
      expect(l.model).toMatch(/^models\/[a-z-]+\.glb$/);
      expect(l.scale ?? 1).toBe(1);
    }
    expect(byId("ferry-building").replacesBuildingIds).toContain(footprint.record.sf16_bldgid);
  });

  it("puts R-Evolution in Embarcadero Plaza facing up Market Street, back to the Ferry Building", () => {
    const rev = byId("r-evolution");
    const ferry = byId("ferry-building");
    const r = toLocal(rev.lat, rev.lon);
    const f = toLocal(ferry.lat, ferry.lon);
    const d = Math.hypot(r.x - f.x, r.z - f.z);
    expect(d).toBeGreaterThan(60);
    expect(d).toBeLessThan(200);
    // seen from the Ferry Building's front, the sculpture is ahead of it (across the Embarcadero)
    const [, zInFerry] = toModel(ferry, r.x, r.z);
    expect(zInFerry).toBeLessThan(-60);
    // and the sculpture faces away from the tower: its front points roughly along the
    // tower -> sculpture direction (up Market Street)
    const bearing = ((Math.atan2(r.x - f.x, -(r.z - f.z)) * 180) / Math.PI + 360) % 360;
    expect(Math.abs(((rev.headingDeg - bearing + 540) % 360) - 180)).toBeLessThan(25);
  });
});

// ----------------------------------------------------------------------- Ferry Building

describe("ferry-building.glb", () => {
  it("has a 70-80 m clock tower", async () => {
    const { doc } = await loadModel("ferry-building.glb");
    const tower = box(nodePositions(node(doc, "tower")));
    expect(tower.max[1]).toBeGreaterThanOrEqual(70);
    expect(tower.max[1]).toBeLessThanOrEqual(80);
    expect(box(allPositions(doc)).max[1]).toBeLessThanOrEqual(80);
    // the tower stands on the model origin
    expect(Math.abs(tower.center[0])).toBeLessThan(1);
    expect(Math.abs(tower.center[2])).toBeLessThan(1);
  });

  it("matches the SF footprint when placed by landmarks.json: front (Embarcadero facade) at -Z", async () => {
    const { doc } = await loadModel("ferry-building.glb");
    const l = byId("ferry-building");
    const ring = footprint.record.shape.coordinates.reduce((a, p) => (p[0]!.length > a.length ? p[0]! : a), [] as number[][]);
    const pts = ring.map(([lon, lat]) => {
      const w = toLocal(lat!, lon!);
      return toModel(l, w.x, w.z);
    });
    const fx = pts.map((p) => p[0]);
    const fz = pts.map((p) => p[1]);
    const m = box(nodePositions(node(doc, "building")));
    // ~200 m long along x, ~58 m deep along z, the projecting pavilion on the -Z side
    expect(Math.max(...fx) - Math.min(...fx)).toBeGreaterThan(195);
    expect(Math.abs(m.min[0] - Math.min(...fx))).toBeLessThan(3);
    expect(Math.abs(m.max[0] - Math.max(...fx))).toBeLessThan(3);
    expect(Math.abs(m.min[2] - Math.min(...fz))).toBeLessThan(2.5);
    expect(Math.abs(m.max[2] - Math.max(...fz))).toBeLessThan(2.5);
    expect(-Math.min(...fz)).toBeLessThan(Math.max(...fz) / 4); // front is the shallow side
    // the collider override is the same footprint
    const c = l.collider ?? [];
    expect(c.length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(Math.min(...c.map((p) => p[1])) - Math.min(...fz))).toBeLessThan(0.5);
    expect(Math.abs(Math.max(...c.map((p) => p[1])) - Math.max(...fz))).toBeLessThan(0.5);
  });

  it("has four dials whose hands turn about local +Z = the dial's outward normal", async () => {
    const { doc } = await loadModel("ferry-building.glb");
    const outward: Record<string, V3> = { N: [0, 0, -1], E: [1, 0, 0], S: [0, 0, 1], W: [-1, 0, 0] };
    const heading = byId("ferry-building").headingDeg;
    const turn: Record<string, number> = { N: 0, E: 90, S: 180, W: 270 };
    for (const f of ["N", "E", "S", "W"]) {
      for (const kind of ["hour", "minute"]) {
        const n = node(doc, `clock_${kind}_${f}`);
        const ex = n.getExtras();
        expect(ex.clockHand).toBe(kind);
        expect(ex.clockAxis).toEqual([0, 0, 1]);
        // N/E/S/W are model-frame names; the extras say so and give the placed world bearing
        expect(ex.clockFace).toBe(f);
        expect(ex.clockFaceFrame).toBe("model");
        expect(ex.clockFaceNormal).toEqual(outward[f]);
        expect(Math.abs((ex.clockFaceBearingDeg as number) - ((heading + turn[f]!) % 360))).toBeLessThan(0.11);
        const z = worldAxis(n, [0, 0, 1]);
        const y = worldAxis(n, [0, 1, 0]);
        const o = outward[f]!;
        expect(z[0] * o[0] + z[1] * o[1] + z[2] * o[2], `${f} ${kind} normal`).toBeGreaterThan(0.999);
        // placed at the landmark heading, the dial's normal points along clockFaceBearingDeg
        const h = (heading * Math.PI) / 180;
        const dx = z[0] * Math.cos(h) - z[2] * Math.sin(h);
        const dz = z[0] * Math.sin(h) + z[2] * Math.cos(h);
        const placed = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
        expect(Math.abs((((placed - (ex.clockFaceBearingDeg as number)) % 360) + 540) % 360 - 180)).toBeLessThan(0.2);
        expect(y[1], `${f} ${kind} rests at 12`).toBeGreaterThan(0.999);
        // pivot at the dial centre on that face, ~37 m up
        const p = worldOrigin(n);
        expect(p[1]).toBeGreaterThan(30);
        expect(p[1]).toBeLessThan(45);
        expect(p[0] * o[0] + p[2] * o[2]).toBeGreaterThan(5);
        // the hand points up from the pivot and sits in front of the dial
        const local = box(nodePositions(n, "local"));
        expect(local.max[1]).toBeGreaterThan(kind === "minute" ? 2.8 : 1.9);
        expect(local.min[2]).toBeGreaterThan(0);
      }
      const minute = box(nodePositions(node(doc, `clock_minute_${f}`), "local"));
      const hour = box(nodePositions(node(doc, `clock_hour_${f}`), "local"));
      expect(minute.max[1]).toBeGreaterThan(hour.max[1]);
      expect(minute.min[2]).toBeGreaterThanOrEqual(hour.max[2] - 1e-3); // minute hand in front
    }
  });

  it("has night outline strips on the tower", async () => {
    const { doc } = await loadModel("ferry-building.glb");
    const strips = box(materialPositions(doc, "light_tower_outline"));
    expect(strips.min[1]).toBeGreaterThan(18);
    expect(strips.max[1]).toBeGreaterThan(65);
    expect(Math.max(Math.abs(strips.min[0]), Math.abs(strips.max[0]))).toBeLessThan(8);
  });
});

// ------------------------------------------------------------------------- R-Evolution

describe("r-evolution.glb", () => {
  it("is a 12.5-15 m figure on a plinth", async () => {
    const { doc } = await loadModel("r-evolution.glb");
    const all = box(allPositions(doc));
    expect(all.max[1]).toBeGreaterThanOrEqual(12.5);
    expect(all.max[1]).toBeLessThanOrEqual(15);
    const plinth = box(nodePositions(node(doc, "plinth")));
    const l = byId("r-evolution");
    const cr = Math.max(...(l.collider ?? []).map(([x, z]) => Math.hypot(x, z)));
    expect(Math.abs(plinth.size[0] / 2 - cr)).toBeLessThan(0.1);
  });

  it("has a chain-link shell (alpha MASK, textured) over a triangulated rod frame, glowing inside", async () => {
    const { doc, json } = await loadModel("r-evolution.glb");
    const mat = (name: string) => (json.materials ?? []).find((m) => m.name === name);
    expect(mat("steel_mesh")?.alphaMode).toBe("MASK");
    expect(doc.getRoot().listMaterials().find((m) => m.getName() === "steel_mesh")?.getBaseColorTexture()).toBeTruthy();
    expect(mat("light_sculpture_glow")?.alphaMode).toBe("MASK");
    expect(mat("steel_rod")?.alphaMode ?? "OPAQUE").toBe("OPAQUE");
    const frame = box(nodePositions(node(doc, "frame")));
    const glow = box(nodePositions(node(doc, "glow")));
    expect(frame.size[1]).toBeGreaterThan(12);
    expect(glow.size[1]).toBeLessThan(frame.size[1]); // inside the frame
  });

  it("stands in the pose its root extras name: tadasana (hands low at her sides) or raised", async () => {
    // The game ships the real sculpture's stance; FC_REVOLUTION_POSE=raised builds the brief's
    // raised arms (run these tests on it with FC_MODELS_DIR, see assets/blender/README.md).
    const { doc } = await loadModel("r-evolution.glb");
    const pose = node(doc, "r_evolution").getExtras().pose;
    expect(["tadasana", "raised"]).toContain(pose);
    const pts = nodePositions(node(doc, "shell"));
    const b = box(pts);
    const base = box(nodePositions(node(doc, "plinth"))).max[1];
    const spreadAtTop = Math.max(...pts.filter((p) => p[1] > b.max[1] - 0.6).map((p) => Math.abs(p[0])));
    const widest = pts.reduce((w, p) => (Math.abs(p[0]) > Math.abs(w[0]) ? p : w));
    const widestAt = (widest[1] - base) / (b.max[1] - base); // 0 = feet, 1 = top
    if (pose === "tadasana") {
      expect(spreadAtTop).toBeLessThan(1.0); // only her head up there
      expect(widestAt).toBeGreaterThan(0.35); // hands open at hip height
      expect(widestAt).toBeLessThan(0.65);
    } else {
      expect(spreadAtTop).toBeGreaterThan(2.0); // two hands, wide apart
      expect(widestAt).toBeGreaterThan(0.9);
    }
  });

  it("faces -Z: her feet point toward -Z", async () => {
    const { doc } = await loadModel("r-evolution.glb");
    const pts = nodePositions(node(doc, "shell"));
    const base = box(nodePositions(node(doc, "plinth"))).max[1];
    const ankles = pts.filter((p) => p[1] > base + 0.75 && p[1] < base + 1.0);
    const feet = pts.filter((p) => p[1] > base && p[1] < base + 0.35);
    const az = mean(ankles)[2];
    const f = box(feet);
    const toes = az - f.min[2];
    const heels = f.max[2] - az;
    expect(toes).toBeGreaterThan(1.5 * heels);
  });
});
