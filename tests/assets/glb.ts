// Reads the hero-asset GLBs (public/models/*.glb) for tests: triangle counts as drawn, world-space
// geometry per node and per material, node lookup. No Blender, no network, no WebGL.

import { NodeIO, type Document, type Node } from "@gltf-transform/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers.ts";

export type V3 = [number, number, number];

export interface Model {
  file: string;
  bytes: Uint8Array;
  doc: Document;
  /** The raw glTF JSON chunk, for fields gltf-transform normalises away. */
  json: GltfJson;
}

export interface GltfJson {
  nodes?: Array<{ name?: string; extras?: Record<string, unknown> }>;
  materials?: Array<{ name?: string; alphaMode?: string; alphaCutoff?: number; emissiveFactor?: number[] }>;
}

const io = new NodeIO();
const cache = new Map<string, Promise<Model>>();

export function modelPath(file: string): string {
  return join(ROOT, "public", "models", file);
}

export function loadModel(file: string): Promise<Model> {
  let p = cache.get(file);
  if (!p) {
    p = (async () => {
      const bytes = new Uint8Array(readFileSync(modelPath(file)));
      const doc = await io.readBinary(bytes);
      return { file, bytes, doc, json: glbJson(bytes) };
    })();
    cache.set(file, p);
  }
  return p;
}

/** The JSON chunk of a GLB container. */
export function glbJson(bytes: Uint8Array): GltfJson {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const len = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error("first GLB chunk is not JSON");
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as GltfJson;
}

export function sceneRoots(doc: Document): Node[] {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) throw new Error("no scene");
  return scene.listChildren();
}

/** Every node reachable from the scene, depth first. */
export function sceneNodes(doc: Document): Node[] {
  const out: Node[] = [];
  const walk = (n: Node): void => {
    out.push(n);
    for (const c of n.listChildren()) walk(c);
  };
  for (const r of sceneRoots(doc)) walk(r);
  return out;
}

export function node(doc: Document, name: string): Node {
  const n = doc.getRoot().listNodes().find((x) => x.getName() === name);
  if (!n) throw new Error(`no node named ${name}`);
  return n;
}

const TRIANGLES = 4;

/** Triangles drawn for the whole scene (instanced meshes count once per node). */
export function triangleCount(doc: Document): number {
  let tris = 0;
  for (const n of sceneNodes(doc)) {
    const mesh = n.getMesh();
    if (!mesh) continue;
    for (const p of mesh.listPrimitives()) {
      if (p.getMode() !== TRIANGLES) throw new Error(`${n.getName()}: primitive mode ${p.getMode()} is not TRIANGLES`);
      const idx = p.getIndices();
      const pos = p.getAttribute("POSITION");
      tris += (idx ? idx.getCount() : (pos?.getCount() ?? 0)) / 3;
    }
  }
  return tris;
}

function apply(m: number[], v: V3): V3 {
  // column-major mat4
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]!,
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]!,
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]!,
  ];
}

/** Direction of a node-local axis in model (world) space, normalised. */
export function worldAxis(n: Node, axis: V3): V3 {
  const m = n.getWorldMatrix() as unknown as number[];
  const d: V3 = [
    m[0]! * axis[0] + m[4]! * axis[1] + m[8]! * axis[2],
    m[1]! * axis[0] + m[5]! * axis[1] + m[9]! * axis[2],
    m[2]! * axis[0] + m[6]! * axis[1] + m[10]! * axis[2],
  ];
  const l = Math.hypot(...d);
  return [d[0] / l, d[1] / l, d[2] / l];
}

export function worldOrigin(n: Node): V3 {
  return apply(n.getWorldMatrix() as unknown as number[], [0, 0, 0]);
}

/** Vertex positions of a node's own mesh: local (no transform) or in model space. */
export function nodePositions(n: Node, space: "local" | "world" = "world", material?: string): V3[] {
  const out: V3[] = [];
  const mesh = n.getMesh();
  if (!mesh) return out;
  const m = n.getWorldMatrix() as unknown as number[];
  const el: number[] = [];
  for (const p of mesh.listPrimitives()) {
    if (material !== undefined && p.getMaterial()?.getName() !== material) continue;
    const pos = p.getAttribute("POSITION");
    if (!pos) continue;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      const v: V3 = [el[0]!, el[1]!, el[2]!];
      out.push(space === "world" ? apply(m, v) : v);
    }
  }
  return out;
}

/** Model-space positions of every primitive using a material, across all nodes. */
export function materialPositions(doc: Document, material: string): V3[] {
  return sceneNodes(doc).flatMap((n) => nodePositions(n, "world", material));
}

export function allPositions(doc: Document): V3[] {
  return sceneNodes(doc).flatMap((n) => nodePositions(n, "world"));
}

export interface Box {
  min: V3;
  max: V3;
  size: V3;
  center: V3;
}

export function box(points: V3[]): Box {
  if (points.length === 0) throw new Error("box of no points");
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[k]!);
      max[k] = Math.max(max[k]!, p[k]!);
    }
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

export function mean(points: V3[]): V3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / points.length, y / points.length, z / points.length];
}
