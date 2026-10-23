import * as THREE from "three";
import { expect, it } from "vitest";
import { Actors } from "../../src/render/actors.ts";
import { AgentLayer } from "../../src/render/agent-layer.ts";
import type { CrowdRig } from "../../src/render/crowd.ts";
import { NightLights } from "../../src/render/lights.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import type { PlayerBodies } from "../../src/render/player-body.ts";
import { personIsChild } from "../../src/sim/agents.ts";
import type { SimState } from "../../src/sim/contract.ts";

function registry(): ModelRegistry<THREE.Object3D> {
  return new ModelRegistry<THREE.Object3D>({
    load: async () => new THREE.Group(),
    fallback: () => new THREE.Group(),
    clone: (model) => model.clone(),
    available: new Set(),
  });
}

const dodge = { phase: "dive" as const, sx: 0, sz: -6, tx: 2.4, tz: -6, t: 9, dur: 18, hop: 0.45, leap: false };
const count = (group: THREE.Group, name: string): number => (group.getObjectByName(name) as THREE.InstancedMesh).count;

it("high-tier players still draw their dodge and recovery, then return to their skinned body", () => {
  const actors = new Actors(registry(), new NightLights());
  const seen: string[] = [];
  const bodies = {
    group: new THREE.Group(), drawn: 0,
    begin() { seen.length = 0; this.drawn = 0; },
    add(id: string) { seen.push(id); this.drawn++; },
    end() {}, dispose() {},
  };
  actors.setBodies(bodies as unknown as PlayerBodies);
  const foot = { x: 0, y: 0.45, z: -6, heading: 0, speed: 1 };
  actors.setFoot("p1", { ...foot, dodge });
  actors.setFoot("p2", foot);
  actors.update(1 / 60);
  expect(seen).toEqual(["p2"]);
  expect(count(actors.group, "players:people:body")).toBe(1);
  expect(count(actors.group, "players:people:dodge-shadow")).toBe(1);
  expect(actors.walkers).toBe(2);
  actors.setFoot("p1", { ...foot, dodge: { ...dodge, phase: "recover", t: 6, dur: 60 } });
  actors.update(1 / 60);
  expect(seen).toEqual(["p2"]);
  expect(actors.walkers).toBe(2);
  actors.setFoot("p1", { ...foot, dodge: null });
  actors.update(1 / 60);
  expect(seen).toEqual(["p1", "p2"]);
  expect(count(actors.group, "players:people:body")).toBe(0);
  expect(actors.walkers).toBe(2);
  actors.dispose();
});

it("high-tier crowds retain child proportions and dodge poses alongside animated adults", () => {
  const layer = new AgentLayer(registry());
  const drawn: string[] = [];
  const crowd = {
    group: new THREE.Group(), drawCalls: 0, triangles: 0,
    begin() { drawn.length = 0; }, setTime() {},
    add(id: string) { drawn.push(id); }, end() {}, dispose() {},
  };
  layer.setCrowd(crowd as unknown as CrowdRig);
  const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
  const child = ids.find(personIsChild)!;
  const adults = ids.filter((id) => !personIsChild(id));
  const list = [child, adults[0]!, adults[1]!].map((id, i) => ({
    id, kind: "person", x: i, y: 0, z: -6, heading: 0, pitch: 0, speed: 1, mode: "go",
    dodge: i === 1 ? dodge : null,
  }));
  const state = { tick: 1, players: {}, ext: { agents: { nextId: 1001, list } } } as unknown as SimState;
  layer.update(state, state, 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
  expect(drawn).toEqual([String(adults[1])]);
  expect(count(layer.group, "agents:people:body")).toBe(2);
  expect(count(layer.group, "agents:people:dodge-shadow")).toBe(1);
  expect(layer.info().drawn).toBe(3);
  expect(layer.info().dodging).toBe(1);
  layer.dispose();
});
