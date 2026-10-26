import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { TICK_HZ } from "../../src/sim/contract.ts";
import { signalAspect, signalPhase, type TrafficSignalControls } from "../../src/sim/traffic-signals.ts";
import { FurnitureCell, type SignalRecord } from "../../src/render/street-furniture.ts";

function signal(edge: string, more: Partial<SignalRecord> = {}): SignalRecord {
  return { id: `sig:n-phase-boundary:${edge}`, node: "n-phase-boundary", x: 20, z: -30,
    heading: Math.PI / 2, group: 1, arm: 0, ped: null, ...more };
}
function mesh(cell: FurnitureCell, name: string): THREE.InstancedMesh {
  const result = cell.group.getObjectByName(name) as THREE.InstancedMesh;
  expect(result?.isInstancedMesh, name).toBe(true);
  return result;
}
function shownAspect(lenses: THREE.InstancedMesh, first = 0): string {
  const light = new THREE.Color(), strengths: number[] = [];
  for (let i = 0; i < 3; i++) { lenses.getColorAt(first + i, light); strengths.push(light.r + light.g + light.b); }
  return ["red", "yellow", "green"][strengths.indexOf(Math.max(...strengths))]!;
}
const controls: TrafficSignalControls = new Map([["n-phase-boundary", { node: "n-phase-boundary", groupCount: 3,
  approaches: new Map([["north", 0], ["skew", 2]]) }]]);

describe("legible traffic signal furniture", () => {
  it("uses 30 cm directional lenses, contrasting backplates and deep sun visors", () => {
    const cell = new FurnitureCell([signal("north")], [], () => 3);
    try {
      const lens = mesh(cell, "signal lenses"), head = mesh(cell, "signal heads"), plate = mesh(cell, "signal backplates");
      lens.geometry.computeBoundingBox(); head.geometry.computeBoundingBox(); plate.geometry.computeBoundingBox();
      const lensSize = lens.geometry.boundingBox!.getSize(new THREE.Vector3());
      const headSize = head.geometry.boundingBox!.getSize(new THREE.Vector3());
      const plateSize = plate.geometry.boundingBox!.getSize(new THREE.Vector3());
      expect(lensSize.x).toBeCloseTo(.30); expect(lensSize.y).toBeCloseTo(.30);
      expect(plateSize.x).toBeGreaterThan(headSize.x); expect(plateSize.y).toBeGreaterThan(headSize.y);
      expect(head.geometry.boundingBox!.min.z).toBeLessThan(-.30);
      expect((plate.material as THREE.MeshStandardMaterial).metalness).toBe(0);
      expect((lens.material as THREE.MeshBasicMaterial).toneMapped).toBe(false);
      const lensMatrix = new THREE.Matrix4(), headMatrix = new THREE.Matrix4();
      lens.getMatrixAt(0, lensMatrix); head.getMatrixAt(0, headMatrix);
      const face = new THREE.Vector3().fromBufferAttribute(lens.geometry.getAttribute("normal"), 0)
        .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(lensMatrix)).normalize();
      expect(face.dot(new THREE.Vector3(1, 0, 0))).toBeCloseTo(1);
      expect(new THREE.Vector3().setFromMatrixPosition(lensMatrix).x).toBeGreaterThan(20);
      expect(new THREE.Vector3().setFromMatrixPosition(headMatrix).y).toBeCloseTo(7);
    } finally { cell.dispose(); }
  });

  it("keeps the existing pole and mast placements in a bounded set of shared draws", () => {
    const pole = signal("north"), mast = signal("skew", { x: 45, arm: 6.65, ped: Math.PI });
    const cell = new FurnitureCell([pole, mast], [], () => 2);
    try {
      expect(cell.signals).toBe(2);
      expect(mesh(cell, "signal heads").count).toBe(3);
      expect(mesh(cell, "signal backplates").count).toBe(3);
      expect(mesh(cell, "signal lenses").count).toBe(10);
      expect(cell.group.children.length).toBeLessThanOrEqual(7);
      const heads = mesh(cell, "signal heads");
      expect((heads.geometry.index?.count ?? heads.geometry.getAttribute("position").count) / 3).toBeLessThan(200);
      for (const name of ["signal poles", "signal mast poles"]) {
        const instance = mesh(cell, name), m = new THREE.Matrix4(); instance.getMatrixAt(0, m);
        expect(new THREE.Vector3().setFromMatrixPosition(m).toArray()).toEqual([name === "signal poles" ? 20 : 45, 2, -30]);
      }
      cell.group.traverse(object => expect((object as THREE.Light).isLight).not.toBe(true));
    } finally { cell.dispose(); }
    expect(cell.group.children).toHaveLength(0);
  });

  it("shows the same three-group phases as cars instead of trusting legacy display groups", () => {
    const cell = new FurnitureCell([signal("north"), signal("skew")], [], () => 0, controls);
    const lenses = mesh(cell, "signal lenses");
    try {
      for (let tick = 0; tick < 96 * TICK_HZ; tick += 37) {
        cell.update(tick);
        expect(shownAspect(lenses, 0)).toBe(signalAspect(controls, "n-phase-boundary", "north", tick));
        expect(shownAspect(lenses, 3)).toBe(signalAspect(controls, "n-phase-boundary", "skew", tick));
      }
    } finally { cell.dispose(); }
  });

  it("switches on the exact phase tick and avoids unchanged color uploads", () => {
    const cell = new FurnitureCell([signal("north")], [], () => 0, controls);
    const lenses = mesh(cell, "signal lenses");
    try {
      let boundary = 1;
      while (signalPhase("n-phase-boundary", 0, boundary, 3).aspect === signalPhase("n-phase-boundary", 0, boundary - 1, 3).aspect) boundary++;
      expect(boundary % (TICK_HZ / 2)).not.toBe(0);
      cell.update(boundary - 1);
      const before = shownAspect(lenses), version = lenses.instanceColor!.version;
      cell.update(boundary);
      expect(shownAspect(lenses)).not.toBe(before);
      expect(shownAspect(lenses)).toBe(signalAspect(controls, "n-phase-boundary", "north", boundary));
      expect(lenses.instanceColor!.version).toBeGreaterThan(version);
      const stable = lenses.instanceColor!.version;
      cell.update(boundary + 1); cell.update(boundary + 1);
      expect(lenses.instanceColor!.version).toBe(stable);
    } finally { cell.dispose(); }
  });

  it("does not invent a green for an unmapped approach at a controlled junction", () => {
    const cell = new FurnitureCell([signal("missing")], [], () => 0, controls);
    try {
      for (const tick of [0, 1234, 5678]) { cell.update(tick); expect(shownAspect(mesh(cell, "signal lenses"))).toBe("red"); }
    } finally { cell.dispose(); }
  });
});
