// A small context-free text grammar (in the spirit of Tracery), plus the static analysis
// that lets tests PROVE properties of every possible output instead of sampling them.
//
// Syntax of an expansion string:
//   {sym}       expand rule `sym` (a fresh, independent choice each time)
//   {sym.cap}   same, first letter upper-cased
//   {$sym}      a BOUND symbol: expanded once per output and reused, so a headline and its
//               subline can share one product name. A bound symbol may be supplied by the
//               caller instead of by a rule ("external", e.g. $product from names.ts).
// Grammars must be acyclic: that is what makes maximum lengths and output counts finite.

import type { Prng } from "./prng.ts";

export type Rules = Readonly<Record<string, readonly string[]>>;

const REF = /\{(\$?[A-Za-z][A-Za-z0-9_]*)(\.cap)?\}/g;

export interface Ref {
  symbol: string;
  cap: boolean;
}

/** The literal text of a template with every {ref} removed. */
export function literalText(template: string): string {
  return template.replace(REF, "");
}

export function refsOf(template: string): Ref[] {
  const out: Ref[] = [];
  for (const m of template.matchAll(REF)) out.push({ symbol: m[1] as string, cap: m[2] !== undefined });
  return out;
}

function capFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Expand `template`. `bound` holds bound-symbol values for this output; values found there
 * are reused, values expanded here are added to it.
 */
export function expandTemplate(rules: Rules, template: string, rng: Prng, bound: Map<string, string>, depth = 0): string {
  if (depth > 32) throw new Error("grammar: expansion too deep (cycle?)");
  return template.replace(REF, (_m, sym: string, cap: string | undefined) => {
    let v: string;
    if (sym.startsWith("$") && bound.has(sym)) {
      v = bound.get(sym) as string;
    } else {
      const alts = rules[sym];
      if (!alts) throw new Error(`grammar: unknown symbol {${sym}}`);
      v = expandTemplate(rules, rng.pick(alts), rng, bound, depth + 1);
      if (sym.startsWith("$")) bound.set(sym, v);
    }
    return cap ? capFirst(v) : v;
  });
}

export interface GrammarIssue {
  symbol: string;
  message: string;
}

/**
 * Structural problems: unknown symbols, cycles, empty rules, unreferenced rules.
 * `external` names bound symbols the caller always supplies. `roots` are the start symbols.
 */
export function checkGrammar(rules: Rules, roots: readonly string[], external: readonly string[]): GrammarIssue[] {
  const issues: GrammarIssue[] = [];
  const ext = new Set(external);
  for (const [sym, alts] of Object.entries(rules)) {
    if (alts.length === 0) issues.push({ symbol: sym, message: "rule has no alternatives" });
    if (ext.has(sym)) issues.push({ symbol: sym, message: "rule shadows an external symbol" });
    for (const a of alts) {
      for (const r of refsOf(a)) {
        if (!(r.symbol in rules) && !ext.has(r.symbol)) issues.push({ symbol: sym, message: `unknown symbol {${r.symbol}}` });
      }
      if (/[{}]/.test(literalText(a))) issues.push({ symbol: sym, message: `stray brace in "${a}"` });
    }
  }
  for (const r of roots) if (!(r in rules)) issues.push({ symbol: r, message: "start symbol has no rule" });

  // Cycle detection (DFS with colours).
  const state = new Map<string, 1 | 2>();
  const visit = (sym: string, path: string[]): void => {
    const s = state.get(sym);
    if (s === 2) return;
    if (s === 1) {
      issues.push({ symbol: sym, message: `cycle: ${[...path, sym].join(" -> ")}` });
      return;
    }
    state.set(sym, 1);
    for (const a of rules[sym] ?? []) for (const r of refsOf(a)) if (r.symbol in rules) visit(r.symbol, [...path, sym]);
    state.set(sym, 2);
  };
  for (const sym of Object.keys(rules)) visit(sym, []);

  // Every rule reachable from a root.
  const seen = new Set<string>();
  const walk = (sym: string): void => {
    if (seen.has(sym) || !(sym in rules)) return;
    seen.add(sym);
    for (const a of rules[sym] ?? []) for (const r of refsOf(a)) walk(r.symbol);
  };
  for (const r of roots) walk(r);
  for (const sym of Object.keys(rules)) if (!seen.has(sym)) issues.push({ symbol: sym, message: "rule is never used" });
  return issues;
}

/**
 * Longest possible expansion of `template`, in UTF-16 code units. External symbols take
 * their declared maximum. Bound symbols that repeat count each time (they print each time).
 * Requires an acyclic grammar (see checkGrammar).
 */
export function maxLength(rules: Rules, template: string, externalMax: Readonly<Record<string, number>>, memo = new Map<string, number>()): number {
  let n = literalText(template).length;
  for (const r of refsOf(template)) n += maxSymbolLength(rules, r.symbol, externalMax, memo);
  return n;
}

export function minLength(rules: Rules, template: string, externalMin: Readonly<Record<string, number>>, memo = new Map<string, number>()): number {
  let n = literalText(template).length;
  for (const r of refsOf(template)) {
    const sym = r.symbol;
    if (sym in externalMin && !(sym in rules)) {
      n += externalMin[sym] as number;
      continue;
    }
    let m = memo.get(sym);
    if (m === undefined) {
      m = Math.min(...(rules[sym] ?? [""]).map((a) => minLength(rules, a, externalMin, memo)));
      memo.set(sym, m);
    }
    n += m;
  }
  return n;
}

function maxSymbolLength(rules: Rules, sym: string, externalMax: Readonly<Record<string, number>>, memo: Map<string, number>): number {
  if (sym in externalMax && !(sym in rules)) return externalMax[sym] as number;
  const hit = memo.get(sym);
  if (hit !== undefined) return hit;
  const alts = rules[sym];
  if (!alts) throw new Error(`grammar: unknown symbol {${sym}}`);
  const m = Math.max(...alts.map((a) => maxLength(rules, a, externalMax, memo)));
  memo.set(sym, m);
  return m;
}

/**
 * Number of distinct derivations of `template` with external symbols fixed. An upper bound
 * on distinct output strings (two derivations can print the same text); bound symbols that
 * repeat are counted once, as they are chosen once.
 */
export function countDerivations(rules: Rules, template: string, memo = new Map<string, number>()): number {
  let n = 1;
  const seenBound = new Set<string>();
  for (const r of refsOf(template)) {
    if (r.symbol.startsWith("$")) {
      if (seenBound.has(r.symbol)) continue;
      seenBound.add(r.symbol);
    }
    if (!(r.symbol in rules)) continue; // external: fixed by the caller
    let m = memo.get(r.symbol);
    if (m === undefined) {
      m = (rules[r.symbol] ?? []).reduce((s, a) => s + countDerivations(rules, a, memo), 0);
      memo.set(r.symbol, m);
    }
    n *= m;
  }
  return n;
}
