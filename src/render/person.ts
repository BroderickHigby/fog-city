// People: a simple low-poly human placeholder (no model exists yet), about 1.75 m tall,
// built procedurally in the packed agent format (agent-packing.ts) so a crowd of them draws
// in three instanced draw calls: body, arms (two instances each), legs (two each); farther
// away, one merged low-detail copy (mid) or a few boxes (far). Clothing,
// skin and hair colours are per instance (fcSlot weights x fcColA..D), chosen from the
// agent id, so no two neighbours need look alike. The same builder draws the player on foot.
//
// Frame: origin at the feet, +y up, facing -z (the renderer sets rotation.y = -heading).
// Arms hang from the shoulder pivots, legs from the hip pivots; a positive rotation about
// +x swings a limb forward (toward -z), as for the errand robot's limbs.

import * as THREE from "three";
import { mergePacked, packGeometry, type PackedSurface } from "./agent-packing.ts";

export const PERSON_HEIGHT_M = 1.75;
/** Right shoulder and hip pivots (the left ones mirror x). */
export const SHOULDER: Readonly<[number, number, number]> = [0.205, 1.43, 0.01];
export const HIP: Readonly<[number, number, number]> = [0.095, 0.92, 0];
/** Half a gait cycle (one step), metres. */
export const STRIDE_M = 0.72;

export interface PersonParts {
  body: THREE.BufferGeometry;
  /** One arm, hanging from (0, 0, 0) at the shoulder. */
  arm: THREE.BufferGeometry;
  /** One leg, hanging from (0, 0, 0) at the hip. */
  leg: THREE.BufferGeometry;
  /** The whole person in the rest pose at low detail (~300 triangles). */
  mid: THREE.BufferGeometry;
  /** A few boxes (~80 triangles), for far away. */
  far: THREE.BufferGeometry;
}

type Slot = "shirt" | "pants" | "skin" | "hair" | null;

function surface(slot: Slot, base = 0x15171a, roughness = 0.85): PackedSurface {
  const c = new THREE.Color().setHex(base);
  return {
    color: [c.r, c.g, c.b],
    roughness,
    metalness: 0,
    emissive: [0, 0, 0],
    channel: 0,
    slot: [slot === "shirt" ? 1 : 0, slot === "pants" ? 1 : 0, slot === "skin" ? 1 : 0, slot === "hair" ? 1 : 0],
  };
}

const M = new THREE.Matrix4();

function at(g: THREE.BufferGeometry, s: PackedSurface, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  M.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
  const out = packGeometry(g, s, M, true);
  g.dispose();
  return out;
}

/** A limb segment from y0 down to y1 (y0 > y1) with radii r0 (top) and r1 (bottom). */
function segment(seg: number, r0: number, r1: number, y0: number, y1: number, s: PackedSurface, z = 0): THREE.BufferGeometry {
  return at(new THREE.CylinderGeometry(r0, r1, y0 - y1, seg, 1), s, 0, (y0 + y1) / 2, z);
}

/** A torso-like box whose top is scaled by (kx, kz). */
function tapered(w: number, h: number, d: number, kx: number, kz: number, s: PackedSurface, y: number, seg = 1): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, seg, 1, seg);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * kx);
      p.setZ(i, p.getZ(i) * kz);
    }
  }
  g.computeVertexNormals();
  return at(g, s, 0, y, 0);
}

function build(detail: "near" | "far"): { body: THREE.BufferGeometry; arm: THREE.BufferGeometry; leg: THREE.BufferGeometry } {
  const near = detail === "near";
  const seg = near ? 8 : 5;
  const shirt = surface("shirt");
  const pants = surface("pants");
  const skin = surface("skin", 0x15171a, 0.6);
  const hair = surface("hair", 0x15171a, 0.9);
  const shoe = surface(null, 0x1a1b1e, 0.7);

  const body: THREE.BufferGeometry[] = [
    tapered(0.33, 0.2, 0.21, 1.0, 1.0, pants, 0.92),
    tapered(0.33, 0.47, 0.22, 1.27, 1.02, shirt, 1.235),
    at(new THREE.CylinderGeometry(0.048, 0.055, 0.1, seg), skin, 0, 1.51, 0),
    at(new THREE.SphereGeometry(0.105, near ? 12 : 6, near ? 9 : 4), skin, 0, 1.635, 0, 1, 1.12, 1.02),
    // Hair: a cap over the crown, and down the back of the head (z >= 0) to the nape.
    at(new THREE.SphereGeometry(0.112, near ? 12 : 6, near ? 4 : 2, 0, Math.PI * 2, 0, Math.PI * 0.3), hair, 0, 1.645, 0.006, 1, 1.12, 1.04),
  ];
  if (near) body.push(at(new THREE.SphereGeometry(0.111, 8, 5, 0, Math.PI, Math.PI * 0.25, Math.PI * 0.42), hair, 0, 1.645, 0.006, 1.01, 1.12, 1.05));
  if (near) {
    for (const x of [-SHOULDER[0], SHOULDER[0]]) body.push(at(new THREE.SphereGeometry(0.062, 8, 6), shirt, x * 0.94, SHOULDER[1] - 0.005, SHOULDER[2]));
    body.push(at(new THREE.BoxGeometry(0.03, 0.025, 0.04), skin, 0, 1.625, -0.105));
  }

  const arm = mergePacked([
    segment(seg, 0.052, 0.045, 0.02, -0.3, shirt),
    segment(seg, 0.044, 0.038, -0.29, -0.55, shirt),
    at(new THREE.SphereGeometry(0.042, near ? 8 : 4, near ? 6 : 3), skin, 0, -0.6, 0, 0.8, 1.15, 1),
  ]);
  const leg = mergePacked([
    segment(seg, 0.078, 0.06, 0.02, -0.46, pants),
    segment(seg, 0.058, 0.046, -0.45, -0.85, pants),
    at(new THREE.BoxGeometry(0.1, 0.07, 0.25), shoe, 0, -0.885, -0.045),
  ]);
  return { body: mergePacked(body), arm, leg };
}

