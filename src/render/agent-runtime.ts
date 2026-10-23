import * as THREE from "three";
import { agentUniforms, mergePacked, packedMaterial, packGeometry, type PackedSurface } from "./agent-packing.ts";
import { channelRatio, lightChannel } from "./lights.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { mergeRuntimeRestPose, packAuthoredRuntimeParts } from "./runtime-packing.ts";
import { installRuntimeRigging, mergeRuntimeAnimatedParts } from "./runtime-rigging.ts";
import { runtimeLetterStrokes, runtimeLiveryPixels } from "./runtime-livery.ts";
export { RUNTIME_LIVERY_WIDTH, RUNTIME_LIVERY_HEIGHT, RUNTIME_LIVERY_COPY, runtimeLiveryPixels } from "./runtime-livery.ts";

/** Runtime rendering consumes copies of poses; it never reads or advances a simulation. */
export interface RuntimeVisualActor {
  readonly id: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly pitch?: number;
  readonly roll?: number;
  readonly pivotY?: number;
  readonly mode?: string;
  readonly rust?: number;
  readonly heightScale?: number;
  readonly visible?: boolean;
  readonly speed?: number;
  readonly scale?: number;
  readonly emote?: string;
  readonly tells?: readonly string[];
}

export interface RuntimeVisualSnapshot {
  readonly actors: readonly RuntimeVisualActor[];
  readonly links?: readonly RuntimeVisualLink[];
  readonly viewer?: { readonly x: number; readonly y?: number; readonly z: number };
}

export interface RuntimeVisualLink {
  readonly id: string;
  readonly from: { readonly x: number; readonly y: number; readonly z: number };
  readonly to: { readonly x: number; readonly y: number; readonly z: number };
}

export type RuntimeVisualKind = "pigeon" | "dog" | "parrot" | "van" | "bus" | "robotaxi" | "drone" |
  "footman" | "trundle" | "patrol" | "tidy" | "sign-spinner" | "associate" | "walker" | "finale" | "heap" | "puddle" | "weak-point" | "leash" | "lanyard";

export interface RuntimeVisualInfo {
  readonly drawn: number;
  readonly bodiesDrawn: number;
  readonly near: number;
  readonly bodiesNear: number;
  readonly dropped: number;
  readonly invalid: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly kinds: readonly RuntimeVisualKind[];
  readonly fileKinds: readonly RuntimeVisualKind[];
}

export interface RuntimeAgentRenderer {
  readonly group: THREE.Group;
  update(snapshot: RuntimeVisualSnapshot, tick: number): void;
  info(): RuntimeVisualInfo;
  dispose(): void;
}

export interface RuntimeAgentRenderOptions {
  /** A hard allocation and draw cap, independent of snapshot size. */
  readonly maxActors?: number;
  readonly shadows?: boolean;
  /** Uses the scene's existing packed/loose asset loader and availability checks. */
  readonly registry?: Pick<ModelRegistry<THREE.Object3D>, "register" | "get">;
}

type Vec = readonly [number, number, number];
type Animation = "fixed" | "left-leg" | "right-leg" | "left-wing" | "right-wing" | "rotor" | "wheel" | "sign" | "left-arm" | "right-arm";
interface Part {
  geometry: THREE.BufferGeometry; pivot: Vec; animation: Animation;
  rest?: THREE.Matrix4; material?: THREE.Material | THREE.Material[]; draws?: number;
}
interface Model { parts: Part[]; scale: number; detailDistance: number; visibilityDistance: number }

const SHELL = surface(0xd9e2df, 0.32, 0.18);
const WHITE = surface(0xf0eee4, 0.38, 0.06);
const DARK = surface(0x202c32, 0.48, 0.28);
const RUBBER = surface(0x11191d, 0.94, 0.02);
const GLASS = surface(0x233e4b, 0.18, 0.42);
const STEEL = surface(0x7c9299, 0.26, 0.82);
const CYAN = surface(0x39c4c5, 0.3, 0.2, 0x24b9be);
const AMBER = surface(0xf4b13f, 0.36, 0.12, 0xe8a62e);
const RED = surface(0xe15b54, 0.4, 0.1, 0xcb3430);
const GREEN = surface(0x71ad67, 0.65, 0.05);

function surface(color: number, roughness = 0.65, metalness = 0, emissive = 0): PackedSurface {
  const c = new THREE.Color(color), e = new THREE.Color(emissive);
  return { color: [c.r, c.g, c.b], roughness, metalness, emissive: [e.r, e.g, e.b], channel: emissive ? 3 : 0 };
}

/** Each rigid part is merged into one vertex-coloured PBR draw, rather than one draw per detail. */
class Builder {
  readonly parts: Part[] = [];
  private shapes: THREE.BufferGeometry[] = [];
  private pivot: Vec = [0, 0, 0];
  private animation: Animation = "fixed";

  part(pivot: Vec = [0, 0, 0], animation: Animation = "fixed"): this {
    this.flush(); this.pivot = pivot; this.animation = animation; return this;
  }

  box(at: Vec, size: Vec, material: PackedSurface, rotation: Vec = [0, 0, 0]): this {
    return this.shape(new THREE.BoxGeometry(1, 1, 1), at, size, material, rotation);
  }

  wedge(at: Vec, size: Vec, material: PackedSurface, front = 0.3): this {
    const geometry = new THREE.BoxGeometry(1, 1, 1), positions = geometry.getAttribute("position");
    for (let index = 0; index < positions.count; index++) if (positions.getY(index) > 0 && positions.getZ(index) < 0) positions.setY(index, front - 0.5);
    geometry.computeVertexNormals(); return this.shape(geometry, at, size, material, [0, 0, 0]);
  }

  word(copy: string, at: Vec, height: number, material: PackedSurface, back = false): this {
    const advance = height * 0.82, width = Math.max(0, copy.length * advance - height * 0.19), stroke = height * 0.075;
    let x = -width / 2;
    for (const letter of copy) {
      for (const path of runtimeLetterStrokes(letter)) for (let index = 2; index < path.length; index += 2) {
        const x0 = x + path[index - 2]! * height * 0.105, y0 = -path[index - 1]! * height / 8;
        const x1 = x + path[index]! * height * 0.105, y1 = -path[index + 1]! * height / 8;
        const dx = x1 - x0, dy = y1 - y0, side = back ? 1 : -1;
        this.box([at[0] + (x0 + x1) * 0.5 * side, at[1] + (y0 + y1) * 0.5, at[2]],
          [Math.hypot(dx, dy) + stroke, stroke, height * 0.05], material, [0, 0, Math.atan2(dy, dx * side)]);
      }
      x += advance;
    }
    return this;
  }

  round(at: Vec, size: Vec, material: PackedSurface, rotation: Vec = [0, 0, 0]): this {
    return this.shape(new THREE.SphereGeometry(0.5, 16, 10), at, size, material, rotation);
  }

  cylinder(at: Vec, size: Vec, material: PackedSurface, rotation: Vec = [0, 0, 0]): this {
    return this.shape(new THREE.CylinderGeometry(0.5, 0.5, 1, 16), at, size, material, rotation);
  }

