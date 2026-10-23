// The far skyline: the pipeline's far-LOD cells (manifest.far, one glb and one draw call per
// 2.5 km cell: every building as a simplified hull, terrain on a 100 m lattice, Marin, Alcatraz
// and the Daly City hills included) drawn everywhere the streamed tiles are not, so the whole
// city reads from any hill.
//
// Where it is drawn: a fragment of a far cell is discarded when it lies inside a tile that is
// in the scene (a small mask texture over the tile grid, one texel per tile, updated as tiles
// stream in and out). The near tiles and the far layer therefore never overlap, whatever the
// streaming radius, and a tile still loading shows its far stand-in until it is ready.
//
// Look: flat-shaded vertex colours, the shared height fog, and at night sparse warm windows
// hashed from world position on the walls, so the distant city glows.
//
// Seams: the pipeline's far terrain runs every tile border through the near tiles' own 10 m
// lattice samples, 0.5 m lower (pipeline far.ts, world QA W-17), so where the streaming ring
// stops the far terrain meets the near ground from just below; the near ground's skirts
// (ground-extras.ts) close that half metre. The far terrain stops at the far box, so at its north
// and south ends the land carries on outward as an apron (farApron) that eases down into the fog.

import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { TILE_SIZE_M } from "../geo/project.ts";
import { fcUniforms, injectUniforms } from "./materials.ts";
import { disposeObject } from "./tile-streamer.ts";
import type { Manifest } from "./types.ts";

export interface FarCell {
  id: string;
  cx?: number;
  cz?: number;
  bbox?: [number, number, number, number];
  glb: string;
  stats?: Record<string, number>;
}

export interface FarLayerOptions {
  manifest: Manifest;
  /** URL prefix of the world directory, ending in "/". */
  base: string;
  /** Loads one glb (the meshopt tile loader, through the asset layer). */
  load: (url: string) => Promise<GLTF>;
  /** Cells loaded at once. */
  maxConcurrent?: number;
}

/** The far terrain is a 100 m lattice: its vertices sit on whole multiples of 100 m; hull corners do not. */
export function onFarLattice(x: number, _y: number, z: number): boolean {
  const fx = x / 100;
  const fz = z / 100;
  return Math.abs(fx - Math.round(fx)) < 1e-3 && Math.abs(fz - Math.round(fz)) < 1e-3;
}

export interface FarInfo {
  /** Cells the manifest lists. */
  total: number;
  /** Cells loaded and in the scene. */
  loaded: number;
  failed: number;
  /** Cells drawn in the last rendered frame (after frustum culling). */
  drawn: number;
  /** Triangles in the loaded cells. */
  triangles: number;
}

/** Distances (m) of the apron's rows outward from the far terrain's north and south ends. */
export const APRON_ROWS_M: readonly number[] = [0, 150, 400, 900, 1800, 3500, 7000, 14000];
/** The apron's height at distance d, as a share of the edge's height: easing to APRON_FLOOR. */
const APRON_FLOOR = 0.45;
const APRON_EASE_M = 2000;
const LATTICE_M = 100;

/** A far-terrain lattice point (world coordinates, x and z on the 100 m lattice). */
export interface FarPoint {
  x: number;
  y: number;
  z: number;
  /** Its colour (the source's components). */
  c: number[];
  /** The geometry's vertex indices at this point. */
  ids: number[];
}

/**
 * One far cell's terrain: its lattice points by key "x,z", its axis-aligned 100 m edges with how
 * many terrain triangles share each (2 inside, 1 at the rim), and its terrain triangles (the
 * geometry's triangle number and the corners' keys).
 */
export interface FarTerrain {
  points: Map<string, FarPoint>;
  edges: Map<string, { a: string; b: string; n: number }>;
  tris: Array<{ t: number; keys: [string, string, string] }>;
  colorSize: number;
}

const pointKey = (x: number, z: number): string => `${x},${z}`;

/**
 * The terrain of a far cell's geometry: triangles whose corners are all on the 100 m lattice
 * and two of whose sides are axis-aligned 100 m lattice steps (hull triangles never are).
 */
