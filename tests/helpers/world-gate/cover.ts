// Gate suite D: ground cover (docs/qa/world-continuity-gate.md, section D). Measures what the
// renderer draws: each tile GLB's ground vertex colours, put through the same runtime tint the
// SceneRenderer applies when a tile loads (scene.ts tintGround: parks.ts tintParks over the
// districts.json park polygons). When Render changes how the ground is coloured, it updates
// drawnGround() here in the same PR, so the gate keeps measuring the drawn ground.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { toLocal } from "../../../src/geo/project.ts";
import { parkShapes, tintParks } from "../../../src/render/parks.ts";
import { cellKey, pointInPolygon } from "../../../src/sim/index.ts";
import { ROOT, readJson } from "../../helpers.ts";
import { glbJsonOf, latticeAt, r2, r3, readGlb, type GameWorld, type P2 } from "../world.ts";
import { Measured } from "./measured.ts";

const FIX = join(ROOT, "tests/helpers/world-gate/fixtures");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), "utf8")) as T;

/** Ground classes by drawn colour. */
export const CLASS = { none: 0, grey: 1, green: 2, sand: 3, water: 4 } as const;

const toSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Classify a linear-space vertex colour by its sRGB hue, saturation and value. */
export function colourClass(r: number, g: number, b: number): number {
  const R = toSrgb(r);
  const G = toSrgb(g);
  const B = toSrgb(b);
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const v = max;
  const s = max > 0 ? (max - min) / max : 0;
  let h = 0;
  if (max > min) {
    if (max === R) h = 60 * (((G - B) / (max - min)) % 6);
    else if (max === G) h = 60 * ((B - R) / (max - min) + 2);
    else h = 60 * ((R - G) / (max - min) + 4);
  }
  if (h < 0) h += 360;
  if (s >= 0.18 && h >= 65 && h <= 170) return CLASS.green;
  if (s >= 0.15 && h >= 25 && h < 65 && v >= 0.5) return CLASS.sand;
  if (s >= 0.1 && h >= 180 && h <= 250) return CLASS.water;
  return CLASS.grey;
}

/** Drawn ground class per lattice vertex: tile key -> 51 x 51 classes (0 where no vertex is drawn). */
export async function drawnGround(gw: GameWorld): Promise<Map<number, Uint8Array>> {
  const districts = readJson(`public/tiles/${gw.name}/${gw.manifest.layers?.districts ?? "districts.json"}`);
  const parks = parkShapes(districts);
  const identity = new THREE.Matrix4();
  const out = new Map<number, Uint8Array>();
  for (const t of gw.manifest.tiles) {
    if (!t.glb) continue;
    const g = await readGlb(`public/tiles/${gw.name}/${t.glb}`, ["ground"], ["POSITION", "COLOR_0"]);
    const node = g.nodes[0];
    if (!node?.colors) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(node.positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(node.colors, 4));
    // scene.ts: tintGround: (geo, m) => tintParks(geo, m, parks)
    tintParks(geo, identity, parks);
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const ix = t.ix ?? Math.floor((t.bbox?.[0] ?? 0) / 500);
    const iz = t.iz ?? Math.floor((t.bbox?.[1] ?? 0) / 500);
    const cls = new Uint8Array(51 * 51);
    for (let v = 0; v < col.count; v++) {
      const x = node.positions[v * 3]!;
      const z = node.positions[v * 3 + 2]!;
      const i = Math.round(x / 10) - ix * 50;
      const k = Math.round(z / 10) - iz * 50;
      if (i < 0 || i > 50 || k < 0 || k > 50 || Math.abs(x - Math.round(x / 10) * 10) > 0.05 || Math.abs(z - Math.round(z / 10) * 10) > 0.05) continue;
      cls[k * 51 + i] = colourClass(col.getX(v), col.getY(v), col.getZ(v));
    }
    out.set(cellKey(ix, iz), cls);
    geo.dispose();
  }
  return out;
}

export function classAt(drawn: Map<number, Uint8Array>, gx: number, gz: number): number {
  const ix = Math.floor(gx / 50);
  const iz = Math.floor(gz / 50);
  const c = drawn.get(cellKey(ix, iz));
  return c ? c[(gz - iz * 50) * 51 + (gx - ix * 50)]! : CLASS.none;
}

