// The crisis check (docs/ai-layer.md, Safety and abuse, gate 1). It runs first on every
// free-text box in the game, scripted or live, online or offline: before the length gate, the
// deny-lists, the keyword matcher, any classifier and any comic fallback. A match always shows a
// sincere, non-comic set of lines with resources, never a kit and never a joke.
//
// The check is deterministic and runs on the device: no network, no model. Phrases, patterns,
// contractions and the look-alike table live in content/crisis.json; this file only normalises
// and matches. It is tuned for recall: a false positive pauses the game on a kind message, a
// false negative answers someone in crisis with a joke.

import crisisJson from "../../content/crisis.json" with { type: "json" };

export type CrisisGroup = "selfHarm" | "danger";

export interface CrisisResource {
  id: string;
  label: string;
  detail: string;
  /** The groups whose response lists this resource. */
  groups: CrisisGroup[];
}

export interface CrisisPattern {
  group: CrisisGroup;
  note?: string;
  /** One alternative from each slot, in order; "" makes a slot optional. */
  slots: string[][];
  /** The match does not count when the next word is one of these ("hit me up"). */
  notFollowedBy?: string[];
}

export interface CrisisData {
  version: 1;
  phrases: Record<CrisisGroup, string[]>;
  patterns: CrisisPattern[];
  contractions: Record<string, string>;
  compactStems: string[];
  normalise: Record<string, string>;
  lines: Record<CrisisGroup, string[]>;
  resources: CrisisResource[];
}

export const CRISIS = crisisJson as unknown as CrisisData;
export const CRISIS_GROUPS: readonly CrisisGroup[] = ["selfHarm", "danger"];

/** Characters that render as nothing and can hide a phrase: zero-width spaces and joiners, soft hyphen, BOM. */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;
const APOSTROPHES = /['‘’ʼ`´]/g;
const LOOKALIKE = new Map(Object.entries(CRISIS.normalise));
/** Look-alikes that are usually punctuation: read as a letter only between two word characters ("d!e", not "die!"). */
const INNER_ONLY = new Set(["!", "¡", "|"]);
/** A distance ("5 kms", "10km") is not "kms". */
const DISTANCE = /(\d)\s*kms?\b/gi;

const squeeze = (w: string): string => w.replace(/([a-z])\1+/g, "$1");

/** Contractions and slang, keyed and valued in squeezed form: "isnt" -> ["is", "not"], "wana" -> ["want", "to"]. */
const EXPAND: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(CRISIS.contractions).map(([k, v]) => [squeeze(k), v.split(" ").map(squeeze)] as const),
);

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && (/\p{L}/u.test(ch) || (LOOKALIKE.has(ch) && !INNER_ONLY.has(ch)));

/** Map look-alike and leet characters to letters; "!", "¡" and "|" only inside a word. */
function mapLookalikes(s: string): string {
  const chars = [...s];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const to = LOOKALIKE.get(ch);
    if (to === undefined) out += ch;
    else if (INNER_ONLY.has(ch)) out += isWordChar(chars[i - 1]) && isWordChar(chars[i + 1]) ? to : " ";
    else out += to;
  }
  return out;
}

/**
 * Normalise text for matching: NFKC (full-width and styled letters to plain), accents removed,
 * invisible characters removed, lower-case, look-alike and leet characters mapped to letters
 * ("!" only inside a word, so "die!" stays "die"), apostrophes dropped ("don't" -> "dont"),
 * everything else to spaces, runs of one repeated letter squeezed to one ("dieeee" -> "die"),
 * runs of single letters joined ("s u i c i d e" -> "suicide"), and contractions and slang
 * expanded ("isnt" -> "is not", "wanna" -> "want to", "im" -> "i am"). Returns words separated
 * by single spaces.
 */
export function normaliseForCrisis(text: string): string {
  return normaliseWords(text).words.join(" ");
}

