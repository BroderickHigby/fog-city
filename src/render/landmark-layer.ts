// Places landmark models from content/landmarks.json and turns their clock hands.
// A landmark whose model is missing is simply not drawn (the generated building it would
// replace stays). When a model loads, the buildings it replaces are hidden.

import * as THREE from "three";
import {
  clockHandAxis,
  clockHandKind,
  clockHandRotation,
  parseLandmarks,
  placeLandmark,
  type ClockHandKind,
  type LandmarkPlacement,
} from "./landmarks.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { GroundFn } from "./types.ts";

interface Hand {
  node: THREE.Object3D;
  kind: ClockHandKind;
  rest: THREE.Quaternion;
  axis: THREE.Vector3;
}

const _q = new THREE.Quaternion();

export class LandmarkLayer {
  readonly group = new THREE.Group();
  readonly placements: LandmarkPlacement[] = [];
  readonly skipped: string[] = [];
  private hands: Hand[] = [];
  private loaded = 0;
  private readonly inScene = new Set<string>();
  private missing: string[] = [];
  private lastMinute = NaN;
  private readonly registry: ModelRegistry<THREE.Object3D>;
  private readonly onReplace: (ids: string[]) => void;
  private readonly onModel: ((root: THREE.Object3D) => void) | undefined;

  constructor(
    doc: unknown,
    registry: ModelRegistry<THREE.Object3D>,
    ground: GroundFn,
    onReplace: (ids: string[]) => void,
    onModel?: (root: THREE.Object3D) => void,
  ) {
    this.registry = registry;
    this.onReplace = onReplace;
    this.onModel = onModel;
    this.group.name = "landmarks";
    const { entries, skipped } = parseLandmarks(doc);
    this.skipped.push(...skipped);
    for (const e of entries) {
      const p = placeLandmark(e, ground);
      this.placements.push(p);
      this.registry.register(`landmark:${p.id}`, p.url);
      void this.registry.get(`landmark:${p.id}`).then((r) => {
        if (r.source !== "file") {
          this.missing.push(p.id);
          return;
        }
        this.place(r.model, p);
      });
    }
  }

  get count(): number {
    return this.loaded;
  }

  get missingIds(): readonly string[] {
    return this.missing;
  }

  /** One entry per landmarks.json placement: where it was placed and whether its model is in the scene. */
  entries(): Array<{ id: string; x: number; y: number; z: number; loaded: boolean }> {
    return this.placements.map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, loaded: this.inScene.has(p.id) }));
  }

  private place(root: THREE.Object3D, p: LandmarkPlacement): void {
    root.name = `landmark:${p.id}`;
    root.position.set(p.x, p.y, p.z);
    root.rotation.set(0, p.rotationY, 0);
    root.scale.setScalar(p.scale);
    root.traverse((o) => {
      const kind = clockHandKind(o.name, o.userData as Record<string, unknown>);
      if (!kind) return;
      const [x, y, z] = clockHandAxis(o.userData as Record<string, unknown>);
      this.hands.push({ node: o, kind, rest: o.quaternion.clone(), axis: new THREE.Vector3(x, y, z) });
    });
    this.onModel?.(root);
    this.group.add(root);
    this.loaded++;
    this.inScene.add(p.id);
    this.lastMinute = NaN;
    if (p.replaces.length > 0) this.onReplace(p.replaces);
  }

  /** Turn every clock hand to the in-game time (minutes since midnight). */
  update(minuteOfDay: number): void {
    // Seconds resolution is plenty; skip when nothing would move.
    const m = Math.floor(minuteOfDay * 60) / 60;
    if (m === this.lastMinute || this.hands.length === 0) return;
    this.lastMinute = m;
    for (const h of this.hands) {
      _q.setFromAxisAngle(h.axis, clockHandRotation(h.kind, m));
      h.node.quaternion.copy(h.rest).multiply(_q);
    }
  }
}
