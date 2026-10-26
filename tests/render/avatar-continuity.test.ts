// A loaded nearby person's authored avatar must survive the road crowd changing around it.
// Exercise the same AgentLayer.update allocation seam as the game, using the actual GLBs.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_DRAW_CALL_BUDGET, AgentLayer } from "../../src/render/agent-layer.ts";
import { CROWD_FILES, CrowdHumans, characterFor } from "../../src/render/crowd-humans.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import type { AgentState } from "../../src/sim/agents.ts";
import type { SimState } from "../../src/sim/contract.ts";

const bytes = async (path: string): Promise<Uint8Array> => new Uint8Array(readFileSync(new URL(`../../public/${path}`, import.meta.url)));

function visibleCalls(group: THREE.Object3D): number {
  let calls = 0;
  group.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || ((mesh as THREE.InstancedMesh).isInstancedMesh && (mesh as THREE.InstancedMesh).count === 0)) return;
    if (Array.isArray(mesh.material)) calls += mesh.geometry.groups.filter(g => mesh.material instanceof Array && mesh.material[g.materialIndex ?? 0]?.visible).length;
    else if (mesh.material.visible) calls++;
  });
  return calls;
}
function visibleCharacterIds(group: THREE.Object3D): number[] {
  const ids: number[] = [];
  group.traverseVisible(object => { if (object.name.startsWith("player-body:")) ids.push(Number(object.name.slice(12))); });
  return ids.sort((a, b) => a - b);
}
function legacyNearAt(layer: AgentLayer, x: number, z: number): boolean {
  const body = layer.group.getObjectByName("agents:people:body") as THREE.InstancedMesh;
  if (!body.visible) return false;
  const matrix = new THREE.Matrix4(), point = new THREE.Vector3();
  for (let i = 0; i < body.count; i++) {
    body.getMatrixAt(i, matrix); point.setFromMatrixPosition(matrix);
    if (Math.abs(point.x - x) < 1e-5 && Math.abs(point.z - z) < 1e-5) return true;
  }
  return false;
}

