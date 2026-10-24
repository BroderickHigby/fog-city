// The skinned pedestrian crowd (src/render/crowd-humans.ts): the Rocketbox crowd files load, each
// person keeps one character, at most CROWD_NEAR_MAX are drawn, and unseen bodies are disposed.
import { existsSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { validateBytes } from "gltf-validator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CROWD_FILES, CROWD_FORGET_S, CROWD_NEAR_MAX, CrowdHumans, characterFor } from "../../src/render/crowd-humans.ts";
import { AGENT_DRAW_CALL_BUDGET, AgentLayer } from "../../src/render/agent-layer.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { AgentState } from "../../src/sim/agents.ts";
import type { SimState } from "../../src/sim/contract.ts";

const bytes = async (path: string): Promise<Uint8Array> => new Uint8Array(readFileSync(new URL(`../../public/${path}`, import.meta.url)));
/** Independent of the renderer's cached cost: count the GLB's authored primitives/indices. */
function fileCost(file: string): { drawCalls: number; triangles: number } {
  const buffer = readFileSync(new URL(`../../public/${file}`, import.meta.url));
  const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString()) as {
    meshes: { primitives: { indices: number }[] }[]; accessors: { count: number }[];
  };
  const primitives = json.meshes.flatMap(mesh => mesh.primitives);
  return { drawCalls: primitives.length, triangles: primitives.reduce((sum, p) => sum + json.accessors[p.indices]!.count / 3, 0) };
}