  ring(at: Vec, size: Vec, material: PackedSurface, rotation: Vec = [0, 0, 0]): this {
    return this.shape(new THREE.TorusGeometry(0.5, 0.065, 8, 24), at, size, material, rotation);
  }

  private shape(geometry: THREE.BufferGeometry, at: Vec, size: Vec, material: PackedSurface, rotation: Vec): this {
    const p = new THREE.Vector3(at[0] - this.pivot[0], at[1] - this.pivot[1], at[2] - this.pivot[2]);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation));
    const matrix = new THREE.Matrix4().compose(p, q, new THREE.Vector3(...size));
    this.shapes.push(packGeometry(geometry, material, matrix, false));
    geometry.dispose();
    return this;
  }

  private flush(): void {
    if (!this.shapes.length) return;
    const geometry = mergePacked(this.shapes);
    for (const shape of this.shapes) shape.dispose();
    this.parts.push({ geometry, pivot: this.pivot, animation: this.animation });
    this.shapes = [];
  }

  finish(scale = 1, detailDistance = 150, visibilityDistance = 650): Model {
    this.flush(); return { parts: this.parts, scale, detailDistance, visibilityDistance };
  }
}

function bird(kind: "pigeon" | "parrot", low: boolean): Model {
  const b = new Builder(), parrot = kind === "parrot";
  const feathers = parrot ? GREEN : surface(0x879298, 0.92);
  const chest = parrot ? surface(0xbdc268, 0.85) : surface(0xadaaaa, 0.92);
  b.round([0, 0.21, 0.02], [0.2, 0.25, 0.38], feathers)
    .round([0, 0.34, -0.15], [0.15, 0.17, 0.17], feathers)
    .box([0, 0.33, -0.25], [0.055, 0.04, 0.09], AMBER)
    .box([0, 0.16, 0.27], [0.09, 0.035, parrot ? 0.28 : 0.16], feathers, [0.25, 0, 0]);
  if (!low) {
    b.round([0, 0.205, -0.105], [0.155, 0.19, 0.14], chest);
    if (parrot) b.round([0, 0.363, -0.18], [0.145, 0.125, 0.1], RED)
      .wedge([0, 0.318, -0.25], [0.075, 0.085, 0.09], surface(0xd6b993, 0.7), 0.7);
    for (const s of [-1, 1]) {
      b.round([s * 0.073, 0.365, -0.19], [0.018, 0.021, 0.018], RUBBER)
        .round([s * 0.079, 0.368, -0.193], [0.006, 0.007, 0.007], WHITE)
        .cylinder([s * 0.045, 0.07, 0.01], [0.018, 0.14, 0.018], RED)
        .box([s * 0.045, 0.008, -0.03], [0.035, 0.015, 0.095], DARK);
    }
    for (const side of [-1, 1]) {
      b.part([side * 0.085, 0.27, 0.01], side < 0 ? "left-wing" : "right-wing")
        .round([side * 0.13, 0.2, 0.07], [0.065, 0.17, 0.29], feathers);
      for (let feather = 0; feather < 6; feather++) b.box([side * (0.13 + feather * 0.003), 0.185 - feather * 0.009, 0.04 + feather * 0.037],
        [0.069, 0.009, 0.12], parrot ? surface(feather % 2 ? 0x305c41 : 0x477447, 0.9) : feathers, [0.22, 0, 0]);
    }
  }
  return b.finish(1, 85, 300);
}

function dog(low: boolean): Model {
  const b = new Builder(), fur = surface(0xb78049, 0.92), cream = surface(0xe4c7a0, 0.95);
  b.round([0, 0.4, 0], [0.27, 0.37, 0.62], fur)
    .round([0, 0.61, -0.3], [0.28, 0.3, 0.28], fur)
    .round([0, 0.55, -0.48], [0.2, 0.13, 0.24], cream)
    .round([0, 0.57, -0.59], [0.075, 0.055, 0.04], DARK)
    .box([0, 0.51, -0.23], [0.29, 0.055, 0.12], CYAN);
  if (!low) {
    for (const s of [-1, 1]) {
      b.round([s * 0.13, 0.73, -0.28], [0.075, 0.19, 0.1], DARK)
        .round([s * 0.125, 0.645, -0.37], [0.026, 0.028, 0.028], RUBBER);
    }
    b.cylinder([0, 0.53, 0.37], [0.07, 0.35, 0.07], fur, [0.9, 0, 0]);
  }
  for (const [s, front] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    b.part([s! * 0.1, 0.4, front! * 0.2], s === front ? "left-leg" : "right-leg")
      .cylinder([s! * 0.1, 0.2, front! * 0.2], [0.075, 0.34, 0.075], fur)
      .round([s! * 0.1, 0.055, front! * 0.2 - 0.025], [0.11, 0.1, 0.17], cream);
  }
  return b.finish(1, 100, 350);
}

function patrolUnit(low: boolean): Model {
  const b = new Builder(), graphite = surface(0x303b3e, 0.4, 0.4);
  b.wedge([0, 0.44, 0.04], [0.62, 0.48, 1.24], graphite, 0.4)
    .box([0, 0.16, 0], [0.5, 0.18, 1.04], DARK)
    .box([0, 0.39, -0.6], [0.42, 0.075, 0.04], GLASS)
    .box([0, 0.395, -0.624], [0.25, 0.018, 0.015], CYAN);
  for (const side of [-1, 1]) {
    b.box([side * 0.29, 0.22, 0], [0.13, 0.34, 0.92], RUBBER);
    for (const z of [-0.45, 0.45]) b.cylinder([side * 0.29, 0.22, z], [0.34, 0.13, 0.34], RUBBER, [0, 0, Math.PI / 2]);
    if (!low) {
      for (const z of [-0.44, -0.22, 0, 0.22, 0.44]) b.cylinder([side * 0.364, 0.22, z], [0.22, 0.025, 0.22], STEEL, [0, 0, Math.PI / 2])
        .cylinder([side * 0.381, 0.22, z], [0.075, 0.014, 0.075], DARK, [0, 0, Math.PI / 2]);
      for (let z = -0.48; z <= 0.48; z += 0.12) b.box([side * 0.29, 0.402, z], [0.14, 0.025, 0.035], DARK);
      b.box([side * 0.322, 0.53, 0.15], [0.016, 0.14, 0.47], DARK);
      for (let slot = 0; slot < 5; slot++) b.box([side * 0.335, 0.53, -0.03 + slot * 0.08], [0.014, 0.09, 0.015], STEEL);
    }
  }
  // A fold-out lectern, not a mast or weapon: the visible face is a terms display.
  b.cylinder([0, 0.73, 0.1], [0.075, 0.44, 0.075], STEEL)
    .box([0, 0.94, -0.03], [0.53, 0.32, 0.085], graphite, [-0.18, 0, 0])
    .box([0, 0.945, -0.085], [0.46, 0.24, 0.02], GLASS)
    .box([0, 0.815, -0.1], [0.56, 0.04, 0.12], STEEL);
  if (!low) {
    b.word("TERMS", [0, 1.02, -0.1], 0.065, WHITE)
      .word("MOAT", [0, 0.615, 0.668], 0.06, CYAN, true);
    for (let line = 0; line < 3; line++) b.box([0, 0.9 - line * 0.028, -0.103], [0.28 - line * 0.04, 0.008, 0.009], CYAN);
    b.box([0, 0.675, 0.38], [0.35, 0.04, 0.18], DARK)
      .round([0, 0.71, 0.39], [0.07, 0.045, 0.07], AMBER);
  }
  return b.finish(1, 140, 650);
}

