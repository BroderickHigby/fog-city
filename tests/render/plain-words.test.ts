import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { PlainWordsLayer, PLAIN_WORDS_BOARD_DIMENSIONS, plainWordsBoardTransform, plainWordsLabel } from "../../src/render/plain-words.ts";
import { setRenderRetirementOwner } from "../../src/render/renderer-warmup.ts";
import { PLAIN_WORDS_BOARDS, PLAIN_WORDS_LADDER, startPlainWords } from "../../src/sim/activities/plain-words.ts";
import { createActivities } from "../../src/sim/activities/system.ts";
import { seedRng } from "../../src/sim/rng.ts";
import { createInitialState } from "../../src/sim/step.ts";
import { buildWorld } from "../../src/sim/world.ts";

function active() {
  const state = createInitialState(buildWorld([]), 7, ["p"], { x: 0, z: 0, heading: 0 });
  const activities = createActivities(1), run = startPlainWords(activities, "p", 1);
  activities.players.p = { nextDirectorTick: 10000, directorRng: seedRng(7), activeCardId: "", cardUntilTick: 0, cardCooldowns: {},
    activeActivityId: "plain-words", activityStartedTick: 1, completedIds: [], commandSequence: 0, checkpointIndex: 0,
    objectiveCount: 0, cooldowns: {}, plainWords: run };
  state.ext.activities = activities;
  return { state, run };
}

function mesh(layer: PlainWordsLayer, name: string): THREE.InstancedMesh {
  const found = layer.root.getObjectByName(name) as THREE.InstancedMesh;
  expect(found?.isInstancedMesh, name).toBe(true);
  return found;
}

