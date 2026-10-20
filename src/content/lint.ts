// The content lint: one deterministic library for every rule in docs/design.md "Legal and taste"
// and docs/roadmap.md "Rules for every wave" that a program can check. It runs over every content
// file in tests/content/lint.test.ts, over every composed name in composer.ts, and later in the
// AI proxy over every model string (docs/ai-layer.md, gate 7).
//
// Rules (LintRule): real brands, real people, accelerator names and catchphrases, shooter terms
// and mode names, the combat and disease lexicon (also inside ids, split at camelCase and dashes),
// "hunt"/"sweep" outside their allowed phrases, punch-down and housing terms, profanity and slurs,
// sexual and hate terms, dialect spelling, the places rule, renamed names, font fit, and invented
// proper names that are not in content/cleared-names.json.
//
// What is a proper name is decided by a REGISTRY of name fields (NAME_FIELDS), never by guessing
// from capital letters: a value at a registered path is an invented proper name and must be
// cleared. Mode and item names are registered too, for the shooter mode-name rule.

import { blockedProseReason } from "./blocklist.ts";
import {
  ACCELERATOR, COMBAT, DIALECT, DISEASE, EXEMPTIONS, HATE, HOUSING, PLACES, PROFANITY, PUNCH_DOWN, RENAMED, RESTRICTED,
  RESTRICTED_ALLOWED, SEXUAL, SHOOTER_MODE_NAMES, SHOOTER_TERMS, type Deny,
} from "./denylists.ts";

export type LintRule =
  | "brand" | "person" | "accelerator" | "shooter" | "shooterMode" | "lexicon" | "disease" | "restricted" | "punchDown" | "housing"
  | "profanity" | "sexual" | "hate" | "dialect" | "places" | "renamed" | "fontFit" | "clearedName";

export interface LintIssue {
  rule: LintRule;
  message: string;
  /** Where in the file (a JSON path like cast.ramenMetrics.name), when linting a document. */
  path?: string;
  text?: string;
}

interface Compiled {
  label: string;
  re: RegExp;
}

const compile = (list: readonly Deny[]): Compiled[] =>
  list.map(([label, pattern]) => ({ label, re: new RegExp(`(^|[^\\p{L}\\p{N}])(${pattern})($|[^\\p{L}\\p{N}])`, "iu") }));

const TEXT_RULES: ReadonlyArray<readonly [LintRule, Compiled[]]> = [
  ["accelerator", compile(ACCELERATOR)],
  ["shooter", compile(SHOOTER_TERMS)],
  ["lexicon", compile(COMBAT)],
  ["disease", compile(DISEASE)],
  ["punchDown", compile(PUNCH_DOWN)],
  ["housing", compile(HOUSING)],
  ["profanity", compile(PROFANITY)],
  ["sexual", compile(SEXUAL)],
  ["hate", compile(HATE)],
  ["dialect", compile(DIALECT)],
  ["places", compile(PLACES)],
  ["renamed", compile(RENAMED)],
];
const RESTRICTED_C = compile(RESTRICTED);
const MODE_C = compile(SHOOTER_MODE_NAMES);

/** "killSwitch", "kill-switch", "kill_switch" -> "kill Switch", so the lexicon also reaches ids. */
export function splitIdWords(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ");
}

function removeExempt(text: string, rule: LintRule): string {
  let t = text;
  for (const e of EXEMPTIONS) if (e.rule === rule) t = t.split(e.text).join(" ");
  return t;
}

/** Rules that also apply to developer comments ($comment), which may state the taste rules themselves. */
const COMMENT_RULES: ReadonlySet<LintRule> = new Set(["brand", "person", "accelerator", "shooter", "renamed"]);

