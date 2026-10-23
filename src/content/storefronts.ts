// Storefront kits by NAICS code (content/storefronts.json). The pipeline's storefront anchors
// carry the raw registry code; the renderer asks shopfrontFor(anchor) which kit to build (house
// kit K5, world QA W-47): the glazed bay, the awning shape and its colour, the empty sign slot and
// the sign's icon shape. storefrontFor(naics) is the kit lookup alone.

import storefrontsJson from "../../content/storefronts.json" with { type: "json" };
import { storefrontAllowedOn } from "./landmarkTags.ts";
import { hashString } from "./prng.ts";

export type SignShape =
  | "neonPanel" | "fasciaBand" | "cupBlade" | "breadBlade" | "barberPole" | "scissorsBlade"
  | "projectingCross" | "hangerBlade" | "awningValance" | "takeoutBoxBlade" | "bottleBlade"
  | "polishBlade" | "shirtBlade" | "keyBlade" | "plugBlade" | "lampBlade" | "bookBlade" | "wheelBlade" | "dropPanel";

export type AwningShape = "none" | "slope" | "striped" | "scalloped" | "box" | "quarterRound" | "flatCanopy" | "canopy";

export interface Shopfront {
  /** Width of the glazed bay along the wall, metres (K5: 5 m). */
  bayWidthM: number;
  /** Height of the bay from the sidewalk to the top of the fascia, metres (K5: 3.5 to 4.5 m). */
  heightM: number;
  /** Share of the bay that is glass. */
  glazing: number;
  /** Height of the solid stall riser under the window, metres. */
  stallRiserM: number;
  door: "side" | "centre" | "recessed";
  /** A glazed transom band above the door and window. */
  transom: boolean;
  /** Mullion, door and stall-riser colours (sRGB hex); one is picked per anchor. */
  frames: string[];
}

export interface Awning {
  shape: AwningShape;
  /** Projection from the wall, metres (0 for none; a fuel canopy stands free over the pumps). */
  depthM: number;
  /** Fabric or panel colours (sRGB hex); one is picked per anchor. Empty for none. */
  colours: string[];
  /** The second colour of a striped awning. */
  stripe?: string;
}

export interface StorefrontType {
  id: string;
  label: string;
  naicsPrefixes: string[];
  naicsNote?: string;
  /** The pipeline's coarse category values (pipeline/lib/storefronts.ts categoryOf) this kit serves. */
  categories: string[];
  signShape: SignShape;
  signSlot: { mount: "fascia" | "blade" | "window" | "awningValance" | "pole"; widthM: number; heightM: number };
  shopfront: Shopfront;
  awning: Awning;
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
    const a = t.awning;
    if (a.shape === "none" ? a.colours.length > 0 || a.depthM !== 0 : a.colours.length === 0 || a.depthM <= 0) {
      errs.push(`type ${t.id}: an awning has a depth and colours exactly when its shape is not none`);
    }
    if ((a.shape === "striped") !== (a.stripe !== undefined)) errs.push(`type ${t.id}: a striped awning, and only one, has a stripe colour`);
    if (new Set(a.colours).size !== a.colours.length) errs.push(`type ${t.id}: duplicate awning colours`);
    if (t.shopfront.stallRiserM >= t.shopfront.heightM / 2) errs.push(`type ${t.id}: the stall riser takes half the bay`);
    if (t.categories.length === 0) errs.push(`type ${t.id}: serves no category`);
  }
  for (const p of kit.noStorefrontPrefixes) claim(p, "noStorefront");
  return errs;
}

/** What the renderer draws for one storefront anchor (house kit K5). */
export interface ShopfrontPlan {
  kit: StorefrontType;
  /** This anchor's awning colour, or null when the kit has no awning. */
  awningColour: string | null;
  frameColour: string;
}

/**
 * The shopfront for a pipeline anchor, or null when nothing is drawn: no kit for its code, or
 * its building is a civic landmark whose storefronts are not drawn (content/landmark-tags.json).
 * Colours are picked by a hash of the anchor id, so a block of shops varies and a rebuild keeps
 * each shop's colour.
 */
export function shopfrontFor(anchor: { id: string; naics: string; buildingId: string }, kit: StorefrontKit = STOREFRONTS): ShopfrontPlan | null {
  const t = storefrontFor(anchor.naics, kit);
  if (!t || !storefrontAllowedOn(anchor.buildingId)) return null;
  const h = hashString(anchor.id);
  const awningColour = t.awning.colours.length > 0 ? t.awning.colours[h % t.awning.colours.length]! : null;
  const frameColour = t.shopfront.frames[(h >>> 8) % t.shopfront.frames.length]!;
  return { kit: t, awningColour, frameColour };
}
