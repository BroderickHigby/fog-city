// Storefront signs from storefronts.json (pipeline/lib/storefronts.ts), per street-detail cell.
// Render-only. Storefronts stay unnamed (docs/design.md: "iconography only, with an empty sign
// slot reserved"): each shop gets a blank fascia band over its door (the reserved sign slot) and
// a projecting blade sign showing only its trade's icon; bars get a beer-mug neon in the window
// and barbers a striped pole. No names, words or logos anywhere.
//
// The anchor stands 0.3 m outside the shopfront wall, `heading` = the way the shop faces.

import * as THREE from "three";

export interface StorefrontRecord {
  id: string;
  x: number;
  z: number;
  heading: number;
  category: string;
}

/** Icons in the atlas, one cell each, in this order. Categories map onto them below. */
export const ICONS = ["cup", "fork", "burger", "mug", "scissors", "comb", "bag", "hanger", "flower", "cross", "hammer", "basket", "bubbles", "wrench", "sofa", "bottle", "plug", "pump", "drop", "star", "box"] as const;
export type Icon = (typeof ICONS)[number];

const CATEGORY_ICON: Record<string, Icon> = {
  cafe: "cup",
  restaurant: "fork",
  "fast-food": "burger",
  bar: "mug",
  barber: "scissors",
  salon: "comb",
  nails: "drop",
  "personal-care": "drop",
  retail: "bag",
  general: "bag",
  clothing: "hanger",
  florist: "flower",
  pharmacy: "cross",
  hardware: "hammer",
  grocery: "basket",
  "specialty-food": "basket",
  laundry: "bubbles",
  auto: "wrench",
  furniture: "sofa",
  liquor: "bottle",
  electronics: "plug",
  fuel: "pump",
  hobby: "star",
};

export function iconFor(category: string): Icon {
  return CATEGORY_ICON[category] ?? "box";
}

const COLS = 7;
const CELL = 128;