/** Every rule that applies to any string the player could read (prose, labels, names, ids). */
export function lintText(text: string): LintIssue[] {
  const out: LintIssue[] = [];
  const brand = blockedProseReason(removeExempt(text, "brand"));
  if (brand) {
    const rule: LintRule = brand.includes("accelerator") ? "accelerator" : /person|surname/.test(brand) ? "person" : "brand";
    out.push({ rule, message: brand, text });
  }
  const variants = [text, splitIdWords(text)];
  for (const [rule, list] of TEXT_RULES) {
    for (const c of list) {
      if (variants.some((v) => c.re.test(v))) {
        out.push({ rule, message: `${rule}: ${c.label}`, text });
        break;
      }
    }
  }
  const allowedRemoved = variants.map((v) => {
    let r = v;
    for (const a of RESTRICTED_ALLOWED) r = r.replace(new RegExp(a.replace(" ", "[\\s_-]*"), "gi"), " ");
    return r;
  });
  for (const c of RESTRICTED_C) {
    if (allowedRemoved.some((v) => c.re.test(v))) out.push({ rule: "restricted", message: `restricted: ${c.label}`, text });
  }
  return out;
}

/** The shooter mode-name rule, for registered mode and item names only. */
export function lintModeName(name: string): LintIssue[] {
  return MODE_C.filter((c) => c.re.test(name) || c.re.test(splitIdWords(name))).map((c) => ({
    rule: "shooterMode" as const,
    message: `shooterMode: a mode or item may not be named like "${c.label}"`,
    text: name,
  }));
}

// ---------------------------------------------------------------------------------------------
// Font fit

/** Character limits per surface (the canvas text slots in the renderer are sized against these). */
export const FONT_FIT = {
  billboardHeadline: 32,
  billboardSubline: 60,
  busWrapHeadline: 40,
  busWrapSubline: 64,
  /** Sandwich boards and shop A-frames. */
  sign: 24,
  /** A speech bubble above a robot or a person. */
  bark: 90,
  /** A phone notification or BotBounty card line. */
  phone: 120,
} as const;
export type Surface = keyof typeof FONT_FIT;

/** Longest value each placeholder can take; the font-fit check fills it at maximum length. */
export const PLACEHOLDER_MAX: Readonly<Record<string, number>> = {
  name: 16, // composer.ts COMPOSED_NAME_MAX (every composed startup or player name; see the composer test)
  $product: 12, // names.ts NAME_MAX
  nounPhrase: 32,
  district: 18, // "Bay Bridge approach"-length labels, checked against content/districts.json
  landmark: 28,
  tell: 40, // bot-tells.json label maxLength
  street: 20,
  pay: 6, // "$1,200"
  model: 8, // Footman, Trundle, Meander
  place: 44, // a district pack's lastSeen label (district-pack.schema.json maxLength)
};

/** The text with every {placeholder} replaced by its maximum length. Unknown placeholders count as 20. */
export function maxRenderedLength(text: string): number {
  return text.replace(/\{(\$?[A-Za-z][A-Za-z0-9_]*)(\.cap)?\}/g, (_m, k: string) => "x".repeat(PLACEHOLDER_MAX[k] ?? 20)).length;
}

export function lintFit(text: string, surface: Surface, limit: number = FONT_FIT[surface]): LintIssue[] {
  const n = maxRenderedLength(text);
  return n > limit ? [{ rule: "fontFit", message: `fontFit: ${surface} holds ${limit} characters, this renders up to ${n}`, text }] : [];
}

// ---------------------------------------------------------------------------------------------
// Documents: the field registry

export type FieldKind = "name" | "modeName" | "itemName";

/**
 * Registry of name fields. A path pattern is a dot path where "*" matches any one key or array
 * index. A value at a "name" path is an invented proper name: it must be in cleared-names.json
 * (or its list of generic labels). Mode and item names get the shooter mode-name rule.
 */
export const NAME_FIELDS: ReadonlyArray<{ file: RegExp; path: string; kind: FieldKind }> = [
  { file: /^content\/missions\/[^/]+\.json$/, path: "cast.*.name", kind: "name" },
  { file: /^content\/brands\.json$/, path: "brands.*.name", kind: "name" },
  { file: /^content\/bot-tells\.json$/, path: "models.*.name", kind: "name" },
  { file: /^content\/bot-tells\.json$/, path: "models.*.maker", kind: "name" },
  { file: /^content\/director-cards\.json$/, path: "cards.*.actors.*.name", kind: "name" },
  { file: /^content\/modes\/instances\.json$/, path: "modes.*.name", kind: "modeName" },
  { file: /^content\/modes\/instances\.json$/, path: "instances.*.name", kind: "modeName" },
  { file: /^content\/vendor\.json$/, path: "items.*.name", kind: "itemName" },
  { file: /^content\/activities\.json$/, path: "activities.*.name", kind: "modeName" },
];