let cached: PersonParts | null = null;

/** The shared person geometry (built once). */
export function personParts(): PersonParts {
  if (cached) return cached;
  const near = build("near");
  const lo = build("far");
  const place = (g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry => {
    const c = g.clone();
    c.translate(x, y, z);
    return c;
  };
  const pieces = [
    lo.body,
    place(lo.arm, SHOULDER[0], SHOULDER[1], SHOULDER[2]),
    place(lo.arm, -SHOULDER[0], SHOULDER[1], SHOULDER[2]),
    place(lo.leg, HIP[0], HIP[1], HIP[2]),
    place(lo.leg, -HIP[0], HIP[1], HIP[2]),
  ];
  const mid = mergePacked(pieces);
  for (const g of [...pieces, lo.arm, lo.leg]) g.dispose();
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, sf: PackedSurface): THREE.BufferGeometry =>
    at(new THREE.BoxGeometry(w, h, d), sf, x, y, z);
  const far = mergePacked([
    box(0.13, 0.86, 0.15, -HIP[0], 0.45, 0, surface("pants")),
    box(0.13, 0.86, 0.15, HIP[0], 0.45, 0, surface("pants")),
    box(0.4, 0.52, 0.23, 0, 1.2, 0, surface("shirt")),
    box(0.09, 0.6, 0.1, -SHOULDER[0] - 0.02, 1.13, 0, surface("shirt")),
    box(0.09, 0.6, 0.1, SHOULDER[0] + 0.02, 1.13, 0, surface("shirt")),
    box(0.19, 0.24, 0.21, 0, 1.62, 0, surface("skin", 0x15171a, 0.6)),
    box(0.2, 0.06, 0.22, 0, 1.75, 0.01, surface("hair", 0x15171a, 0.9)),
  ]);
  cached = { body: near.body, arm: near.arm, leg: near.leg, mid, far };
  return cached;
}

// ---------------------------------------------------------------- looks

const SHIRTS = [
  0x2f4f7f, 0x8a3b3b, 0x3f6f4a, 0xc9a23a, 0x6b6f76, 0x26282c, 0xd9d6cf, 0x2f7f7a, 0x6a2a3a, 0xc8642a, 0x8b7fb0, 0x6b6b3a, 0x4a6a8f,
  0xa9824f, 0x9aa3ab, 0xb84a62,
];
const PANTS = [0x34496b, 0x23304a, 0x1e1f22, 0x9c8a62, 0x55585e, 0x4e5236, 0x262f45, 0x6e5a48];
const SKIN = [0xf1c7a5, 0xe0ac86, 0xc68e64, 0xa5714b, 0x8d5a3b, 0x6b4229, 0x4f3020];
const HAIR = [0x1b1612, 0x2a1f17, 0x3b2a1e, 0x6b4a2e, 0xb08a52, 0x8a8a88, 0x7a3d1f, 0xd8d2c8];

export interface PersonLook {
  shirt: THREE.Color;
  pants: THREE.Color;
  skin: THREE.Color;
  hair: THREE.Color;
  /** Uniform scale around PERSON_HEIGHT_M: 0.93 .. 1.07. */
  scale: number;
}

export function newLook(): PersonLook {
  return { shirt: new THREE.Color(), pants: new THREE.Color(), skin: new THREE.Color(), hair: new THREE.Color(), scale: 1 };
}

/** A stable 32-bit hash of (id, salt). */
function hash(id: number, salt: number): number {
  let h = Math.imul((id | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The look of person `id`: the same id always looks the same. Fills and returns `out`. */
export function personLook(id: number, out: PersonLook): PersonLook {
  out.shirt.setHex(SHIRTS[hash(id, 1) % SHIRTS.length]!);
  out.pants.setHex(PANTS[hash(id, 2) % PANTS.length]!);
  out.skin.setHex(SKIN[hash(id, 3) % SKIN.length]!);
  out.hair.setHex(HAIR[hash(id, 4) % HAIR.length]!);
  out.scale = 0.93 + (hash(id, 5) % 1000) / 1000 * 0.14;
  return out;
}