export function farTerrain(geo: THREE.BufferGeometry, matrixWorld: THREE.Matrix4): FarTerrain {
  const pos = geo.getAttribute("position");
  const col = geo.getAttribute("color") as THREE.BufferAttribute | undefined;
  const colorSize = col ? col.itemSize : 3;
  const out: FarTerrain = { points: new Map(), edges: new Map(), tris: [], colorSize };
  if (!pos) return out;
  const index = geo.getIndex();
  const e = matrixWorld.elements;
  const at = (i: number): { key: string; x: number; y: number; z: number } | null => {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const wx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
    const wy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
    const wz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
    if (!onFarLattice(wx, wy, wz)) return null;
    const lx = Math.round(wx / LATTICE_M) * LATTICE_M;
    const lz = Math.round(wz / LATTICE_M) * LATTICE_M;
    return { key: pointKey(lx, lz), x: lx, y: wy, z: lz };
  };
  const tris = (index ? index.count : pos.count) / 3;
  for (let t = 0; t < tris; t++) {
    const ids = [0, 1, 2].map((k) => (index ? index.getX(3 * t + k) : 3 * t + k));
    const vs = ids.map(at);
    if (vs.some((v) => v === null)) continue;
    const v = vs as Array<{ key: string; x: number; y: number; z: number }>;
    const axis: Array<[number, number]> = [];
    for (const [i, j] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ] as const) {
      const p = v[i]!;
      const q = v[j]!;
      if ((p.x === q.x && Math.abs(p.z - q.z) === LATTICE_M) || (p.z === q.z && Math.abs(p.x - q.x) === LATTICE_M)) axis.push([i, j]);
    }
    if (axis.length !== 2) continue;
    out.tris.push({ t, keys: [v[0]!.key, v[1]!.key, v[2]!.key] });
    v.forEach((p, k) => {
      let pt = out.points.get(p.key);
      if (!pt) {
        const c: number[] = [];
        for (let m = 0; m < colorSize; m++) c.push(col ? col.getComponent(ids[k]!, m) : 1);
        out.points.set(p.key, (pt = { x: p.x, y: p.y, z: p.z, c, ids: [] }));
      }
      if (!pt.ids.includes(ids[k]!)) pt.ids.push(ids[k]!);
    });
    for (const [i, j] of axis) {
      const p = v[i]!;
      const q = v[j]!;
      const [a, b] = p.x < q.x || (p.x === q.x && p.z < q.z) ? [p, q] : [q, p];
      const key = `${a.key}|${b.key}`;
      const got = out.edges.get(key);
      if (got) got.n++;
      else out.edges.set(key, { a: a.key, b: b.key, n: 1 });
    }
  }
  return out;
}

/** Apron triangles for one cell: positions and colours (the terrain's colour components). */
export function farApron(t: FarTerrain, northZ: number, southZ: number): { positions: number[]; colors: number[] } {
  const out = { positions: [] as number[], colors: [] as number[] };
  const keys = [...t.edges.keys()].sort();
  const h = (y: number, d: number): number => y * (APRON_FLOOR + (1 - APRON_FLOOR) * Math.exp(-d / APRON_EASE_M));
  for (const key of keys) {
    const { a: ka, b: kb, n } = t.edges.get(key)!;
    const a = t.points.get(ka)!;
    const b = t.points.get(kb)!;
    if (n !== 1 || a.z !== b.z || (a.z !== northZ && a.z !== southZ)) continue;
    const dir = a.z === southZ ? 1 : -1;
    const push = (p: FarPoint, d: number): void => {
      out.positions.push(p.x, h(p.y, d), p.z + dir * d);
      out.colors.push(...p.c);
    };
    for (let r = 0; r + 1 < APRON_ROWS_M.length; r++) {
      const d0 = APRON_ROWS_M[r]!;
      const d1 = APRON_ROWS_M[r + 1]!;
      // Two triangles per row, wound to face up (counter-clockwise seen from above) either way.
      const tri: Array<[FarPoint, number]> =
        dir > 0
          ? [
              [a, d0],
              [a, d1],
              [b, d0],
              [b, d0],
              [a, d1],
              [b, d1],
            ]
          : [
              [a, d0],
              [b, d0],
              [a, d1],
              [b, d0],
              [b, d1],
              [a, d1],
            ];
      for (const [p, d] of tri) push(p, d);
    }
  }
  return out;
}

