// Storefront kits by NAICS code (content/storefronts.json). The pipeline's storefront anchors
// carry the raw registry code; the renderer asks storefrontFor(anchor.naics) which kit to build.

import storefrontsJson from "../../content/storefronts.json" with { type: "json" };

export type SignShape =
  | "neonPanel" | "fasciaBand" | "cupBlade" | "breadBlade" | "barberPole" | "scissorsBlade"
  | "projectingCross" | "hangerBlade" | "awningValance";

export interface StorefrontType {
  id: string;
  label: string;
  naicsPrefixes: string[];
  naicsNote?: string;
  signShape: SignShape;
  signSlot: { mount: "fascia" | "blade" | "window" | "awningValance" | "pole"; widthM: number; heightM: number };
  props: string[];
  nightGlow?: boolean;
  /** Always null for now: storefronts are unnamed. */
  signText: null;
}

export interface StorefrontKit {
  version: 1;
  noStorefrontPrefixes: string[];
  types: StorefrontType[];
}

export const STOREFRONTS = storefrontsJson as unknown as StorefrontKit;

interface Entry {
  prefix: string;
  type: StorefrontType | null;
}

function index(kit: StorefrontKit): Entry[] {
  const out: Entry[] = [];
  for (const t of kit.types) for (const p of t.naicsPrefixes) out.push({ prefix: p, type: t });
  for (const p of kit.noStorefrontPrefixes) out.push({ prefix: p, type: null });
  // Longest prefix first; ties cannot happen (checkStorefronts forbids duplicate prefixes).
  return out.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
}

const DEFAULT_INDEX = index(STOREFRONTS);

/**
 * The kit for a NAICS code, or null when the business has no storefront kit (offices,
 * non-store retail, unknown codes). Accepts codes with stray whitespace or punctuation.
 */
export function storefrontFor(naics: string | null | undefined, kit: StorefrontKit = STOREFRONTS): StorefrontType | null {
  if (!naics) return null;
  const code = naics.replace(/[^0-9]/g, "");
  if (code.length < 2) return null;
  const idx = kit === STOREFRONTS ? DEFAULT_INDEX : index(kit);
  for (const e of idx) if (code.startsWith(e.prefix)) return e.type;
  return null;
}

/** Rules beyond the schema: unique ids and prefixes, no sign text, every prop and shape known. */
export function checkStorefronts(kit: StorefrontKit = STOREFRONTS): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const prefixes = new Map<string, string>();
  const claim = (p: string, owner: string): void => {
    const prev = prefixes.get(p);
    if (prev) errs.push(`prefix ${p} claimed by both ${prev} and ${owner}`);
    prefixes.set(p, owner);
  };
  for (const t of kit.types) {
    if (ids.has(t.id)) errs.push(`type ${t.id}: duplicate id`);
    ids.add(t.id);
    if (t.signText !== null) errs.push(`type ${t.id}: signText must be null (storefronts are unnamed)`);
    for (const p of t.naicsPrefixes) claim(p, t.id);
    if (new Set(t.props).size !== t.props.length) errs.push(`type ${t.id}: duplicate props`);
  }
  for (const p of kit.noStorefrontPrefixes) claim(p, "noStorefront");
  return errs;
}
