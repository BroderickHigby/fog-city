// One-Sentence Startup, scripted (docs/ai-layer.md, 3.2 and 3.0): the keyword matcher that turns
// the sign-up form's "What are you building?" into a startup kit, on the device.
//
// Order of gates (docs/ai-layer.md, Safety and abuse): the crisis check runs first, on the raw
// text, before anything else; a match returns the crisis response and no kit. Then the length
// cap and look-alike normalisation, then the deny-lists that decide a refusal (a refused sentence
// gets a fallback kit about startup culture, never a kit about the sentence), then keyword
// scoring. The typed sentence is never stored or shown; only the kit id leaves this module, for
// the StartupDefined event. Picks are by keyed hash of the normalised sentence, never the sim RNG.

import kitsJson from "../../content/startup-kits.json" with { type: "json" };
import { composeStartupName, type ComposedName } from "./composer.ts";
import { CRISIS, crisisCheck, crisisResponse, type CrisisResponse } from "./crisis.ts";
import { SENSITIVE_TOPICS } from "./denylists.ts";
import { lintText, type LintRule } from "./lint.ts";
import { hashString } from "./prng.ts";

/** The one refusal enum every route and AI event uses (docs/ai-layer.md, 3.0). */
export type Refusal =
  | "none" | "off_topic" | "real_person" | "private_person" | "punching_down" | "sexual" | "violent" | "hateful" | "self_harm";

export const REFUSALS: readonly Refusal[] = [
  "none", "off_topic", "real_person", "private_person", "punching_down", "sexual", "violent", "hateful", "self_harm",
];

export type SlideKind = "problem" | "solution" | "market" | "traction" | "ask";

export interface StartupKit {
  id: string;
  keywords: string[];
  /** [startup head id, startup tail id] in content/name-parts.json. */
  nameParts: [string, string];
  nounPhrase: string;
  tagline: string;
  slides: Array<{ kind: SlideKind; text: string }>;
  billboard: { headline: string; subline: string };
  busWrap: { headline: string; subline: string };
  /** Index into content/billboards.json palettes. */
  palette: number;
  /** Generic startup-culture kit: the pool for refusals and sentences no keyword matches. */
  fallback?: boolean;
}

export const STARTUP_KITS: readonly StartupKit[] = (kitsJson as unknown as { kits: StartupKit[] }).kits;
export const FALLBACK_KITS: readonly StartupKit[] = STARTUP_KITS.filter((k) => k.fallback);

/** The sign-up form's limit (content/missions/hot-desk.json, form.maxLength). */
export const STARTUP_SENTENCE_MAX = 140;

const KIT_BY_ID = new Map(STARTUP_KITS.map((k) => [k.id, k]));

export function kitById(id: string): StartupKit | undefined {
  return KIT_BY_ID.get(id);
}

// ---------------------------------------------------------------------------------------------
// Normalisation and tokens

const LETTER_LOOKALIKE = new Map(Object.entries(CRISIS.normalise).filter(([k, v]) => /\p{L}/u.test(k) && /^[a-z]+$/.test(v)));

/** NFKC, accents and invisible characters removed, lower-case, Cyrillic and Greek look-alikes mapped to Latin. */
export function normaliseSentence(text: string): string {
  let s = text.normalize("NFKC").replace(/[­​-‏⁠-⁤﻿]/g, "");
  s = s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  let out = "";
  for (const ch of s) out += LETTER_LOOKALIKE.get(ch) ?? ch;
  return out;
}

/** Plural and simple inflection stripping, applied to keywords and input alike. */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Words that say nothing about the topic and must not decide a match. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  `a an the for to of and or with that which who in on at by from my your our their it its is are be this these those i we you me us them
  app apps tool tools thing things like but just using use uses so make makes making build building builds help helps people way
  ai new better smarter smart platform startup company find get want need will can more every everyone anyone someone`.split(/\s+/).filter((w) => w.length > 0),
);

export function tokensOf(text: string): string[] {
  return normaliseSentence(text)
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)
    .map(stem);
}

interface Keyword {
  kit: StartupKit;
  /** Stemmed tokens; a multi-word keyword matches as a contiguous run. */
  tokens: string[];
  /** Words in the keyword, divided by the number of kits that list the same stemmed keyword. */
  weight: number;
}

const KEYWORDS: readonly Keyword[] = (() => {
  const raw: Array<{ kit: StartupKit; tokens: string[]; key: string }> = [];
  for (const kit of STARTUP_KITS) {
    const seen = new Set<string>();
    for (const k of kit.keywords) {
      const tokens = tokensOf(k);
      const key = tokens.join(" ");
      if (tokens.length === 0 || seen.has(key) || (tokens.length === 1 && STOP_WORDS.has(key))) continue;
      seen.add(key);
      raw.push({ kit, tokens, key });
    }
  }
  const shared = new Map<string, number>();
  for (const r of raw) shared.set(r.key, (shared.get(r.key) ?? 0) + 1);
  return raw.map((r) => ({ kit: r.kit, tokens: r.tokens, weight: r.tokens.length / (shared.get(r.key) ?? 1) }));
})();

// ---------------------------------------------------------------------------------------------
// Refusals

