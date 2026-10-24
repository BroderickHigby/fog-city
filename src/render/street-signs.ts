// Street-name blades, one-way signs and kerbside parking signs from the pipeline's
// street-signs.json (pipeline/lib/street-signs.ts), per street-detail cell. Render-only.
//
// Blades are SF's white-on-green street-name signs with the real names. Each cell draws its
// names into one canvas atlas (rows of BLADE_W x BLADE_H pixels) and merges its blades into
// one mesh; posts and the generic sign faces are instanced. Without a DOM (tests) the blades
// are plain green. Models face -z; the renderer sets rotation.y = -heading.

import * as THREE from "three";

export interface CornerRecord {
  id: string;
  x: number;
  z: number;
  blades: Array<{ name: string; heading: number }>;
  oneWay: number[];
}

export type CurbKind = "cleaning" | "permit" | "time" | "noParking" | "tow";

export interface CurbRecord {
  id: string;
  x: number;
  z: number;
  heading: number;
  kind: CurbKind;
}

/** Blade size (36 x 8 in), metres, and its first height above the ground. */
export const BLADE_W_M = 0.92;
export const BLADE_H_M = 0.2;
const BLADE_Y = 2.75;
const BLADE_GAP_M = 0.24;
const ONE_WAY_Y = 2.25;
const CURB_Y = 2.0;
const ATLAS_W = 512;
const ROW_H = 112;
const ROWS = 18;

/** The atlas rows a cell needs: one per distinct name, in first-seen order. */
export function bladeNames(corners: readonly CornerRecord[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of corners) for (const b of c.blades) if (!seen.has(b.name)) {
    seen.add(b.name);
    out.push(b.name);
  }
  return out;
}

/** Title-ish SF style: the name in capitals, the suffix smaller ("CHESTNUT" + "ST"). */
function splitName(name: string): [string, string] {
  const m = /^(.*?)\s+(ST|AVE|BLVD|WAY|DR|PL|TER|CT|LN|RD|ALY|HWY|CIR|PLZ|WALK|ROW|STPS|PATH)$/.exec(name);
  return m ? [m[1]!, m[2]!] : [name, ""];
}