/** The normalised words, and which of them were joined from a run of single letters. */
function normaliseWords(text: string): { words: string[]; joined: string[] } {
  let s = text.normalize("NFKC").replace(INVISIBLE, "").replace(DISTANCE, "$1 kilometres");
  s = s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  s = mapLookalikes(s).replace(APOSTROPHES, "").replace(/[^a-z]+/g, " ").trim();
  // Join runs of 3+ single-letter words: spacing a word out does not hide it.
  const words = s.split(" ").filter((w) => w.length > 0);
  const out: string[] = [];
  const joined: string[] = [];
  let run = "";
  let runLen = 0;
  const flush = () => {
    if (runLen >= 3) {
      out.push(run);
      joined.push(squeeze(run));
    } else if (runLen > 0) out.push(...run.split(""));
    run = "";
    runLen = 0;
  };
  for (const w of words) {
    if (w.length === 1) {
      run += w;
      runLen++;
    } else {
      flush();
      out.push(w);
    }
  }
  flush();
  return { words: out.map(squeeze).flatMap((w) => EXPAND.get(w) ?? [w]), joined };
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface CompiledPhrase {
  group: CrisisGroup;
  phrase: string;
  /** " normalised phrase ", for whole-word matching against " normalised text ". */
  key: string;
  /** The key without spaces, for words spelled out letter by letter ("K I L L M Y S E L F"). */
  compact: string;
}

interface CompiledPattern {
  group: CrisisGroup;
  label: string;
  /** Matched against " normalised text " (every slot starts with a space, so words stay whole). */
  spaced: RegExp;
  /** Matched inside a word joined from single letters. */
  compact: RegExp;
}

const PHRASES: readonly CompiledPhrase[] = (() => {
  const seen = new Set<string>();
  const out: CompiledPhrase[] = [];
  for (const group of CRISIS_GROUPS) {
    for (const phrase of CRISIS.phrases[group]) {
      const norm = normaliseForCrisis(phrase);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({ group, phrase, key: ` ${norm} `, compact: norm.replace(/ /g, "") });
    }
  }
  return out;
})();

function compilePattern(p: CrisisPattern): CompiledPattern {
  const alts = (slot: string[], joiner: string): string => {
    const norm = [...new Set(slot.filter((a) => a !== "").map((a) => normaliseForCrisis(a).replace(/ /g, joiner)))];
    // Longest first, so "step dad" is tried before "step".
    return `(?:${norm.sort((a, b) => b.length - a.length).map(escape).join("|")})`;
  };
  const spacedSlots = p.slots.map((s) => (s.includes("") ? `(?: ${alts(s, " ")})?` : ` ${alts(s, " ")}`)).join("");
  const compactSlots = p.slots.map((s) => (s.includes("") ? `${alts(s, "")}?` : alts(s, ""))).join("");
  const next = p.notFollowedBy ? alts(p.notFollowedBy, " ") : null;
  return {
    group: p.group,
    label: p.slots.map((s) => s.find((a) => a !== "") ?? "").filter((w) => w !== "").join(" "),
    spaced: new RegExp(`${spacedSlots}(?= )${next ? `(?! ${next} )` : ""}`),
    compact: new RegExp(`${compactSlots}${next ? `(?!${next})` : ""}`),
  };
}

const PATTERNS: readonly CompiledPattern[] = CRISIS.patterns.map(compilePattern);
const STEMS = CRISIS.compactStems.map((s) => normaliseForCrisis(s).replace(/ /g, ""));

export interface CrisisMatch {
  matched: true;
  group: CrisisGroup;
  /** The listed phrase or pattern that matched (for tests and the proxy log; never shown). */
  phrase: string;
}

/** The first crisis phrase or pattern in the text, or null. Self-harm is checked before danger. */
export function crisisCheck(text: string): CrisisMatch | null {
  const { words, joined } = normaliseWords(text);
  const norm = words.join(" ");
  const spaced = ` ${norm} `;
  for (const group of CRISIS_GROUPS) {
    for (const p of PHRASES) if (p.group === group && spaced.includes(p.key)) return { matched: true, group, phrase: p.phrase };
    for (const p of PATTERNS) if (p.group === group && p.spaced.test(spaced)) return { matched: true, group, phrase: p.label };
  }
  for (const w of joined) {
    for (const p of PHRASES) if (w.includes(p.compact)) return { matched: true, group: p.group, phrase: p.phrase };
    for (const p of PATTERNS) if (p.compact.test(w)) return { matched: true, group: p.group, phrase: p.label };
  }
  const compact = norm.replace(/ /g, "");
  for (const stem of STEMS) if (compact.includes(stem)) return { matched: true, group: "selfHarm", phrase: stem };
  return null;
}

export interface CrisisResponse {
  group: CrisisGroup;
  lines: readonly string[];
  resources: readonly CrisisResource[];
}

/** What every free-text box shows on a match: the group's sincere lines and its resources, in order. */
export function crisisResponse(group: CrisisGroup): CrisisResponse {
  return { group, lines: CRISIS.lines[group], resources: CRISIS.resources.filter((r) => r.groups.includes(group)) };
}

export interface CrisisIssue {
  message: string;
}

/** Sentences that vary one slot at a time from the first alternatives, so every alternative is exercised once. */
export function patternSamples(p: CrisisPattern): string[] {
  const firsts = p.slots.map((s) => s.find((a) => a !== "") ?? "");
  const out = new Set<string>();
  p.slots.forEach((s, i) => {
    for (const a of s) out.add(firsts.map((f, j) => (j === i ? a : f)).filter((w) => w !== "").join(" "));
  });
  return [...out];
}

/**
 * The data is sound: every listed phrase and every pattern alternative is caught, phrases are
 * written in expanded form (no contraction the normaliser would rewrite), every group has lines
 * and at least one resource.
 */
export function checkCrisisData(d: CrisisData = CRISIS): CrisisIssue[] {
  const out: CrisisIssue[] = [];
  const contractionKeys = new Set(Object.keys(d.contractions));
  for (const g of CRISIS_GROUPS) {
    if (!d.lines[g] || d.lines[g].length === 0) out.push({ message: `${g}: no lines` });
    if (!d.resources.some((r) => r.groups.includes(g))) out.push({ message: `${g}: no resources` });
    for (const p of d.phrases[g]) {
      if (!crisisCheck(p)) out.push({ message: `${g}: "${p}" is not caught by crisisCheck` });
      for (const w of p.split(" ")) if (contractionKeys.has(w)) out.push({ message: `${g}: "${p}" uses "${w}"; write the expanded form "${d.contractions[w]}"` });
    }
  }
  for (const p of d.patterns) {
    for (const s of patternSamples(p)) {
      const m = crisisCheck(s);
      if (!m || m.group !== p.group) out.push({ message: `pattern ${p.group}: "${s}" is not caught as ${p.group}` });
    }
  }
  return out;
}
