import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { AvatarGround } from "../../src/render/avatar-ground.ts";

function tile(id: string, y = 0.15, material = "fc:road-uv", slope = 0): THREE.Group {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, y, 0, 4, y + slope * 4, 0, 0, y, 4,
    4, y + slope * 4, 0, 4, y + slope * 4, 4, 0, y, 4,
  ], 3));
  const group = new THREE.Group();
  group.name = `tile:${id}`;
  group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ name: material })));
  return group;
}

describe("avatar alignment with rendered floors", () => {
  it("raises feet onto the real 15 cm road surface but leaves outside positions untouched", () => {
    const ground = new AvatarGround();
    ground.addTile(tile("a"));
    expect(ground.heightAt(1, 0, 1)).toBeCloseTo(0.15);
    expect(ground.heightAt(4, 0, 4)).toBeCloseTo(0.15);
    expect(ground.heightAt(4.1, 0, 4.1)).toBe(0);
    expect(ground.heightAt(-0.1, 0, 1)).toBe(0);
    expect(ground.heightAt(1, 0.2, 1)).toBe(0.2); // Never lower an avatar.
  });

  it("interpolates the triangle plane in world coordinates rather than snapping to vertex heights", () => {
    const ground = new AvatarGround(), group = tile("slope", 0.1, "fc:ground", 0.025);
    group.position.set(10, 2, -20);
    ground.addTile(group);
    expect(ground.heightAt(12, 2, -18)).toBeCloseTo(2.15);
    expect(ground.heightAt(11, 2, -18)).toBeCloseTo(2.125);
  });

  it("samples both uphill and downhill shoe positions without mistaking a bridge for support", () => {
    const ground = new AvatarGround();
    ground.addTile(tile("hill", 0.1, "fc:road-uv", 0.1));
    ground.addTile(tile("terrain", 0, "fc:ground", 0.1));
    ground.addTile(tile("overpass", 6, "fc:freeway-uv"));
    expect(ground.surfaceAt(1, 0.3, 1)).toBeCloseTo(0.2);
    expect(ground.surfaceAt(3, 0.3, 1)).toBeCloseTo(0.4);
    expect(ground.heightAt(1, 0.3, 1)).toBe(0.3); // Body placement remains upward-only.
    expect(ground.surfaceAt(10, 0.3, 10)).toBeUndefined();
    ground.removeTile("hill");
    expect(ground.surfaceAt(1, 0.3, 1)).toBeCloseTo(0.1);
    ground.clear();
    expect(ground.surfaceAt(1, 0.3, 1)).toBeUndefined();
  });

  it("does not snap onto roofs, bridges or steep/degenerate geometry", () => {
    const ground = new AvatarGround();
    ground.addTile(tile("roof", 0.1, "fc:building"));
    ground.addTile(tile("bridge", 6, "fc:freeway-uv"));
    ground.addTile(tile("too-high", 0.351));
    ground.addTile(tile("steep", 0, "fc:road", 2));
    const collapsed = tile("collapsed");
    (collapsed.children[0] as THREE.Mesh).scale.x = 0;
    ground.addTile(collapsed);
    expect(ground.heightAt(1, 0, 1)).toBe(0);
    expect(ground.heightAt(0, 0, 1)).toBe(0);
    expect(ground.heightAt(1, 6.1, 1)).toBe(6.1);
  });

  it("replaces and removes each tile without retaining stale height data", () => {
    const ground = new AvatarGround();
    ground.addTile(tile("a", 0.15));
    ground.addTile(tile("b", 0.1));
    expect(ground.heightAt(1, 0, 1)).toBeCloseTo(0.15);
    ground.removeTile("a");
    expect(ground.heightAt(1, 0, 1)).toBeCloseTo(0.1);
    ground.addTile(tile("b", 0.25));
    expect(ground.heightAt(1, 0, 1)).toBeCloseTo(0.25);
    ground.removeTile("b");
    expect(ground.heightAt(1, 0, 1)).toBe(0);
    ground.addTile(tile("a", 0.2));
    ground.clear();
    expect(ground.heightAt(1, 0, 1)).toBe(0);
  });

  it("rejects out-of-range grid coordinates instead of looping on unrepresentable increments", () => {
    const ground = new AvatarGround(), enormous = tile("invalid");
    enormous.position.x = 1e20;
    enormous.children[0]!.scale.x = 4096;
    ground.addTile(enormous);
    expect(ground.heightAt(1e20, 0, 1)).toBe(0);
  });

  it("handles indexed multi-material floors using only the ground material's triangles", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0.15, 0, 4, 0.15, 0, 0, 0.15, 4, 4, 0.3, 4,
    ], 3));
    geometry.setIndex([0, 1, 2, 1, 3, 2]);
    geometry.addGroup(0, 3, 0); geometry.addGroup(3, 3, 1);
    const group = new THREE.Group(); group.name = "tile:materials";
    group.add(new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial({name:"fc:road"}), new THREE.MeshBasicMaterial({name:"fc:building"})]));
    const ground = new AvatarGround(); ground.addTile(group);
    expect(ground.heightAt(1, 0, 1)).toBeCloseTo(0.15);
    expect(ground.heightAt(3, 0, 3)).toBe(0);
  });
});