/** These assets use one opaque material per mesh; instanced rigs multiply its triangles. */
function visibleCost(group: THREE.Object3D): { drawCalls: number; triangles: number } {
  const result = { drawCalls: 0, triangles: 0 };
  group.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    if (instances === 0) return;
    result.drawCalls++;
    result.triangles += instances * (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count) / 3;
  });
  return result;
}
beforeEach(() => {
  vi.stubGlobal("self", globalThis);
  vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
    const texture = new THREE.Texture<HTMLImageElement>();
    queueMicrotask(() => loaded?.(texture));
    return texture;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("crowd characters", () => {
  it("ships every crowd file, each well under the static build's 15 MB per-file budget", () => {
    let total = 0;
    for (const f of CROWD_FILES) {
      const url = new URL(`../../public/${f}`, import.meta.url);
      expect(existsSync(url), f).toBe(true);
      const n = readFileSync(url).byteLength;
      expect(n).toBeLessThan(4_000_000);
      total += n;
    }
    expect(total).toBeLessThan(30_000_000);
  });

  it.each(CROWD_FILES)("%s is valid glTF 2.0 with no errors or warnings", async (f) => {
    const report = await validateBytes(await bytes(f), { maxIssues: 50 });
    expect(report.issues.numErrors).toBe(0);
    expect(report.issues.numWarnings).toBe(0);
  });

  it("gives each person one stable character, spread over the whole crowd", () => {
    const counts = new Array(CROWD_FILES.length).fill(0);
    for (let id = 1; id <= 1200; id++) {
      const c = characterFor(id);
      expect(characterFor(id)).toBe(c);
      counts[c]++;
    }
    for (const n of counts) expect(n).toBeGreaterThan(60);
  });
});

describe("CrowdHumans", () => {
  it("draws the nearest people as skinned bodies, at most CROWD_NEAR_MAX, and forgets unseen ones", async () => {
    const crowd = new CrowdHumans(bytes, false);
    await vi.waitFor(() => expect(crowd.loaded).toBe(CROWD_FILES.length), { timeout: 20_000 });
    crowd.begin(1 / 60);
    let accepted = 0;
    for (let id = 1; id <= CROWD_NEAR_MAX + 6; id++) if (crowd.add(id, id, 0, 0, 0, id % 3 ? 1.3 : 0, 1 / 60)) accepted++;
    crowd.end();
    expect(accepted).toBe(CROWD_NEAR_MAX);
    expect(crowd.drawn).toBe(CROWD_NEAR_MAX);
    const expected = Array.from({ length: CROWD_NEAR_MAX }, (_, i) => fileCost(CROWD_FILES[characterFor(i + 1)]!))
      .reduce((sum, cost) => ({ drawCalls: sum.drawCalls + cost.drawCalls, triangles: sum.triangles + cost.triangles }), { drawCalls: 0, triangles: 0 });
    expect({ drawCalls: crowd.drawCalls, triangles: crowd.triangles }).toEqual(expected);
    expect(visibleCost(crowd.group)).toEqual(expected);
    // A frame's remaining allocation can accept one body without accepting the next one.
    crowd.begin(1 / 60, fileCost(CROWD_FILES[characterFor(1)]!).drawCalls);
    expect(crowd.add(1, 0, 0, 0, 0, 0, 1 / 60)).toBe(true);
    expect(crowd.add(2, 0, 0, 0, 0, 0, 1 / 60)).toBe(false);
    crowd.end();
    expect(crowd.drawn).toBe(1);
    expect(visibleCost(crowd.group)).toEqual({ drawCalls: crowd.drawCalls, triangles: crowd.triangles });
    const bodies = (): number => { let n = 0; crowd.group.traverse((o) => { if (o.name.startsWith("player-body:")) n++; }); return n; };
    expect(bodies()).toBe(CROWD_NEAR_MAX);
    let skinned = 0;
    crowd.group.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.parent?.visible !== false) skinned++; });
    expect(skinned).toBeGreaterThan(0);
    // Nobody seen for longer than CROWD_FORGET_S: every body is disposed.
    for (let t = 0; t < CROWD_FORGET_S + 2; t++) { crowd.begin(1); crowd.end(); }
    expect(bodies()).toBe(0);
    crowd.dispose();
  }, 60_000);

  it("draws nobody until a character has loaded, so the caller keeps the procedural person", () => {
    const crowd = new CrowdHumans(() => new Promise(() => {}), false);
    crowd.begin(1 / 60);
    expect(crowd.add(1, 0, 0, 0, 0, 0, 1 / 60)).toBe(false);
    crowd.end();
    crowd.dispose();
  });

  it("counts real crowd primitives inside the 27-call agent allocation and falls back for overflow", async () => {
    const crowd = new CrowdHumans(bytes, false);
    const registry = new ModelRegistry<THREE.Object3D>({
      load: async path => new GLTFLoader().parseAsync((await bytes(path)).slice().buffer as ArrayBuffer, "").then(gltf => gltf.scene),
      fallback: () => new THREE.Group(), clone: model => model.clone(),
    });
    const layer = new AgentLayer(registry);
    try {
      await vi.waitFor(() => expect(crowd.loaded).toBe(CROWD_FILES.length), { timeout: 20_000 });
      await Promise.all([registry.get("robotaxi"), registry.get("robot"), registry.get("sidewalk-bot")]);
      layer.setCrowd(crowd);
      // IDs run farthest first: admission must pick the nearest people, not the first ids.
      const people = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, kind: "person", x: 0, y: 0, z: -(17 - i), heading: 0, pitch: 0, speed: 0, mode: "go" }));
      const state = (list: unknown[]): SimState => ({ tick: 1, players: {}, ext: { agents: { nextId: 100, list: list as AgentState[] } } }) as SimState;
      const draw = (list: unknown[]): void => { const s = state(list); layer.update(s, s, 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0); };
      draw(people);
      const chosen: number[] = [];
      let calls = 0;
      for (const person of [...people].reverse()) {
        const cost = fileCost(CROWD_FILES[characterFor(person.id)]!).drawCalls;
        if (calls + cost > AGENT_DRAW_CALL_BUDGET - 3) continue;
        chosen.push(person.id); calls += cost;
      }
      const visible: number[] = [];
      crowd.group.traverseVisible(object => { if (object.name.startsWith("player-body:")) visible.push(Number(object.name.slice(12))); });
      expect(visible.sort((a, b) => a - b)).toEqual(chosen.sort((a, b) => a - b));
      expect(chosen.length).toBeGreaterThan(0);
      expect(chosen.length).toBeLessThan(16);
      const fallback = layer.group.getObjectByName("agents:people:body") as THREE.InstancedMesh;
      expect(fallback.count).toBe(16 - chosen.length);
      const assertMetrics = (): void => {
        const old = visibleCost(layer.group), real = visibleCost(crowd.group), stats = layer.info();
        expect(stats.drawCalls).toBe(old.drawCalls + real.drawCalls);
        expect(stats.triangles).toBe(old.triangles + real.triangles);
        expect(stats.drawCalls).toBeLessThanOrEqual(AGENT_DRAW_CALL_BUDGET);
      };
      assertMetrics();
      const peopleOnly = { ...layer.info(), crowd: crowd.drawn, crowdCalls: crowd.drawCalls };
      // Occupy every rigid kind's near/mid/far tiers as well as both person proxy tiers.
      const robots = ["robotaxi", "errandRobot", "sidewalkBot"].flatMap((kind, i) => [1, 90, 220].map((distance, j) => ({ id: 30 + i * 3 + j, kind, x: i, y: 0, z: -distance, heading: 0, pitch: 0, speed: 0, mode: "go" })));
      draw([...people, ...robots, { ...people[0], id: 99, z: -200 }]);
      assertMetrics();
      expect(layer.info().drawn).toBe(26);
      expect(fallback.count).toBeGreaterThan(0);
      console.info("crowd budget proof", JSON.stringify({ peopleOnly, mixed: { ...layer.info(), crowd: crowd.drawn, crowdCalls: crowd.drawCalls } }));
    } finally {
      crowd.dispose();
      layer.dispose();
    }
  }, 60_000);
});
