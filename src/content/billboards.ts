// Fictional AI SaaS billboard and bus-wrap copy, generated from content/billboards.json.
//
// generateBillboard(seed) is pure and deterministic: the same seed gives the same board on
// every machine, with its own PRNG (never the sim's). Every possible headline is proven to fit
// its limit by checkBillboardGrammar's static length analysis, not by sampling.

import grammarJson from "../../content/billboards.json" with { type: "json" };
import { blockedProseReason } from "./blocklist.ts";
import { checkGrammar, expandTemplate, maxLength, minLength, refsOf, type Rules } from "./grammar.ts";
import { NAME_MAX, NAME_MIN, nameFromPrng } from "./names.ts";
import { makePrng, type Prng } from "./prng.ts";

export type BillboardKind = "billboard" | "busWrap";

export interface Palette {
  id: string;
  /** Flat background colour, #RRGGBB. */
  bg: string;
  /** Headline and subline colour, #RRGGBB. */
  fg: string;
  /** Small accent (logo mark, rule line), #RRGGBB. */
  accent: string;
}

export interface Billboard {
  kind: BillboardKind;
  headline: string;
  subline: string;
  palette: Palette;
  /** The invented product the copy advertises. */
  product: string;
}

export interface StartSpec {
  symbol: string;
  headlineMax: number;
  sublineMax: number;
  description?: string;
}

export interface BillboardGrammar {
  version: 1;
  start: string;
  starts: Record<BillboardKind, StartSpec>;
  external: Record<string, { minLength: number; maxLength: number; description?: string }>;
  rules: Record<string, string[]>;
  palettes: Palette[];
}

export const BILLBOARD_GRAMMAR = grammarJson as unknown as BillboardGrammar;

const SEP = "|";

export interface GenerateOptions {
  kind?: BillboardKind;
  /**
   * Advertise this product instead of an invented one (the player's own startup, say).
   * Must be NAME_MIN..NAME_MAX characters, so every headline still fits.
   */
  product?: string;
}

function seedKey(kind: BillboardKind, seed: number | string): string {
  return `${kind}:${typeof seed === "number" ? `n${seed}` : `s${seed}`}`;
}

function checkProduct(product: string): void {
  if (product.length < NAME_MIN || product.length > NAME_MAX) {
    throw new RangeError(`billboards: product name must be ${NAME_MIN}-${NAME_MAX} characters, got ${product.length}`);
  }
}

/** Expand one start alternative ("headline|subline") into a board. */
function board(grammar: BillboardGrammar, kind: BillboardKind, alt: string, rng: Prng, product: string, palette: Palette): Billboard {
  const bound = new Map<string, string>([["$product", product]]);
  const text = expandTemplate(grammar.rules, alt, rng, bound);
  const cut = text.indexOf(SEP);
  return { kind, headline: text.slice(0, cut), subline: text.slice(cut + 1), palette, product };
}

/** Deterministic billboard (or bus wrap) for a seed. */
export function generateBillboard(seed: number | string, opts: GenerateOptions = {}, grammar: BillboardGrammar = BILLBOARD_GRAMMAR): Billboard {
  const kind = opts.kind ?? "billboard";
  const spec = grammar.starts[kind];
  if (!spec) throw new Error(`billboards: unknown kind ${kind}`);
  const rng = makePrng(seedKey(kind, seed));
  const product = opts.product ?? nameFromPrng(rng);
  checkProduct(product);
  const alt = rng.pick(grammar.rules[spec.symbol] ?? []);
  return board(grammar, kind, alt, rng, product, rng.pick(grammar.palettes));
}

/**
 * `count` boards for one place (a street, the 101 corridor, a bus depot): the jokes are dealt
 * like a shuffled deck, so none repeats until every template has been used, and no two
 * neighbouring boards share a palette. Deterministic for a seed.
 */
export function generateBillboardSet(
  seed: number | string,
  count: number,
  opts: GenerateOptions = {},
  grammar: BillboardGrammar = BILLBOARD_GRAMMAR,
): Billboard[] {
  const kind = opts.kind ?? "billboard";
  const spec = grammar.starts[kind];
  if (!spec) throw new Error(`billboards: unknown kind ${kind}`);
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`billboards: bad count ${count}`);
  if (opts.product !== undefined) checkProduct(opts.product);
  const alts = grammar.rules[spec.symbol] ?? [];
  const rng = makePrng(`set:${seedKey(kind, seed)}`);
  const out: Billboard[] = [];
  let deck: number[] = [];
  let lastPalette = "";
  for (let i = 0; i < count; i++) {
    if (deck.length === 0) deck = shuffled(alts.length, rng);
    const alt = alts[deck.pop() as number] as string;
    const product = opts.product ?? nameFromPrng(rng);
    let palette = rng.pick(grammar.palettes);
    if (palette.id === lastPalette && grammar.palettes.length > 1) {
      const others = grammar.palettes.filter((p) => p.id !== lastPalette);
      palette = rng.pick(others);
    }
    lastPalette = palette.id;
    out.push(board(grammar, kind, alt, rng, product, palette));
  }
  return out;
}

