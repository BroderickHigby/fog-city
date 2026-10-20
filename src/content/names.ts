// Invented startup and product names: "Kelpforge", "Feral Teapot", "moss.ai", "Pondr".
//
// The whole output space is finite and enumerable (allNames()), and every candidate is run
// through the real-brand blocklist before it can be chosen, so "no real name ever comes out"
// is a property of the construction, and tests/content/names.test.ts checks it exhaustively.

import { blockedNameReason } from "./blocklist.ts";
import { makePrng, type Prng } from "./prng.ts";

/** Longest name ever produced. Billboard headlines are sized against it. */
export const NAME_MAX = 12;
export const NAME_MIN = 3;

// Word pools. Bay Area nouns, AI jargon and harmless animals; nothing that is a person.
const ROOTS = [
  "Prompt", "Vector", "Latent", "Token", "Tensor", "Kernel", "Cache", "Shard", "Ember", "Quill", "Ledger",
  "Orbit", "Drift", "Glide", "Prism", "Vapor", "Sonder", "Parrot", "Marble", "Comet", "Lattice",
  "Hush", "Nimbus", "Quokka", "Bramble", "Sorrel", "Juniper", "Basil", "Fennel", "Moss", "Kale", "Fog",
  "Ferry", "Cable", "Pier", "Brine", "Kelp", "Heron", "Pelican", "Sprout", "Gull", "Fable", "Hatch",
  "Kiln", "Tally", "Plinth", "Rook", "Wren", "Yarrow", "Thistle", "Clam", "Burrow", "Mortar", "Grove",
  "Bluff", "Cove", "Sable", "Tinsel", "Dune", "Pylon", "Lumber", "Tangent",
] as const;

/** Joined lower-case ("Kalely") or CamelCase ("KaleStack"). */
const SUFFIXES: ReadonlyArray<readonly [string, "join" | "camel"]> = [
  ["ly", "join"], ["ify", "join"], ["io", "join"], ["wise", "join"], ["ster", "join"], ["ware", "join"],
  ["verse", "join"], ["kit", "join"], ["grid", "join"], ["sync", "join"], ["deck", "join"],
  ["Stack", "camel"], ["Loop", "camel"], ["Forge", "camel"], ["Mind", "camel"], ["Works", "camel"],
  ["Flow", "camel"], ["Base", "camel"],
];

const ADJECTIVES = [
  "Latent", "Quiet", "Stealth", "Hyper", "Tiny", "Feral", "Polite", "Lucid", "Sober", "Velvet", "Cosmic",
  "Honest", "Patient", "Rogue", "Ambient", "Serene", "Bespoke", "Mild", "Brave", "Gentle", "Earnest",
  "Sudden", "Plucky", "Frugal", "Lazy", "Sincere", "Vague", "Calm", "Proud", "Sleepy",
] as const;

const NOUNS = [
  "Pelican", "Heron", "Crab", "Gull", "Walrus", "Ferret", "Toaster", "Lobster", "Parakeet", "Cactus",
  "Fern", "Tugboat", "Trolley", "Kiln", "Lantern", "Teapot", "Compass", "Harbor", "Anchor", "Ladder",
  "Pigeon", "Raccoon", "Moth", "Badger", "Yak", "Sourdough", "Kelp", "Clam", "Muffin", "Pretzel", "Turnip",
] as const;

const TLDS = [".ai", ".dev", ".so", ".run", ".sh", ".xyz"] as const;

/** Words ending in "er" that drop the e: Ledger -> Ledgr. */
const DROP_E = [
  "Ledger", "Gather", "Ponder", "Wander", "Ember", "Hammer", "Shimmer", "Linger", "Tinker", "Clamber",
  "Glimmer", "Ladder", "Thunder", "Copper", "Badger", "Ranger", "Mutter", "Saunter", "Banter",
] as const;

const GREEK_HEADS = ["Ve", "Ka", "Ny", "Zo", "Ori", "Sa", "Te", "Xe", "Mi", "Ara", "Eli", "Iso"] as const;
const GREEK_MIDS = ["lo", "ra", "ni", "ve", "ta", "si", "mo", "de"] as const;
const GREEK_TAILS = ["ra", "x", "n", "ssa", "via", "lith", "ze"] as const;

