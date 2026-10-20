// Wave-2 props, the water blaster, rust heaps and animals (assets/blender/models/{props,
// water_blaster,heaps,animals}.py): valid glTF, budgets, the nodes and extras the game reads,
// real-world sizes, front at -Z, and the taste rules that can be checked from the file
// (a toy-coloured, non-gun-shaped blaster with no gun words; animals and wheelchair users
// flagged no-touch).

import { validateBytes } from "gltf-validator";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers.ts";
import { allPositions, box, loadModel, materialPositions, mean, node, nodeMaterials, nodePositions, sceneNodes, triangleCount, worldOrigin, type V3 } from "./glb.ts";

interface PropSpec {
  file: string;
  budget: number;
  nodes: string[];
  height: [number, number];
  /** Rests on the ground (the blaster is laid out as worn, so it does not). */
  grounded?: boolean;
  lights?: string[];
}

const PROPS: PropSpec[] = [
  { file: "hydrant.glb", budget: 1_200, nodes: ["hydrant", "body", "refill_point"], height: [0.7, 0.9] },
  { file: "drinking-fountain.glb", budget: 1_200, nodes: ["drinking_fountain", "body", "refill_point"], height: [0.85, 1.1] },
  { file: "traffic-cone.glb", budget: 400, nodes: ["traffic_cone", "cone"], height: [0.65, 0.75] },
  { file: "repair-kiosk.glb", budget: 3_000, nodes: ["repair_kiosk", "booth", "bay"], height: [2.2, 2.8], lights: ["light_kiosk_screen", "light_kiosk_status"] },
  { file: "vendor-cart.glb", budget: 4_000, nodes: ["vendor_cart", "cart", "sign_slot", "wheel_L", "wheel_R"], height: [2.0, 2.4] },
  { file: "wheelchair.glb", budget: 2_500, nodes: ["wheelchair", "chair", "wheel_L", "wheel_R"], height: [0.85, 1.05] },
  { file: "water-blaster.glb", budget: 2_500, nodes: ["water_blaster", "tank", "pump_handle", "water_level", "hose", "wand", "nozzle"], height: [0.5, 1.6], grounded: false },
  { file: "heap-porter.glb", budget: 2_500, nodes: ["heap", "pile", "puddle"], height: [0.15, 0.6] },
  { file: "heap-trundle.glb", budget: 2_500, nodes: ["heap", "pile", "puddle"], height: [0.1, 0.6] },
  { file: "heap-mixed.glb", budget: 2_500, nodes: ["heap", "pile", "puddle"], height: [0.15, 0.6] },
  { file: "pigeon.glb", budget: 300, nodes: ["pigeon", "body"], height: [0.2, 0.32] },
  { file: "dog.glb", budget: 1_000, nodes: ["dog", "body", "leash"], height: [0.6, 1.0] },
];

describe.each(PROPS)("$file", (spec) => {
  it("is valid glTF 2.0", async () => {
    const m = await loadModel(spec.file);
    const report = await validateBytes(m.bytes, { maxIssues: 50 });
    const errors = report.issues.messages.filter((x) => x.severity === 0);
    expect(errors, JSON.stringify(errors.slice(0, 5))).toEqual([]);
  });

  it(`stays within ${spec.budget} triangles and has its nodes`, async () => {
    const { doc } = await loadModel(spec.file);
    const tris = triangleCount(doc);
    expect(tris).toBeGreaterThan(spec.budget * 0.05);
    expect(tris).toBeLessThanOrEqual(spec.budget);
    const names = new Set(sceneNodes(doc).map((n) => n.getName()));
    for (const n of spec.nodes) expect(names, n).toContain(n);
  });

  it("is emissive only on light_* materials, never alpha BLEND", async () => {
    const { json } = await loadModel(spec.file);
    const mats = json.materials ?? [];
    for (const mat of mats) {
      const glows = (mat.emissiveFactor ?? [0, 0, 0]).some((c) => c > 0.05);
      expect(glows, mat.name).toBe((mat.name ?? "").startsWith("light_"));
      expect(mat.alphaMode ?? "OPAQUE", mat.name).not.toBe("BLEND");
    }
    for (const l of spec.lights ?? []) expect(mats.map((m) => m.name)).toContain(l);
  });

  it("has a real-world size and sits where it should", async () => {
    const { doc } = await loadModel(spec.file);
    const b = box(allPositions(doc));
    const h = spec.file.startsWith("water-blaster") ? b.size[1] : b.max[1];
    expect(h).toBeGreaterThanOrEqual(spec.height[0]);
    expect(h).toBeLessThanOrEqual(spec.height[1]);
    if (spec.grounded !== false) expect(Math.abs(b.min[1])).toBeLessThan(0.02);
  });
});