function drawIcon(ctx: CanvasRenderingContext2D, icon: Icon, cx: number, cy: number): void {
  const s = CELL * 0.32;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = "#f3efe4";
  ctx.fillStyle = "#f3efe4";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const line = (pts: number[]): void => {
    ctx.beginPath();
    ctx.moveTo(pts[0]! * s, pts[1]! * s);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]! * s, pts[i + 1]! * s);
    ctx.stroke();
  };
  const circle = (x: number, y: number, r: number, fill = false): void => {
    ctx.beginPath();
    ctx.arc(x * s, y * s, r * s, 0, Math.PI * 2);
    if (fill) ctx.fill();
    else ctx.stroke();
  };
  switch (icon) {
    case "cup":
      line([-0.6, -0.3, -0.5, 0.6, 0.4, 0.6, 0.5, -0.3, -0.6, -0.3]);
      ctx.beginPath();
      ctx.arc(0.6 * s, 0.1 * s, 0.25 * s, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      line([-0.25, -0.55, -0.15, -0.8]);
      line([0.1, -0.55, 0.2, -0.8]);
      break;
    case "fork":
      line([-0.4, -0.8, -0.4, 0.8]);
      line([-0.6, -0.8, -0.6, -0.3, -0.2, -0.3, -0.2, -0.8]);
      line([0.4, -0.8, 0.4, 0.8]);
      line([0.4, -0.8, 0.65, -0.4, 0.4, 0]);
      break;
    case "burger":
      ctx.beginPath();
      ctx.arc(0, 0, 0.75 * s, Math.PI, 0);
      ctx.stroke();
      line([-0.8, 0.15, 0.8, 0.15]);
      line([-0.75, 0.5, 0.75, 0.5]);
      break;
    case "mug":
      line([-0.55, -0.6, -0.55, 0.7, 0.35, 0.7, 0.35, -0.6]);
      ctx.beginPath();
      ctx.arc(0.5 * s, 0.05 * s, 0.3 * s, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      circle(-0.35, -0.75, 0.2, true);
      circle(0, -0.8, 0.22, true);
      circle(0.25, -0.72, 0.18, true);
      break;
    case "scissors":
      circle(-0.35, 0.55, 0.25);
      circle(0.35, 0.55, 0.25);
      line([-0.25, 0.35, 0.45, -0.8]);
      line([0.25, 0.35, -0.45, -0.8]);
      break;
    case "comb":
      line([-0.8, -0.2, 0.8, -0.2]);
      for (let k = -0.7; k <= 0.71; k += 0.2) line([k, -0.2, k, 0.4]);
      break;
    case "bag":
      line([-0.6, -0.3, -0.7, 0.75, 0.7, 0.75, 0.6, -0.3, -0.6, -0.3]);
      ctx.beginPath();
      ctx.arc(0, -0.3 * s, 0.3 * s, Math.PI, 0);
      ctx.stroke();
      break;
    case "hanger":
      line([-0.8, 0.5, 0, 0, 0.8, 0.5, -0.8, 0.5]);
      line([0, 0, 0, -0.3]);
      ctx.beginPath();
      ctx.arc(0.15 * s, -0.45 * s, 0.17 * s, Math.PI * 0.8, Math.PI * 2.4);
      ctx.stroke();
      break;
    case "flower":
      for (let k = 0; k < 5; k++) circle(Math.cos((k * 2 * Math.PI) / 5) * 0.35, Math.sin((k * 2 * Math.PI) / 5) * 0.35 - 0.2, 0.22);
      circle(0, -0.2, 0.12, true);
      line([0, 0.2, 0, 0.85]);
      break;
    case "cross":
      ctx.fillRect(-0.25 * s, -0.75 * s, 0.5 * s, 1.5 * s);
      ctx.fillRect(-0.75 * s, -0.25 * s, 1.5 * s, 0.5 * s);
      break;
    case "hammer":
      line([0.1, -0.3, -0.45, 0.8]);
      line([-0.4, -0.6, 0.6, -0.1]);
      break;
    case "basket":
      line([-0.75, -0.1, -0.55, 0.7, 0.55, 0.7, 0.75, -0.1, -0.75, -0.1]);
      line([-0.4, -0.1, -0.15, -0.65]);
      line([0.4, -0.1, 0.15, -0.65]);
      break;
    case "bubbles":
      circle(-0.3, 0.25, 0.35);
      circle(0.35, -0.2, 0.28);
      circle(0.25, 0.55, 0.15);
      circle(-0.35, -0.5, 0.15);
      break;
    case "wrench":
      line([-0.6, 0.6, 0.25, -0.25]);
      ctx.beginPath();
      ctx.arc(0.4 * s, -0.4 * s, 0.3 * s, Math.PI * 0.9, Math.PI * 2.6);
      ctx.stroke();
      break;
    case "sofa":
      line([-0.8, 0.5, -0.8, -0.1, 0.8, -0.1, 0.8, 0.5]);
      line([-0.6, -0.1, -0.6, -0.5, 0.6, -0.5, 0.6, -0.1]);
      line([-0.8, 0.5, 0.8, 0.5]);
      break;
    case "bottle":
      line([-0.15, -0.85, -0.15, -0.4, -0.35, -0.15, -0.35, 0.8, 0.35, 0.8, 0.35, -0.15, 0.15, -0.4, 0.15, -0.85]);
      break;
    case "plug":
      line([-0.4, -0.2, 0.4, -0.2, 0.4, 0.25, 0, 0.55, -0.4, 0.25, -0.4, -0.2]);
      line([-0.2, -0.2, -0.2, -0.7]);
      line([0.2, -0.2, 0.2, -0.7]);
      line([0, 0.55, 0, 0.85]);
      break;
    case "pump":
      line([-0.55, 0.8, -0.55, -0.7, 0.25, -0.7, 0.25, 0.8]);
      line([-0.4, -0.45, 0.1, -0.45, 0.1, -0.1, -0.4, -0.1, -0.4, -0.45]);
      line([0.25, -0.3, 0.55, -0.1, 0.55, 0.5]);
      break;
    case "drop":
      ctx.beginPath();
      ctx.moveTo(0, -0.8 * s);
      ctx.quadraticCurveTo(0.6 * s, 0, 0.45 * s, 0.35 * s);
      ctx.arc(0, 0.3 * s, 0.45 * s, 0, Math.PI);
      ctx.quadraticCurveTo(-0.6 * s, 0, 0, -0.8 * s);
      ctx.stroke();
      break;
    case "star":
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const r = (k % 2 ? 0.35 : 0.8) * s, a = -Math.PI / 2 + (k * Math.PI) / 5;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.stroke();
      break;
    default:
      line([-0.6, -0.5, 0.6, -0.5, 0.6, 0.6, -0.6, 0.6, -0.6, -0.5]);
  }
  ctx.restore();
}

/** UV rectangle [u0, v0, u1, v1] of an icon in the atlas. */
export function iconUv(icon: Icon): [number, number, number, number] {
  const i = ICONS.indexOf(icon);
  const rows = Math.ceil(ICONS.length / COLS);
  const c = i % COLS, r = Math.floor(i / COLS);
  return [c / COLS, 1 - (r + 1) / rows, (c + 1) / COLS, 1 - r / rows];
}

interface Protos {
  atlas: THREE.MeshStandardMaterial;
  fascia: THREE.MeshStandardMaterial;
  bracket: THREE.MeshStandardMaterial;
  neon: THREE.MeshBasicMaterial;
  pole: THREE.MeshStandardMaterial;
  poleGeo: THREE.BufferGeometry;
  boxGeo: THREE.BufferGeometry;
}

let protos: Protos | null = null;

function getProtos(): Protos {
  if (protos) return protos;
  let atlas: THREE.Texture | null = null, neon: THREE.Texture | null = null, stripes: THREE.Texture | null = null;
  if (typeof document !== "undefined") {
    const rows = Math.ceil(ICONS.length / COLS);
    const c = document.createElement("canvas");
    c.width = COLS * CELL;
    c.height = rows * CELL;
    const ctx = c.getContext("2d");
    if (ctx) {
      // Blade signs: a dark enamel plate with a cream rim and the icon.
      ICONS.forEach((icon, i) => {
        const x = (i % COLS) * CELL, y = Math.floor(i / COLS) * CELL;
        ctx.fillStyle = ["#1f3b4d", "#5a2a27", "#2f4a2b", "#3b2f4f"][i % 4]!;
        ctx.fillRect(x, y, CELL, CELL);
        ctx.strokeStyle = "#e9dfc6";
        ctx.lineWidth = 6;
        ctx.strokeRect(x + 6, y + 6, CELL - 12, CELL - 12);
        drawIcon(ctx, icon, x + CELL / 2, y + CELL / 2);
      });
      atlas = new THREE.CanvasTexture(c);
      atlas.colorSpace = THREE.SRGBColorSpace;
      atlas.anisotropy = 4;
    }
    const n = document.createElement("canvas");
    n.width = n.height = CELL;
    const nctx = n.getContext("2d");
    if (nctx) {
      nctx.clearRect(0, 0, CELL, CELL);
      nctx.shadowColor = "#ffb347";
      nctx.shadowBlur = 12;
      drawIcon(nctx, "mug", CELL / 2, CELL / 2);
      neon = new THREE.CanvasTexture(n);
      neon.colorSpace = THREE.SRGBColorSpace;
    }
    const st = document.createElement("canvas");
    st.width = 64;
    st.height = 64;
    const sctx = st.getContext("2d");
    if (sctx) {
      sctx.fillStyle = "#f4f2ec";
      sctx.fillRect(0, 0, 64, 64);
      for (const [color, off] of [["#c4232b", 0], ["#25459a", 32]] as const) {
        sctx.fillStyle = color;
        sctx.beginPath();
        sctx.moveTo(0, off);
        sctx.lineTo(64, off - 32);
        sctx.lineTo(64, off - 16);
        sctx.lineTo(0, off + 16);
        sctx.fill();
        sctx.beginPath();
        sctx.moveTo(0, off + 64);
        sctx.lineTo(64, off + 32);
        sctx.lineTo(64, off + 48);
        sctx.lineTo(0, off + 80);
        sctx.fill();
      }
      stripes = new THREE.CanvasTexture(st);
      stripes.wrapS = stripes.wrapT = THREE.RepeatWrapping;
      stripes.repeat.set(1, 3);
      stripes.colorSpace = THREE.SRGBColorSpace;
    }
  }
  protos = {
    atlas: new THREE.MeshStandardMaterial({ color: atlas ? 0xffffff : 0x2a3b45, map: atlas, roughness: 0.55, name: "fc:storefront-blade" }),
    fascia: new THREE.MeshStandardMaterial({ color: 0x2b2f31, roughness: 0.7, name: "fc:storefront-fascia" }),
    bracket: new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7, name: "fc:storefront-bracket" }),
    neon: new THREE.MeshBasicMaterial({ color: 0xffb347, map: neon, transparent: !!neon, alphaTest: neon ? 0.2 : 0, side: THREE.DoubleSide, name: "fc:storefront-neon" }),
    pole: new THREE.MeshStandardMaterial({ color: stripes ? 0xffffff : 0xc4232b, map: stripes, roughness: 0.35, name: "fc:barber-pole" }),
    poleGeo: new THREE.CylinderGeometry(0.09, 0.09, 0.8, 12).translate(0, 0.4, 0),
    boxGeo: new THREE.BoxGeometry(1, 1, 1),
  };
  return protos;
}