/** Which lint rules decide which refusal. Brands, renamed names and dialect only mean "do not echo", which a kit never does. */
const RULE_REFUSAL: Partial<Record<LintRule, Refusal>> = {
  sexual: "sexual",
  hate: "hateful",
  lexicon: "violent",
  shooter: "violent",
  shooterMode: "violent",
  punchDown: "punching_down",
  housing: "punching_down",
  person: "real_person",
  accelerator: "real_person",
};
/** Most serious first: the refusal reported when several apply. */
const SEVERITY: readonly Refusal[] = ["sexual", "hateful", "violent", "punching_down", "real_person", "private_person"];

const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE = /(\+?\d[\s().-]?){7,}/;
const STREET_ADDRESS = /\b\d{1,5}\s+([a-z]+\s){0,3}(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl)\b/i;

const SENSITIVE_RE = SENSITIVE_TOPICS.map(([, p]) => new RegExp(`(^|[^\\p{L}\\p{N}])(${p})($|[^\\p{L}\\p{N}])`, "iu"));

export interface Screening {
  refusal: Refusal;
  /** A sincere topic the game never jokes about (health, disability, faith, identity, grief): a fallback kit, no refusal. */
  sensitive: boolean;
}

/** The refusal a sentence earns from the deny-lists, after the crisis check has passed. */
export function screenSentence(text: string): Screening {
  const norm = normaliseSentence(text);
  const found = new Set<Refusal>();
  for (const i of lintText(norm)) {
    const r = i.rule === "profanity" && i.message.includes("slur") ? "hateful" : RULE_REFUSAL[i.rule];
    if (r) found.add(r);
  }
  if (EMAIL.test(norm) || PHONE.test(norm) || STREET_ADDRESS.test(norm)) found.add("private_person");
  const refusal = SEVERITY.find((r) => found.has(r)) ?? "none";
  return { refusal, sensitive: SENSITIVE_RE.some((re) => re.test(norm)) };
}

// ---------------------------------------------------------------------------------------------
// The matcher

export type KitSource = "keyword" | "fallback";

export type KitMatch =
  | { kind: "crisis"; refusal: "self_harm"; kitId: null; crisis: CrisisResponse }
  | { kind: "kit"; refusal: Exclude<Refusal, "self_harm">; kitId: string; source: KitSource; reason: "matched" | "noKeyword" | "refused" | "sensitive" };

function pick<T>(xs: readonly T[], key: string): T {
  return xs[hashString(key) % xs.length] as T;
}

/**
 * Score every kit by the distinct keywords the sentence contains: a keyword counts its words,
 * shared between the kits that list it, so "sea lion" beats "seal" and a word every kit lists
 * decides nothing.
 */
export function scoreKits(text: string): Map<string, number> {
  const toks = tokensOf(text).slice(0, 64);
  const set = new Set(toks.filter((t) => !STOP_WORDS.has(t)));
  const joined = ` ${toks.join(" ")} `;
  const scores = new Map<string, number>();
  for (const k of KEYWORDS) {
    const hit = k.tokens.length === 1 ? set.has(k.tokens[0] as string) : joined.includes(` ${k.tokens.join(" ")} `);
    if (hit) scores.set(k.kit.id, (scores.get(k.kit.id) ?? 0) + k.weight);
  }
  return scores;
}

/**
 * The kit for a typed sentence. Crisis first (no kit); then a refusal or a sensitive topic gets a
 * fallback kit; then the best keyword score wins, ties broken by keyed hash; no keyword at all
 * gets a fallback kit. Deterministic: the same sentence always gets the same kit.
 */
export function matchKit(text: string): KitMatch {
  const crisis = crisisCheck(text);
  if (crisis) return { kind: "crisis", refusal: "self_harm", kitId: null, crisis: crisisResponse(crisis.group) };
  const capped = text.slice(0, STARTUP_SENTENCE_MAX);
  const key = tokensOf(capped).join(" ");
  const { refusal, sensitive } = screenSentence(capped);
  if (refusal !== "none") {
    return { kind: "kit", refusal: refusal as Exclude<Refusal, "self_harm">, kitId: pick(FALLBACK_KITS, `refused:${key}`).id, source: "fallback", reason: "refused" };
  }
  if (sensitive) return { kind: "kit", refusal: "none", kitId: pick(FALLBACK_KITS, `sensitive:${key}`).id, source: "fallback", reason: "sensitive" };
  const scores = scoreKits(capped);
  let best = 0;
  for (const s of scores.values()) best = Math.max(best, s);
  if (best === 0) return { kind: "kit", refusal: "none", kitId: pick(FALLBACK_KITS, `none:${key}`).id, source: "fallback", reason: "noKeyword" };
  const top = STARTUP_KITS.filter((k) => scores.get(k.id) === best);
  return { kind: "kit", refusal: "none", kitId: pick(top, `kit:${key}`).id, source: "keyword", reason: "matched" };
}

/** A kit's composed name (its own pair unless the composer had to take the next-ranked part). */
export function kitName(kit: StartupKit): ComposedName {
  return composeStartupName(kit.nameParts[0], kit.nameParts[1], kit.id);
}

/** Fill a kit string's {name} and {nounPhrase} slots. */
export function renderKitText(kit: StartupKit, text: string, name: string = kitName(kit).text): string {
  return text.replace(/\{name\}/g, name).replace(/\{nounPhrase\}/g, kit.nounPhrase);
}

/** Every player-facing string of a kit, unrendered. */
export function kitTexts(kit: StartupKit): string[] {
  return [kit.nounPhrase, kit.tagline, ...kit.slides.map((s) => s.text), kit.billboard.headline, kit.billboard.subline, kit.busWrap.headline, kit.busWrap.subline];
}
