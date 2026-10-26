import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { filterStreetTrees } from "../../pipeline/lib/clear-street-trees.ts";
import { TreeClearance } from "../../pipeline/lib/tree-clearance.ts";
import { treeProfile } from "../../pipeline/lib/tree-profile.ts";
import { createFoliagePrototype, type Species } from "../../src/render/foliage.ts";
import { foliagePlacements, type TreeRecord } from "../../src/render/street-trees.ts";
import type { RoadGraph } from "../../src/render/types.ts";
import { propsFromStreetDetail } from "../../src/sim/props.ts";

const classes = ["broadleaf", "conifer", "palm"];
const flatGround = () => 0;
function road(points: Array<[number, number]> = [[0, -100], [0, 100]], widthM = 10): RoadGraph {
  return {
    version: 1,
    nodes: [{ id: "a", x: points[0]![0], z: points[0]![1] }, { id: "b", x: points.at(-1)![0], z: points.at(-1)![1] }],
    edges: [{ id: "street", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, widthM, points }],
  };
}

/** The anisotropic crown transform applied by the foliage renderer. */
function renderedMatrix(tree: TreeRecord): THREE.Matrix4 {
  const p = foliagePlacements([tree], classes, flatGround)[0]!;
  const crown = .5 + .5 * Math.sin(p.x * .17 + p.z * .31);
  return new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.heading),
    new THREE.Vector3(p.scale, p.scale, p.scale))
    .multiply(new THREE.Matrix4().makeScale(.88 + crown * .24, 1, 1.10 - crown * .20));
}

describe("street tree source clearance", () => {
  it.each([
    { label: "broadleaf", centre: [11, 0, -30, 0, 3], tall: [12, 7, -20, 0, 18] },
    { label: "conifer", centre: [21, 0, -10, 1, 6], tall: [22, 7, 0, 1, 18] },
    { label: "palm", centre: [31, 0, 10, 2, 4.3], tall: [32, 7, 20, 2, 12] },
  ])("removes a $label trunk in the street but retains its clear tall sidewalk counterpart", ({ centre, tall }) => {
    const trees = [centre, tall] as TreeRecord[];
    const retained = filterStreetTrees(trees, classes, road(), flatGround);
    expect(retained).toEqual([tall]);
    expect(retained[0]).toBe(tall);
  });

  it.each([
    { species: 0 as Species, tree: [41, 30, 30, 0, 3] as TreeRecord },
    { species: 1 as Species, tree: [42, 30, 30, 1, 3] as TreeRecord },
  ])("preserves actual scale and height for short species $species away from the road", ({ species, tree }) => {
    const matrix = renderedMatrix(tree), clearance = new TreeClearance(road(), flatGround);
    const near = createFoliagePrototype(species, false), far = createFoliagePrototype(species, true);
    try {
      expect(foliagePlacements([tree], classes, flatGround)[0]!.scale).toBe(Math.max(.35, tree[4] / (species === 0 ? 6.6 : 10.5)));
      expect(clearance.allows(treeProfile([near.bark, near.leaves]), matrix)).toBe(true);
      expect(clearance.allows(treeProfile([far.bark, far.leaves]), matrix)).toBe(true);
      const retained = filterStreetTrees([tree], classes, road(), flatGround);
      expect(retained).toEqual([tree]);
      expect(retained[0]).toBe(tree);
      expect(propsFromStreetDetail({ trees: { classes, trees: retained } })[0]!.height).toBe(3);
    } finally {
      near.bark.dispose(); near.leaves.dispose(); far.bark.dispose(); far.leaves.dispose();
    }
  });

  it.each([
    { tree: [71, 5.9, 30, 0, 3] as TreeRecord },
    { tree: [72, 5.9, 30, 1, 3] as TreeRecord },
  ])("removes short inventory tree $tree.0 when its scaled low crown reaches the street", ({ tree }) => {
    expect(filterStreetTrees([tree], classes, road(), flatGround)).toEqual([]);
  });

  it("still removes a short palm whose drooping fronds enter the driving band", () => {
    const tree: TreeRecord = [43, 7, 10, 2, 4.3];
    expect(filterStreetTrees([tree], classes, road(), flatGround)).toEqual([]);
  });

  it("removes the real Drumm Street centreline witness before creating collision props", () => {
    const drumm = road([[-236.96, 203.81], [-254.18, 101.2]], 11);
    // Original inventory record: about 2 cm from the rendered Drumm Street centreline.
    const witness: TreeRecord = [135582, -242.3, 172.1, 0, 4.3];
    const clear: TreeRecord = [999991, -260, 175, 0, 18];
    const retained = filterStreetTrees([witness, clear], classes, drumm, () => 3);
    expect(retained).toEqual([clear]);
    const props = propsFromStreetDetail({ trees: { classes, trees: retained } });
    expect(props.map(p => p.id)).toEqual(["tree:999991"]);
    expect(props.some(p => p.id === "tree:135582")).toBe(false);
    expect(props[0]).toMatchObject({ x: clear[1], z: clear[2], height: clear[4] });
  });

  it("uses a junction's asphalt patch beyond the adjoining road ribbon", () => {
    const graph = road([[-50, 0], [50, 0]], 4);
    const tree: TreeRecord = [51, 4, 4, 0, 18];
    expect(filterStreetTrees([tree], classes, graph, flatGround)).toEqual([tree]);
    expect(filterStreetTrees([tree], classes, graph, flatGround, [{ ring: [0, -9, 9, 0, 0, 9, -9, 0], x: 0, z: 0 }])).toEqual([]);
  });

  it("preserves retained finite source records, coordinates, ordering and identities", () => {
    const trees: TreeRecord[] = [[61, 30, -30, 0, 6], [62, -30, 10, 1, 8], [63, 30, 35, 2, 12]];
    const original = JSON.stringify(trees);
    trees.forEach(Object.freeze); Object.freeze(trees);
    const retained = filterStreetTrees(trees, classes, road(), (x, z) => (x + z) * .01);
    expect(retained).toEqual(trees);
    expect(retained).not.toBe(trees);
    expect(JSON.stringify(trees)).toBe(original);
    retained.forEach((record, i) => {
      expect(record).toBe(trees[i]);
      expect(record.every(Number.isFinite)).toBe(true);
    });
  });
});