function tidyUnit(low: boolean): Model {
  const b = new Builder(), paint = surface(0xd7ded8, 0.53, 0.12), blue = surface(0x356775, 0.42, 0.28);
  b.box([0, 0.33, 0.04], [0.6, 0.46, 0.63], paint)
    .wedge([0, 0.54, 0.05], [0.59, 0.18, 0.61], paint, 0.65)
    .box([0, 0.135, 0.04], [0.62, 0.17, 0.65], DARK)
    .box([0, 0.47, -0.285], [0.42, 0.105, 0.04], GLASS)
    .box([0, 0.476, -0.31], [0.24, 0.022, 0.015], CYAN);
  for (const side of [-1, 1]) {
    for (const z of [-0.18, 0.28]) {
      b.cylinder([side * 0.31, 0.16, z], [0.29, 0.105, 0.29], RUBBER, [0, 0, Math.PI / 2]);
      if (!low) b.cylinder([side * 0.371, 0.16, z], [0.145, 0.018, 0.145], STEEL, [0, 0, Math.PI / 2]);
    }
    b.box([side * 0.35, 0.35, -0.43], [0.065, 0.12, 0.42], blue)
      .box([side * 0.35, 0.47, -0.48], [0.05, 0.29, 0.39], paint)
      .box([side * 0.35, 0.635, -0.48], [0.07, 0.025, 0.41], AMBER);
    if (!low) {
      b.box([side * 0.31, 0.39, 0.13], [0.018, 0.17, 0.32], blue);
      for (let slot = 0; slot < 4; slot++) b.box([side * 0.327, 0.38, 0.01 + slot * 0.07], [0.012, 0.095, 0.012], DARK);
      b.cylinder([side * 0.27, 0.58, -0.51], [0.06, 0.045, 0.06], STEEL, [0, 0, Math.PI / 2]);
    }
  }
  b.box([0, 0.3, -0.53], [0.69, 0.07, 0.48], STEEL)
    .cylinder([0, 0.255, -0.74], [0.12, 0.65, 0.12], RUBBER, [0, 0, Math.PI / 2]);
  if (!low) {
    for (const side of [-1, 1]) b.round([side * 0.29, 0.075, -0.49], [0.3, 0.08, 0.3], DARK);
    b.box([0, 0.65, 0.19], [0.25, 0.05, 0.23], blue)
      .cylinder([0, 0.715, 0.19], [0.11, 0.09, 0.11], AMBER)
      .box([0, 0.385, 0.366], [0.3, 0.16, 0.016], blue);
    for (let stripe = -1; stripe <= 1; stripe++) b.box([stripe * 0.075, 0.385, 0.379], [0.024, 0.12, 0.012], WHITE, [0, 0, -0.25]);
  }
  return b.finish(1, 140, 650);
}

function spinnerBoard(low: boolean): Part[] {
  const b = new Builder();
  b.part([0, 1.02, -0.3], "sign").box([0, 1.02, -0.38], [1.02, 0.66, 0.07], DARK)
    .box([0, 1.02, -0.424], [0.93, 0.56, 0.018], GREEN)
    .box([0, 1.02, -0.335], [0.93, 0.56, 0.018], GREEN);
  if (!low) {
    for (const back of [false, true]) {
      const z = back ? -0.319 : -0.443;
      b.word("AI", [0, 1.21, z], 0.31, WHITE, back)
        .word("MOAT", [0, 0.87, z], 0.063, DARK, back);
    }
    for (const x of [-0.48, 0.48]) for (const y of [0.72, 1.32]) b.round([x, y, -0.435], [0.026, 0.026, 0.012], STEEL);
  }
  return b.finish().parts;
}

function robot(kind: "footman" | "trundle" | "patrol" | "tidy" | "sign-spinner", low: boolean): Model {
  if (kind === "patrol") return patrolUnit(low);
  if (kind === "tidy") return tidyUnit(low);
  const b = new Builder(), trundle = kind === "trundle";
  if (trundle) {
    b.round([0, 0.4, 0], [0.72, 0.64, 0.78], SHELL)
      .box([0, 0.18, 0], [0.62, 0.2, 0.67], DARK)
      .box([0, 0.59, -0.34], [0.4, 0.12, 0.04], GLASS)
      .box([0, 0.595, -0.365], [0.26, 0.025, 0.016], CYAN);
    for (const s of [-1, 1]) b.cylinder([s * 0.34, 0.18, 0], [0.28, 0.09, 0.28], RUBBER, [0, 0, Math.PI / 2]);
    return b.finish(1, 130, 500);
  }
  const h = 0.94;
  b.round([0, h, 0], [0.54, 0.64, 0.34], SHELL)
    .cylinder([0, h + 0.4, 0], [0.12, 0.18, 0.12], DARK)
    .round([0, h + 0.62, 0], [0.38, 0.34, 0.32], SHELL)
    .box([0, h + 0.63, -0.15], [0.28, 0.12, 0.04], GLASS)
    .box([0, h + 0.64, -0.178], [0.18, 0.028, 0.013], CYAN)
    .box([0, h - 0.13, -0.18], [0.3, 0.09, 0.035], CYAN)
    .round([0, h - 0.4, 0], [0.39, 0.19, 0.3], DARK);
  if (!low) {
    for (const s of [-1, 1]) {
      b.part([s * 0.31, h + 0.17, 0], s < 0 ? "left-arm" : "right-arm")
        .round([s * 0.31, h + 0.17, 0], [0.2, 0.2, 0.2], STEEL)
        .cylinder([s * 0.34, h - 0.1, 0], [0.13, 0.44, 0.13], SHELL)
        .round([s * 0.34, h - 0.35, -0.03], [0.14, 0.14, 0.14], DARK);
    }
    b.part().box([0, h, 0.23], [0.36, 0.48, 0.16], DARK);
  }
  for (const s of [-1, 1]) {
    b.part([s * 0.14, h - 0.38, 0], s < 0 ? "left-leg" : "right-leg")
      .cylinder([s * 0.14, 0.35, 0], [0.13, 0.48, 0.13], SHELL)
      .round([s * 0.14, 0.1, -0.075], [0.2, 0.15, 0.34], DARK);
  }
  if (kind === "sign-spinner") {
    const model = b.finish(1, 140, 650); model.parts.push(...spinnerBoard(low)); return model;
  }
  return b.finish(1, 140, 650);
}