beforeEach(() => {
  vi.stubGlobal("self", globalThis);
  vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
    const texture = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1) as unknown as THREE.Texture<HTMLImageElement>; queueMicrotask(() => loaded?.(texture)); return texture;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("nearby pedestrian avatar continuity", () => {
  it("keeps the same loaded character instead of returning to the old box avatar as road tiers come and go", async () => {
    const crowd = new CrowdHumans(bytes, false);
    const registry = new ModelRegistry<THREE.Object3D>({
      load: async path => new GLTFLoader().parseAsync((await bytes(path)).slice().buffer as ArrayBuffer, "").then(gltf => gltf.scene),
      fallback: () => new THREE.Group(), clone: model => model.clone(),
    });
    const layer = new AgentLayer(registry);
    try {
      await vi.waitFor(() => expect(crowd.loaded).toBe(CROWD_FILES.length), { timeout: 20_000 });
      await Promise.all([registry.get("robotaxi"), registry.get("robot"), registry.get("sidewalk-bot"), registry.get("player-car")]);
      layer.setCrowd(crowd);
      const people = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, kind: "person", x: 0, y: 0, z: -(i + 1), heading: 0, pitch: 0, speed: 0, mode: "go" }));
      const road = ["robotaxi", "errandRobot", "sidewalkBot"].flatMap((kind, i) => [30, 90, 220].map((distance, j) => ({ id: 30 + i * 3 + j, kind, x: i + 4, y: 0, z: -distance, heading: 0, pitch: 0, speed: 0, mode: "go" })));
      const mixed = [...people, ...road,
        { ...road[0], id: 47, x: -4, z: -30 }, // Actual scheduled civilian render family.
        { ...road[0], id: 55, x: -4, z: -220 },
        { ...people[0], id: 1001, z: -100 }, { ...people[0], id: 1002, z: -230 }];
      let tick = 0;
      const draw = (list: unknown[]) => {
        const state = { version: 18, tick: ++tick, players: {}, ext: { agents: { nextId: 2000, list: list as AgentState[] } } } as unknown as SimState;
        layer.update(state, state, 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, tick / 60);
        const actual = visibleCalls(layer.group) + visibleCalls(crowd.group);
        expect(layer.info().drawn).toBe(list.length);
        expect(layer.info().drawCalls).toBe(actual);
        expect(actual).toBeLessThanOrEqual(AGENT_DRAW_CALL_BUDGET);
        return { ids: visibleCharacterIds(crowd.group), legacyAtTarget: legacyNearAt(layer, 0, -1), calls: actual, targetCharacter: characterFor(1) };
      };
      const alone = draw(people);
      expect(alone.ids).toContain(1);
      expect(alone.legacyAtTarget).toBe(false);
      const crowded = draw(mixed);
      const quietAgain = draw(people);
      const crowdedAgain = draw(mixed);
      for (const frame of [crowded, quietAgain, crowdedAgain]) {
        expect(frame.legacyAtTarget, "the same pedestrian is one metre away with its model already loaded").toBe(false);
        expect(frame.ids).toContain(1);
        expect(frame.targetCharacter).toBe(alone.targetCharacter);
      }
    } finally { crowd.dispose(); layer.dispose(); }
  }, 60_000);

  it("does not replace a person 2.4 metres away with the old mid proxy when robots take the shared near slots", async () => {
    const crowd = new CrowdHumans(bytes, false);
    const registry = new ModelRegistry<THREE.Object3D>({
      load: async path => new GLTFLoader().parseAsync((await bytes(path)).slice().buffer as ArrayBuffer, "").then(gltf => gltf.scene),
      fallback: () => new THREE.Group(), clone: model => model.clone(),
    });
    const layer = new AgentLayer(registry);
    try {
      await vi.waitFor(() => expect(crowd.loaded).toBe(CROWD_FILES.length), { timeout: 20_000 });
      await Promise.all([registry.get("robotaxi"), registry.get("robot"), registry.get("sidewalk-bot"), registry.get("player-car")]);
      layer.setCrowd(crowd);
      const person = { id: 1, kind: "person", x: 0, y: 0, z: -2.4, heading: 0, pitch: 0, speed: 0, mode: "go" };
      // Robot centres remain ~0.70m apart on this ring. All are closer to the viewer,
      // and within the renderer's ordinary behind-camera allowance, than the person.
      const robots = Array.from({ length: 16 }, (_, i) => ({ id: 20 + i, kind: "sidewalkBot", x: 1.8 * Math.sin(i * Math.PI / 8), y: 0, z: 1.8 * Math.cos(i * Math.PI / 8), heading: 0, pitch: 0, speed: 0, mode: "go" }));
      let tick = 0;
      const draw = (list: unknown[], viewer = { x: 0, z: 0, fx: 0, fz: -1 }) => {
        const state = { version: 18, tick: ++tick, players: {}, ext: { agents: { nextId: 100, list: list as AgentState[] } } } as unknown as SimState;
        layer.update(state, state, 1, viewer, 1 / 60, tick / 60);
        const actual = visibleCalls(layer.group) + visibleCalls(crowd.group);
        expect(layer.info().drawn).toBe(list.length);
        expect(layer.info().drawCalls).toBe(actual);
        expect(actual).toBeLessThanOrEqual(AGENT_DRAW_CALL_BUDGET);
        const mid = layer.group.getObjectByName("agents:people:mid") as THREE.InstancedMesh;
        return { ids: visibleCharacterIds(crowd.group), midProxyCount: mid.visible ? mid.count : 0, calls: actual };
      };
      const alone = draw([person]);
      expect(alone.ids).toContain(1);
      // Returning after a camera excursion clears near-tier hysteresis, as it does in play.
      // The character remains loaded and cached; only the physical scene around it changes.
      draw([person], { x: 250, z: 250, fx: 0, fz: -1 });
      const crowded = draw([person, ...robots]);
      const quietAgain = draw([person]);
      console.info("[avatar-repro-near-cap]", JSON.stringify({ alone, crowded, quietAgain, loaded: crowd.loaded, budget: AGENT_DRAW_CALL_BUDGET }));
      expect(crowded.midProxyCount, "a loaded human at conversation distance must not become the old box proxy").toBe(0);
      expect(crowded.ids).toContain(1);
      expect(quietAgain.ids).toContain(1);
    } finally { crowd.dispose(); layer.dispose(); }
  }, 60_000);
});