const BLADE_M = 0.62;
const BLADE_Y = 3.1;
const FASCIA_Y = 3.15;

/** One cell's storefront signs. */
export class StorefrontCell {
  readonly group = new THREE.Group();
  readonly signs: number;
  private readonly owned: THREE.BufferGeometry[] = [];

  constructor(shops: readonly StorefrontRecord[], ground: (x: number, z: number) => number) {
    const p = getProtos();
    this.signs = shops.length;
    // Blade signs: one merged mesh (two faces each), UVs into the icon atlas.
    const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const fascia: THREE.Matrix4[] = [], brackets: THREE.Matrix4[] = [], neons: THREE.Matrix4[] = [], poles: THREE.Matrix4[] = [];
    for (const s of shops) {
      const fx = Math.sin(s.heading), fz = -Math.cos(s.heading); // out of the shop
      const rx = -fz, rz = fx; // along the wall
      const wx = s.x - fx * 0.3, wz = s.z - fz * 0.3; // the wall line
      const gy = ground(s.x, s.z);
      // The blade sits beside the door: 0.9 m along the wall, sticking out 0.2 to 0.82 m.
      const bx = wx + rx * 0.9, bz = wz + rz * 0.9;
      const [u0, v0, u1, v1] = iconUv(iconFor(s.category));
      const y0 = gy + BLADE_Y - BLADE_M / 2, y1 = y0 + BLADE_M;
      for (const side of [1, -1]) {
        const base = pos.length / 3;
        const ox = rx * 0.01 * side, oz = rz * 0.01 * side;
        const ax = bx + fx * 0.2 + ox, az = bz + fz * 0.2 + oz;
        const cx = bx + fx * (0.2 + BLADE_M) + ox, cz = bz + fz * (0.2 + BLADE_M) + oz;
        // Seen from the `side` normal, the wall-side edge is on the left for side +1, the right for -1.
        const [lx, lz, rxx, rzz] = side > 0 ? [ax, az, cx, cz] : [cx, cz, ax, az];
        pos.push(lx, y0, lz, rxx, y0, rzz, rxx, y1, rzz, lx, y1, lz);
        uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
        for (let k = 0; k < 4; k++) nor.push(rx * side, 0, rz * side);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      q.setFromAxisAngle(up, -s.heading);
      brackets.push(m.compose(v.set(bx + fx * 0.5, gy + BLADE_Y + BLADE_M / 2 + 0.04, bz + fz * 0.5), q, sc.set(0.04, 0.04, 0.68)).clone());
      // The reserved sign slot: a blank band across the shopfront above the door.
      fascia.push(m.compose(v.set(wx + fx * 0.06, gy + FASCIA_Y, wz + fz * 0.06), q, sc.set(2.6, 0.55, 0.08)).clone());
      if (s.category === "bar") neons.push(m.compose(v.set(wx - rx * 0.9 + fx * 0.04, gy + 1.7, wz - rz * 0.9 + fz * 0.04), q, sc.set(0.7, 0.7, 1)).clone());
      if (s.category === "barber") poles.push(m.compose(v.set(wx - rx * 1.4 + fx * 0.15, gy + 2.0, wz - rz * 1.4 + fz * 0.15), q, sc.set(1, 1, 1)).clone());
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.owned.push(g);
    const blades = new THREE.Mesh(g, p.atlas);
    blades.name = "storefront blades";
    blades.castShadow = true;
    blades.matrixAutoUpdate = false;
    this.group.add(blades);
    const neonGeo = new THREE.PlaneGeometry(1, 1).rotateY(Math.PI);
    this.owned.push(neonGeo);
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], name: string): void => {
      if (!mats.length) return;
      const im = new THREE.InstancedMesh(geo, mat, mats.length);
      mats.forEach((mm, k) => im.setMatrixAt(k, mm));
      im.computeBoundingSphere();
      im.name = name;
      im.matrixAutoUpdate = false;
      this.group.add(im);
    };
    inst(p.boxGeo, p.fascia, fascia, "storefront sign slots");
    inst(p.boxGeo, p.bracket, brackets, "storefront brackets");
    inst(neonGeo, p.neon, neons, "bar neons");
    inst(p.poleGeo, p.pole, poles, "barber poles");
  }

  dispose(): void {
    for (const o of this.group.children) if (o instanceof THREE.InstancedMesh) o.dispose();
    for (const g of this.owned) g.dispose();
    this.group.clear();
  }
}