function vehicle(kind: "van" | "bus", low: boolean): Model {
  const b = new Builder(), bus = kind === "bus", length = bus ? 10.5 : 5.2, width = bus ? 2.5 : 2.15;
  const front = -length / 2, rear = length / 2, roof = bus ? 2.95 : 2.6;
  b.box([0, 0.55, 0], [width, 0.55, length], DARK)
    .box([0, 1.57, 0.07], [width, bus ? 2.02 : 1.8, length - 0.18], WHITE)
    .box([0, roof, 0.07], [width - 0.08, 0.1, length - 0.25], SHELL)
    .box([0, 1.75, front - 0.015], [width - 0.25, 0.83, 0.04], GLASS)
    .box([0, 0.64, front - 0.1], [width, 0.18, 0.14], DARK)
    .box([0, 0.73, rear + 0.015], [width - 0.1, 0.18, 0.12], DARK);
  for (const s of [-1, 1]) {
    b.box([s * (width / 2 + 0.008), 1, 0], [0.025, 0.17, length - 0.45], bus ? CYAN : DARK)
      .box([s * (width / 2 - 0.32), 0.97, front - 0.037], [0.45, 0.15, 0.04], WHITE)
      .box([s * (width / 2 - 0.2), 1.09, rear + 0.008], [0.13, 0.38, 0.04], RED);
    if (!low) {
      const windows = bus ? 8 : 1;
      for (let i = 0; i < windows; i++) {
        const z = bus ? front + 1.35 + i * 1.06 : front + 0.72;
        b.box([s * (width / 2 + 0.008), 2.1, z], [0.027, 0.86, bus ? 0.93 : 1.15], GLASS);
      }
      b.box([s * (width / 2 + 0.1), 1.84, front + 0.23], [0.2, 0.3, 0.14], DARK)
        .box([s * (width / 2 + 0.023), 1.44, 0.45], [0.035, 0.8, bus ? 3.4 : 2.35], DARK);
      // Crisp geometric ad artwork stays readable at every render resolution; no remote fonts or texture fetches.
      for (let stripe = 0; stripe < 5; stripe++) b.box([s * (width / 2 + 0.05), 1.25 + stripe * 0.09, 0.4 + stripe * 0.18], [0.018, 0.045, 1.5], stripe % 2 ? WHITE : CYAN);
      b.box([s * (width / 2 + 0.05), 1.5, -0.8], [0.02, 0.36, 0.35], AMBER);
    }
  }
  if (!low) {
    b.box([0, roof + 0.13, 0.7], [width * 0.65, 0.21, bus ? 2.8 : 0.6], DARK)
      .box([0, 1.52, rear + 0.025], [0.04, 1.5, 0.026], STEEL);
    if (bus) b.box([width / 2 + 0.03, 1.25, front + 1.05], [0.05, 1.95, 1.05], GLASS);
  }
  for (const s of [-1, 1]) for (const z of [front + (bus ? 1.8 : 1), rear - (bus ? 2.1 : 1)]) {
    b.part([s * width / 2, 0.49, z], "wheel")
      .cylinder([s * width / 2, 0.49, z], [0.92, 0.24, 0.92], RUBBER, [0, 0, Math.PI / 2])
      .cylinder([s * (width / 2 + 0.13), 0.49, z], [0.48, 0.035, 0.48], STEEL, [0, 0, Math.PI / 2]);
  }
  return b.finish(1, 190, 1000);
}

function taxi(low: boolean): Model {
  const b = new Builder();
  b.round([0, 0.71, 0], [1.95, 0.72, 4.6], SHELL)
    .box([0, 0.39, 0], [1.81, 0.28, 4.1], DARK)
    .round([0, 1.15, 0.18], [1.7, 0.74, 2.58], GLASS)
    .box([0, 1.48, 0.23], [1.44, 0.08, 1.85], SHELL);
  for (const s of [-1, 1]) {
    b.box([s * 0.61, 0.82, -2.15], [0.46, 0.07, 0.04], WHITE)
      .box([s * 0.66, 0.85, 2.14], [0.39, 0.09, 0.04], RED);
    if (!low) b.box([s * 0.94, 0.85, 0.16], [0.035, 0.04, 0.37], DARK)
      .box([s * 0.91, 1.17, -0.88], [0.22, 0.12, 0.2], SHELL)
      .box([s * 0.89, 0.73, 0.25], [0.035, 0.11, 1.6], CYAN);
  }
  if (!low) b.cylinder([0, 1.58, 0.26], [0.26, 0.12, 0.26], DARK)
    .box([0, 0.53, -2.27], [1.31, 0.08, 0.06], DARK);
  for (const s of [-1, 1]) for (const z of [-1.34, 1.4]) {
    b.part([s * 0.93, 0.38, z], "wheel")
      .cylinder([s * 0.93, 0.38, z], [0.71, 0.19, 0.71], RUBBER, [0, 0, Math.PI / 2])
      .cylinder([s * 1.03, 0.38, z], [0.4, 0.027, 0.4], STEEL, [0, 0, Math.PI / 2]);
  }
  return b.finish(1, 190, 1000);
}

function drone(low: boolean): Model {
  const b = new Builder();
  b.round([0, 0.07, 0], [0.55, 0.22, 0.45], SHELL)
    .box([0, -0.35, 0], [1.15, 0.68, 0.12], DARK)
    .box([0, -0.35, -0.066], [0.97, 0.48, 0.018], CYAN)
    .box([0, -0.35, 0.066], [0.97, 0.48, 0.018], CYAN);
  if (!low) {
    b.box([0, 0.125, 0], [0.34, 0.045, 0.28], DARK)
      .box([0, -0.67, 0], [1.2, 0.055, 0.15], STEEL)
      .box([0, -0.35, -0.079], [0.9, 0.43, 0.01], surface(0x172e35, 0.35, 0.2))
      .box([0, -0.35, 0.079], [0.9, 0.43, 0.01], surface(0x172e35, 0.35, 0.2));
    for (const back of [false, true]) b.word("MOAT", [0, -0.25, back ? 0.091 : -0.091], 0.16, WHITE, back)
      .word("LABS", [0, -0.47, back ? 0.091 : -0.091], 0.065, CYAN, back);
    for (const side of [-1, 1]) b.cylinder([side * 0.4, -0.035, 0], [0.025, 0.19, 0.025], STEEL)
      .round([side * 0.24, 0.09, -0.17], [0.075, 0.05, 0.07], side < 0 ? RED : CYAN);
    for (const s of [-1, 1]) for (const z of [-0.38, 0.38]) {
      b.part().box([s * 0.35, 0.12, z * 0.6], [0.75, 0.045, 0.055], STEEL, [0, s * z, 0]);
      b.ring([s * 0.62, 0.21, z], [0.65, 0.65, 0.65], DARK, [Math.PI / 2, 0, 0]);
      b.part([s * 0.62, 0.17, z], "rotor")
        .cylinder([s * 0.62, 0.17, z], [0.12, 0.1, 0.12], DARK)
        .box([s * 0.62, 0.23, z], [0.57, 0.017, 0.06], RUBBER)
        .box([s * 0.62, 0.23, z], [0.06, 0.017, 0.57], RUBBER);
    }
  }
  return b.finish(1, 130, 650);
}