const FAR_VERTEX_PARS = /* glsl */ `
varying vec3 vFarWorld;
`;
const FAR_VERTEX = /* glsl */ `
vFarWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;
const FAR_FRAGMENT_PARS = /* glsl */ `
varying vec3 vFarWorld;
uniform sampler2D uFarMask;
uniform vec4 uFarMaskRect;
uniform float fcNight;
float fcFarHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
`;
const FAR_DISCARD = /* glsl */ `
{
  vec2 farUv = ( vFarWorld.xz - uFarMaskRect.xy ) / uFarMaskRect.zw;
  if ( farUv.x >= 0.0 && farUv.y >= 0.0 && farUv.x < 1.0 && farUv.y < 1.0 && texture2D( uFarMask, farUv ).r > 0.5 ) discard;
}
`;
// After the lights: at night, warm window dots on walls (faces whose normal is near horizontal).
const FAR_NIGHT = /* glsl */ `
if ( fcNight > 0.0 ) {
  vec3 fdx = dFdx( vFarWorld );
  vec3 fdy = dFdy( vFarWorld );
  vec3 fn = normalize( cross( fdx, fdy ) );
  float wall = 1.0 - smoothstep( 0.25, 0.45, abs( fn.y ) );
  vec2 cell = floor( vec2( vFarWorld.x + vFarWorld.z, vFarWorld.y ) / vec2( 4.0, 3.2 ) );
  float lit = step( 0.72, fcFarHash( cell ) ) * wall * step( 2.0, vFarWorld.y );
  vec3 warm = mix( vec3( 1.0, 0.72, 0.42 ), vec3( 0.75, 0.85, 1.0 ), fcFarHash( cell + 17.0 ) * 0.4 );
  gl_FragColor.rgb += warm * lit * fcNight * 0.9;
}
`;

/** The grid of tiles a manifest lists: one mask texel per tile. */
export function tileGrid(manifest: Manifest): { ix0: number; iz0: number; nx: number; nz: number; index: Map<string, number> } {
  const T = manifest.tileSizeM ?? TILE_SIZE_M;
  const cells: Array<{ id: string; ix: number; iz: number }> = [];
  for (const t of manifest.tiles) {
    let ix = t.ix;
    let iz = t.iz;
    if ((ix === undefined || iz === undefined) && t.bbox) {
      ix = Math.floor((t.bbox[0] + 1e-6) / T);
      iz = Math.floor((t.bbox[1] + 1e-6) / T);
    }
    if (ix === undefined || iz === undefined) continue;
    cells.push({ id: t.id, ix, iz });
  }
  if (cells.length === 0) return { ix0: 0, iz0: 0, nx: 1, nz: 1, index: new Map() };
  let ix0 = Infinity, iz0 = Infinity, ix1 = -Infinity, iz1 = -Infinity;
  for (const c of cells) {
    ix0 = Math.min(ix0, c.ix);
    iz0 = Math.min(iz0, c.iz);
    ix1 = Math.max(ix1, c.ix);
    iz1 = Math.max(iz1, c.iz);
  }
  const nx = ix1 - ix0 + 1;
  const nz = iz1 - iz0 + 1;
  const index = new Map<string, number>();
  for (const c of cells) index.set(c.id, (c.iz - iz0) * nx + (c.ix - ix0));
  return { ix0, iz0, nx, nz, index };
}

export class FarLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private readonly opts: FarLayerOptions;
  private readonly builtTiles: Set<string>;
  private readonly ends: { northZ: number; southZ: number };
  private readonly cells: FarCell[];
  private readonly mask: THREE.DataTexture;
  private readonly maskData: Uint8Array;
  private readonly maskIndex: Map<string, number>;
  private readonly roots: THREE.Object3D[] = [];
  private loaded = 0;
  private failed = 0;
  private triangles = 0;
  private drawnThisFrame = 0;
  private drawnLast = 0;
  private started = false;
  private disposed = false;

  constructor(opts: FarLayerOptions) {
    this.opts = opts;
    this.cells = ((opts.manifest as Manifest & { far?: FarCell[] }).far ?? []).filter((c) => typeof c.glb === "string");
    this.group.name = "far";
    const T = opts.manifest.tileSizeM ?? TILE_SIZE_M;
    const grid = tileGrid(opts.manifest);
    this.maskIndex = grid.index;
    this.maskData = new Uint8Array(grid.nx * grid.nz);
    this.mask = new THREE.DataTexture(this.maskData, grid.nx, grid.nz, THREE.RedFormat, THREE.UnsignedByteType);
    this.mask.magFilter = THREE.NearestFilter;
    this.mask.minFilter = THREE.NearestFilter;
    this.mask.generateMipmaps = false;
    this.mask.needsUpdate = true;
    const maskUniforms = {
      uFarMask: { value: this.mask },
      uFarMaskRect: { value: new THREE.Vector4(grid.ix0 * T, grid.iz0 * T, grid.nx * T, grid.nz * T) },
    };
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0, name: "fc:far" });
    this.material.onBeforeCompile = (shader) => {
      injectUniforms(shader);
      Object.assign(shader.uniforms, maskUniforms, { fcNight: fcUniforms.fcNight });
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${FAR_VERTEX_PARS}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${FAR_VERTEX}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FAR_FRAGMENT_PARS}`)
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${FAR_DISCARD}`)
        .replace("#include <opaque_fragment>", `#include <opaque_fragment>\n${FAR_NIGHT}`);
    };
    this.material.customProgramCacheKey = () => "fc:far:v1";
    this.builtTiles = new Set(
      opts.manifest.tiles.flatMap((t) => {
        const ix = t.ix ?? (t.bbox ? Math.floor((t.bbox[0] + 1e-6) / T) : undefined);
        const iz = t.iz ?? (t.bbox ? Math.floor((t.bbox[1] + 1e-6) / T) : undefined);
        return ix === undefined || iz === undefined ? [] : [`${ix},${iz}`];
      }),
    );
    let northZ = Infinity;
    let southZ = -Infinity;
    for (const c of this.cells) {
      if (!c.bbox) continue;
      northZ = Math.min(northZ, c.bbox[1]);
      southZ = Math.max(southZ, c.bbox[3]);
    }
    this.ends = { northZ, southZ };
  }

  /** Start loading every cell (a few at a time). Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const queue = this.cells.slice();
    const next = (): void => {
      const cell = queue.shift();
      if (!cell || this.disposed) return;
      this.opts.load(this.opts.base + cell.glb).then(
        (gltf) => {
          this.add(cell, gltf);
          next();
        },
        (err: unknown) => {
          this.failed++;
          console.warn(`[fog-city] far cell ${cell.id}: ${err instanceof Error ? err.message : String(err)}`);
          next();
        },
      );
    };
    for (let i = 0; i < (this.opts.maxConcurrent ?? 4); i++) next();
  }

  private add(cell: FarCell, gltf: GLTF): void {
    const root = gltf.scene;
    if (this.disposed) {
      disposeObject(root);
      return;
    }
    root.name = `far:${cell.id}`;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      o.matrixAutoUpdate = false;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of old) m.dispose();
      mesh.material = this.material;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const index = mesh.geometry.getIndex();
      this.triangles += (index ? index.count : mesh.geometry.getAttribute("position").count) / 3;
      mesh.onBeforeRender = () => {
        this.drawnThisFrame++;
      };
    });
    this.addApron(root);
    this.roots.push(root);
    this.group.add(root);
    this.loaded++;
  }

  /** The cell's apron (farApron), under its root. */
  private addApron(root: THREE.Object3D): void {
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    const part = (name: string, data: { positions: number[]; colors: number[] }, colorSize: number): void => {
      if (data.positions.length === 0) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(data.positions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(data.colors, colorSize));
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, this.material);
      m.name = name;
      m.castShadow = false;
      m.receiveShadow = false;
      m.matrixAutoUpdate = false;
      root.add(m);
      this.triangles += data.positions.length / 9;
    };
    for (const mesh of meshes) {
      const terrain = farTerrain(mesh.geometry, mesh.matrixWorld);
      if (terrain.points.size === 0) continue;
      part("far-apron", farApron(terrain, this.ends.northZ, this.ends.southZ), terrain.colorSize);
    }
  }

  /** A streamed tile entered (true) or left (false) the scene: the far layer hides under it. */
  setTileVisible(id: string, visible: boolean): void {
    const i = this.maskIndex.get(id);
    if (i === undefined) return;
    const v = visible ? 255 : 0;
    if (this.maskData[i] === v) return;
    this.maskData[i] = v;
    this.mask.needsUpdate = true;
  }

  /** Call once per rendered frame, after render(): rolls the drawn-cell count over. */
  endFrame(): void {
    this.drawnLast = this.drawnThisFrame;
    this.drawnThisFrame = 0;
  }

  info(): FarInfo {
    return { total: this.cells.length, loaded: this.loaded, failed: this.failed, drawn: this.drawnLast, triangles: this.triangles };
  }

  /** True once every cell has loaded or failed. */
  settled(): boolean {
    return !this.started || this.loaded + this.failed >= this.cells.length;
  }

  dispose(): void {
    this.disposed = true;
    for (const r of this.roots) {
      r.removeFromParent();
      r.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
    }
    this.roots.length = 0;
    this.material.dispose();
    this.mask.dispose();
  }
}
