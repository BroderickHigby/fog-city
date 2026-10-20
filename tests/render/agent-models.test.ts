// The agent models as the renderer packs them: the committed GLBs split at the joints it
// animates (assets/blender/README.md node contracts), every triangle accounted for, light
// channels kept, proxies within budget; and the procedural person at human size.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENT_MODEL_KEY, AGENT_RIGS, AgentLayer, fallbackProxy } from "../../src/render/agent-layer.ts";
import { DEFAULT_TIERS, instanceBudget, tierCapacity, TIER_FAR, TIER_MID, TIER_NEAR } from "../../src/render/agent-lod.ts";
import { extractParts, proxyOf, triangleCount, type PackedModel } from "../../src/render/agent-packing.ts";
import { channelRatio } from "../../src/render/lights.ts";
import type { ModelRegistry } from "../../src/render/model-registry.ts";
import { HIP, PERSON_HEIGHT_M, SHOULDER, personLook, newLook, personParts } from "../../src/render/person.ts";
import { AGENT_SPEC, MAX_AGENTS, type AgentState } from "../../src/sim/agents.ts";
import type { SimState } from "../../src/sim/contract.ts";
import { ROOT } from "../helpers.ts";

async function load(file: string): Promise<THREE.Object3D> {
  const buf = readFileSync(join(ROOT, "public/models", file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const gltf = await new Promise<{ scene: THREE.Object3D }>((res, rej) => new GLTFLoader().parse(ab, "", res, rej));
  return gltf.scene;
}

function modelTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) n += triangleCount(m.geometry);
  });
  return n;
}

function channels(g: THREE.BufferGeometry | null): Set<number> {
  const out = new Set<number>();
  if (!g) return out;
  const a = g.getAttribute("fcEmit");
  for (let i = 0; i < a.count; i++) out.add(Math.round(a.getW(i)));
  return out;
}

const part = (m: PackedModel, name: string) => m.parts.find((p) => p.name === name)!;