const BRANDISH = [" AI", "OS", " Labs", " HQ"] as const;
const PREFIX_VERBS = ["Hey ", "Ask ", "Just ", "Go "] as const;

export type NamePattern = "compound" | "twoWord" | "domain" | "dropE" | "greek" | "brandish" | "imperative";

const WEIGHTS: Readonly<Record<NamePattern, number>> = {
  compound: 30,
  twoWord: 20,
  domain: 15,
  dropE: 5,
  greek: 10,
  brandish: 15,
  imperative: 5,
};

export const NAME_PATTERNS = Object.keys(WEIGHTS) as NamePattern[];

function joinRoot(root: string, suffix: string, mode: "join" | "camel"): string | null {
  if (mode === "camel") return root + suffix;
  let r = root;
  const last = r[r.length - 1] as string;
  if (suffix === "ly" && (last === "l" || last === "y")) return null; // "Basilly", "Ferryly"
  if (/^[aeiou]/.test(suffix) && /[aeiouy]$/.test(r)) r = r.slice(0, -1); // Cache+ify -> Cachify
  if (r.length < 2) return null;
  return r + suffix;
}

function candidates(p: NamePattern): string[] {
  const out: string[] = [];
  switch (p) {
    case "compound":
      for (const r of ROOTS) for (const [s, m] of SUFFIXES) {
        const n = joinRoot(r, s, m);
        if (n) out.push(n);
      }
      break;
    case "twoWord":
      for (const a of ADJECTIVES) for (const n of NOUNS) out.push(`${a} ${n}`);
      break;
    case "domain":
      for (const r of ROOTS) for (const t of TLDS) out.push(r.toLowerCase() + t);
      break;
    case "dropE":
      for (const w of DROP_E) out.push(w.slice(0, -2) + "r");
      break;
    case "greek":
      for (const h of GREEK_HEADS) for (const m of GREEK_MIDS) for (const t of GREEK_TAILS) out.push(h + m + t);
      break;
    case "brandish":
      for (const r of ROOTS) for (const b of BRANDISH) out.push(r + b);
      break;
    case "imperative":
      for (const v of PREFIX_VERBS) for (const r of ROOTS) out.push(v + r);
      break;
  }
  return out;
}

/** Why a candidate is rejected (length, shape or blocklist), or null when it is usable. */
export function rejectReason(name: string): string | null {
  if (name.length < NAME_MIN || name.length > NAME_MAX) return `length ${name.length}`;
  if (/(.)\1\1/i.test(name)) return "triple letter";
  return blockedNameReason(name);
}

const pools = new Map<NamePattern, readonly string[]>();

/** Every usable name of one pattern, deduplicated and sorted (stable across engines). */
export function namesOfPattern(p: NamePattern): readonly string[] {
  let pool = pools.get(p);
  if (!pool) {
    pool = [...new Set(candidates(p))].filter((n) => rejectReason(n) === null).sort();
    pools.set(p, pool);
  }
  return pool;
}

/** The complete output space of generateName, for audits and tests. */
export function allNames(): readonly string[] {
  return [...new Set(NAME_PATTERNS.flatMap((p) => namesOfPattern(p)))].sort();
}

/** Every candidate the patterns can spell, before filtering, with the reason it was dropped. */
export function rejectedCandidates(): Array<{ name: string; reason: string }> {
  const out: Array<{ name: string; reason: string }> = [];
  for (const p of NAME_PATTERNS) {
    for (const n of new Set(candidates(p))) {
      const why = rejectReason(n);
      if (why) out.push({ name: n, reason: why });
    }
  }
  return out;
}

/** A name drawn from an existing PRNG stream (used by the billboard generator). */
export function nameFromPrng(rng: Prng): string {
  const p = rng.weighted(NAME_PATTERNS, NAME_PATTERNS.map((k) => WEIGHTS[k]));
  return rng.pick(namesOfPattern(p));
}

/** Deterministic invented startup or product name for a seed (number or string id). */
export function generateName(seed: number | string): string {
  return nameFromPrng(makePrng(seed));
}