/**
 * Files, or parts of files, that are not text a player reads and are exempt from the text rules:
 * detector lists (they exist to contain the words they detect) and research records.
 */
export const EXEMPT_PATHS: ReadonlyArray<{ file: RegExp; path?: string; why: string }> = [
  { file: /^content\/cleared-names\.json$/, why: "the name-search record quotes real companies, by design" },
  { file: /^content\/banned-pairs\.json$/, why: "the list of composed names that fail the lint, by definition" },
  { file: /^content\/crisis\.json$/, path: "phrases", why: "the crisis detector's phrase list" },
  { file: /^content\/crisis\.json$/, path: "normalise", why: "look-alike character table" },
  { file: /^content\/landmarks\.json$/, why: "owned by the assets track; real landmark names and sources" },
];

/** Keys whose string values are provenance or machine data rather than player-facing text. */
const DATA_KEYS = new Set(["source", "sources", "attribution", "$schema", "url", "urls", "glb", "hash"]);
/** Any string anywhere under one of these keys is provenance or a reference to outside data. */
const DATA_SEGMENTS = new Set(["provenance", "sources", "attribution", "analysisNeighborhoods"]);

export interface ClearedNames {
  /** Invented proper names that passed the search (verdict clear or caution). */
  cleared: ReadonlySet<string>;
  /** Labels used in name fields that are not invented proper names ("You", "Mom"). */
  generic: ReadonlySet<string>;
}

function matches(pattern: string, path: readonly string[]): boolean {
  const p = pattern.split(".");
  if (p.length !== path.length) return false;
  return p.every((seg, i) => seg === "*" || seg === path[i]);
}

function walk(v: unknown, path: string[], visit: (path: string[], s: string) => void): void {
  if (typeof v === "string") visit(path, v);
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, String(i)], visit));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...path, k], visit);
}

/**
 * Lint one parsed content file. `rel` is its path from the repo root ("content/brands.json").
 * Every string is linted as text unless the file or path is exempt or the key holds provenance;
 * registered name fields are also checked against `cleared`.
 */
export function lintDocument(rel: string, doc: unknown, cleared: ClearedNames | null): LintIssue[] {
  const out: LintIssue[] = [];
  const fileExempt = EXEMPT_PATHS.filter((e) => e.file.test(rel));
  if (fileExempt.some((e) => e.path === undefined)) return out;
  const nameFields = NAME_FIELDS.filter((f) => f.file.test(rel));
  walk(doc, [], (path, s) => {
    const at = path.join(".");
    if (fileExempt.some((e) => e.path !== undefined && (at === e.path || at.startsWith(`${e.path}.`)))) return;
    const key = path[path.length - 1] ?? "";
    const parentKey = path[path.length - 2] ?? "";
    if (DATA_KEYS.has(key) || DATA_KEYS.has(parentKey) || path.some((seg) => DATA_SEGMENTS.has(seg))) return;
    const isComment = key === "$comment" || key === "designNote" || key === "note";
    for (const i of lintText(s)) if (!isComment || COMMENT_RULES.has(i.rule)) out.push({ ...i, path: at });
    for (const f of nameFields) {
      if (!matches(f.path, path)) continue;
      if (f.kind === "modeName" || f.kind === "itemName") for (const i of lintModeName(s)) out.push({ ...i, path: at });
      if (f.kind === "name" && cleared && !cleared.cleared.has(s) && !cleared.generic.has(s)) {
        out.push({ rule: "clearedName", message: `clearedName: "${s}" is an invented proper name missing from content/cleared-names.json`, path: at, text: s });
      }
    }
  });
  return out;
}
