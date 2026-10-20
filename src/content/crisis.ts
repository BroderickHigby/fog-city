// The crisis check (docs/ai-layer.md, Safety and abuse, gate 1). It runs first on every
// free-text box in the game, scripted or live, online or offline: before the length gate, the
// deny-lists, the keyword matcher, any classifier and any comic fallback. A match always shows a
// sincere, non-comic set of lines with resources, never a kit and never a joke.
//
// The check is deterministic and runs on the device: no network, no model. Phrases and the
// look-alike table live in content/crisis.json; this file only normalises and matches.

import crisisJson from "../../content/crisis.json" with { type: "json" };

export type CrisisGroup = "selfHarm" | "danger";

export interface CrisisResource {
  id: string;
  label: string;
  detail: string;
}

export interface CrisisData {
  version: 1;
  phrases: Record<CrisisGroup, string[]>;
  compactStems: string[];
  normalise: Record<string, string>;
  lines: Record<CrisisGroup, string[]>;
  resources: CrisisResource[];
}

export const CRISIS = crisisJson as unknown as CrisisData;

/** Characters that render as nothing and can hide a phrase: zero-width spaces and joiners, soft hyphen, BOM. */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;
const APOSTROPHES = /['‘’ʼ`´]/g;
const LOOKALIKE = new Map(Object.entries(CRISIS.normalise));

/**
 * Normalise text for matching: NFKC (full-width and styled letters to plain), accents removed,
 * invisible characters removed, lower-case, look-alike and leet characters mapped to letters,
 * apostrophes dropped ("don't" -> "dont"), everything else to spaces, runs of one repeated
 * letter squeezed to one ("dieeee" -> "die"), and runs of single letters joined
 * ("s u i c i d e" -> "suicide"). Returns words separated by single spaces.
 */
export function normaliseForCrisis(text: string): string {
  return normaliseWords(text).words.join(" ");
}

/** The normalised words, and which of them were joined from a run of single letters. */
function normaliseWords(text: string): { words: string[]; joined: string[] } {
  let s = text.normalize("NFKC").replace(INVISIBLE, "");
  s = s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  let mapped = "";
  for (const ch of s) mapped += LOOKALIKE.get(ch) ?? ch;
  s = mapped.replace(APOSTROPHES, "").replace(/[^a-z]+/g, " ").trim();
  // Join runs of 3+ single-letter words: spacing a word out does not hide it.
  const words = s.split(" ").filter((w) => w.length > 0);
  const out: string[] = [];
  const joined: string[] = [];
  let run = "";
  let runLen = 0;
  const flush = () => {
    if (runLen >= 3) {
      out.push(run);
      joined.push(run.replace(/([a-z])\1+/g, "$1"));
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
  return { words: out.map((w) => w.replace(/([a-z])\1+/g, "$1")), joined };
}

const PHRASES: ReadonlyArray<readonly [CrisisGroup, string, string]> = (Object.keys(CRISIS.phrases) as CrisisGroup[]).flatMap((g) =>
  CRISIS.phrases[g].map((p) => [g, p, ` ${normaliseForCrisis(p)} `] as const),
);
const STEMS = CRISIS.compactStems.map((s) => normaliseForCrisis(s).replace(/ /g, ""));
/** Every phrase without its spaces, for words spelled out letter by letter ("K I L L M Y S E L F"). */
const COMPACT_PHRASES = PHRASES.map(([g, p, key]) => [g, p, key.replace(/ /g, "")] as const);

export interface CrisisMatch {
  matched: true;
  group: CrisisGroup;
  /** The listed phrase that matched (for tests and the proxy log; never shown). */
  phrase: string;
}

/** The first crisis phrase in the text, or null. Self-harm phrases are checked before danger phrases. */
export function crisisCheck(text: string): CrisisMatch | null {
  const { words, joined } = normaliseWords(text);
  const norm = words.join(" ");
  const spaced = ` ${norm} `;
  for (const [group, phrase, key] of PHRASES) if (spaced.includes(key)) return { matched: true, group, phrase };
  for (const w of joined) for (const [group, phrase, key] of COMPACT_PHRASES) if (w.includes(key)) return { matched: true, group, phrase };
  const compact = norm.replace(/ /g, "");
  for (const stem of STEMS) if (compact.includes(stem)) return { matched: true, group: "selfHarm", phrase: stem };
  return null;
}

export interface CrisisResponse {
  group: CrisisGroup;
  lines: readonly string[];
  resources: readonly CrisisResource[];
}

/** What every free-text box shows on a match: the sincere lines and the resources, in order. */
export function crisisResponse(group: CrisisGroup): CrisisResponse {
  return { group, lines: CRISIS.lines[group], resources: CRISIS.resources };
}

export interface CrisisIssue {
  message: string;
}

/** Every listed phrase is caught by the check, and every group has lines and resources. */
export function checkCrisisData(d: CrisisData = CRISIS): CrisisIssue[] {
  const out: CrisisIssue[] = [];
  for (const g of Object.keys(d.phrases) as CrisisGroup[]) {
    if (!d.lines[g] || d.lines[g].length === 0) out.push({ message: `${g}: no lines` });
    for (const p of d.phrases[g]) {
      const m = crisisCheck(p);
      if (!m) out.push({ message: `${g}: "${p}" is not caught by crisisCheck` });
    }
  }
  if (d.resources.length === 0) out.push({ message: "no resources" });
  return out;
}
