import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createSurfaceDetail } from "../../src/render/surface-detail.ts";
import { dressPlayerCar } from "../../src/render/car-finish.ts";

describe("generated surface detail", () => {
  it("is a repeatable, mipmapped 256 KiB data texture shared by surface shaders", () => {
    const a = createSurfaceDetail(), b = createSurfaceDetail();
    expect(a.image.width).toBe(256); expect(a.image.height).toBe(256);
    expect(a.image.data!.byteLength).toBe(256 * 256 * 4);
    expect(a.image.data).toEqual(b.image.data);
    expect(new Set(a.image.data).size).toBeGreaterThan(80);
    expect(a.wrapS).toBe(THREE.RepeatWrapping);
    expect(a.generateMipmaps).toBe(true);
    expect(a.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    a.dispose(); b.dispose();
  });
});

describe("player car surface finishes", () => {
  it("keeps software rendering on the standard material path", () => {
    const car = new THREE.Group();
    car.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: "glass" })));
    const finishes = dressPlayerCar(car, null, false);
    expect((finishes[0] as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial).not.toBe(true);
    expect((finishes[0] as THREE.MeshStandardMaterial).color.getHex()).toBe(0x455d70);
    for (const finish of finishes) finish.dispose();
  });

  it("preserves geometry and shared light materials while giving each car its own finish", () => {
    const geometry = new THREE.BoxGeometry();
    const paint = new THREE.MeshStandardMaterial({ name: "paint", color: 0xe0552b });
    const glass = new THREE.MeshStandardMaterial({ name: "glass", color: 0x223140 });
    const light = new THREE.MeshStandardMaterial({ name: "light_headlight", emissive: 0xffffff });
    const car = new THREE.Group();
    car.add(new THREE.Mesh(geometry, [paint, glass, light]), new THREE.Mesh(geometry, paint));
    const originals = [paint.color.getHex(), glass.color.getHex()];
    const finishes = dressPlayerCar(car, 0x2d6fc8);
    const [newPaint, newGlass, sameLight] = (car.children[0] as THREE.Mesh).material as THREE.MeshPhysicalMaterial[];
    expect(finishes).toHaveLength(2);
    expect(newPaint!.color.getHex()).toBe(0x2d6fc8);
    expect(newPaint!.clearcoat).toBe(1);
    expect(newGlass!.transmission).toBe(0);
    expect(newGlass!.transparent).toBe(false);
    expect(sameLight).toBe(light);
    expect((car.children[1] as THREE.Mesh).material).toBe(newPaint);
    expect((car.children[0] as THREE.Mesh).geometry).toBe(geometry);
    expect([paint.color.getHex(), glass.color.getHex()]).toEqual(originals);
    for (const finish of finishes) finish.dispose();
    geometry.dispose(); paint.dispose(); glass.dispose(); light.dispose();
  });
});
