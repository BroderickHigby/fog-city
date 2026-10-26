import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { AgentLayer } from "../../src/render/agent-layer.ts";
import { AvatarGround } from "../../src/render/avatar-ground.ts";
import { CrowdHumans } from "../../src/render/crowd-humans.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import { SIM_VERSION, type SimState } from "../../src/sim/contract.ts";

function floor(): THREE.Group {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(500, 500).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ name: "fc:road-uv" }));
  mesh.position.y = 0.2;
  const tile = new THREE.Group();
  tile.name = "tile:street";
  tile.add(mesh);
  return tile;
}

describe("ambient bodies on rendered streets", () => {
  it("places the skinned crowd and distant proxies on asphalt without changing simulation height", () => {
    const registry = new ModelRegistry<THREE.Object3D>({
      load: async () => new THREE.Group(), fallback: () => new THREE.Group(),
      clone: object => object.clone(), available: new Set(),
    });
    const layer = new AgentLayer(registry);
    const ground = new AvatarGround();
    const tile = floor();
    ground.addTile(tile);
    layer.setSupportHeight((x, y, z) => ground.heightAt(x, y, z));
    const crowd = new CrowdHumans(() => new Promise(() => {}), false);
    vi.spyOn(crowd, "costFor").mockReturnValue({ drawCalls: 1, triangles: 20 });
    const draw = vi.spyOn(crowd, "add").mockReturnValue(true);
    layer.setCrowd(crowd);
    const people = [2, 90, 200].map((distance, i) => ({ id: i + 1, kind: "person", x: 0, y: 0,
      z: -distance, heading: 0, pitch: 0, speed: 0, mode: "go", dodge: null }));
    const state = { version: SIM_VERSION, tick: 1, players: {},
      ext: { agents: { nextId: 4, list: people } } } as unknown as SimState;
    try {
      layer.update(state, state, 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
      expect(draw).toHaveBeenCalled();
      expect(draw.mock.calls[0]![2]).toBeCloseTo(0.2);
      const matrix = new THREE.Matrix4();
      for (const name of ["agents:people:mid", "agents:people:far"]) {
        const mesh = layer.group.getObjectByName(name) as THREE.InstancedMesh;
        expect(mesh.count, name).toBe(1);
        mesh.getMatrixAt(0, matrix);
        expect(matrix.elements[13], name).toBeCloseTo(0.2);
      }
      expect(people.map(person => person.y)).toEqual([0, 0, 0]);
      ground.removeTile("street");
      layer.update(state, state, 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
      expect(draw.mock.calls.at(-1)![2]).toBe(0);
    } finally {
      layer.dispose(); crowd.dispose(); ground.clear();
      tile.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
      });
      vi.restoreAllMocks();
    }
  });
});
