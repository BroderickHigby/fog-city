// The near pedestrians as real people: the Rocketbox adult crowd (assets/imports/rocketbox-crowd,
// MIT) drawn with the same skinned bodies, materials and idle/walk/run clips as the player's
// avatar (player-body.ts), for the CROWD_NEAR_MAX nearest people. Farther people stay on the
// instanced procedural rig (agent-layer.ts). Render-only: poses come from the sim.
//
// Each person keeps one character (picked from its agent id) for as long as it lives. A body
// unseen for CROWD_FORGET_S is disposed, so memory follows the people near the camera.
import * as THREE from "three";
import type { DodgeState } from "../sim/contract.ts";
import { PlayerBodies, type BodyRenderCost } from "./player-body.ts";
import type { HumanSupportHeight } from "./human-feet.ts";

export const CROWD_FILES: readonly string[] = [
  "Female_Adult_01", "Female_Adult_03", "Female_Adult_05", "Female_Adult_07", "Female_Adult_09", "Female_Adult_11",
  "Male_Adult_02", "Male_Adult_04", "Male_Adult_06", "Male_Adult_08", "Male_Adult_10", "Male_Adult_12",
].map((name) => `models/crowd/${name}.glb`);
/** Skinned people drawn at once (the nearest; the agent layer's near tier hands them over). */
export const CROWD_NEAR_MAX = 24;
/** A body not drawn for this long is disposed. */
export const CROWD_FORGET_S = 6;

/** The character a person wears: stable for its id, spread evenly over the crowd. */
export function characterFor(id: number, characters: number = CROWD_FILES.length): number {
  // murmur3's finaliser: neighbouring ids land on unrelated characters.
  let h = id >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) % characters;
}

export class CrowdHumans {
  readonly group = new THREE.Group();
  private readonly kinds: (PlayerBodies | null)[];
  private readonly seen = new Map<number, number>();
  private time = 0;
  private lastSweep = 0;
  private drawnCount = 0;
  private drawBudget = Infinity;
  private calls = 0;
  private tris = 0;
  private disposed = false;
  private supportHeight: HumanSupportHeight | undefined;

  constructor(bytes: (path: string) => Promise<Uint8Array>, shadows: boolean, files: readonly string[] = CROWD_FILES) {
    this.group.name = "crowd:humans";
    this.kinds = files.map(() => null);
    files.forEach((file, i) => {
      void PlayerBodies.load(bytes, shadows, file, { compactCrowd: true }).then((bodies) => {
        if (this.disposed) { bodies.dispose(); return; }
        if (this.supportHeight) bodies.setSupportHeight(this.supportHeight);
        bodies.group.name = `crowd:${i}`;
        this.kinds[i] = bodies;
        this.group.add(bodies.group);
      }).catch((error: unknown) => {
        console.warn(`[fog-city] crowd model ${file}: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  /** Apply actual road/ground support to current characters and ones still loading. */
  setSupportHeight(height: HumanSupportHeight): void {
    this.supportHeight = height;
    for (const bodies of this.kinds) bodies?.setSupportHeight(height);
  }

  /** Characters loaded so far. */
  get loaded(): number { return this.kinds.filter(Boolean).length; }
  /** People drawn as skinned bodies last frame. */
  get drawn(): number { return this.drawnCount; }
  /** Actual colour-pass primitives/triangles of the accepted bodies this frame. */
  get drawCalls(): number { return this.calls; }
  get triangles(): number { return this.tris; }

  /** Cost of this person's loaded character, or null while it needs the procedural fallback. */
  costFor(id: number): Readonly<BodyRenderCost> | null {
    return this.kinds[characterFor(id, this.kinds.length)]?.renderCost ?? null;
  }

  begin(dt: number, drawBudget = Infinity): void {
    this.time += Math.max(0, dt);
    this.drawnCount = 0;
    this.calls = 0;
    this.tris = 0;
    this.drawBudget = Math.max(0, drawBudget);
    for (const k of this.kinds) k?.begin();
  }

  /**
   * Draw person `id` this frame. False when its character has not loaded yet or the crowd is
   * full: the caller draws the procedural person instead.
   */
  /** `dodge`: the agent's (sim/dodge.ts) while it gets out of a car's way, else null: picks the dodge clips (human-motion.ts). */
  add(id: number, x: number, y: number, z: number, heading: number, speed: number, dt: number, dodge: Readonly<DodgeState> | null = null): boolean {
    if (this.disposed || this.drawnCount >= CROWD_NEAR_MAX) return false;
    const bodies = this.kinds[characterFor(id, this.kinds.length)];
    if (!bodies) return false;
    const cost = bodies.renderCost;
    if (this.calls + cost.drawCalls > this.drawBudget) return false;
    bodies.add(String(id), x, y, z, heading, speed, dt, undefined, dodge);
    this.seen.set(id, this.time);
    this.drawnCount++;
    this.calls += cost.drawCalls;
    this.tris += cost.triangles;
    return true;
  }

  end(): void {
    for (const k of this.kinds) k?.end();
    if (this.time - this.lastSweep < 1) return;
    this.lastSweep = this.time;
    const keep = this.kinds.map(() => new Set<string>());
    for (const [id, at] of this.seen) {
      if (this.time - at > CROWD_FORGET_S) { this.seen.delete(id); continue; }
      keep[characterFor(id, this.kinds.length)]!.add(String(id));
    }
    this.kinds.forEach((k, i) => k?.remove(keep[i]!));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const k of this.kinds) k?.dispose();
    this.kinds.fill(null);
    this.seen.clear();
    this.group.removeFromParent();
  }
}
