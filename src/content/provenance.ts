// Provenance (docs/ai-layer.md, How agents write it, step 5): every committed content file an
// agent wrote carries a provenance block whose contentHash covers its text, so an edit after
// review shows up as a stale hash in tests/content/provenance.test.ts.

import { contentHash, type BarkPool } from "./barks.ts";
import { bountyTexts, type BountyFile } from "./bounties.ts";
import { packTexts, type DistrictPack } from "./packs.ts";

/** Every string in the document, in file order, outside its provenance block. */
export function documentTexts(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "provenance") walk(x);
  };
  walk(doc);
  return out;
}

/**
 * The text a file's provenance hash covers: the file's own extractor where one exists (bark
 * pools, bounty templates and district packs hash their player lines), otherwise every string
 * outside the provenance block.
 */
export function provenanceTexts(rel: string, doc: unknown): string[] {
  if (/^content\/barks\/[^/]+\.json$/.test(rel)) return (doc as BarkPool).barks.map((b) => b.text);
  if (rel === "content/bounties.json") return bountyTexts(doc as BountyFile);
  if (/^content\/packs\/[^/]+\.json$/.test(rel)) return packTexts(doc as DistrictPack);
  return documentTexts(doc);
}

/** The contentHash a file's provenance block must carry. */
export function expectedContentHash(rel: string, doc: unknown): string {
  return contentHash(provenanceTexts(rel, doc));
}

/**
 * Content files without a provenance block, and why. Every other file under content/ must
 * carry one with a current hash.
 */
export const PROVENANCE_EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  { file: "content/cleared-names.json", why: "a research record; its own status field ('signed off' since 2026-10-20) is its review state" },
  { file: "content/banned-pairs.json", why: "generated from name-parts.json by the composer test (UPDATE_BANNED_PAIRS=1); regenerated, never hand-edited" },
];