/** Beach boxes (lat0, lon0, lat1, lon1): the beach is the land in the box within 80 m of the sea, up to 8 m. */
export const BEACHES: ReadonlyArray<{ name: string; box: [number, number, number, number] }> = [
  { name: "Ocean Beach", box: [37.7355, -122.514, 37.779, -122.506] },
  { name: "Baker Beach", box: [37.788, -122.485, 37.799, -122.481] },
  { name: "China Beach", box: [37.787, -122.4925, 37.7895, -122.4895] },
  { name: "Crissy Field beach", box: [37.8035, -122.47, 37.8075, -122.445] },
];

/** Parks whose tiles must carry a foliage node: Rec and Park names, plus points for the Presidio and Sutro Forest. */
export const FOLIAGE_PARKS: readonly string[] = ["Golden Gate Park", "McLaren Park", "Lincoln Park", "Buena Vista Park", "Glen Canyon Park", "Mount Davidson Park"];
export const FOLIAGE_POINTS: ReadonlyArray<{ name: string; at: [number, number] }> = [
  { name: "Presidio forest", at: [37.7955, -122.464] },
  { name: "Presidio, Lovers' Lane", at: [37.7935, -122.454] },
  { name: "Sutro Forest", at: [37.759, -122.459] },
];

interface Property {
  name: string;
  type: string;
  polygons: P2[][][];
}

function inProperty(p: Property, x: number, z: number): boolean {
  return p.polygons.some((poly) => pointInPolygon(x, z, poly[0]!) && !poly.slice(1).some((h) => pointInPolygon(x, z, h)));
}

function nearSea(gw: GameWorld, gx: number, gz: number, cells = 8): boolean {
  for (let dz = -cells; dz <= cells; dz += 2) for (let dx = -cells; dx <= cells; dx += 2) if (latticeAt(gw.world, gx + dx, gz + dz)?.water) return true;
  return false;
}