function associate(low: boolean): Model {
  const b = new Builder(), suit = surface(0x586678, 0.86), skin = surface(0xbd8e70, 0.87);
  b.round([0, 1.19, 0], [0.47, 0.63, 0.28], suit)
    .round([0, 1.69, 0], [0.26, 0.32, 0.25], skin)
    .round([0, 1.8, 0.012], [0.27, 0.17, 0.25], DARK)
    .box([0, 1.36, -0.15], [0.14, 0.27, 0.028], WHITE)
    .box([0, 1.3, -0.172], [0.035, 0.32, 0.018], CYAN);
  if (!low) {
    for (const s of [-1, 1]) {
      b.cylinder([s * 0.28, 1.13, 0], [0.13, 0.62, 0.13], suit)
        .round([s * 0.29, 0.81, 0], [0.11, 0.14, 0.11], skin);
    }
    b.box([0.29, 0.84, -0.055], [0.08, 0.13, 0.025], DARK)
      .box([0, 1.59, -0.126], [0.19, 0.025, 0.023], DARK)
      .wedge([0, 1.66, -0.139], [0.045, 0.07, 0.064], skin, 0.5)
      .box([-0.055, 1.73, -0.122], [0.035, 0.014, 0.014], DARK)
      .box([0.055, 1.73, -0.122], [0.035, 0.014, 0.014], DARK)
      .box([0, 1.71, -0.133], [0.17, 0.012, 0.018], STEEL)
      .box([0, 1.22, -0.159], [0.012, 0.25, 0.012], DARK);
    for (const side of [-1, 1]) {
      b.box([side * 0.104, 1.39, -0.15], [0.087, 0.28, 0.036], suit, [0, 0, side * 0.25])
        .box([side * 0.25, 0.99, -0.055], [0.13, 0.04, 0.13], WHITE)
        .box([side * 0.11, 1.06, -0.151], [0.095, 0.016, 0.018], DARK);
    }
    b.box([0.115, 1.31, -0.178], [0.082, 0.071, 0.017], WHITE)
      .box([0.115, 1.327, -0.19], [0.06, 0.012, 0.01], CYAN);
  }
  for (const s of [-1, 1]) {
    b.part([s * 0.115, 0.91, 0], s < 0 ? "left-leg" : "right-leg")
      .cylinder([s * 0.115, 0.49, 0], [0.15, 0.8, 0.16], suit)
      .round([s * 0.115, 0.08, -0.07], [0.18, 0.12, 0.31], DARK);
  }
  return b.finish(1, 140, 600);
}

function colossus(kind: "walker" | "finale", low: boolean): Model {
  const b = new Builder(), finale = kind === "finale";
  if (!finale) {
    b.box([0, 2.1, 0], [2.5, 0.54, 7.2], SHELL)
      .box([0, 2.44, 0], [2.25, 0.12, 6.8], DARK)
      .wedge([0, 2.47, -2.4], [1.7, 0.46, 1.5], DARK, 0.5)
      .box([0, 2.39, -3.17], [1.18, 0.12, 0.04], CYAN);
    for (const s of [-1, 1]) {
      b.box([s * 1.2, 2.29, 0], [0.12, 0.44, 6.65], STEEL);
      if (!low) {
        b.box([s * 1.27, 2.55, 0.1], [0.075, 0.13, 6.8], DARK);
        for (let bay = -2; bay <= 2; bay++) {
          b.box([s * 1.28, 2.3, bay * 1.05], [0.09, 0.1, 1.15], DARK, [bay % 2 ? 0.29 : -0.29, 0, 0])
            .box([s * 1.28, 2.63, bay * 1.05], [0.08, 0.1, 0.42], AMBER);
        }
      }
    }
    for (const s of [-1, 1]) for (const z of [-2, 2]) {
      // Combat's weak points are fixed at x±1.5,z±2,y0.5 relative to the body.
      b.cylinder([s * 1.43, 1.18, z], [0.28, 1.64, 0.28], DARK)
        .round([s * 1.5, 0.5, z], [0.47, 0.4, 0.47], AMBER)
        .box([s * 1.5, 0.15, z], [0.72, 0.3, 0.86], STEEL);
      if (!low) b.cylinder([s * 1.43, 1.42, z], [0.4, 0.45, 0.4], SHELL)
        .box([s * 1.5, 0.31, z], [0.5, 0.055, 0.65], DARK);
    }
    return b.finish(1, 300, 1500);
  }
  b.round([0, 3.22, 0], [1.6, 1.8, 0.75], DARK)
    .cylinder([0, 4.12, 0], [0.71, 0.4, 0.66], DARK)
    .round([0, 4.64, -0.01], [0.81, 0.9, 0.72], SHELL)
    .box([0, 4.71, -0.37], [0.5, 0.08, 0.05], CYAN)
    .round([0, 2.29, 0], [1.23, 0.45, 0.71], DARK);
  for (const s of [-1, 1]) {
    // At the 100x boss scale these match the authoritative ±12 m / 5 m ankle and
    // ±12 m / 100 m knee targets. Do not animate joints independently of those targets.
    b.part().cylinder([s * 0.27, 1.63, 0], [0.29, 1.296, 0.29], DARK, [0, 0, -s * 0.234])
      .cylinder([s * 0.12, 0.525, 0], [0.19, 0.95, 0.19], DARK)
      .round([s * 0.12, 1, 0], [0.12, 0.12, 0.12], AMBER)
      .round([s * 0.12, 0.035, -0.1], [0.28, 0.07, 0.55], DARK)
      .round([s * 0.12, 0.05, 0], [0.08, 0.08, 0.08], CYAN);
    b.part([s * 0.93, 3.82, 0], s < 0 ? "right-leg" : "left-leg")
      .cylinder([s * 1.02, 2.91, 0.04], [0.38, 1.86, 0.39], DARK)
      .round([s * 1.04, 1.91, 0.04], [0.36, 0.45, 0.36], SHELL);
  }
  if (!low) {
    b.part();
    b.round([0, 4.87, 0.03], [0.86, 0.5, 0.77], DARK)
      .box([-0.16, 4.73, -0.376], [0.14, 0.06, 0.035], DARK)
      .box([0.16, 4.73, -0.376], [0.14, 0.06, 0.035], DARK)
      .box([0, 4.55, -0.388], [0.22, 0.018, 0.025], STEEL);
    for (let rib = 0; rib < 5; rib++) b.ring([0, 4.04 + rib * 0.055, 0], [0.75, 0.62, 0.75], DARK, [Math.PI / 2, 0, 0]);
    for (let row = 0; row < 5; row++) for (let col = -2; col <= 2; col++) {
      const x = col * 0.22, y = 2.67 + row * 0.22;
      b.box([x, y, -0.35], [0.18, 0.19, 0.06], (row + col) % 3 ? surface(0x354246, 0.57, 0.4) : DARK)
        .box([x, y + 0.04, -0.386], [0.09, 0.025, 0.012], (row + col) % 4 ? STEEL : CYAN)
        .box([x - 0.055, y - 0.03, -0.389], [0.025, 0.052, 0.012], DARK);
    }
    for (const side of [-1, 1]) for (let row = 0; row < 6; row++) {
      b.box([side * 0.38, 1.25 + row * 0.15, 0.06], [0.09, 0.09, 0.29], surface(0x354246, 0.6, 0.36))
        .box([side * 0.12, 0.2 + row * 0.105, -0.095], [0.1, 0.07, 0.045], STEEL);
    }
    b.box([0, 3.8, 0.33], [1.03, 0.17, 0.13], DARK);
  }
  return b.finish(100, 2200, 10000);
}

