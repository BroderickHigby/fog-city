import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { ImpactLayer } from "../../src/render/impact-layer.ts";
import { PropDamage } from "../../src/render/prop-damage.ts";
import { createPortablePoints } from "../../src/render/portable-points.ts";
import { setGpuMaterialsEnabled } from "../../src/render/node-materials.ts";
import { createInitialState } from "../../src/sim/step.ts";
import { buildWorld } from "../../src/sim/world.ts";
import type { ImpactsExt } from "../../src/sim/impacts.ts";

afterEach(() => setGpuMaterialsEnabled(false));
const world = buildWorld([]);
function state() {
  const result = createInitialState(world, 1, ["p"], { x: 0, z: 0, heading: 0 });
  const impacts: ImpactsExt = {
    version: 1, nextId: 2,
    events: [{ id: 1, tick: 0, kind: "car-car", a: "p:p", b: "p:q", x: 3, y: 0, z: -4, speed: 8, dv: 4 }],
    cars: { p: { condition: 0, front: .3, rear: 0, left: 0, right: 0, lastHitTick: 0 } },
    props: { "hydrant:h": { kind: "hydrant", tick: 0, state: "knocked", dir: 0 } },
  };
  result.ext.impacts = impacts;
  return result;
}
function values(object: THREE.Points | THREE.Sprite): number[] {
  const attribute = object.geometry.getAttribute((object as THREE.Sprite).isSprite ? "fcParticlePosition" : "position");
  const count = (object as THREE.Sprite).isSprite ? (object as THREE.Sprite).count : object.geometry.drawRange.count;
  return Array.from(attribute.array).slice(0, count * 3);
}

describe("portable dynamic point pools", () => {
  it("keeps CPU arrays, active counts and update prefixes while drawing genuine sprite corners", () => {
    setGpuMaterialsEnabled(true);
    const geometry = new THREE.BufferGeometry(), array = new Float32Array(30);
    const source = new THREE.BufferAttribute(array, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", source);
    const draw = createPortablePoints(geometry, { color: 0xabcdee, size: 1.1, opacity: .45, transparent: true, depthWrite: false });
    const sprite = draw.object as THREE.Sprite;
    expect(sprite.isSprite).toBe(true); expect(sprite.count).toBe(0);
    expect(sprite.geometry.getAttribute("uv").count).toBe(4);
    expect(geometry.hasAttribute("uv")).toBe(false);
    const instanced = sprite.geometry.getAttribute("fcParticlePosition") as THREE.InstancedBufferAttribute;
    expect(instanced.array).toBe(array);
    array.set([10, 2, -3, 11, 4, -5]); geometry.setDrawRange(0, 2); source.needsUpdate = true; draw.sync();
    expect(sprite.count).toBe(2); expect(values(sprite)).toEqual([10, 2, -3, 11, 4, -5]);
    expect(instanced.updateRanges).toEqual([{ start: 0, count: 6 }]);
    const version = instanced.version; draw.sync(); expect(instanced.version).toBe(version);
    geometry.setDrawRange(0, 0); source.needsUpdate = true; draw.sync(); expect(sprite.count).toBe(0);
    expect(instanced.updateRanges).toEqual([]);
    geometry.setDrawRange(0, 1); source.needsUpdate = true; draw.sync();
    expect(sprite.count).toBe(1); expect(instanced.updateRanges).toEqual([{ start: 0, count: 3 }]);
    expect(draw.material.size).toBe(1.1); expect(draw.material.opacity).toBe(.45);
    let sourceDisposed = false, drawDisposed = 0, materialDisposed = 0;
    geometry.addEventListener("dispose", () => { sourceDisposed = true; });
    sprite.geometry.addEventListener("dispose", () => { drawDisposed++; });
    draw.material.addEventListener("dispose", () => { materialDisposed++; });
    draw.dispose(); draw.dispose();
    expect(sourceDisposed).toBe(false); expect(drawDisposed).toBe(1); expect(materialDisposed).toBe(1);
    geometry.dispose();
  });

  it("preserves sparks, smoke and geyser trajectories/counts and disposes both renderer paths", () => {
    const snapshots: number[][][] = [];
    for (const node of [false, true]) {
      setGpuMaterialsEnabled(node);
      const scene = new THREE.Scene(), current = state();
      const impacts = new ImpactLayer(scene);
      const props = new PropDamage(scene, {
        prop: () => undefined, hydrants: [{ id: "hydrant:h", x: 0, z: 0 }], ground: () => 0, setFoliageOverride: () => {},
      });
      for (let i = 0; i < 3; i++) { impacts.update(current, current, 1, .1, 0, 0); props.update(current, .1, 0, 0); }
      const sparks = impacts.root.getObjectByName("impact-sparks") as THREE.Points | THREE.Sprite;
      const smoke = impacts.root.getObjectByName("impact-smoke") as THREE.Points | THREE.Sprite;
      const geyser = props.root.getObjectByName("hydrant-geyser") as THREE.Points | THREE.Sprite;
      const objects = [sparks, smoke, geyser];
      for (const object of objects) expect(Boolean((object as THREE.Sprite).isSprite)).toBe(node);
      expect(values(sparks).length / 3).toBe(impacts.sparkCount());
      expect(values(smoke).length).toBeGreaterThan(0);
      expect(values(geyser).length / 3).toBe(props.info().geyser);
      expect(objects.map(object => (object.material as THREE.PointsMaterial).size)).toEqual([.12, 1.1, .22]);
      expect((sparks.material as THREE.Material).blending).toBe(THREE.AdditiveBlending);
      snapshots.push(objects.map(values));
      let disposed = 0;
      objects.forEach(object => (object.material as THREE.Material).addEventListener("dispose", () => { disposed++; }));
      impacts.dispose(); props.dispose();
      expect(disposed).toBe(3); expect(scene.children).toHaveLength(0);
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
  });
});
