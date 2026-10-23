import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ContactShadows } from "../../src/render/contact-shadows.ts";

describe("player contact shadows", () => {
  it("batches finite accepted poses with elevation and slope in one bounded mesh", () => {
    const contacts = new ContactShadows(2);
    contacts.begin();
    contacts.add(10, 8, 20, Math.PI / 2, 2.6, 5.2, 0.1, -0.05);
    contacts.add(11, 8, 21, 0, 0.85, 0.85);
    contacts.add(12, 8, 22, 0, 1, 1);
    contacts.end();
    expect(contacts.mesh.count).toBe(2);
    expect(contacts.mesh.geometry.index?.count).toBe(6);
    const matrix = new THREE.Matrix4();
    contacts.mesh.getMatrixAt(0, matrix);
    const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
    matrix.decompose(position, rotation, scale);
    expect(position.x).toBe(10); expect(position.y).toBeCloseTo(8.035); expect(position.z).toBe(20);
    expect(scale.x).toBeCloseTo(2.6); expect(scale.z).toBeCloseTo(5.2);
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -Math.PI / 2, 0.05, "YXZ"));
    expect(Math.abs(rotation.dot(expected))).toBeCloseTo(1);
    contacts.dispose();
  });

  it("drops removed players on the next frame and rejects invalid poses", () => {
    const contacts = new ContactShadows(2);
    contacts.begin(); contacts.add(0, 0, 0, 0, 1, 1); contacts.end();
    expect(contacts.mesh.visible).toBe(true);
    contacts.begin();
    contacts.add(NaN, 0, 0, 0, 1, 1); contacts.add(0, 0, 0, 0, -1, 1);
    contacts.end();
    expect(contacts.mesh.count).toBe(0); expect(contacts.mesh.visible).toBe(false);
    contacts.dispose();
  });
});
