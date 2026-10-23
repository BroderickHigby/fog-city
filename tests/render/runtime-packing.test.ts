import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { packGeometry, surfaceOf } from "../../src/render/agent-packing.ts";
import { mergeRuntimeRestPose, packAuthoredRuntimeParts } from "../../src/render/runtime-packing.ts";

const triangleCount = (parts: ReturnType<typeof packAuthoredRuntimeParts>): number => parts.reduce((sum, part) => sum + (part.geometry.index?.count ?? part.geometry.getAttribute("position").count) / 3, 0);
const dispose = (parts: ReturnType<typeof packAuthoredRuntimeParts>): void => { for (const part of parts) part.geometry.dispose(); };

describe("runtime authored geometry packing", () => {
  it("merges opaque materials without losing authored triangles, PBR surfaces or vertex colors", () => {
    const root = new THREE.Group(), box = new THREE.BoxGeometry(1, 2, 3);
    box.setAttribute("color", new THREE.BufferAttribute(new Float32Array(box.getAttribute("position").count * 3).fill(0.5), 3));
    const red = new THREE.MeshStandardMaterial({ color: 0xc82d36, roughness: 0.32, metalness: 0.4, vertexColors: true });
    const blue = new THREE.MeshStandardMaterial({ color: 0x1144cc, roughness: 0.82, metalness: 0.1 });
    const left = new THREE.Mesh(box, red), right = new THREE.Mesh(box, blue); left.position.x = -2; right.position.x = 2;
    root.add(left, right);
    const parts = packAuthoredRuntimeParts(root);
    expect(parts).toHaveLength(1); expect(parts[0]!.material).toBeUndefined(); expect(triangleCount(parts)).toBe(24);
    const geometry = parts[0]!.geometry, color = geometry.getAttribute("color"), pbr = geometry.getAttribute("fcPbr");
    expect(color.getX(0)).toBeCloseTo(red.color.r * 0.5); expect(pbr.getX(0)).toBeCloseTo(0.32);
    expect(color.getZ(box.getAttribute("position").count)).toBeCloseTo(blue.color.b);
    geometry.computeBoundingBox(); expect(geometry.boundingBox!.min.x).toBeCloseTo(-2.5); expect(geometry.boundingBox!.max.x).toBeCloseTo(2.5);
    expect(box.getAttribute("color").getX(0)).toBe(0.5);
    dispose(parts); box.dispose(); red.dispose(); blue.dispose();
  });

  it("preserves textured livery UVs and original material draw beside the packed body", () => {
    const root = new THREE.Group(), body = new THREE.BoxGeometry(2, 3, 8), panel = new THREE.PlaneGeometry(4, 1);
    const paint = new THREE.MeshStandardMaterial({ color: 0xcccccc }), texture = new THREE.Texture();
    const livery = new THREE.MeshStandardMaterial({ map: texture }); livery.name = "livery";
    root.add(new THREE.Mesh(body, paint), new THREE.Mesh(panel, livery));
    const parts = packAuthoredRuntimeParts(root), panelPart = parts.find(part => part.material)!;
    expect(parts).toHaveLength(2); expect(triangleCount(parts)).toBe(14);
    expect(panelPart.material).toBe(livery); expect(panelPart.geometry.getAttribute("uv")).toBe(panel.getAttribute("uv"));
    expect(panelPart.geometry.getAttribute("position")).toBe(panel.getAttribute("position"));
    dispose(parts); body.dispose(); panel.dispose(); paint.dispose(); livery.dispose(); texture.dispose();
  });

  it("retains wheel pivots and distinct light channels through material consolidation", () => {
    const root = new THREE.Group(), wheel = new THREE.Group(); wheel.name = "wheel_front_left"; wheel.position.set(-1, 0.4, -2);
    const geometry = new THREE.BoxGeometry(1, 1, 1), paint = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const head = new THREE.MeshStandardMaterial({ emissive: 0xeeeeff }); head.name = "light_headlight";
    const tail = new THREE.MeshStandardMaterial({ emissive: 0xff1111 }); tail.name = "light_taillight";
    root.add(new THREE.Mesh(geometry, paint), new THREE.Mesh(geometry, head), new THREE.Mesh(geometry, tail));
    const tire = new THREE.Mesh(geometry, paint), rim = new THREE.Mesh(geometry, paint);
    tire.name = "wheel_front_left"; rim.name = "wheel_front_left_1";
    wheel.add(tire, rim); root.add(wheel);
    const parts = packAuthoredRuntimeParts(root);
    expect(parts).toHaveLength(2); expect(triangleCount(parts)).toBe(60);
    expect(parts.find(part => part.animation === "wheel")!.pivot).toEqual([-1, 0.4, -2]);
    const body = parts.find(part => part.animation === "fixed")!.geometry;
    expect(new Set(Array.from({ length: body.getAttribute("fcEmit").count }, (_, index) => body.getAttribute("fcEmit").getW(index)))).toEqual(new Set([0, 1, 2]));
    dispose(parts); geometry.dispose(); paint.dispose(); head.dispose(); tail.dispose();
  });

  it("respects material groups and keeps transparent/custom emission surfaces separate", () => {
    const root = new THREE.Group(), geometry = new THREE.BoxGeometry(1, 1, 1);
    const opaque = new THREE.MeshStandardMaterial({ color: 0x7799aa }), transparent = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    const emissive = new THREE.MeshStandardMaterial({ emissive: 0xff0000 });
    root.add(new THREE.Mesh(geometry, [opaque, transparent, opaque, opaque, emissive, opaque]));
    const parts = packAuthoredRuntimeParts(root);
    expect(parts).toHaveLength(3); expect(triangleCount(parts)).toBe(12);
    expect(parts.filter(part => part.material).map(part => part.material)).toEqual([transparent, emissive]);
    dispose(parts); geometry.dispose(); opaque.dispose(); transparent.dispose(); emissive.dispose();
  });

  it("merges distant rigid joints at their exact rest poses while leaving sources intact", () => {
    const raw = new THREE.BoxGeometry(1, 1, 1), material = new THREE.MeshStandardMaterial({ color: 0x998877 });
    const source = [
      { geometry: packGeometry(raw, surfaceOf(material), null, false), pivot: [-2, 0, 0] as const, animation: "left-leg" as const },
      { geometry: packGeometry(raw, surfaceOf(material), null, false), pivot: [2, 1, 0] as const, animation: "right-leg" as const },
    ];
    const parts = mergeRuntimeRestPose(source);
    expect(parts).toHaveLength(1); expect(parts[0]!.animation).toBe("fixed"); expect(triangleCount(parts)).toBe(24);
    parts[0]!.geometry.computeBoundingBox();
    expect(parts[0]!.geometry.boundingBox!.min.x).toBeCloseTo(-2.5); expect(parts[0]!.geometry.boundingBox!.max.y).toBeCloseTo(1.5);
    expect(source[0]!.geometry.getAttribute("position").getX(0)).toBeCloseTo(0.5);
    dispose(parts); dispose(source); raw.dispose(); material.dispose();
  });
});