function remains(kind: "heap" | "puddle", low: boolean): Model {
  const b = new Builder();
  if (kind === "puddle") {
    b.cylinder([0, 0.013, 0], [1.45, 0.022, 1.07], surface(0x47606a, 0.12, 0.35));
  } else {
    const rust = surface(0x8e4b31, 0.91, 0.22);
    b.round([0, 0.2, 0], [0.83, 0.38, 0.66], rust)
      .box([-0.25, 0.16, 0.2], [0.43, 0.16, 0.28], STEEL, [0.15, -0.5, 0.25]);
    if (!low) b.cylinder([0.27, 0.12, -0.19], [0.15, 0.42, 0.15], DARK, [0, 0.8, 1.1])
      .round([0.18, 0.32, 0.07], [0.25, 0.12, 0.3], SHELL);
  }
  return b.finish(1, 130, 650);
}

function weakPoint(low: boolean): Model {
  const b = new Builder();
  b.round([0, 0, 0], [0.72, 0.72, 0.72], CYAN)
    .ring([0, 0, 0], [1, 1, 1], AMBER);
  if (!low) b.ring([0, 0, 0], [1, 1, 1], AMBER, [0, Math.PI / 2, 0]);
  return b.finish(1, 2200, 10000);
}

function accessory(kind: "leash" | "lanyard"): Model {
  const b = new Builder();
  if (kind === "leash") b.cylinder([0, 0.5, 0], [0.018, 1, 0.018], DARK);
  else b.box([-0.055, 1.35, -0.17], [0.022, 0.29, 0.013], CYAN, [0, 0, -0.37])
    .box([0.055, 1.35, -0.17], [0.022, 0.29, 0.013], CYAN, [0, 0, 0.37])
    .box([0, 1.16, -0.18], [0.14, 0.19, 0.025], WHITE)
    .box([0, 1.19, -0.196], [0.1, 0.035, 0.008], AMBER);
  return b.finish(1, 120, 300);
}

function buildModel(kind: RuntimeVisualKind, low: boolean): Model {
  if (kind === "pigeon" || kind === "parrot") return bird(kind, low);
  if (kind === "dog") return dog(low);
  if (kind === "van" || kind === "bus") return vehicle(kind, low);
  if (kind === "robotaxi") return taxi(low);
  if (kind === "drone") return drone(low);
  if (kind === "associate") return associate(low);
  if (kind === "walker" || kind === "finale") return colossus(kind, low);
  if (kind === "heap" || kind === "puddle") return remains(kind, low);
  if (kind === "weak-point") return weakPoint(low);
  if (kind === "leash" || kind === "lanyard") return accessory(kind);
  return robot(kind, low);
}

function canonicalKind(kind: string): RuntimeVisualKind | null {
  switch (kind) {
    case "pigeon": case "dog": case "parrot": case "van": case "bus": case "robotaxi": case "drone":
    case "footman": case "trundle": case "patrol": case "tidy": case "sign-spinner": case "associate": case "walker": case "finale": case "heap": case "puddle": case "weak-point": case "leash": case "lanyard": return kind;
    case "moat-van": return "van";
    case "muni-bus": return "bus";
    case "ad-drone": return "drone";
    case "errandRobot": return "footman";
    case "sidewalkBot": return "trundle";
    case "recruit": case "robot-body": return "footman";
    case "vc-associate": return "associate";
    case "moat-walker": return "walker";
    case "boss": case "elizabeth": case "elizabeth-homes": return "finale";
    default: return null;
  }
}

interface BatchPart extends Part { mesh: THREE.InstancedMesh; cues: THREE.InstancedBufferAttribute; rig: THREE.InstancedBufferAttribute; gesture: THREE.InstancedBufferAttribute; triangles: number }
interface Batch { model: Model; parts: BatchPart[]; count: number; kind: RuntimeVisualKind; low: boolean; source: "file" | "procedural" }

const FILE_MODELS: Partial<Record<RuntimeVisualKind, string>> = {
  van: "models/moat-van.glb", bus: "models/muni-bus.glb", dog: "models/dog.glb",
  pigeon: "models/pigeon.glb", robotaxi: "models/robotaxi.glb", footman: "models/errand-robot.glb",
  trundle: "models/sidewalk-bot.glb", "sign-spinner": "models/errand-robot.glb", heap: "models/heap-mixed.glb",
};
const EXISTING_MODEL_KEYS: Partial<Record<RuntimeVisualKind, string>> = { footman: "robot", "sign-spinner": "robot", trundle: "sidewalk-bot" };
const HUMANOID_JOINTS = { arm_upper_L: "left-arm", arm_upper_R: "right-arm", leg_upper_L: "left-leg", leg_upper_R: "right-leg" } as const;

/** Preserve authored geometry while batching compatible surfaces at their animated joints. */
function authoredModel(root: THREE.Object3D, kind: RuntimeVisualKind, materials: Set<THREE.Material>, livery: () => THREE.Texture): Model {
  const cloned = new Map<THREE.Material, THREE.Material>();
  const material = (source: THREE.Material): THREE.Material => {
    const existing = cloned.get(source); if (existing) return existing;
    const copy = source.clone();
    if (kind === "bus" && source.name === "livery" && (copy as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      (copy as THREE.MeshStandardMaterial).map = livery();
    }
    cloned.set(source, copy); materials.add(copy); return copy;
  };
  const parts = packAuthoredRuntimeParts(root, { material,
    // The live owner-to-collar line replaces the authored rest-pose leash.
    omit: source => kind === "dog" && /leash/i.test(source.name) || kind === "heap" && /puddle/i.test(source.name) ||
      kind === "sign-spinner" && /^bag(?:_|$)/i.test(source.name),
    joint: kind === "footman" || kind === "sign-spinner" ? (source, modelRoot) => {
      let selected: { object: THREE.Object3D; animation: Animation } | null = null;
      for (let node: THREE.Object3D | null = source; node && node !== modelRoot; node = node.parent) {
        const animation: Animation | undefined = HUMANOID_JOINTS[node.name as keyof typeof HUMANOID_JOINTS];
        if (animation) selected = { object: node, animation };
      }
      return selected;
    } : undefined });
  if (kind === "sign-spinner") parts.push(...spinnerBoard(false));
  return { parts, scale: 1, detailDistance: kind === "dog" || kind === "pigeon" ? 100 : 190,
    visibilityDistance: kind === "dog" || kind === "pigeon" ? 650 : 1000 };
}

/** Pure ID phase keeps animations stable when objects enter/leave visibility. */
function idPhase(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 4096) / 4096 * Math.PI * 2;
}

