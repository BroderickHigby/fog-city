// Graphics preferences are presentation state. They never enter saves or the simulation.
import { chooseTier, type GfxCaps, type GfxRequest, type GfxTier } from "./gfx.ts";

export const GFX_PREFS_KEY = "fogcity.graphics.v1";
export const GFX_URL_OVERRIDES = ["gfx", "pr", "quality", "shadows"] as const;
export type GfxPrefsStorage = Pick<Storage, "getItem" | "setItem"> | null;
export type GfxPreferenceSource = "url" | "saved" | "default" | "settings";
export interface GfxApplied {
  readonly tier: GfxTier;
  readonly reason: string;
  /** A GPU recovery may use Low while retaining the player's manual preference. */
  readonly safetyFallback?: boolean;
}
export interface GfxPreferenceState extends GfxApplied {
  readonly requested: GfxRequest;
  readonly source: GfxPreferenceSource;
  readonly overrides: readonly string[];
  readonly persisted: boolean;
  readonly applying: boolean;
  readonly error: string | null;
}
export interface GfxPreferenceOptions {
  readonly url: URL;
  readonly caps: GfxCaps;
  readonly safeMode?: boolean;
  readonly storage?: GfxPrefsStorage;
  /** Apply safely at the owning renderer's lifecycle boundary. The URL has graphics overrides removed. */
  readonly apply: (selection: { requested: GfxRequest; url: URL }) => GfxApplied | Promise<GfxApplied>;
}

export function isGfxRequest(value: unknown): value is GfxRequest {
  return value === "auto" || value === "low" || value === "standard" || value === "high";
}
function browserStorage(): GfxPrefsStorage {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}
export function loadGfxPreference(storage: GfxPrefsStorage): GfxRequest | null {
  try {
    const text = storage?.getItem(GFX_PREFS_KEY);
    const value: unknown = text ? JSON.parse(text) : undefined;
    if (!value || typeof value !== "object") return null;
    const saved = value as { version?: unknown; requested?: unknown };
    return saved.version === 1 && isGfxRequest(saved.requested) ? saved.requested : null;
  } catch { return null; }
}
/** A valid link override wins over the saved preference; invalid link values do not erase it. */
export function resolveGfxPreference(params: URLSearchParams, saved: GfxRequest | null): { requested: GfxRequest; source: GfxPreferenceSource } {
  const override = params.get("gfx");
  return isGfxRequest(override) ? { requested: override, source: "url" }
    : saved ? { requested: saved, source: "saved" } : { requested: "auto", source: "default" };
}
export function withoutGraphicsOverrides(url: URL): URL {
  const clean = new URL(url.href);
  for (const key of GFX_URL_OVERRIDES) clean.searchParams.delete(key);
  return clean;
}

/** Owns requested preference and asynchronous application, not renderer resources. */
export class GfxPreferenceController {
  private value: GfxPreferenceState;
  private url: URL;
  private readonly storage: GfxPrefsStorage;
  private readonly apply: GfxPreferenceOptions["apply"];
  private readonly listeners = new Set<(state: GfxPreferenceState) => void>();

  constructor(options: GfxPreferenceOptions) {
    this.url = new URL(options.url.href);
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.apply = options.apply;
    const saved = loadGfxPreference(this.storage);
    const preference = resolveGfxPreference(this.url.searchParams, saved);
    const choice = chooseTier(options.safeMode ? "auto" : preference.requested, options.caps, options.safeMode);
    this.value = { ...preference, tier: choice.tier, reason: choice.reason,
      safetyFallback: !!options.safeMode, persisted: saved !== null,
      overrides: GFX_URL_OVERRIDES.filter(key => this.url.searchParams.has(key)), applying: false, error: null };
  }
  get(): GfxPreferenceState { return { ...this.value, overrides: [...this.value.overrides] }; }
  subscribe(listener: (state: GfxPreferenceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(): void { for (const listener of this.listeners) listener(this.get()); }
  /** Report an automatic step-down/recovery without changing or persisting the requested choice. */
  reportApplied(applied: GfxApplied): void {
    this.value = { ...this.value, safetyFallback: false, ...applied };
    this.publish();
  }
  async select(requested: GfxRequest): Promise<void> {
    if (!isGfxRequest(requested)) throw new Error("Choose Auto, Low, Standard or High.");
    if (this.value.applying) throw new Error("Wait for the graphics change to finish.");
    this.value = { ...this.value, applying: true, error: null };
    this.publish();
    const url = withoutGraphicsOverrides(this.url);
    try {
      const applied = await this.apply({ requested, url });
      let persisted = false;
      try {
        this.storage?.setItem(GFX_PREFS_KEY, JSON.stringify({ version: 1, requested }));
        persisted = this.storage !== null;
      } catch { /* The selected tier still applies when storage is blocked or full. */ }
      this.url = url;
      this.value = { requested, source: "settings", ...applied, overrides: [], persisted, applying: false, error: null };
      this.publish();
    } catch {
      this.value = { ...this.value, applying: false, error: "Graphics could not be changed. Your previous setting is still selected. Try again." };
      this.publish();
      throw new Error(this.value.error!);
    }
  }
}
