// Node-side replays for the browser tests: step a snapshot taken from the running game with the
// same inputs and events the game got, and say whether the game ended in exactly the same state.
//
// The game builds its sim world from a world directory: colliders, and the road graph (ambient
// traffic) and boundary (edge and shore walls) when the manifest names them. Which construction
// the game used is a question tests ask on purpose: `constructions()` lists the one the
// manifest describes first, then colliders only as the fallback.

import {
  NEUTRAL_INPUT,
  canonicalJson,
  hashState,
  step,
  type InputFrame,
  type SimEvent,
  type SimInput,
  type SimState,
  type World,
} from "../../src/sim/index.ts";
import { loadWorldFiles } from "../helpers.ts";
import { makeWorld } from "./determinism-scenario.ts";

export const COLLIDERS_ONLY = "colliders only";
export const WITH_ROADS = "colliders + road graph";
export const WITH_ROADS_AND_BOUNDARY = "colliders + road graph + boundary";
export type ConstructionLabel = typeof COLLIDERS_ONLY | typeof WITH_ROADS | typeof WITH_ROADS_AND_BOUNDARY;

export interface Construction {
  label: ConstructionLabel;
  world: World;
}

export interface Constructions {
  /** What the manifest describes: with the road graph and the boundary when it names them. */
  expected: ConstructionLabel;
  /** The expected construction first, then the other (when the manifest names roads). Built lazily, once. */
  get(i: number): Construction;
  count: number;
}

const cache = new Map<string, Constructions>();

/** The sim worlds a game may have built from public/tiles/<name>/, cached per world. */
export function constructions(name: string): Constructions {
  let c = cache.get(name);
  if (c) return c;
  const files = loadWorldFiles(name);
  const full: ConstructionLabel = files.roads ? (files.boundary ? WITH_ROADS_AND_BOUNDARY : WITH_ROADS) : COLLIDERS_ONLY;
  const labels: ConstructionLabel[] = full === COLLIDERS_ONLY ? [COLLIDERS_ONLY] : [full, COLLIDERS_ONLY];
  const built: Construction[] = [];
  c = {
    expected: labels[0]!,
    count: labels.length,
    get(i: number): Construction {
      if (!built[i]) {
        const label = labels[i]!;
        const world = label === COLLIDERS_ONLY ? makeWorld(files.tiles, null, null, files.gameplay ?? undefined, files.transit ?? undefined) : makeWorld(files.tiles, files.roads, label === WITH_ROADS_AND_BOUNDARY ? files.boundary : null, files.gameplay ?? undefined, files.transit ?? undefined);
        built[i] = { label, world };
      }
      return built[i]!;
    },
  };
  cache.set(name, c);
  return c;
}

/** A run of ticks: one input frame per tick, plus the events that apply during it (absolute ticks). */
export interface Chunk {
  frames: readonly InputFrame[];
  events?: readonly SimEvent[];
}

/** n ticks of one input for p1 (what window.__fogcity.stepN(n, input) does). */
export function p1Chunk(n: number, input: SimInput = NEUTRAL_INPUT): Chunk {
  return { frames: Array.from({ length: n }, () => ({ p1: input })) };
}

/** Step `s0` through the chunks: the hash after each chunk, and the final state. */
export function replay(world: World, s0: SimState, chunks: readonly Chunk[]): { hashes: string[]; final: SimState } {
  let s = s0;
  const hashes: string[] = [];
  for (const c of chunks) {
    const byTick = new Map<number, SimEvent[]>();
    for (const e of c.events ?? []) {
      const list = byTick.get(e.tick);
      if (list) list.push(e);
      else byTick.set(e.tick, [e]);
    }
    for (const f of c.frames) s = step(world, s, f, byTick.get(s.tick + 1) ?? []);
    hashes.push(hashState(s));
  }
  return { hashes, final: s };
}

/** Where two long strings first differ, with a little context, for failure messages. */
export function firstDifference(a: string, b: string, labelA = "node", labelB = "browser"): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return "identical";
  const from = Math.max(0, i - 120);
  return `offset ${i}:\n  ${labelA}: …${a.slice(from, i + 80)}\n  ${labelB}: …${b.slice(from, i + 80)}`;
}

export interface MatchResult {
  expected: ConstructionLabel;
  /** The construction under which Node reproduced the game exactly, or undefined. */
  match?: { label: ConstructionLabel; world: World; hashes: string[]; final: SimState };
  /** Per construction tried: where Node first parted from the game. */
  tried: string[];
}

/**
 * Replay `chunks` from `s0` under each construction (expected first, the next only if needed)
 * and compare every chunk hash and the final state with what the game produced.
 */
export function matchGame(
  name: string,
  s0: SimState,
  chunks: readonly Chunk[],
  gameHashes: readonly string[],
  gameFinal: SimState,
): MatchResult {
  const c = constructions(name);
  const tried: string[] = [];
  const finalJson = canonicalJson(gameFinal);
  for (let i = 0; i < c.count; i++) {
    const { label, world } = c.get(i);
    const r = replay(world, s0, chunks);
    const k = r.hashes.findIndex((h, j) => h !== gameHashes[j]);
    const nodeJson = canonicalJson(r.final);
    if (k < 0 && r.hashes.length === gameHashes.length && nodeJson === finalJson) {
      return { expected: c.expected, match: { label, world, ...r }, tried };
    }
    const at = k >= 0 ? `first divergence after chunk ${k} (node ${r.hashes[k]} vs game ${gameHashes[k]}); ` : "";
    const diff = firstDifference(nodeJson, finalJson, "node", "game");
    tried.push(`${label}: ${at}${diff === "identical" ? "final states equal again by the end" : `final states differ at ${diff}`}`);
  }
  return { expected: c.expected, tried };
}
