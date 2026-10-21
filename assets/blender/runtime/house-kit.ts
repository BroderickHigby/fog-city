// Layout maths for the house-kit prototypes (public/models/house-kit/, contract in
// house-kit.json, built by assets/blender/models/house_kit.py). Pure functions: given a house's
// numbers (front length, storeys, the first floor's rise above the sidewalk, a stair's profile)
// they return instance transforms for the renderer's InstancedMesh (column-major 4x4 arrays,
// three.js Matrix4.fromArray) in a local frame the caller places in the world.
//
// Frames.
// - Facade frame: origin on the wall's outer face at its middle, at the sidewalk (the house's
//   street level, house-kit-spec K0 `streetY`); +x along the wall (the facade's right, seen
//   from behind it), +y up, -z out of the wall (into the street). Place it in the world with
//   rotation.y = -heading, heading = the compass bearing the facade faces.
// - Path frame (stairs): origin on the path's centreline at its start, +x to the right, +y up,
//   -z forward along the path; a point s metres along the path is at z = -s.
// Tested in tests/assets/house-kit.test.ts.

export type Mat4 = number[];

export interface Instance {
  /** Prototype file key in house-kit.json ("bay-italianate", "stoop", ...). */
  proto: string;
  /** Node inside the prototype GLB ("storey", "cap", "step", ...). */
  node: string;
  matrix: Mat4;
}

export interface KitDoc {
  version: number;
  storeyM: number;
  slots: Array<{ id: number; name: string; default: string }>;
  rules: { bayEveryM: number; bayMinFrontM: number; bayMaxYear: number; stoopMinRiseM: number; rooflineMaxAboveM: number };
  prototypes: Record<string, Record<string, unknown> & { kind: string; file: string; budget: number }>;
}

/** T(t) * shear/scale: x' = sx*x + tx; y' = sy*y + kyz*z + ty; z' = sz*z + tz. */
export function affine(t: [number, number, number], s: [number, number, number], kyz = 0): Mat4 {
  return [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, kyz, s[2], 0, t[0], t[1], t[2], 1];
}