describe("Plain Words board presentation", () => {
  it("allocates no geometry or scene objects before the local activity starts", () => {
    const scene = new THREE.Scene(), ground = vi.fn(() => 5), layer = new PlainWordsLayer(scene, ground);
    const { state } = active();
    layer.update(state, "another-player");
    expect(scene.children).toEqual([]);
    expect(layer.root.children).toEqual([]);
    expect(layer.info()).toEqual({ boards: 0, drawCalls: 0, triangles: 0 });
    expect(ground).not.toHaveBeenCalled();
    layer.dispose(); layer.dispose();
  });

  it("places every bounded A-frame on terrain using its authored SF position and heading", () => {
    const scene = new THREE.Scene(), ground = (x: number, z: number) => 5 + x * .0001 + z * .0002;
    const layer = new PlainWordsLayer(scene, ground), { state } = active();
    const before = JSON.stringify(state);
    layer.update(state, "p");
    expect(JSON.stringify(state)).toBe(before);
    const frames = mesh(layer, "plain-words-frames"), bounds = frames.geometry.boundingBox!;
    expect(frames.count).toBe(20);
    expect(bounds.min.y).toBeCloseTo(0, 6);
    expect(bounds.max.y).toBeLessThanOrEqual(PLAIN_WORDS_BOARD_DIMENSIONS.height);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(PLAIN_WORDS_BOARD_DIMENSIONS.width, 6);
    expect(bounds.max.z - bounds.min.z).toBeLessThan(PLAIN_WORDS_BOARD_DIMENSIONS.depth);
    const transform = new THREE.Matrix4(), position = new THREE.Vector3();
    for (let index = 0; index < PLAIN_WORDS_BOARDS.length; index++) {
      const board = PLAIN_WORDS_BOARDS[index]!;
      frames.getMatrixAt(index, transform); position.setFromMatrixPosition(transform);
      expect(position.x).toBeCloseTo(board.x, 3); expect(position.z).toBeCloseTo(board.z, 3);
      expect(position.y).toBeCloseTo(ground(board.x, board.z), 5);
      const forward = new THREE.Vector3(0, 0, -1).transformDirection(transform), heading = board.headingDeg * Math.PI / 180;
      expect(forward.x).toBeCloseTo(Math.sin(heading), 6); expect(forward.z).toBeCloseTo(-Math.cos(heading), 6);
    }
    const a = plainWordsBoardTransform({ id: "flat", x: 4, z: 8, headingDeg: 90 }, () => 3);
    expect(new THREE.Vector3().setFromMatrixPosition(a).toArray()).toEqual([4, 3, 8]);
    layer.dispose();
  });

  it("shares label batches across all twenty boards and shows authored hype, clean text and wash progress", () => {
    const layer = new PlainWordsLayer(new THREE.Scene(), () => 0), { state, run } = active();
    layer.update(state, "p");
    expect(layer.info()).toEqual({ boards: 20, drawCalls: 2, triangles: 800 });
    expect(mesh(layer, `plain-words-label:${plainWordsLabel(0)}`).count).toBe(40);
    expect(mesh(layer, "plain-words-wash-progress").count).toBe(0);
    for (let index = 0; index < PLAIN_WORDS_LADDER.length; index++) run.boards[index]!.word = index;
    run.boards[5]!.word = -1;
    run.boards[6]!.wash = 60;
    layer.update(state, "p");
    const labels = layer.root.children.filter(child => child.name.startsWith("plain-words-label:")) as THREE.InstancedMesh[];
    expect(labels).toHaveLength(PLAIN_WORDS_LADDER.length + 1);
    expect(new Set(labels.map(label => label.geometry)).size).toBe(1);
    expect(labels.reduce((count, label) => count + label.count, 0)).toBe(40);
    expect(labels.find(label => label.userData.label === "PLAIN WORDS")?.count).toBe(2);
    const progress = mesh(layer, "plain-words-wash-progress");
    expect(progress.count).toBe(4);
    const transform = new THREE.Matrix4(), scale = new THREE.Vector3();
    progress.getMatrixAt(2, transform); scale.setFromMatrixScale(transform);
    expect(scale.x).toBeCloseTo(.5, 6);
    expect(layer.info()).toEqual({ boards: 20, drawCalls: 8, triangles: 808 });
    layer.dispose();
  });

  it("stays under the mesh budget and reuses resources across progress, rebrands and repeat runs", () => {
    const scene = new THREE.Scene(), layer = new PlainWordsLayer(scene, () => 0), { state, run } = active();
    for (let round = 0; round < 12; round++) {
      for (let index = 0; index < run.boards.length; index++) {
        run.boards[index]!.word = (round + index) % (PLAIN_WORDS_LADDER.length + 1) - 1;
        run.boards[index]!.wash = 90;
      }
      layer.update(state, "p");
      expect(layer.info().boards).toBe(20);
      expect(layer.info().drawCalls).toBeLessThanOrEqual(8);
      expect(layer.info().triangles).toBeLessThanOrEqual(880);
    }
    const children = [...layer.root.children];
    state.ext.activities!.players.p!.activeActivityId = "";
    layer.update(state, "p");
    expect(layer.root.visible).toBe(false);
    expect(layer.info()).toEqual({ boards: 0, drawCalls: 0, triangles: 0 });
    state.ext.activities!.players.p!.activeActivityId = "plain-words";
    layer.update(state, "p");
    expect(layer.root.children).toEqual(children);
    for (const board of run.boards) board.word = -1;
    layer.update(state, "p");
    expect(layer.info()).toEqual({ boards: 20, drawCalls: 3, triangles: 880 });
    expect(scene.children).toEqual([layer.root]);
    layer.dispose();
  });

  it("disposes every owned mesh and each shared geometry/material once", () => {
    const scene = new THREE.Scene(), layer = new PlainWordsLayer(scene, () => 0), { state, run } = active();
    run.boards[0]!.word = -1;
    layer.update(state, "p");
    const meshes = layer.root.children as THREE.InstancedMesh[];
    const geometries = new Set(meshes.map(mesh => mesh.geometry)), materials = new Set(meshes.map(mesh => mesh.material as THREE.Material));
    const released = [...meshes, ...geometries, ...materials].map(resource => vi.spyOn(resource, "dispose"));
    layer.dispose(); layer.dispose(); layer.update(state, "p");
    for (const release of released) expect(release).toHaveBeenCalledTimes(1);
    expect(scene.children).toEqual([]); expect(layer.root.children).toEqual([]);
    expect(layer.info()).toEqual({ boards: 0, drawCalls: 0, triangles: 0 });
  });

  it("detaches immediately and defers resource disposal while a GPU compiler still borrows the tree", async () => {
    const scene = new THREE.Scene(), layer = new PlainWordsLayer(scene, () => 0), { state } = active();
    layer.update(state, "p");
    const dispose = vi.spyOn(mesh(layer, "plain-words-frames").geometry, "dispose");
    let release!: () => void;
    setRenderRetirementOwner(layer.root, { retire: () => new Promise<void>(resolve => { release = resolve; }) });
    layer.dispose();
    expect(scene.children).toEqual([]); expect(dispose).not.toHaveBeenCalled();
    release(); await Promise.resolve(); await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
