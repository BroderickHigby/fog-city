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
    this.roots.push(root);
    this.group.add(root);
    this.loaded++;
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