/** Apply a column-major matrix to a point. */
export function apply(m: Mat4, p: [number, number, number]): [number, number, number] {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

// ------------------------------------------------------------------------------- bays

export interface BayOptions {
  /** Bay prototype key: "bay-italianate", "bay-queen-anne", "bay-edwardian", "bay-turret". */
  proto: string;
  /** Length of the front wall, metres. */
  frontM: number;
  /** Storeys the house shows on its front (K2), including the ground storey. */
  storeys: number;
  /** Storey height the facade is drawn with (K2), metres. */
  storeyM: number;
  /** The wall's top above the sidewalk (the collider's topY - streetY), metres. */
  roofM: number;
  /** The first floor's height above the sidewalk (a raised Victorian parlour floor), default 0. */
  floorM?: number;
  /** How far the front's roofline moulding hangs below the roof line (its profile's drop), default 0. */
  rooflineDropM?: number;
}

/**
 * One bay per bayEveryM of front (at least one when the front is bayMinFrontM or more), evenly
 * spaced, on storeys 1 to n-1: they start on the second floor, clear of the sidewalk; where the
 * first floor is raised 1.5 m or more (floorM, a Victorian parlour over the basement), they
 * start on it. A bay's cap must stay under the roof line (+ rooflineMaxAboveM) and clear of the
 * front's cornice or coping (rooflineDropM); storeys are dropped from the top until it does,
 * except the corner turret, whose cone rises above the roof as built.
 */
export function bayLayout(kit: KitDoc, o: BayOptions): Instance[] {
  const p = kit.prototypes[o.proto];
  if (!p || p.kind !== "bay") throw new Error(`not a bay prototype: ${o.proto}`);
  if (o.frontM < kit.rules.bayMinFrontM || o.storeys < 2) return [];
  const count = Math.max(1, Math.floor(o.frontM / kit.rules.bayEveryM));
  const capM = p.capM as number;
  const corner = p.corner === true;
  const floor = o.floorM ?? 0;
  const first = floor >= 1.5 ? 0 : 1;
  let top = o.storeys - 1; // index of the bay's top storey
  const ceiling = o.roofM - (o.rooflineDropM ?? 0) + kit.rules.rooflineMaxAboveM;
  while (!corner && top >= first && floor + (top + 1) * o.storeyM + capM > ceiling) top--;
  if (top < first) return [];
  const out: Instance[] = [];
  const sy = o.storeyM / kit.storeyM;
  for (let i = 0; i < count; i++) {
    const x = corner ? o.frontM / 2 : -o.frontM / 2 + ((i + 0.5) * o.frontM) / count;
    for (let s = first; s <= top; s++) out.push({ proto: o.proto, node: "storey", matrix: affine([x, floor + s * o.storeyM, 0], [1, sy, 1]) });
    out.push({ proto: o.proto, node: "cap", matrix: affine([x, floor + (top + 1) * o.storeyM, 0], [1, 1, 1]) });
    if (corner) break;
  }
  return out;
}

// ------------------------------------------------------------------------------ stoops

export interface StoopOptions {
  /** The first floor's height above the sidewalk at the door, metres. */
  riseM: number;
  /** Door position along the wall (facade frame x), metres. */
  x: number;
  /** Stair width, metres (default the door's width + 0.4). */
  widthM?: number;
  /** Iron railings on the cheek walls (Victorian), else plain stucco cheeks. */
  rails?: boolean;
}

export interface StoopPlan {
  risers: number;
  riserM: number;
  goingM: number;
  /** How far the stoop reaches out from the wall, metres. */
  reachM: number;
  instances: Instance[];
}

/**
 * A straight stoop from the sidewalk up to the door: a landing at the door, then treads down
 * and out toward the street, every riser the same height (about 0.18 m), solid down below the
 * sidewalk; cheek walls either side whose tops follow the stair, sheared; the door frame at
 * the threshold. Below stoopMinRiseM it is the door and a step or two, without cheeks.
 */
export function stoopLayout(kit: KitDoc, o: StoopOptions): StoopPlan {
  const s = kit.prototypes["stoop"]!;
  const rise = Math.max(0, o.riseM);
  const riseM = s.riseM as number;
  const going = s.goingM as number;
  const landing = s.landingM as number;
  const width = o.widthM ?? (s.doorWidthM as number) + 0.4;
  const cheek = s.cheekM as number;
  const cheekTop = s.cheekTopM as number;
  const out: Instance[] = [{ proto: "stoop", node: "door", matrix: affine([o.x, rise, 0], [1, 1, 1]) }];
  if (rise < 0.1) return { risers: 0, riserM: 0, goingM: going, reachM: 0, instances: out };
  const n = Math.min(Math.max(Math.round(rise / riseM), 1), s.maxRisers as number);
  const r = rise / n;
  const sink = 0.3;
  out.push({ proto: "stoop", node: "landing", matrix: affine([o.x, rise, 0], [width, rise + sink, landing]) });
  for (let i = 1; i < n; i++) {
    const top = rise - i * r;
    out.push({ proto: "stoop", node: "step", matrix: affine([o.x, top, -(landing + (i - 1) * going)], [width, top + sink, going]) });
  }
  const run = (n - 1) * going;
  const reach = landing + run;
  if (rise >= kit.rules.stoopMinRiseM) {
    for (const side of [-1, 1]) {
      const cx = o.x + side * (width / 2 + cheek / 2);
      // over the landing: flat top; along the stair: the top falls with the treads (sheared)
      const t0 = rise + cheekTop;
      out.push({ proto: "stoop", node: "cheek", matrix: affine([cx, t0, 0], [cheek, t0 + sink, landing]) });
      if (n > 1) {
        const t1 = r + cheekTop; // over the last tread
        const k = t0 - t1; // the top drops k over the run (unit z -1..0 -> shear)
        out.push({ proto: "stoop", node: "cheek", matrix: affine([cx, t0, -landing], [cheek, t0 + sink, run], k) });
        if (o.rails) out.push({ proto: "stoop", node: "rail", matrix: affine([cx, t0 + 0.05, -landing], [1, (s.railM as number), run], k) });
      }
    }
  }
  return { risers: n, riserM: r, goingM: going, reachM: reach, instances: out };
}

// -------------------------------------------------------------------------- roofline

/**
 * Roofline segments along a front wall: whole 1 m segments, stretched to fit the wall exactly,
 * and the profile's end at each end of the run.
 */
export function rooflineLayout(kit: KitDoc, proto: string, frontM: number, roofM: number): Instance[] {
  const p = kit.prototypes[proto];
  if (!p || p.kind !== "roofline") throw new Error(`not a roofline prototype: ${proto}`);
  const n = Math.max(1, Math.round(frontM / (p.lengthM as number)));
  const sx = frontM / n / (p.lengthM as number);
  const out: Instance[] = [];
  for (let i = 0; i < n; i++) out.push({ proto, node: "segment", matrix: affine([-frontM / 2 + (i * frontM) / n, roofM, 0], [sx, 1, 1]) });
  for (const x of [-frontM / 2, frontM / 2]) out.push({ proto, node: "end", matrix: affine([x, roofM, 0], [1, 1, 1]) });
  return out;
}

// --------------------------------------------------------------------------- stairs

export interface StairPlan {
  risers: number;
  maxRiserM: number;
  minGoingM: number;
  instances: Instance[];
}

/**
 * Steps along a path profile [[s, y], ...] (distance along the path, height), for a public
 * stairway: wherever the grade reaches minGrade, the rise is split into equal risers of about
 * riseM spread evenly over that run, tread tops following the profile within a riser; flatter
 * stretches are landings. Every block is solid down to below the lowest ground under it. A
 * curb runs along each side; handrails on request.
 */
export function stairLayout(kit: KitDoc, profile: ReadonlyArray<readonly [number, number]>, widthM: number, handrails = false): StairPlan {
  const st = kit.prototypes["stair-flight"]!;
  const riseM = st.riseM as number;
  const minGrade = st.minGrade as number;
  const curb = st.curbM as number;
  const out: Instance[] = [];
  let risers = 0;
  let maxRiser = 0;
  let minGoing = Infinity;
  const sink = 0.4;
  for (let i = 0; i + 1 < profile.length; i++) {
    const [s0, y0] = profile[i]!;
    const [s1, y1] = profile[i + 1]!;
    const ds = s1 - s0;
    const dy = y1 - y0;
    if (ds <= 0) continue;
    const low = Math.min(y0, y1);
    if (Math.abs(dy) / ds < minGrade) {
      out.push({ proto: "stair-flight", node: "landing", matrix: affine([0, y0, -s0], [widthM, y0 - low + sink, ds], -dy) });
      continue;
    }
    const n = Math.max(1, Math.round(Math.abs(dy) / riseM));
    const r = dy / n;
    const g = ds / n;
    risers += n;
    maxRiser = Math.max(maxRiser, Math.abs(r));
    minGoing = Math.min(minGoing, g);
    for (let k = 0; k < n; k++) {
      const top = y0 + (k + (r > 0 ? 1 : 0)) * r;
      out.push({ proto: "stair-flight", node: "step", matrix: affine([0, top, -(s0 + k * g)], [widthM, top - low + sink, g]) });
    }
    for (const side of [-1, 1]) {
      const cx = side * (widthM / 2 + curb / 2);
      const t0 = y0 + 0.15;
      out.push({ proto: "stair-flight", node: "curb", matrix: affine([cx, t0, -s0], [curb, t0 - low + sink, ds], -dy) });
      if (handrails) out.push({ proto: "stair-flight", node: "handrail", matrix: affine([cx, y0 + 0.15 + (st.railM as number), -s0], [1, st.railM as number, ds], -dy) });
    }
  }
  return { risers, maxRiserM: maxRiser, minGoingM: Number.isFinite(minGoing) ? minGoing : 0, instances: out };
}

// ------------------------------------------------------------------------- roof props

export interface RoofOptions {
  /** The roof's footprint in the house's local frame (x, z), metres. */
  footprint: ReadonlyArray<readonly [number, number]>;
  /** The roof's height (the collider's topY), metres. */
  roofM: number;
  storeys: number;
  year?: number;
  use?: string;
  /** A stable per-building hash in [0, 1) (e.g. from the record id). */
  hash: number;
}

function inside(x: number, z: number, ring: ReadonlyArray<readonly [number, number]>): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/**
 * Rooftop kit for flat-roofed commercial and taller residential buildings: a mechanical unit
 * per 250 m² of roof (at most 6), a stair penthouse from 5 storeys, a water tank on about one
 * in three pre-1950 buildings of 5 storeys or more. Placed on a 3.5 m grid inset 2 m from the
 * roof's edge, so nothing overhangs; houses of fewer than 4 storeys get none (their roofs are
 * K8's gables and parapets).
 */
export function roofLayout(o: RoofOptions): Instance[] {
  if (o.storeys < 4) return [];
  const xs = o.footprint.map((p) => p[0]);
  const zs = o.footprint.map((p) => p[1]);
  const spots: Array<[number, number]> = [];
  const edge = 2.0;
  const near = (x: number, z: number): boolean => {
    for (let a = 0; a < 8; a++) {
      const ang = (a * Math.PI) / 4;
      if (!inside(x + Math.cos(ang) * edge, z + Math.sin(ang) * edge, o.footprint)) return false;
    }
    return inside(x, z, o.footprint);
  };
  for (let x = Math.min(...xs) + edge; x <= Math.max(...xs) - edge; x += 3.5) for (let z = Math.min(...zs) + edge; z <= Math.max(...zs) - edge; z += 3.5) if (near(x, z)) spots.push([x, z]);
  let area = 0;
  for (let i = 0, j = o.footprint.length - 1; i < o.footprint.length; j = i++) area += o.footprint[j]![0] * o.footprint[i]![1] - o.footprint[i]![0] * o.footprint[j]![1];
  area = Math.abs(area) / 2;
  const out: Instance[] = [];
  // a stable order of the free spots, from the building's hash
  const key = (x: number, z: number): number => {
    const h = Math.sin(x * 12.9898 + z * 78.233 + o.hash * 437.585) * 43758.5453;
    return h - Math.floor(h);
  };
  spots.sort((a, b) => key(a[0], a[1]) - key(b[0], b[1]));
  const take = (): [number, number] | null => spots.shift() ?? null;
  if (o.storeys >= 5) {
    const s = take();
    if (s) out.push({ proto: "roof-penthouse", node: "unit", matrix: affine([s[0], o.roofM, s[1]], [0.8, 1, 0.8]) });
    if ((o.year ?? 2000) < 1950 && o.hash < 0.34) {
      const t = take();
      if (t) out.push({ proto: "roof-water-tank", node: "tank", matrix: affine([t[0], o.roofM, t[1]], [1, 1, 1]) });
    }
  }
  const units = Math.min(6, Math.max(1, Math.floor(area / 250)));
  for (let u = 0; u < units; u++) {
    const s = take();
    if (!s) break;
    out.push({ proto: "roof-mech-box", node: "unit", matrix: affine([s[0], o.roofM, s[1]], [1, 1, 1]) });
  }
  return out;
}