describe("agent models, packed", () => {
  const scenes: Record<string, THREE.Object3D> = {};
  const packed: Record<string, PackedModel> = {};
  beforeAll(async () => {
    for (const [kind, file] of [
      ["robotaxi", "robotaxi.glb"],
      ["errandRobot", "errand-robot.glb"],
      ["sidewalkBot", "sidewalk-bot.glb"],
    ] as const) {
      scenes[kind] = await load(file);
      packed[kind] = extractParts(scenes[kind]!, AGENT_RIGS[kind]);
    }
  });

  it("keeps every triangle of every model, split into its rig's parts", () => {
    for (const kind of ["robotaxi", "errandRobot", "sidewalkBot"] as const) {
      const m = packed[kind]!;
      expect(m.parts.map((p) => p.name), kind).toEqual(AGENT_RIGS[kind].map((s) => s.name));
      for (const p of m.parts) expect(p.geometry, `${kind}.${p.name}`).not.toBeNull();
      expect(m.parts.reduce((s, p) => s + triangleCount(p.geometry), 0), kind).toBe(modelTriangles(scenes[kind]!));
    }
  });

  it("pivots wheels at their hubs and turns the rear axle as one", () => {
    const m = packed.robotaxi!;
    expect(part(m, "wheelFL").pivot.toArray().map((v) => +v.toFixed(2))).toEqual([-0.81, 0.38, -1.45]);
    expect(part(m, "wheelFR").pivot.toArray().map((v) => +v.toFixed(2))).toEqual([0.81, 0.38, -1.45]);
    expect(part(m, "axleRear").pivot.toArray().map((v) => +v.toFixed(2))).toEqual([0, 0.38, 1.45]);
    expect(part(m, "wheelFL").channel.type).toBe("steer-spin");
    expect(part(m, "dome").channel.type).toBe("dome");
    expect(m.wheelRadius).toBe(0.375);
    expect(m.wheelbase).toBeCloseTo(2.9, 6);
    // A wheel's geometry is centred on its pivot (spins in place).
    const bb = new THREE.Box3().setFromBufferAttribute(part(m, "wheelFL").geometry!.getAttribute("position") as THREE.BufferAttribute);
    expect(Math.abs((bb.min.y + bb.max.y) / 2)).toBeLessThan(0.01);
    expect(Math.abs((bb.min.z + bb.max.z) / 2)).toBeLessThan(0.01);
  });

  it("keeps the lights as packed channels: head, tail and status on the robotaxi body", () => {
    expect([...channels(part(packed.robotaxi!, "body").geometry)].sort()).toEqual([0, 1, 2, 3]);
    expect(channels(part(packed.robotaxi!, "wheelFL").geometry)).toEqual(new Set([0]));
    expect(channels(part(packed.errandRobot!, "body").geometry).has(3)).toBe(true); // light_face
    expect(channels(part(packed.sidewalkBot!, "body").geometry).has(3)).toBe(true); // light_eyes
  });

  it("keeps each light material's own night level on its shared channel (emissive pre-scaled)", () => {
    // light_face shares the status channel with light_status, so its emissive carries their ratio.
    const face = new THREE.MeshStandardMaterial({ name: "light_face", emissive: 0xffffff });
    const packedFace = extractParts(
      Object.assign(new THREE.Group(), { name: "root" }).add(new THREE.Mesh(new THREE.BoxGeometry(), face)),
      [{ name: "body", nodes: [], pivot: "root", channel: { type: "none" } }],
    );
    const e = packedFace.parts[0]!.geometry!.getAttribute("fcEmit");
    expect(e.getX(0)).toBeCloseTo(channelRatio("light_face"), 6);
    expect(e.getW(0)).toBe(3);
  });

  it("swings errand-robot limbs from their joints, with the groceries riding the right arm", () => {
    const m = packed.errandRobot!;
    const contents = part(m, "bagContents");
    expect(contents.bagContents).toBe(true);
    expect(contents.pivot.equals(part(m, "armR").pivot)).toBe(true);
    expect(part(m, "legL").pivot.y).toBeCloseTo(0.86, 2); // hip joint
    expect(part(m, "armL").pivot.y).toBeCloseTo(1.37, 2); // shoulder joint
    expect((part(m, "legL").channel as { gain: number }).gain).toBe(-(part(m, "legR").channel as { gain: number }).gain);
  });

  it("gives the sidewalk bot three rolling axles and a swaying flag", () => {
    const m = packed.sidewalkBot!;
    expect(m.parts.filter((p) => p.channel.type === "spin").map((p) => p.name)).toEqual(["axle1", "axle2", "axle3"]);
    expect(part(m, "flag").channel.type).toBe("sway");
    expect(m.wheelRadius).toBe(0.095);
  });

  it("simplifies far copies within budget, lights kept", () => {
    const budget = { robotaxi: [1200, 200], errandRobot: [450, 160], sidewalkBot: [200, 100] } as const;
    for (const kind of ["robotaxi", "errandRobot", "sidewalkBot"] as const) {
      const cell = { robotaxi: 0.2, errandRobot: 0.16, sidewalkBot: 0.12 }[kind];
      const mid = proxyOf(packed[kind]!, cell);
      expect(triangleCount(mid), `${kind} mid`).toBeLessThan(budget[kind][0]);
      expect(triangleCount(mid), `${kind} mid`).toBeGreaterThan(20);
      const far = fallbackProxy(kind);
      expect(triangleCount(far), `${kind} far`).toBeLessThan(budget[kind][1]);
    }
    expect(channels(proxyOf(packed.robotaxi!, 0.2))).toEqual(new Set([0, 1, 2, 3]));
    expect(channels(fallbackProxy("robotaxi"))).toEqual(new Set([0, 1, 2, 3]));
  });
});