describe("hydrant and drinking fountain", () => {
  it.each([
    ["hydrant.glb", "hydrant", [0.3, 0.6]],
    ["drinking-fountain.glb", "fountain", [0.8, 1.05]],
  ] as const)("%s has a refill point at the front, at hose height", async (file, kind, [lo, hi]) => {
    const { doc } = await loadModel(file);
    const root = sceneNodes(doc)[0]!;
    expect(root.getExtras().refill).toBe(kind);
    const rp = node(doc, "refill_point");
    expect(rp.getExtras().refillPoint).toBe(true);
    const p = worldOrigin(rp);
    expect(p[1]).toBeGreaterThan(lo);
    expect(p[1]).toBeLessThan(hi);
    expect(p[2]).toBeLessThan(0); // the front
  });

  it("the hydrant is SF-style: a white barrel under a coloured bonnet, three outlets", async () => {
    const { doc } = await loadModel("hydrant.glb");
    expect(box(materialPositions(doc, "paint_bonnet_blue")).max[1]).toBeGreaterThan(0.7);
    const white = box(materialPositions(doc, "paint_white"));
    expect(white.size[0]).toBeGreaterThan(0.4); // the side outlets
    expect(white.min[2]).toBeLessThan(-0.2); // the pumper outlet at the front
  });
});

describe("traffic-cone", () => {
  it("is a throwable orange cone with white bands on a square base", async () => {
    const { doc } = await loadModel("traffic-cone.glb");
    expect(sceneNodes(doc)[0]!.getExtras().throwable).toBe(true);
    const mats = nodeMaterials(node(doc, "cone"));
    expect(mats).toContain("cone_orange");
    expect(mats).toContain("cone_band_white");
    const base = box(materialPositions(doc, "cone_base"));
    expect(base.size[0]).toBeGreaterThan(0.3);
    expect(base.size[0]).toBeLessThan(0.42);
  });
});

describe("repair-kiosk", () => {
  it("opens its service bay to the front (-Z) with the screen on the back wall", async () => {
    const { doc } = await loadModel("repair-kiosk.glb");
    const bay = node(doc, "bay");
    expect(bay.getExtras().bay).toBe(true);
    const screen = mean(materialPositions(doc, "light_kiosk_screen"));
    expect(screen[2]).toBeGreaterThan(0.3); // back wall at +Z
    expect(worldOrigin(bay)[2]).toBeLessThan(screen[2]);
    expect(sceneNodes(doc)[0]!.getExtras().interact).toBe("repair");
  });
});

describe("vendor-cart", () => {
  it("has a blank sign slot facing the customers (-Z) and resting wheels", async () => {
    const { doc } = await loadModel("vendor-cart.glb");
    const sign = node(doc, "sign_slot");
    expect(sign.getExtras().signSlot).toBe(true);
    expect(sign.getExtras().sizeM).toEqual([0.84, 0.34]);
    const cart = box(nodePositions(node(doc, "cart")));
    expect(box(nodePositions(sign)).min[2]).toBeLessThan(cart.center[2]);
    expect(cart.size[0]).toBeGreaterThan(1.6);
    expect(cart.size[0]).toBeLessThan(2.3);
    for (const w of ["wheel_L", "wheel_R"]) expect(node(doc, w).getExtras().radius).toBeGreaterThan(0.1);
  });
});

