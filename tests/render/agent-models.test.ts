// The agent models as the renderer packs them: the committed GLBs split at the joints it
// animates (assets/blender/README.md node contracts), every triangle accounted for, light
// channels kept, proxies within budget; and the procedural person at human size.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENT_MODEL_KEY, AGENT_RIGS, AgentLayer, PROXY_CELL, bagFull, fallbackProxy } from "../../src/render/agent-layer.ts";
import { agentModelScale, DEFAULT_TIERS, instanceBudget, tierCapacity, TIER_FAR, TIER_MID, TIER_NEAR } from "../../src/render/agent-lod.ts";
import { extractParts, proxyOf, triangleCount, type PackedModel } from "../../src/render/agent-packing.ts";
import { channelRatio } from "../../src/render/lights.ts";
import type { ModelRegistry } from "../../src/render/model-registry.ts";
import { HIP, PERSON_HEIGHT_M, SHOULDER, personLook, newLook, personParts } from "../../src/render/person.ts";
import { AGENT_SPEC, LOD_STRIDE, MAX_AGENTS, type AgentState } from "../../src/sim/agents.ts";
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
const boundsOf = (g: THREE.BufferGeometry) => new THREE.Box3().setFromBufferAttribute(g.getAttribute("position") as THREE.BufferAttribute);
const KINDS = ["robotaxi", "errandRobot", "sidewalkBot"] as const;
const CELL = PROXY_CELL;

