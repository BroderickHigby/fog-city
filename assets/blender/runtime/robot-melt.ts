// Melt and rust hooks for the robot models (errand-robot.glb, sidewalk-bot.glb; built with
// assets/blender/lib/melt.py and fc.add_rust_mask). A reference for the render track:
//
//  - Every mesh part carries three morph targets, in order seize, slump, melt, authored at
//    rest. meltWeights() gives their influences for the sim's melt state and the time spent
//    in it. Before blending, ease every joint node (limbs, head, lid, wheels) back to its rest
//    rotation over the first 0.3 s of `seized`: the morphs assume the rest pose.
//  - Every primitive carries a float vertex attribute _RUST_MASK (three.js: `_rust_mask`):
//    0 rusts first (joints, seams), 1 last (the middle of panels), 2 never (night lights,
//    groceries, cargo). Rust shows where rustCoverage(mask, rust) > 0; materials that may
//    rust carry extras { rustable: true }.
//  - At `heap`, swap the robot for heap-porter.glb or heap-trundle.glb (heap-mixed.glb for
//    two melting together): the heap is the melt shape, rusted and simplified, on a puddle.

export type MeltState = "active" | "seized" | "slumping" | "heap";

/** Seconds the sim spends in each state (design.md, Combat: water and rust). */
export const MELT_SECONDS = { seized: 0.5, slumping: 1.5 } as const;

/** Morph influences [seize, slump, melt] for a melt state and the seconds spent in it. */
export function meltWeights(state: MeltState, t: number): [number, number, number] {
  const clamp = (x: number) => Math.min(Math.max(x, 0), 1);
  switch (state) {
    case "seized":
      return [clamp(t / MELT_SECONDS.seized), 0, 0];
    case "slumping": {
      const u = clamp(t / MELT_SECONDS.slumping);
      return u < 0.5 ? [1 - 2 * u, 2 * u, 0] : [0, 2 - 2 * u, 2 * u - 1];
    }
    case "heap":
      return [0, 0, 1];
    default:
      return [0, 0, 0];
  }
}

/** How rusted a vertex looks (0..1) for its mask and the robot's rust value (0..1). */
export function rustCoverage(mask: number, rust: number): number {
  const lo = mask - 0.1;
  const hi = mask + 0.1;
  const x = Math.min(Math.max((1.1 * rust - lo) / (hi - lo), 0), 1);
  return x * x * (3 - 2 * x);
}

/** The same in GLSL, for a material's onBeforeCompile (declare `attribute float _rust_mask;`). */
export const RUST_GLSL = /* glsl */ `
float rustCoverage(float mask, float rust) {
  return smoothstep(mask - 0.1, mask + 0.1, 1.1 * rust);
}
`;