export async function measureCover(gw: GameWorld): Promise<Measured> {
  const m = new Measured("cover", "pr");
  const drawn = await drawnGround(gw);
  m.lap("decode");
  const props = fixture<{ properties: Property[] }>("rec-park-properties.json").properties;

  // ---- Rec and Park land drawn green (W-18)
  {
    let land = 0;
    let green = 0;
    let under10 = 0;
    let withLand = 0;
    const greyest: Array<{ name: string; ha: number; green: number }> = [];
    for (const p of props) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const poly of p.polygons) for (const [x, z] of poly[0]!) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      let l = 0;
      let g = 0;
      for (let gx = Math.ceil(x0 / 10); gx * 10 <= x1; gx++) {
        for (let gz = Math.ceil(z0 / 10); gz * 10 <= z1; gz++) {
          if (!inProperty(p, gx * 10, gz * 10)) continue;
          const L = latticeAt(gw.world, gx, gz);
          if (!L || L.water || L.y <= 0.1) continue;
          l++;
          if (classAt(drawn, gx, gz) === CLASS.green) g++;
        }
      }
      land += l;
      green += g;
      if (l > 0) {
        withLand++;
        if (g / l < 0.1) {
          under10++;
          greyest.push({ name: p.name, ha: l / 100, green: r3(g / l) });
        }
      }
    }
    greyest.sort((a, b) => b.ha - a.ha);
    m.metric({ id: "D.parks.greenShare", target: 0.9, better: "higher", unit: "share of park land", defects: ["W-18"], desc: "share of Rec and Park land (lattice vertices in the 255 properties) drawn as grass or forest" }, r3(land ? green / land : 0), { landHa: r2(land / 100), greenHa: r2(green / 100) });
    m.metric({ id: "D.parks.propertiesUnder10pct", target: 0, better: "lower", unit: "properties", defects: ["W-18"], desc: "Rec and Park properties less than 10% of whose land is drawn green" }, under10, { withLand, largest: greyest.slice(0, 12) });
  }
  m.lap("parks");

  // ---- lakes painted lawn (W-11)
  {
    let greenLake = 0;
    for (const l of fixture<{ lakes: Array<{ runs: number[][] }> }>("lakes.json").lakes) {
      for (const [gz, gx0, gx1] of l.runs) for (let gx = gx0!; gx <= gx1!; gx++) if (classAt(drawn, gx, gz!) === CLASS.green) greenLake++;
    }
    m.metric({ id: "D.lakes.drawnGrassHa", target: 0, better: "lower", unit: "ha", defects: ["W-11"], desc: "lake surface (the eight hydro-flattened lakes) drawn as grass" }, r2(greenLake / 100));
  }

  // ---- beaches and shore (W-34, W-18)
  {
    let beach = 0;
    let sand = 0;
    const per: Record<string, number> = {};
    for (const b of BEACHES) {
      const a = toLocal(b.box[2], b.box[1]);
      const c = toLocal(b.box[0], b.box[3]);
      let n = 0;
      let s = 0;
      for (let gx = Math.ceil(a.x / 10); gx * 10 <= c.x; gx++) {
        for (let gz = Math.ceil(a.z / 10); gz * 10 <= c.z; gz++) {
          const L = latticeAt(gw.world, gx, gz);
          if (!L || L.water || L.y <= 0.1 || L.y > 8 || !nearSea(gw, gx, gz)) continue;
          n++;
          if (classAt(drawn, gx, gz) === CLASS.sand) s++;
        }
      }
      per[b.name] = n ? r3(s / n) : -1;
      beach += n;
      sand += s;
    }
    m.metric({ id: "D.beaches.sandShare", target: 0.9, better: "higher", unit: "share", defects: ["W-34"], desc: "share of the Ocean, Baker, China and Crissy beaches (land within 80 m of the sea, up to 8 m) drawn as sand" }, r3(beach ? sand / beach : 0), per);
    let shoreGreen = 0;
    for (const t of gw.tiles) {
      const g = t.ground;
      if (!g?.water) continue;
      const ix = g.x0 / 500;
      const iz = g.z0 / 500;
      for (let k = 0; k < 51; k++) {
        for (let i = 0; i < 51; i++) {
          // Each vertex once: skip the shared east and south borders unless the tile has no neighbour there.
          if ((i === 50 && gw.world.tileGround?.has(cellKey(ix + 1, iz))) || (k === 50 && gw.world.tileGround?.has(cellKey(ix, iz + 1)))) continue;
          const y = g.heights[k * 51 + i]!;
          if (y < 1.5 || y > 8 || g.water[k * 51 + i] === 1) continue;
          const gx = ix * 50 + i;
          const gz = iz * 50 + k;
          if (classAt(drawn, gx, gz) !== CLASS.green || !nearSea(gw, gx, gz)) continue;
          shoreGreen++;
        }
      }
    }
    m.metric({ id: "D.shore.drawnGrassHa", target: 0, better: "lower", unit: "ha", defects: ["W-18", "W-34"], desc: "shore land 1.5 to 8 m high within 80 m of the sea drawn as grass (beaches and bluffs painted lawn)" }, r2(shoreGreen / 100));
  }
  m.lap("shore");

  // ---- foliage (W-18): the listed parks' tiles carry a foliage node
  {
    const tiles = new Set<string>();
    const byName = new Map(props.map((p) => [p.name, p]));
    for (const name of FOLIAGE_PARKS) {
      const p = byName.get(name);
      if (!p) continue;
      for (const poly of p.polygons) for (const [x, z] of poly[0]!) tiles.add(`t${Math.floor(x / 500)}_${Math.floor(z / 500)}`);
    }
    for (const f of FOLIAGE_POINTS) {
      const q = toLocal(f.at[0], f.at[1]);
      tiles.add(`t${Math.floor(q.x / 500)}_${Math.floor(q.z / 500)}`);
    }
    const built = new Map(gw.manifest.tiles.map((t) => [t.id, t]));
    let listed = 0;
    let withFoliage = 0;
    for (const id of [...tiles].sort()) {
      const t = built.get(id);
      if (!t?.glb) continue;
      listed++;
      const json = glbJsonOf(new Uint8Array(readFileSync(join(ROOT, "public/tiles", gw.name, t.glb))));
      if ((json.nodes ?? []).some((n) => /foliage|trees|canopy/i.test(n.name ?? "") && n.mesh !== undefined)) withFoliage++;
    }
    m.metric({ id: "D.foliage.parkTilesShare", target: 1, better: "higher", unit: "share of tiles", defects: ["W-18"], desc: "share of the tiles over Golden Gate Park, the Presidio, McLaren, Lincoln Park, Buena Vista, Glen Canyon, Sutro Forest and Mt Davidson whose GLB has a foliage node" }, r3(listed ? withFoliage / listed : 0), { listed, withFoliage });
  }
  return m;
}
