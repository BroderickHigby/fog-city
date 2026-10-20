// The name composer: every startup and player name in the game is two parts from the pre-cleared
// pools in content/name-parts.json, so no free-form brand name exists (docs/ai-layer.md, 3.2).
// The client uses it for scripted kits, and the AI proxy will use it for live ones (the model
// returns part ids, never a name).
//
// Every two-part composition, with and without its space, is run through the content lint at
// build time (tests/content/composer.test.ts); the ones that fail are in content/banned-pairs.json
// beside hand-added pairs. Composing at run time checks the list again and lints again. On a hit
// the composer keeps the first part and takes the next-ranked second part, then the next-ranked
// first part, so it never returns a banned pair.

import bannedJson from "../../content/banned-pairs.json" with { type: "json" };
import partsJson from "../../content/name-parts.json" with { type: "json" };
import { blockedNameReason, offensiveNameReason } from "./blocklist.ts";
import { lintText } from "./lint.ts";
import { hashString } from "./prng.ts";

export type NameKind = "startup" | "player";
export type NamePool = "startupHead" | "startupTail" | "playerAdjective" | "playerNoun";

/** How a startup tail joins its head: "Kelp Labs" (space) or "KelpStack" (camel). */
export type Glue = "space" | "camel";

export interface NamePart {
  id: string;
  text: string;
  glue?: Glue;
}

export interface NameParts {
  version: 1;
  pools: Record<NamePool, NamePart[]>;
}

export interface BannedPair {
  kind: NameKind;
  /** First part id (startup head or player adjective). */
  a: string;
  /** Second part id (startup tail or player noun). */
  b: string;
  source: "lint" | "hand";
  reason: string;
}

export interface BannedPairs {
  version: 1;
  pairs: BannedPair[];
}

/** Longest composed name, with its space: the `{name}` slot on billboards and bus wraps (lint.ts PLACEHOLDER_MAX). */
export const COMPOSED_NAME_MAX = 16;

export const NAME_PARTS = partsJson as unknown as NameParts;
export const BANNED_PAIRS = bannedJson as unknown as BannedPairs;

/** The two pools a kind of name is composed from, first part then second. */
export const POOLS_OF: Readonly<Record<NameKind, readonly [NamePool, NamePool]>> = {
  startup: ["startupHead", "startupTail"],
  player: ["playerAdjective", "playerNoun"],
};

const BY_ID = new Map<NamePool, Map<string, NamePart>>(
  (Object.keys(NAME_PARTS.pools) as NamePool[]).map((p) => [p, new Map(NAME_PARTS.pools[p].map((x) => [x.id, x]))]),
);

export function namePart(pool: NamePool, id: string): NamePart | undefined {
  return BY_ID.get(pool)?.get(id);
}

const pairKey = (kind: NameKind, a: string, b: string): string => `${kind}:${a}+${b}`;
const BANNED = new Set(BANNED_PAIRS.pairs.map((p) => pairKey(p.kind, p.a, p.b)));

export function isBannedPair(kind: NameKind, a: string, b: string): boolean {
  return BANNED.has(pairKey(kind, a, b));
}

/** The displayed name and its no-space form. */
export function composeText(kind: NameKind, a: NamePart, b: NamePart): { text: string; compact: string } {
  const compact = `${a.text}${b.text}`;
  if (kind === "startup" && b.glue === "camel") return { text: compact, compact };
  return { text: `${a.text} ${b.text}`, compact };
}

/** Why one string may not be a name: length, an offensive word, the brand and people blocklist, or any content-lint rule. */
export function nameLintReason(text: string): string | null {
  if (text.length > COMPOSED_NAME_MAX) return `length ${text.length} > ${COMPOSED_NAME_MAX}`;
  const bad = offensiveNameReason(text) ?? blockedNameReason(text);
  if (bad) return bad;
  const issue = lintText(text)[0];
  return issue ? issue.message : null;
}

/** Why a composed pair fails the lint (either form), or null. Does not read banned-pairs.json. */
export function pairLintReason(kind: NameKind, aId: string, bId: string): string | null {
  const [pa, pb] = POOLS_OF[kind];
  const a = namePart(pa, aId);
  const b = namePart(pb, bId);
  if (!a || !b) return `unknown part ${a ? bId : aId}`;
  const { text, compact } = composeText(kind, a, b);
  const r = nameLintReason(text);
  if (r) return `"${text}": ${r}`;
  const rc = compact === text ? null : nameLintReason(compact);
  return rc ? `"${compact}": ${rc}` : null;
}

export interface ComposedName {
  kind: NameKind;
  text: string;
  compact: string;
  parts: readonly [string, string];
}