/** Every node name in a loaded model. */
function nodeNames(root: THREE.Object3D): Set<string> {
  const out = new Set<string>();
  root.traverse((o) => {
    if (o.name) out.add(o.name);
  });
  return out;
}

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

  it("names in its rigs only nodes the committed models have (wave 2: no sensor_dome, flag or third axle)", () => {
    for (const kind of KINDS) {
      const names = nodeNames(scenes[kind]!);
      for (const spec of AGENT_RIGS[kind]) for (const n of spec.nodes) expect(names.has(n), `${kind}.${spec.name}: node ${n}`).toBe(true);
    }
    // And every animated node of the asset contract is claimed by a part (assets/blender/README.md).
    const claimed = (kind: (typeof KINDS)[number]) => new Set(AGENT_RIGS[kind].flatMap((s) => s.nodes));
    for (const n of ["wheel_FL", "wheel_FR", "wheel_RL", "wheel_RR", "door_slide_R"]) expect(claimed("robotaxi").has(n), `robotaxi ${n}`).toBe(true);
    for (const n of ["wheel_L1", "wheel_L2", "wheel_R1", "wheel_R2"]) expect(claimed("sidewalkBot").has(n), `sidewalkBot ${n}`).toBe(true);
    for (const n of ["arm_upper_L", "arm_upper_R", "leg_upper_L", "leg_upper_R", "bag_contents"]) expect(claimed("errandRobot").has(n), `errandRobot ${n}`).toBe(true);
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
    expect(part(m, "wheelFL").pivot.toArray().map((v) => +v.toFixed(2))).toEqual([-0.81, 0.36, -1.52]);
    expect(part(m, "wheelFR").pivot.toArray().map((v) => +v.toFixed(2))).toEqual([0.81, 0.36, -1.52]);
    expect(part(m, "axleRear").pivot.toArray().map((v) => +v.toFixed(2))).toEqual([0, 0.36, 1.52]);
    expect(part(m, "wheelFL").channel.type).toBe("steer-spin");
    expect(m.wheelRadius).toBe(0.36);
    expect(m.wheelbase).toBeCloseTo(3.05, 2);
    // A wheel's geometry is centred on its pivot (spins in place).
    const bb = new THREE.Box3().setFromBufferAttribute(part(m, "wheelFL").geometry!.getAttribute("position") as THREE.BufferAttribute);
    expect(Math.abs((bb.min.y + bb.max.y) / 2)).toBeLessThan(0.01);
    expect(Math.abs((bb.min.z + bb.max.z) / 2)).toBeLessThan(0.01);
  });

  it("gives the Meander its kerb-side sliding door as its own part, on the right and drawn shut", () => {
    const m = packed.robotaxi!;
    const door = part(m, "doorR");
    expect(door.channel.type).toBe("slide");
    const bb = boundsOf(door.geometry!).translate(door.pivot);
    expect(bb.min.x, "on the kerb side (+x)").toBeGreaterThan(0.6);
    expect(bb.max.x).toBeLessThanOrEqual(m.bounds.max.x + 1e-6);
    // Shut: it lies inside the car's length, between the axles.
    expect(bb.min.z).toBeGreaterThan(part(m, "wheelFL").pivot.z);
    expect(bb.max.z).toBeLessThan(part(m, "axleRear").pivot.z);
    // No part sits above the roof band: the wave-1 dome is gone.
    for (const p of m.parts) expect(boundsOf(p.geometry!).translate(p.pivot).max.y, p.name).toBeLessThan(1.54);
  });

  it("keeps packed light channels on their owning rig parts", () => {
    expect([...channels(part(packed.robotaxi!, "body").geometry)].sort()).toEqual([0, 1, 2, 3]);
    expect(channels(part(packed.robotaxi!, "wheelFL").geometry)).toEqual(new Set([0]));
    expect(channels(part(packed.robotaxi!, "doorR").geometry)).toEqual(new Set([0]));
    // The face follows the independent tell-driven head joint; the torso does not glow.
    expect(channels(part(packed.errandRobot!, "head").geometry).has(3)).toBe(true); // light_face
    expect(channels(part(packed.errandRobot!, "body").geometry).has(3)).toBe(false);
    expect(channels(part(packed.sidewalkBot!, "body").geometry).has(3)).toBe(true); // light_face (wave 1: light_eyes)
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
    expect(part(m, "legL").pivot.y).toBeCloseTo(0.91, 2); // hip joint
    expect(part(m, "armL").pivot.y).toBeCloseTo(1.43, 2); // shoulder joint (README: 1.43 m)
    expect((part(m, "legL").channel as { gain: number }).gain).toBe(-(part(m, "legR").channel as { gain: number }).gain);
  });

  it("gives the Trundle (sidewalk bot) two rolling axles, front and rear, and nothing above its lid", () => {
    const m = packed.sidewalkBot!;
    expect(m.parts.map((p) => p.name)).toEqual(["body", "axle1", "axle2"]);
    expect(m.parts.filter((p) => p.channel.type === "spin").map((p) => p.name)).toEqual(["axle1", "axle2"]);
    expect(part(m, "axle1").pivot.z).toBeLessThan(0); // 1 = front (-z)
    expect(part(m, "axle2").pivot.z).toBeGreaterThan(0);
    expect(m.wheelRadius).toBe(0.085);
    expect(m.wheelbase).toBeCloseTo(0.48, 2);
    // The wave-1 flag mast rose to 1.4 m; the Trundle is 0.56 m with its lid and cargo inside.
    expect(m.bounds.max.y).toBeLessThan(0.57);
  });

  it("simplifies far copies within budget, lights kept", () => {
    const budget = { robotaxi: [1200, 200], errandRobot: [450, 160], sidewalkBot: [200, 100] } as const;
    for (const kind of ["robotaxi", "errandRobot", "sidewalkBot"] as const) {
      const mid = proxyOf(packed[kind]!, CELL[kind]);
      expect(triangleCount(mid), `${kind} mid`).toBeLessThan(budget[kind][0]);
      expect(triangleCount(mid), `${kind} mid`).toBeGreaterThan(20);
      const far = fallbackProxy(kind);
      expect(triangleCount(far), `${kind} far`).toBeLessThan(budget[kind][1]);
    }
    expect(channels(proxyOf(packed.robotaxi!, 0.2))).toEqual(new Set([0, 1, 2, 3]));
    expect(channels(fallbackProxy("robotaxi"))).toEqual(new Set([0, 1, 2, 3]));
  });

  it("builds every box proxy lengthwise on z at AGENT_SPEC size, the model's footprint within 15%", () => {
    for (const kind of KINDS) {
      const far = boundsOf(fallbackProxy(kind));
      const m = packed[kind]!;
      const body = m.bodyBounds.isEmpty() ? m.bounds : m.bodyBounds;
      const size = { length: body.max.z - body.min.z, width: body.max.x - body.min.x };
      // The proxy is drawn at the model's scale (its stand-in before the model loads, at scale 1).
      const scale = agentModelScale(kind, size);
      const L = (far.max.z - far.min.z) * scale;
      const W = (far.max.x - far.min.x) * scale;
      const spec = AGENT_SPEC[kind];
      if (spec.road) {
        // A road vehicle is the spec body: 2 * halfWidth across, 2 * halfLength long.
        expect(W / (spec.halfWidth * 2), `${kind} width`).toBeGreaterThan(0.85);
        expect(W / (spec.halfWidth * 2), `${kind} width`).toBeLessThan(1.15);
        expect(L / (spec.halfLength * 2), `${kind} length`).toBeGreaterThan(0.85);
        expect(L / (spec.halfLength * 2), `${kind} length`).toBeLessThan(1.15);
        expect(L, `${kind} is longer than wide`).toBeGreaterThan(1.8 * W);
      } else {
        // A walker keeps its designed size up to 1.2x the spec body (agentModelScale's rule,
        // measured on the model's body).
        expect(W, `${kind} width`).toBeLessThanOrEqual(spec.halfWidth * 2 * 1.2);
        expect(size.width * scale, `${kind} body width`).toBeLessThanOrEqual(spec.halfWidth * 2 * 1.2 + 1e-9);
        expect(size.length * scale, `${kind} body length`).toBeLessThanOrEqual(spec.halfLength * 2 * 1.2 + 1e-9);
      }
      // Either way the proxy stands in for the model: same footprint within 15%.
      expect((far.max.x - far.min.x) / (m.bounds.max.x - m.bounds.min.x), `${kind} width vs model`).toBeGreaterThan(0.85);
      expect((far.max.x - far.min.x) / (m.bounds.max.x - m.bounds.min.x), `${kind} width vs model`).toBeLessThan(1.15);
      expect((far.max.z - far.min.z) / (m.bounds.max.z - m.bounds.min.z), `${kind} length vs model`).toBeGreaterThan(0.85);
      expect((far.max.z - far.min.z) / (m.bounds.max.z - m.bounds.min.z), `${kind} length vs model`).toBeLessThan(1.15);
      // Same height within 10%: no wave-1 dome or flag mast on the proxy, no missing lantern head.
      expect((far.max.y - far.min.y) / (m.bounds.max.y - m.bounds.min.y), `${kind} height vs model`).toBeGreaterThan(0.9);
      expect((far.max.y - far.min.y) / (m.bounds.max.y - m.bounds.min.y), `${kind} height vs model`).toBeLessThan(1.1);
    }
  });

  it("stands every mid and far proxy on the ground, like the model (within 1 cm)", () => {
    for (const kind of KINDS) {
      const m = packed[kind]!;
      expect(Math.abs(m.bounds.min.y), `${kind} model`).toBeLessThan(0.01);
      expect(Math.abs(boundsOf(proxyOf(m, CELL[kind])).min.y), `${kind} mid`).toBeLessThan(0.01);
      expect(Math.abs(boundsOf(fallbackProxy(kind)).min.y), `${kind} far`).toBeLessThan(0.01);
    }
    expect(Math.abs(boundsOf(personParts().far).min.y), "person far").toBeLessThan(0.01);
    expect(Math.abs(boundsOf(personParts().mid).min.y), "person mid").toBeLessThan(0.01);
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

  function errandRobot(): SimState {
    const list = [{ id: 1, kind: "errandRobot", x: 0, y: 0, z: -6, heading: 0, pitch: 0, speed: 1.7, mode: "go" }];
    return { tick: 1, players: {}, ext: { agents: { nextId: 2, list: list as unknown as AgentState[] } } } as unknown as SimState;
  }

  function robotaxis(n: number): SimState {
    const list = Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: "robotaxi", x: (i % 5) * 3 - 6, y: 0, z: -8 - 2 * i, heading: 0, pitch: 0, speed: 10, mode: "go" }));
    return { tick: 1, players: {}, ext: { agents: { nextId: n + 1, list: list as unknown as AgentState[] } } } as unknown as SimState;
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
        else if (name.endsWith(":people:dodge-shadow")) expect(cap, name).toBe(near); // one per person drawn near
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

  it("draws an agent over 200 m from every player gliding across the sim's 4-tick steps", async () => {
    const layer = new AgentLayer(registry);
    await new Promise((r) => setTimeout(r, 0));
    const id = 3;
    // The sim's far rule: it moves 4 m on ticks where (tick + id) % LOD_STRIDE === 0, else holds.
    const state = (tick: number): SimState => {
      const x = 300 + Math.floor((tick + id) / LOD_STRIDE) * 4;
      const list = [{ id, kind: "robotaxi", x, y: 0, z: 0, heading: Math.PI / 2, pitch: 0, speed: 12, mode: "go" }];
      const players = { p1: { mode: "vehicle", car: { x: 0, z: 0 } } };
      return { tick, players, ext: { agents: { nextId: id + 1, list: list as unknown as AgentState[] } } } as unknown as SimState;
    };
    const xs: number[] = [];
    const body = layer.group.getObjectByName("agents:robotaxi:body") as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let tick = 1; tick <= 24; tick++) {
      const prev = state(tick - 1);
      const curr = state(tick);
      for (const alpha of [0, 0.5]) {
        layer.update(prev, curr, alpha, { x: 290, z: 0, fx: 1, fz: 0 }, 1 / 120, tick / 60);
        body.getMatrixAt(0, m);
        xs.push(p.setFromMatrixPosition(m).x);
      }
    }
    expect(layer.info().near).toBe(1);
    const d = xs.slice(10).map((x, i, a) => (i === 0 ? 0.5 : x - a[i - 1]!));
    for (const step of d) expect(step).toBeCloseTo(0.5, 6); // 4 m per 4 ticks, every half tick
    layer.dispose();
  });

  it("draws an errand robot's bag contents when the bag is full (the default), skips them when setBags(false)", async () => {
    const layer = new AgentLayer(registry);
    await new Promise((r) => setTimeout(r, 0));
    const s = errandRobot();
    const count = (name: string): number => (layer.group.getObjectByName(name) as THREE.InstancedMesh).count;
    const draw = (): void => layer.update(s, s, 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
    draw();
    expect(layer.info().near).toBe(1);
    expect(count("agents:errandRobot:body")).toBe(1);
    expect(count("agents:errandRobot:bagContents")).toBe(1);
    layer.setBags(false);
    draw();
    expect(count("agents:errandRobot:body")).toBe(1);
    expect(count("agents:errandRobot:bagContents")).toBe(0);
    layer.setBags(null);
    draw();
    expect(count("agents:errandRobot:bagContents")).toBe(1);
    const robot = (s.ext as { agents: { list: AgentState[] } }).agents.list[0]!;
    expect(bagFull(robot)).toBe(true);
    expect(bagFull(robot, false)).toBe(false);
    const emptyTell = { ...robot, tell: "emptyBag" } as unknown as AgentState;
    expect(bagFull(emptyTell)).toBe(false);
    expect(bagFull(emptyTell, true)).toBe(true);
    layer.dispose();
  });
});