describe("the procedural person", () => {
  const p = personParts();
  const box = (g: THREE.BufferGeometry) => new THREE.Box3().setFromBufferAttribute(g.getAttribute("position") as THREE.BufferAttribute);

  it("is about 1.75 m tall, with feet on the ground and a body inside the sim's", () => {
    const body = box(p.body);
    expect(body.max.y).toBeGreaterThan(PERSON_HEIGHT_M - 0.05);
    expect(body.max.y).toBeLessThan(PERSON_HEIGHT_M + 0.05);
    const leg = box(p.leg);
    expect(HIP[1] + leg.min.y).toBeCloseTo(0, 1);
    expect(Math.abs(HIP[1] + leg.min.y)).toBeLessThan(0.01);
    const arm = box(p.arm);
    expect(SHOULDER[1] + arm.min.y).toBeGreaterThan(0.7); // hands at the thighs
    const width = 2 * Math.max(-body.min.x, body.max.x);
    expect(width).toBeLessThanOrEqual(AGENT_SPEC.person.halfWidth * 2);
    for (const g of [p.mid, p.far]) {
      const b = box(g);
      expect(b.min.y).toBeCloseTo(0, 1);
      expect(b.max.y).toBeGreaterThan(PERSON_HEIGHT_M - 0.06);
    }
  });

  it("is cheap: near ~1000 triangles in five instanced parts, far proxies a fraction of that", () => {
    const near = triangleCount(p.body) + 2 * triangleCount(p.arm) + 2 * triangleCount(p.leg);
    expect(near).toBeLessThan(1200);
    expect(triangleCount(p.mid)).toBeLessThan(400);
    expect(triangleCount(p.far)).toBeLessThan(100);
  });

  it("dresses each person from slots, the same way every time for an id", () => {
    for (const g of [p.body, p.arm, p.leg, p.mid, p.far]) expect(g.getAttribute("fcSlot").itemSize).toBe(4);
    const a = personLook(42, newLook());
    const b = personLook(42, newLook());
    expect(a.shirt.equals(b.shirt) && a.pants.equals(b.pants) && a.skin.equals(b.skin) && a.scale === b.scale).toBe(true);
    const looks = new Set<string>();
    for (let id = 0; id < 50; id++) looks.add(personLook(id, newLook()).shirt.getHexString());
    expect(looks.size).toBeGreaterThan(8);
    for (let id = 0; id < 200; id++) {
      const s = personLook(id, newLook()).scale;
      expect(s).toBeGreaterThanOrEqual(0.93);
      expect(s).toBeLessThanOrEqual(1.07);
    }
  });
});

describe("AgentLayer instance capacities", () => {
  const files = { robotaxi: "robotaxi.glb", robot: "errand-robot.glb", "sidewalk-bot": "sidewalk-bot.glb" } as const;
  const models: Record<string, THREE.Object3D> = {};
  beforeAll(async () => {
    for (const [key, file] of Object.entries(files)) models[key] = await load(file);
  });
  const registry = {
    get: async (key: string) => ({ source: "file" as const, model: models[key]! }),
  } as unknown as ModelRegistry<THREE.Object3D>;

  function robotaxis(n: number): SimState {
    const list = Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: "robotaxi", x: (i % 5) * 3 - 6, y: 0, z: -8 - 2 * i, heading: 0, pitch: 0, speed: 10, mode: "go" }));
    return { tick: 1, ext: { agents: { nextId: n + 1, list: list as unknown as AgentState[] } } } as unknown as SimState;
  }

  it("allocates every part mesh from tierCapacity() and instanceBudget(), and draws no more than that", async () => {
    for (const nearCap of [DEFAULT_TIERS.nearCap, 5]) {
      const layer = new AgentLayer(registry, { nearCap });
      await new Promise((r) => setTimeout(r, 0)); // the models install
      const caps = layer.capacities();
      const near = instanceBudget(tierCapacity(TIER_NEAR, { nearCap }, MAX_AGENTS), 1);
      let nearParts = 0;
      for (const [name, cap] of Object.entries(caps)) {
        if (name.endsWith(":far")) expect(cap, name).toBe(instanceBudget(tierCapacity(TIER_FAR, { nearCap }, MAX_AGENTS), 1));
        else if (name.endsWith(":mid")) expect(cap, name).toBe(instanceBudget(tierCapacity(TIER_MID, { nearCap }, MAX_AGENTS), 1));
        else if (/:people:(arms|legs)$/.test(name)) expect(cap, name).toBe(instanceBudget(near, 2));
        else {
          expect(cap, name).toBe(near);
          nearParts++;
        }
      }
      // Every rig part of every kind, plus the person's body.
      const rigParts = Object.keys(AGENT_MODEL_KEY).reduce((n, k) => n + AGENT_RIGS[k as keyof typeof AGENT_RIGS].length, 0);
      expect(nearParts).toBe(rigParts + 1);

      // 40 robotaxis within 60 m in front of the camera: nearCap get the full model, the rest the mid copy.
      const s = robotaxis(40);
      layer.update(s, s, 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
      expect(layer.info().drawn).toBe(40);
      expect(layer.info().near).toBe(nearCap);
      const counts: Record<string, number> = {};
      layer.group.traverse((o) => {
        const m = o as THREE.InstancedMesh;
        if (m.isInstancedMesh) counts[m.name] = m.count;
      });
      expect(counts["agents:robotaxi:body"]).toBe(nearCap);
      expect(counts["agents:robotaxi:mid"]).toBe(40 - nearCap);
      layer.dispose();
    }
  });
});