/**
 * The ranked ids followed by every other part of the pool, in a stable order keyed by `key`, so
 * the composer always has a next-ranked part to take.
 */
function ranked(pool: NamePool, first: readonly string[], key: string): string[] {
  const all = NAME_PARTS.pools[pool];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of first) {
    if (!seen.has(id) && BY_ID.get(pool)?.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  const rest = all.filter((p) => !seen.has(p.id)).map((p) => [hashString(`${key}:${p.id}`), p.id] as const);
  rest.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : 1));
  for (const [, id] of rest) out.push(id);
  return out;
}

/**
 * Compose a name from ranked part ids (most preferred first). The first acceptable pair wins:
 * the first-ranked first part with each second part in rank order, then the next first part.
 * Unknown ids are skipped. A pair is acceptable when it is not in banned-pairs.json and both of
 * its forms pass the lint now.
 */
export function composeName(kind: NameKind, firstIds: readonly string[], secondIds: readonly string[], key = ""): ComposedName {
  const [pa, pb] = POOLS_OF[kind];
  const as = ranked(pa, firstIds, `${key}:a`);
  const bs = ranked(pb, secondIds, `${key}:b`);
  for (const a of as) {
    for (const b of bs) {
      if (isBannedPair(kind, a, b) || pairLintReason(kind, a, b) !== null) continue;
      const { text, compact } = composeText(kind, namePart(pa, a) as NamePart, namePart(pb, b) as NamePart);
      return { kind, text, compact, parts: [a, b] };
    }
  }
  throw new Error(`composer: no acceptable ${kind} name in the pools`);
}

/** A startup name from a head and tail id (a kit's nameParts, or a live kit's ranked ids). */
export function composeStartupName(headIds: string | readonly string[], tailIds: string | readonly string[], key = ""): ComposedName {
  return composeName("startup", typeof headIds === "string" ? [headIds] : headIds, typeof tailIds === "string" ? [tailIds] : tailIds, key);
}

/** A deterministic name for a seed (a player id, a session id), picked by keyed hash. */
export function nameForSeed(kind: NameKind, seed: string | number): ComposedName {
  const key = `${kind}:${seed}`;
  const [pa, pb] = POOLS_OF[kind];
  const A = NAME_PARTS.pools[pa];
  const B = NAME_PARTS.pools[pb];
  const a = A[hashString(`${key}:first`) % A.length] as NamePart;
  const b = B[hashString(`${key}:second`) % B.length] as NamePart;
  return composeName(kind, [a.id], [b.id], key);
}

export const playerNameFor = (seed: string | number): ComposedName => nameForSeed("player", seed);
export const startupNameFor = (seed: string | number): ComposedName => nameForSeed("startup", seed);

/** Every pair of a kind that fails the lint now, for the build step and the property test. */
export function lintFailingPairs(kind: NameKind): Array<{ a: string; b: string; reason: string }> {
  const [pa, pb] = POOLS_OF[kind];
  const out: Array<{ a: string; b: string; reason: string }> = [];
  for (const a of NAME_PARTS.pools[pa]) {
    for (const b of NAME_PARTS.pools[pb]) {
      const reason = pairLintReason(kind, a.id, b.id);
      if (reason) out.push({ a: a.id, b: b.id, reason });
    }
  }
  return out;
}

export interface ComposerIssue {
  message: string;
}

/** Structural checks: unique ids, every part passes the lint alone, startup tails say how they join. */
export function checkNameParts(parts: NameParts = NAME_PARTS): ComposerIssue[] {
  const out: ComposerIssue[] = [];
  for (const pool of Object.keys(parts.pools) as NamePool[]) {
    const ids = new Set<string>();
    const texts = new Set<string>();
    for (const p of parts.pools[pool]) {
      if (ids.has(p.id)) out.push({ message: `${pool}: duplicate id ${p.id}` });
      if (texts.has(p.text.toLowerCase())) out.push({ message: `${pool}: duplicate text ${p.text}` });
      ids.add(p.id);
      texts.add(p.text.toLowerCase());
      const r = nameLintReason(p.text);
      if (r) out.push({ message: `${pool}.${p.id} "${p.text}": ${r}` });
      if (pool === "startupTail" && p.glue === undefined) out.push({ message: `startupTail.${p.id}: needs a glue` });
      if (pool !== "startupTail" && p.glue !== undefined) out.push({ message: `${pool}.${p.id}: only startup tails have a glue` });
    }
  }
  for (const bp of BANNED_PAIRS.pairs) {
    const [pa, pb] = POOLS_OF[bp.kind];
    if (!namePart(pa, bp.a) || !namePart(pb, bp.b)) out.push({ message: `banned pair ${bp.kind}:${bp.a}+${bp.b} names a part that does not exist` });
  }
  return out;
}