/** All transforms are local scratch state; ticks and optional asset access come from the caller. */
export function createRuntimeAgentRenderer(scene: THREE.Scene | THREE.Group, options: RuntimeAgentRenderOptions = {}): RuntimeAgentRenderer {
  const capacity = Math.max(1, Math.min(2048, Math.floor(Number.isFinite(options.maxActors) ? options.maxActors! : 256)));
  const group = new THREE.Group(); group.name = "runtime-agents"; scene.add(group);
  const material = packedMaterial(false), batches = new Map<string, Batch>(), clock = { value: 0 };
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const distanceMaterial = new THREE.MeshDistanceMaterial();
  for (const pass of [material, depthMaterial, distanceMaterial]) installRuntimeRigging(pass, clock);
  const authored = new Map<RuntimeVisualKind, THREE.Object3D>(), requested = new Set<RuntimeVisualKind>(), authoredMaterials = new Set<THREE.Material>();
  let liveryTexture: THREE.DataTexture | null = null;
  const base = new THREE.Matrix4(), local = new THREE.Matrix4(), matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3(), scale = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, "YXZ");
  const pivot = new THREE.Vector3(), pivotOffset = new THREE.Vector3();
  const color = new THREE.Color(), clean = new THREE.Color(0xffffff), rusty = new THREE.Color(0x9a492d);
  let disposed = false;
  let info: RuntimeVisualInfo = { drawn: 0, bodiesDrawn: 0, near: 0, bodiesNear: 0, dropped: 0, invalid: 0, drawCalls: 0, triangles: 0, kinds: [], fileKinds: [] };

  function disposeBatch(batch: Batch): void {
    for (const part of batch.parts) { part.mesh.geometry.dispose(); part.mesh.dispose(); group.remove(part.mesh); }
  }

  function requestAuthored(kind: RuntimeVisualKind): void {
    const path = FILE_MODELS[kind];
    if (!path || !options.registry || requested.has(kind)) return;
    requested.add(kind);
    const key = EXISTING_MODEL_KEYS[kind] ?? `runtime:${kind}`;
    if (!EXISTING_MODEL_KEYS[kind]) options.registry.register(key, path);
    void options.registry.get(key).then(result => { if (!disposed && result.source === "file") authored.set(kind, result.model); });
  }

  function livery(): THREE.Texture {
    if (!liveryTexture) {
      const image = runtimeLiveryPixels();
      liveryTexture = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat);
      liveryTexture.name = "runtime:bus-livery:2048"; liveryTexture.colorSpace = THREE.SRGBColorSpace;
      liveryTexture.magFilter = THREE.LinearFilter; liveryTexture.minFilter = THREE.LinearMipmapLinearFilter;
      liveryTexture.generateMipmaps = true; liveryTexture.needsUpdate = true;
    }
    return liveryTexture;
  }

  function batchFor(kind: RuntimeVisualKind, low: boolean): Batch {
    const key = `${kind}:${low ? "far" : "near"}`;
    requestAuthored(kind);
    const cached = batches.get(key), loaded = low ? undefined : authored.get(kind);
    if (cached && (!loaded || cached.source === "file")) return cached;
    if (cached) disposeBatch(cached);
    const candidate = loaded ? authoredModel(loaded, kind, authoredMaterials, livery) : null;
    const fromFile = candidate !== null && candidate.parts.length > 0;
    if (candidate && !fromFile) authored.delete(kind);
    let model = fromFile ? candidate : buildModel(kind, low);
    if (low) {
      const parts = mergeRuntimeRestPose(model.parts);
      for (const part of model.parts) part.geometry.dispose();
      model = { ...model, parts };
    }
    const animated = mergeRuntimeAnimatedParts(model.parts);
    for (const part of model.parts) if (!part.material) part.geometry.dispose();
    model = { ...model, parts: animated };
    const parts = model.parts.map(part => {
      const cues = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
      cues.setUsage(THREE.DynamicDrawUsage); part.geometry.setAttribute("fcCue", cues);
      const rig = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      rig.setUsage(THREE.DynamicDrawUsage); part.geometry.setAttribute("fcRig", rig);
      const gesture = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      gesture.setUsage(THREE.DynamicDrawUsage); part.geometry.setAttribute("fcGesture", gesture);
      const mesh = new THREE.InstancedMesh(part.geometry, part.material ?? material, capacity);
      mesh.name = `runtime:${key}:${part.animation}`; mesh.count = 0; mesh.visible = false; mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = options.shadows === true; mesh.receiveShadow = options.shadows === true;
      if (!part.material) { mesh.customDepthMaterial = depthMaterial; mesh.customDistanceMaterial = distanceMaterial; }
      group.add(mesh);
      return { ...part, mesh, cues, rig, gesture, triangles: (part.geometry.index?.count ?? part.geometry.getAttribute("position").count) / 3 };
    });
    const batch: Batch = { model, parts, count: 0, kind, low, source: fromFile ? "file" : "procedural" }; batches.set(key, batch); return batch;
  }

  function update(snapshot: RuntimeVisualSnapshot, tick: number): void {
    if (disposed) throw new Error("Runtime agent renderer has been disposed");
    if (!Number.isFinite(tick)) throw new RangeError("Runtime visual tick must be finite");
    clock.value = tick / 60;
    for (const batch of batches.values()) batch.count = 0;
    for (const material of authoredMaterials) {
      const light = material as THREE.MeshStandardMaterial, channel = lightChannel(light.name);
      if (channel > 0 && light.emissive) {
        const levels = agentUniforms.fcLightK.value;
        light.emissiveIntensity = channelRatio(light.name) * (channel === 1 ? levels.x : channel === 2 ? levels.y : levels.z);
      }
    }
    const viewer = snapshot.viewer;
    const haveViewer = viewer && Number.isFinite(viewer.x) && Number.isFinite(viewer.z);
    let invalid = 0, drawn = 0, bodiesDrawn = 0, near = 0, bodiesNear = 0, dropped = 0;
    const seen = new Set<string>();
    const candidates: { actor: RuntimeVisualActor; kind: RuntimeVisualKind; distance: number }[] = [];
    const inputLimit = Math.min(snapshot.actors.length, 8192);
    dropped += snapshot.actors.length - inputLimit;
    for (let candidateIndex = 0; candidateIndex < inputLimit; candidateIndex++) {
      const actor = snapshot.actors[candidateIndex]!;
      if (actor.visible === false) continue;
      const kind = canonicalKind(actor.kind);
      if (!kind || !actor.id || ![actor.x, actor.y, actor.z, actor.heading].every(Number.isFinite) ||
          Math.max(Math.abs(actor.x), Math.abs(actor.y), Math.abs(actor.z)) > 1e6 ||
          (actor.scale !== undefined && (!Number.isFinite(actor.scale) || actor.scale <= 0 || actor.scale > 1000)) ||
          (actor.heightScale !== undefined && (!Number.isFinite(actor.heightScale) || actor.heightScale < 0))) { invalid++; continue; }
      const dx = haveViewer ? actor.x - viewer.x : 0, dz = haveViewer ? actor.z - viewer.z : 0;
      candidates.push({ actor, kind, distance: Math.sqrt(dx * dx + dz * dz) });
    }
    for (const link of (snapshot.links ?? []).slice(0, 256)) {
      if (!link.id || ![link.from.x, link.from.y, link.from.z, link.to.x, link.to.y, link.to.z].every(Number.isFinite)) { invalid++; continue; }
      const dx = link.to.x - link.from.x, dy = link.to.y - link.from.y, dz = link.to.z - link.from.z;
      const horizontal = Math.sqrt(dx * dx + dz * dz), length = Math.sqrt(horizontal * horizontal + dy * dy);
      if (length < 1e-5 || length > 16) { invalid++; continue; }
      const actor: RuntimeVisualActor = { id: link.id, kind: "leash", x: link.from.x, y: link.from.y, z: link.from.z,
        heading: Math.atan2(-dx, dz), pitch: Math.atan2(horizontal, dy), heightScale: length };
      const vx = haveViewer ? actor.x - viewer.x : 0, vz = haveViewer ? actor.z - viewer.z : 0;
      candidates.push({ actor, kind: "leash", distance: Math.sqrt(vx * vx + vz * vz) });
    }
    candidates.sort((a, b) => a.distance - b.distance || (a.actor.id < b.actor.id ? -1 : a.actor.id > b.actor.id ? 1 : 0));
    for (const candidate of candidates) {
      const { actor, kind, distance } = candidate;
      if (seen.has(actor.id)) { invalid++; continue; } seen.add(actor.id);
      if (drawn >= capacity) { dropped++; continue; }
      const detailDistance = kind === "finale" || kind === "weak-point" ? 2200 : kind === "walker" ? 300 : kind === "bus" || kind === "van" || kind === "robotaxi" ? 190 : kind === "pigeon" || kind === "parrot" ? 85 : 140;
      const visibility = kind === "finale" || kind === "weak-point" ? 10000 : kind === "walker" ? 1500 : kind === "bus" || kind === "van" || kind === "robotaxi" ? 1000 : kind === "pigeon" || kind === "parrot" ? 300 : 650;
      if (distance > visibility) { dropped++; continue; }
      const low = distance > detailDistance, batch = batchFor(kind, low), index = batch.count++;
      const actorScale = actor.scale ?? batch.model.scale;
      const height = Math.min(kind === "leash" ? 16 : 1.5, actor.heightScale ?? 1);
      const speed = Number.isFinite(actor.speed) ? Math.max(-100, Math.min(100, actor.speed!)) : 0;
      const moving = Math.min(1, Math.abs(speed) / (kind === "dog" ? 2 : 1.5));
      const phase = idPhase(actor.id), time = tick / 60;
      const gait = Math.sin(time * 7 + phase) * 0.45 * moving;
      const flight = actor.mode === "startle" || actor.mode === "flee" || actor.mode === "fly" || kind === "parrot";
      const bob = kind === "drone" ? Math.sin(time * 1.7 + phase) * 0.07 : 0;
      const pitch = Number.isFinite(actor.pitch) ? actor.pitch! : 0, roll = Number.isFinite(actor.roll) ? actor.roll! : 0;
      q.setFromEuler(e.set(pitch, -actor.heading, roll));
      pivot.set(0, (Number.isFinite(actor.pivotY) ? actor.pivotY! : 0) * actorScale * height, 0);
      pivotOffset.copy(pivot).applyQuaternion(q).multiplyScalar(-1).add(pivot);
      base.compose(pos.set(actor.x + pivotOffset.x, actor.y + bob + pivotOffset.y, actor.z + pivotOffset.z), q, scale.set(actorScale, actorScale * height, actorScale));
      const rust = Math.max(0, Math.min(1, Number.isFinite(actor.rust) ? actor.rust! : 0));
      color.copy(clean).lerp(rusty, rust * 0.8);
      const alert = kind === "weak-point" || actor.mode === "attack" || actor.mode === "alerted" || actor.mode === "windup" || actor.mode === "forced-update" || actor.mode === "honk" ||
        actor.tells?.some(tell => tell === "battery-overdraw" || tell === "battery-calibrating") === true;
      for (const part of batch.parts) {
        let rx = 0, ry = 0, rz = 0;
        if (part.animation === "left-leg") rx = gait;
        if (part.animation === "right-leg") rx = -gait;
        if (part.animation === "left-wing") rz = flight ? Math.sin(time * 28 + phase) * 1.1 - 0.35 : 0;
        if (part.animation === "right-wing") rz = flight ? -Math.sin(time * 28 + phase) * 1.1 + 0.35 : 0;
        if (part.animation === "rotor") ry = time * 43 + phase;
        if (part.animation === "wheel") rx = -time * speed / 0.46;
        if (part.animation === "sign") ry = Math.sin(time * 1.8 + phase) * 0.55;
        local.compose(pos.set(...part.pivot), q.setFromEuler(e.set(rx, ry, rz)), scale.set(1, 1, 1));
        if (part.rest) local.multiply(part.rest);
        matrix.multiplyMatrices(base, local); part.mesh.setMatrixAt(index, matrix); part.mesh.setColorAt(index, color);
        part.cues.setXY(index, 0, alert ? 0.45 + Math.sin(time * 8) * 0.2 : 0);
        part.rig.setXYZW(index, phase, moving, speed, flight ? 1 : 0);
        part.gesture.setX(index, actor.emote === "wave" ? 1 : 0);
      }
      drawn++; if (!low) near++;
      if (!["puddle", "weak-point", "leash", "lanyard"].includes(kind)) { bodiesDrawn++; if (!low) bodiesNear++; }
    }
    let drawCalls = 0, triangles = 0;
    const kinds: RuntimeVisualKind[] = [], fileKinds: RuntimeVisualKind[] = [];
    for (const batch of batches.values()) {
      if (batch.count && !kinds.includes(batch.kind)) kinds.push(batch.kind);
      if (batch.count && batch.source === "file" && !fileKinds.includes(batch.kind)) fileKinds.push(batch.kind);
      for (const part of batch.parts) {
        part.mesh.count = batch.count; part.mesh.visible = batch.count > 0;
        if (!batch.count) continue;
        drawCalls += part.draws ?? 1; triangles += part.triangles * batch.count;
        part.mesh.instanceMatrix.clearUpdateRanges(); part.mesh.instanceMatrix.addUpdateRange(0, batch.count * 16); part.mesh.instanceMatrix.needsUpdate = true;
        if (part.mesh.instanceColor) { part.mesh.instanceColor.clearUpdateRanges(); part.mesh.instanceColor.addUpdateRange(0, batch.count * 3); part.mesh.instanceColor.needsUpdate = true; }
        part.cues.clearUpdateRanges(); part.cues.addUpdateRange(0, batch.count * 2); part.cues.needsUpdate = true;
        part.rig.clearUpdateRanges(); part.rig.addUpdateRange(0, batch.count * 4); part.rig.needsUpdate = true;
        part.gesture.clearUpdateRanges(); part.gesture.addUpdateRange(0, batch.count); part.gesture.needsUpdate = true;
      }
    }
    info = { drawn, bodiesDrawn, near, bodiesNear, dropped, invalid, drawCalls, triangles, kinds: kinds.sort(), fileKinds: fileKinds.sort() };
  }

  function dispose(): void {
    if (disposed) return; disposed = true; scene.remove(group);
    for (const batch of batches.values()) disposeBatch(batch);
    batches.clear(); material.dispose(); depthMaterial.dispose(); distanceMaterial.dispose();
    for (const material of authoredMaterials) material.dispose();
    liveryTexture?.dispose(); liveryTexture = null;
    authoredMaterials.clear(); authored.clear();
    info = { drawn: 0, bodiesDrawn: 0, near: 0, bodiesNear: 0, dropped: 0, invalid: 0, drawCalls: 0, triangles: 0, kinds: [], fileKinds: [] };
  }

  return { group, update, info: () => ({ ...info, kinds: [...info.kinds], fileKinds: [...info.fileKinds] }), dispose };
}
