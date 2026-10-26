// A guest identity for online play: a device token kept on this device, a display name composed
// from the game's vetted name parts (never free text: docs/design.md, The profile), and one of the
// looks the licensed avatar and car are drawn in. The relay re-checks the name with the same
// content lint (deny-lists, brand and people blocklists) before anyone else sees it.
import { composeText, isBannedPair, namePart, pairLintReason } from "../content/composer.ts";
import { NAME_PARTS } from "../content/composer.ts";

/** Looks: the renderer's player colour slots (car paint, shirt, trousers, skin and hair together). */
export const LOOK_COUNT = 6;
export const LOOK_NAMES = ["Persimmon", "Bay Blue", "Mustard", "Eucalyptus", "Fog", "Ube"] as const;
/** The swatch shown for each look: the same sRGB as the renderer's player car colours (CAR_COLORS). */
export const LOOK_SWATCHES = [0xe0552b, 0x2d6fc8, 0xe0b23a, 0x3a9a6a, 0xe8e4da, 0x6a3fa0] as const;
export const DEVICE_TOKEN = /^[a-f0-9]{32}$/;
const PART_ID = /^[a-z0-9-]{1,32}$/;

export interface Profile { name: readonly [adjective: string, noun: string]; look: number }
export interface Identity extends Profile { token: string }

/** The displayed name for a pair of part ids, or null when it is unknown, banned or fails the lint. */
export function profileName(adjective: string, noun: string): string | null {
  if (!PART_ID.test(adjective) || !PART_ID.test(noun) || isBannedPair("player", adjective, noun) || pairLintReason("player", adjective, noun)) return null;
  const a = namePart("playerAdjective", adjective), b = namePart("playerNoun", noun);
  return a && b ? composeText("player", a, b).text : null;
}

export function validProfile(value: unknown): value is Profile {
  const p = value as Profile | null;
  return !!p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 2 && Array.isArray(p.name) && p.name.length === 2 &&
    typeof p.name[0] === "string" && typeof p.name[1] === "string" && profileName(p.name[0], p.name[1]) !== null &&
    Number.isInteger(p.look) && p.look >= 0 && p.look < LOOK_COUNT;
}

/** A random lint-clean name. `random` returns [0, 1) (UI only: never the sim). */
export function randomName(random: () => number = Math.random): [string, string] {
  const adjectives = NAME_PARTS.pools.playerAdjective, nouns = NAME_PARTS.pools.playerNoun;
  for (let i = 0; i < 200; i++) {
    const a = adjectives[Math.floor(random() * adjectives.length)]!.id, b = nouns[Math.floor(random() * nouns.length)]!.id;
    if (profileName(a, b)) return [a, b];
  }
  return ["quiet", "heron"];
}

function newToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
}

const KEY = "fog-city.identity";
type Store = Pick<Storage, "getItem" | "setItem">;

/** This device's identity, created on first use and kept in `storage` (localStorage). */
export function loadIdentity(storage: Store | null): Identity {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? "null") as Identity | null;
    if (saved && DEVICE_TOKEN.test(saved.token) && validProfile({ name: saved.name, look: saved.look })) return { token: saved.token, name: [saved.name[0], saved.name[1]], look: saved.look };
  } catch { /* fall through to a new identity */ }
  const fresh: Identity = { token: newToken(), name: randomName(), look: Math.floor(Math.random() * LOOK_COUNT) };
  saveIdentity(storage, fresh);
  return fresh;
}
export function saveIdentity(storage: Store | null, identity: Identity): void {
  try { storage?.setItem(KEY, JSON.stringify(identity)); } catch { /* private mode: identity lasts this page */ }
}