function drawAtlas(names: readonly string[]): THREE.Texture | null {
  if (typeof document === "undefined" || !names.length) return null;
  const c = document.createElement("canvas");
  c.width = ATLAS_W;
  c.height = ROW_H * Math.min(ROWS, names.length);
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  names.slice(0, ROWS).forEach((name, i) => {
    const y = i * ROW_H;
    ctx.fillStyle = "#0b6a3b";
    ctx.fillRect(0, y, ATLAS_W, ROW_H);
    ctx.strokeStyle = "#f4f4ee";
    ctx.lineWidth = 6;
    ctx.strokeRect(7, y + 7, ATLAS_W - 14, ROW_H - 14);
    const [main, suffix] = splitName(name);
    ctx.fillStyle = "#f4f4ee";
    ctx.textBaseline = "middle";
    let size = 72;
    ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
    const sw = suffix ? ctx.measureText(` ${suffix}`).width * 0.6 : 0;
    while (size > 24 && ctx.measureText(main).width + sw > ATLAS_W - 48) {
      size -= 4;
      ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
    }
    const mw = ctx.measureText(main).width;
    ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
    const total = mw + (suffix ? ctx.measureText(` ${suffix}`).width * 0.6 : 0);
    let x = (ATLAS_W - total) / 2;
    ctx.fillText(main, x, y + ROW_H / 2 + 3);
    x += mw;
    if (suffix) {
      ctx.font = `bold ${Math.round(size * 0.6)}px Arial, Helvetica, sans-serif`;
      ctx.fillText(` ${suffix}`, x, y + ROW_H / 2 - size * 0.12);
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function faceTexture(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const text = (ctx: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, color: string): void => {
  ctx.fillStyle = color;
  ctx.font = `bold ${px}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(s, x, y);
};

/** Generic faces of the kerbside sign kinds (regulation layouts, no legends). */
function curbFace(kind: CurbKind): THREE.Texture | null {
  return faceTexture((ctx, w, h) => {
    ctx.fillStyle = "#f6f6f2";
    ctx.fillRect(0, 0, w, h);
    const ink = kind === "time" || kind === "permit" ? "#13703c" : "#b5121b";
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    if (kind === "cleaning") {
      text(ctx, "NO", w / 2, 30, 30, ink);
      text(ctx, "PARKING", w / 2, 62, 26, ink);
      text(ctx, "STREET", w / 2, 102, 20, "#222");
      text(ctx, "CLEANING", w / 2, 126, 20, "#222");
    } else if (kind === "permit") {
      text(ctx, "2 HOUR", w / 2, 36, 26, ink);
      text(ctx, "PARKING", w / 2, 66, 24, ink);
      text(ctx, "EXCEPT", w / 2, 104, 18, "#222");
      text(ctx, "PERMITS", w / 2, 126, 18, "#222");
    } else if (kind === "time") {
      text(ctx, "PARKING", w / 2, 40, 26, ink);
      text(ctx, "LIMITED", w / 2, 76, 22, "#222");
      text(ctx, "HOURS", w / 2, 110, 22, "#222");
    } else if (kind === "noParking") {
      text(ctx, "NO", w / 2, 42, 34, ink);
      text(ctx, "PARKING", w / 2, 82, 26, ink);
      text(ctx, "ANY TIME", w / 2, 118, 20, ink);
    } else {
      text(ctx, "TOW", w / 2, 40, 34, ink);
      text(ctx, "AWAY", w / 2, 78, 30, ink);
      text(ctx, "NO STOPPING", w / 2, 118, 16, "#222");
    }
  }, 128, 160);
}

const oneWayFace = (): THREE.Texture | null =>
  faceTexture((ctx, w, h) => {
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#f6f6f2";
    // A right-pointing arrow carrying the words.
    ctx.beginPath();
    ctx.moveTo(12, h * 0.32);
    ctx.lineTo(w * 0.74, h * 0.32);
    ctx.lineTo(w * 0.74, h * 0.12);
    ctx.lineTo(w - 10, h / 2);
    ctx.lineTo(w * 0.74, h * 0.88);
    ctx.lineTo(w * 0.74, h * 0.68);
    ctx.lineTo(12, h * 0.68);
    ctx.closePath();
    ctx.fill();
    text(ctx, "ONE WAY", w * 0.42, h / 2 + 2, 36, "#111");
  }, 256, 86);

interface Protos {
  post: THREE.BufferGeometry;
  oneWay: THREE.BufferGeometry;
  curb: THREE.BufferGeometry;
  back: THREE.BufferGeometry;
  metal: THREE.MeshStandardMaterial;
  backMat: THREE.MeshStandardMaterial;
  oneWayMat: THREE.MeshStandardMaterial;
  curbMats: Record<CurbKind, THREE.MeshStandardMaterial>;
}

let protos: Protos | null = null;

function getProtos(): Protos {
  if (protos) return protos;
  const mat = (map: THREE.Texture | null, fallback: number, name: string): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color: map ? 0xffffff : fallback, map, roughness: 0.55, name, side: THREE.FrontSide });
  protos = {
    post: new THREE.CylinderGeometry(0.035, 0.035, 3.0, 6).translate(0, 1.5, 0),
    // Faces -z (toward the viewer the heading points at), double-sided where it matters.
    oneWay: new THREE.PlaneGeometry(0.9, 0.3).rotateY(Math.PI),
    curb: new THREE.PlaneGeometry(0.3, 0.38).rotateY(Math.PI),
    back: new THREE.PlaneGeometry(1, 1),
    metal: new THREE.MeshStandardMaterial({ color: 0x8c908c, roughness: 0.5, metalness: 0.6, name: "fc:sign-post" }),
    backMat: new THREE.MeshStandardMaterial({ color: 0x9a9d9a, roughness: 0.6, metalness: 0.5, name: "fc:sign-back" }),
    oneWayMat: mat(oneWayFace(), 0x111111, "fc:one-way"),
    curbMats: {
      cleaning: mat(curbFace("cleaning"), 0xf0f0ea, "fc:sign-cleaning"),
      permit: mat(curbFace("permit"), 0xf0f0ea, "fc:sign-permit"),
      time: mat(curbFace("time"), 0xf0f0ea, "fc:sign-time"),
      noParking: mat(curbFace("noParking"), 0xf0f0ea, "fc:sign-noparking"),
      tow: mat(curbFace("tow"), 0xf0f0ea, "fc:sign-tow"),
    },
  };
  return protos;
}

/**
 * The blades of a cell as one mesh: each blade is two quads back to back (readable from both
 * sides), UVs into the cell's atlas row for its name.
 */
export function bladeGeometry(corners: readonly CornerRecord[], ground: (x: number, z: number) => number): { geometry: THREE.BufferGeometry; names: string[]; blades: number } {
  const names = bladeNames(corners).slice(0, ROWS);
  const row = new Map(names.map((n, i) => [n, i]));
  const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
  let blades = 0;
  for (const c of corners) {
    const gy = ground(c.x, c.z);
    c.blades.forEach((b, k) => {
      const r = row.get(b.name);
      if (r === undefined) return;
      // The blade lies along the street: its long axis is the heading direction.
      const ax = Math.sin(b.heading), az = -Math.cos(b.heading);
      const nx = -az, nz = ax;
      const y0 = gy + BLADE_Y + k * BLADE_GAP_M;
      const v0 = 1 - (r + 1) / names.length, v1 = 1 - r / names.length;
      for (const side of [1, -1]) {
        const base = pos.length / 3;
        const hx = (ax * BLADE_W_M) / 2, hz = (az * BLADE_W_M) / 2;
        const ox = nx * 0.006 * side, oz = nz * 0.006 * side;
        // Corners: left-bottom, right-bottom, right-top, left-top as seen from the `side` normal.
        const lx = side > 0 ? -hx : hx, lz = side > 0 ? -hz : hz;
        pos.push(c.x + lx + ox, y0, c.z + lz + oz, c.x - lx + ox, y0, c.z - lz + oz, c.x - lx + ox, y0 + BLADE_H_M, c.z - lz + oz, c.x + lx + ox, y0 + BLADE_H_M, c.z + lz + oz);
        uv.push(0, v0, 1, v0, 1, v1, 0, v1);
        for (let q = 0; q < 4; q++) nor.push(nx * side, 0, nz * side);
        // Wound counter-clockwise when seen from the normal's side.
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      blades++;
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return { geometry: g, names, blades };
}

/** One cell's sign posts, blades, one-way signs and kerbside signs. */
export class SignCell {
  readonly group = new THREE.Group();
  readonly blades: number;
  readonly posts: number;
  readonly curbSigns: number;
  private readonly owned: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [];

  constructor(corners: readonly CornerRecord[], curb: readonly CurbRecord[], ground: (x: number, z: number) => number) {
    const p = getProtos();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const local = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const place = (x: number, z: number, heading: number, ly = 0, lz = 0): THREE.Matrix4 => {
      q.setFromAxisAngle(up, -heading);
      local.set(0, ly, lz).applyQuaternion(q);
      pos.set(x + local.x, ground(x, z) + ly, z + local.z);
      return m.compose(pos, q, one).clone();
    };
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], name: string): void => {
      if (!mats.length) return;
      const im = new THREE.InstancedMesh(geo, mat, mats.length);
      mats.forEach((mm, k) => im.setMatrixAt(k, mm));
      im.computeBoundingSphere();
      im.name = name;
      im.castShadow = true;
      im.receiveShadow = true;
      im.matrixAutoUpdate = false;
      this.group.add(im);
    };

    const posts: THREE.Matrix4[] = [], ways: THREE.Matrix4[] = [], wayBacks: THREE.Matrix4[] = [];
    for (const c of corners) {
      posts.push(place(c.x, c.z, 0));
      for (const h of c.oneWay) {
        // The plate lies along the street, its arrow (pointing right on the face) along the
        // flow: a viewer whose right is the flow looks at a face turned 90° clockwise of it.
        ways.push(place(c.x, c.z, h + Math.PI / 2, ONE_WAY_Y, -0.04));
        wayBacks.push(place(c.x, c.z, h + Math.PI / 2, ONE_WAY_Y, -0.03).multiply(new THREE.Matrix4().makeScale(0.9, 0.3, 1)));
      }
    }
    const curbPosts: THREE.Matrix4[] = [];
    const faces: Record<CurbKind, THREE.Matrix4[]> = { cleaning: [], permit: [], time: [], noParking: [], tow: [] };
    for (const s of curb) {
      curbPosts.push(place(s.x, s.z, 0));
      faces[s.kind].push(place(s.x, s.z, s.heading, CURB_Y, -0.04));
      faces[s.kind].push(place(s.x, s.z, s.heading + Math.PI, CURB_Y, -0.04));
    }
    inst(p.post, p.metal, [...posts, ...curbPosts], "sign posts");
    inst(p.oneWay, p.oneWayMat, ways, "one-way signs");
    inst(p.back, p.backMat, wayBacks, "one-way sign backs");
    for (const k of Object.keys(faces) as CurbKind[]) inst(p.curb, p.curbMats[k], faces[k], `${k} signs`);

    const b = bladeGeometry(corners, ground);
    const atlas = drawAtlas(b.names);
    const bladeMat = new THREE.MeshStandardMaterial({ color: atlas ? 0xffffff : 0x0b6a3b, map: atlas, roughness: 0.5, name: "fc:street-blade" });
    const blades = new THREE.Mesh(b.geometry, bladeMat);
    blades.name = "street-name blades";
    blades.castShadow = true;
    blades.matrixAutoUpdate = false;
    this.group.add(blades);
    this.owned.push(b.geometry, bladeMat);
    if (atlas) this.owned.push(atlas);
    this.blades = b.blades;
    this.posts = corners.length;
    this.curbSigns = curb.length;
  }

  dispose(): void {
    for (const o of this.group.children) if (o instanceof THREE.InstancedMesh) o.dispose();
    for (const o of this.owned) o.dispose();
    this.group.clear();
  }
}