/** Fisher-Yates over 0..n-1 with the content PRNG. */
function shuffled(n: number, rng: Prng): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j] as number, a[i] as number];
  }
  return a;
}

/** Convenience: a bus wrap. */
export function generateBusWrap(seed: number | string, opts: Omit<GenerateOptions, "kind"> = {}): Billboard {
  return generateBillboard(seed, { ...opts, kind: "busWrap" });
}

export interface GrammarReport {
  errors: string[];
  /** Per kind: the longest headline and subline any derivation can print. */
  bounds: Record<string, { headlineMax: number; sublineMax: number; headlineMin: number }>;
}

/**
 * Everything that must hold for the grammar to be shippable, checked statically:
 * structure (no unknown symbols, no cycles, no unused rules), the headline|subline split,
 * length limits over EVERY derivation, and no real brand or person in any rule text.
 */
export function checkBillboardGrammar(g: BillboardGrammar = BILLBOARD_GRAMMAR): GrammarReport {
  const errors: string[] = [];
  const rules = g.rules as Rules;
  const roots = Object.values(g.starts).map((s) => s.symbol);
  const external = Object.keys(g.external);
  for (const i of checkGrammar(rules, roots, external)) errors.push(`${i.symbol}: ${i.message}`);
  if (!roots.includes(g.start)) errors.push(`start "${g.start}" is not one of starts`);
  if (errors.length > 0) return { errors, bounds: {} };

  const extMax = Object.fromEntries(Object.entries(g.external).map(([k, v]) => [k, v.maxLength]));
  const extMin = Object.fromEntries(Object.entries(g.external).map(([k, v]) => [k, v.minLength]));
  if ((extMax["$product"] ?? Infinity) > NAME_MAX) errors.push("$product maxLength exceeds NAME_MAX");

  // "|" may appear only in start alternatives, exactly once.
  for (const [sym, alts] of Object.entries(rules)) {
    for (const a of alts) {
      const bars = a.split(SEP).length - 1;
      if (roots.includes(sym) ? bars !== 1 : bars !== 0) errors.push(`${sym}: "${a}" has ${bars} "${SEP}"`);
      const why = blockedProseReason(a);
      if (why) errors.push(`${sym}: "${a}" ${why}`);
      if (/\s$|^\s|\s\s/.test(a.replace(/\|/, ""))) errors.push(`${sym}: "${a}" has stray whitespace`);
    }
  }

  const bounds: GrammarReport["bounds"] = {};
  for (const [kind, spec] of Object.entries(g.starts)) {
    let hMax = 0;
    let sMax = 0;
    let hMin = Infinity;
    for (const alt of rules[spec.symbol] ?? []) {
      const cut = alt.indexOf(SEP);
      if (cut < 0) continue;
      const head = alt.slice(0, cut);
      const sub = alt.slice(cut + 1);
      const h = maxLength(rules, head, extMax);
      const s = maxLength(rules, sub, extMax);
      if (h > spec.headlineMax) errors.push(`${kind}: headline can reach ${h} > ${spec.headlineMax}: "${head}"`);
      if (s > spec.sublineMax) errors.push(`${kind}: subline can reach ${s} > ${spec.sublineMax}: "${sub}"`);
      if (!refsOf(alt).some((r) => r.symbol === "$product")) errors.push(`${kind}: "${alt}" never names the product`);
      hMax = Math.max(hMax, h);
      sMax = Math.max(sMax, s);
      hMin = Math.min(hMin, minLength(rules, head, extMin));
    }
    bounds[kind] = { headlineMax: hMax, sublineMax: sMax, headlineMin: hMin };
  }

  const hex = /^#[0-9A-F]{6}$/;
  if (g.palettes.length < 6) errors.push("fewer than 6 palettes");
  for (const p of g.palettes) {
    for (const c of [p.bg, p.fg, p.accent]) if (!hex.test(c)) errors.push(`palette ${p.id}: "${c}" is not #RRGGBB (upper-case)`);
    const ratio = contrastRatio(p.bg, p.fg);
    if (ratio < 4.5) errors.push(`palette ${p.id}: text contrast ${ratio.toFixed(2)} < 4.5`);
  }
  return { errors, bounds };
}

/** WCAG 2.x contrast ratio between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (lin[0] as number) + 0.7152 * (lin[1] as number) + 0.0722 * (lin[2] as number);
}