describe("wheelchair", () => {
  it("is flagged a mobility aid and no-touch, with the sit clip's seat height", async () => {
    const { doc } = await loadModel("wheelchair.glb");
    const ex = sceneNodes(doc)[0]!.getExtras();
    expect(ex.mobilityAid).toBe(true);
    expect(ex.noTouch).toBe(true);
    const vat = readJson<{ clips: { adult: Array<{ name: string; seatHeightM?: number }> } }>("public/models/humanoid-vat.json");
    const sit = vat.clips.adult.find((c) => c.name === "sit")!;
    expect(ex.seatHeightM).toBeCloseTo(sit.seatHeightM!, 2);
    const seat = box(materialPositions(doc, "seat_fabric").filter((p) => p[1] < 0.5 && p[2] < 0.2)); // not the back rest
    expect(Math.abs(seat.max[1] - (ex.seatHeightM as number))).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------- the blaster

const GUN_WORDS = /\b(gun|guns|rifle|pistol|revolver|barrel|trigger|magazine|mag|stock|buttstock|muzzle|ammo|ammunition|bullet|cartridge|scope|sight|holster|firearm|weapon|shoot|shooting|shot|sniper|grenade|chamber|clip|round|rounds)\b/i;

function srgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

describe("water-blaster", () => {
  it("uses no gun words in any node, mesh, material or extra", async () => {
    const { doc, json } = await loadModel("water-blaster.glb");
    const words: string[] = [];
    for (const n of sceneNodes(doc)) {
      words.push(n.getName(), n.getMesh()?.getName() ?? "");
      for (const [k, v] of Object.entries(n.getExtras())) words.push(k, typeof v === "string" ? v : "");
    }
    for (const m of json.materials ?? []) words.push(m.name ?? "");
    for (const w of words) expect(w.replace(/_/g, " "), w).not.toMatch(GUN_WORDS);
    expect(sceneNodes(doc)[0]!.getExtras().toy).toBe(true);
  });

  it("is a bright toy: nearly every surface a saturated, light colour", async () => {
    const { doc } = await loadModel("water-blaster.glb");
    let bright = 0;
    let total = 0;
    for (const n of sceneNodes(doc)) {
      for (const p of n.getMesh()?.listPrimitives() ?? []) {
        const tris = (p.getIndices()?.getCount() ?? 0) / 3;
        const [r, g, b] = p.getMaterial()!.getBaseColorFactor().slice(0, 3).map(srgb) as [number, number, number];
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        if (sat > 0.5 && mx > 0.5) bright += tris;
        total += tris;
      }
    }
    expect(bright / total).toBeGreaterThan(0.85);
  });

  it("is a sprayer wand, not a gun shape: nothing hangs under the grip or sticks out behind it", async () => {
    const { doc } = await loadModel("water-blaster.glb");
    const wand = node(doc, "wand");
    const grip = worldOrigin(wand);
    const pts = nodePositions(wand);
    const b = box(pts);
    expect(grip[1] - b.min[1]).toBeLessThan(0.06); // no pistol grip, no magazine
    expect(b.max[2] - grip[2]).toBeLessThan(0.1); // no stock behind the hand (the back is +Z)
    const nozzle = worldOrigin(node(doc, "nozzle"));
    expect(grip[2] - nozzle[2]).toBeGreaterThan(0.4); // a long wand forward (-Z)
    expect(node(doc, "nozzle").getExtras().sprayOrigin).toBe(true);
  });

  it("is laid out as worn: tank on the back, wand in the right hand, attach bones named", async () => {
    const { doc } = await loadModel("water-blaster.glb");
    const tank = node(doc, "tank");
    const wand = node(doc, "wand");
    expect(tank.getExtras().attachBone).toBe("chest");
    expect(wand.getExtras().attachBone).toBe("hand_R");
    const t = box(nodePositions(tank, "world", "toy_yellow")); // the canister (its straps wrap round the shoulders)
    expect(t.min[2]).toBeGreaterThan(0.05); // behind the player
    expect(t.center[1]).toBeGreaterThan(1.0);
    expect(worldOrigin(wand)[0]).toBeGreaterThan(0.1); // right hand is +X
    const level = node(doc, "water_level");
    expect(level.getExtras().levelAxis).toEqual([0, 1, 0]);
    expect(box(nodePositions(level, "local")).min[1]).toBeGreaterThanOrEqual(-1e-4); // origin at its bottom
  });
});

// --------------------------------------------------------------------------------- heaps

describe.each(["porter", "trundle", "mixed"])("heap-%s", (kind) => {
  it("is a rusty mound on a flat puddle, no glow", async () => {
    const { doc, json } = await loadModel(`heap-${kind}.glb`);
    expect(sceneNodes(doc)[0]!.getExtras().heap).toBe(kind);
    const pile = box(nodePositions(node(doc, "pile")));
    const puddle = box(nodePositions(node(doc, "puddle")));
    expect(puddle.size[1]).toBeLessThan(0.01);
    expect(puddle.max[1]).toBeLessThan(0.01);
    expect(puddle.size[0]).toBeGreaterThan(pile.size[0] * 0.7);
    expect(Math.abs(pile.center[0])).toBeLessThan(0.05);
    expect(Math.abs(pile.center[2])).toBeLessThan(0.05);
    const mats = (json.materials ?? []).map((m) => m.name ?? "");
    expect(mats.filter((m) => m.startsWith("rust_")).length).toBeGreaterThanOrEqual(2);
    expect(mats.some((m) => m.startsWith("light_"))).toBe(false);
  });
});

// ------------------------------------------------------------------------------- animals

describe.each([
  ["pigeon.glb", "peck", [0.25, 0.4]],
  ["dog.glb", "stride", [0.7, 1.05]],
] as const)("%s", (file, key, [lo, hi]) => {
  it("is flagged animal and no-touch, with a two-frame morph", async () => {
    const { doc } = await loadModel(file);
    const ex = sceneNodes(doc)[0]!.getExtras();
    expect(ex.animal).toBe(true);
    expect(ex.noTouch).toBe(true);
    const body = node(doc, "body").getMesh()!;
    expect(body.getExtras().targetNames).toEqual([key]);
    for (const p of body.listPrimitives()) expect(p.listTargets()).toHaveLength(1);
  });

  it("is animal-sized and faces -Z", async () => {
    const { doc } = await loadModel(file);
    const b = box(nodePositions(node(doc, "body")));
    expect(b.size[2]).toBeGreaterThan(lo);
    expect(b.size[2]).toBeLessThan(hi);
    // the head end: the highest point of the body is toward the front
    const pts = nodePositions(node(doc, "body"));
    const top = pts.reduce((a, p) => (p[1] > a[1] ? p : a));
    expect(top[2]).toBeLessThan(b.center[2]);
  });
});

describe("dog leash", () => {
  it("runs from the collar to a hand loop at a walker's hand height", async () => {
    const { doc } = await loadModel("dog.glb");
    const leash = node(doc, "leash");
    const ex = leash.getExtras() as { collar: V3; handle: V3 };
    expect(ex.collar[1]).toBeGreaterThan(0.4);
    expect(ex.handle[1]).toBeGreaterThan(0.8);
    expect(ex.handle[1]).toBeLessThan(1.1);
    const lb = box(nodePositions(leash));
    expect(lb.max[1]).toBeGreaterThanOrEqual(ex.handle[1] - 0.05);
    expect(sceneNodes(doc)[0]!.getExtras().leashed).toBe(true);
  });
});

describe("wheelchair orientation", () => {
  it("faces -Z: footplates and casters at the front, push handles behind", async () => {
    const { doc } = await loadModel("wheelchair.glb");
    const pts = nodePositions(node(doc, "chair"));
    const handles = pts.filter((p) => p[1] > 0.9);
    const feet = pts.filter((p) => p[1] < 0.12);
    expect(mean(handles)[2]).toBeGreaterThan(0.2);
    expect(mean(feet)[2]).toBeLessThan(-0.1);
  });
});
