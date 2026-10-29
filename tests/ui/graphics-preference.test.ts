import { describe, expect, it } from "vitest";
import { GFX_PREFS_KEY, GfxPreferenceController, loadGfxPreference, resolveGfxPreference, withoutGraphicsOverrides, type GfxApplied } from "../../src/render/gfx-preference.ts";
import type { GfxCaps } from "../../src/render/gfx.ts";

const caps: GfxCaps = { webgl2: true, renderer: "Intel Iris", maxTextureSize: 16384, mobile: false };
const url = () => new URL("http://localhost:4371/?world=sf&seed=7");
function storage(initial?: string) {
  const values = new Map<string, string>(initial ? [[GFX_PREFS_KEY, initial]] : []);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const apply = ({ requested }: { requested: string }): GfxApplied => ({ tier: requested === "auto" ? "standard" : requested as "low" | "standard" | "high", reason: "test application" });

describe("graphics preference ownership", () => {
  it("resolves valid link > saved choice > Auto, ignoring invalid link values", () => {
    expect(resolveGfxPreference(new URLSearchParams("gfx=low"), "high")).toEqual({ requested: "low", source: "url" });
    expect(resolveGfxPreference(new URLSearchParams("gfx=auto"), "high")).toEqual({ requested: "auto", source: "url" });
    expect(resolveGfxPreference(new URLSearchParams("gfx=default"), "high")).toEqual({ requested: "high", source: "saved" });
    expect(resolveGfxPreference(new URLSearchParams(), null)).toEqual({ requested: "auto", source: "default" });
  });
  it.each(["broken", "null", "[]", '{"version":2,"requested":"high"}', '{"version":1,"requested":"ultra"}'])("rejects invalid saved preferences: %s", text => {
    expect(loadGfxPreference(storage(text))).toBeNull();
  });
  it("clears only graphics overrides, retaining city, gameplay and renderer parameters", () => {
    const original = new URL("http://localhost/?world=sf&seed=7&renderer=webgl&gfx=high&gfx=low&pr=2&quality=1&shadows=1#view");
    const clean = withoutGraphicsOverrides(original);
    expect(clean.href).toBe("http://localhost/?world=sf&seed=7&renderer=webgl#view");
    expect(original.searchParams.get("gfx")).toBe("high");
  });
  it("persists an applied manual preference and uses it in a fresh controller", async () => {
    const prefs = storage(), controller = new GfxPreferenceController({ url: url(), caps, storage: prefs, apply });
    await controller.select("high");
    expect(controller.get()).toMatchObject({ requested: "high", tier: "high", source: "settings", persisted: true, applying: false });
    const reloaded = new GfxPreferenceController({ url: url(), caps, storage: prefs, apply });
    expect(reloaded.get()).toMatchObject({ requested: "high", tier: "high", source: "saved" });
  });
  it("keeps an explicit request selected when GPU recovery needs Low", async () => {
    const controller = new GfxPreferenceController({ url: new URL("http://localhost/?gfx=high"), caps, safeMode: true, storage: null, apply: () => ({ tier: "low", reason: "GPU recovery", safetyFallback: true }) });
    expect(controller.get()).toMatchObject({ requested: "high", tier: "low", source: "url", safetyFallback: true });
    await controller.select("standard");
    expect(controller.get()).toMatchObject({ requested: "standard", tier: "low", safetyFallback: true });
  });
  it("serializes application and sends the caller a URL free of quality overrides", async () => {
    let finish!: (result: GfxApplied) => void;
    let received: URL | undefined;
    const controller = new GfxPreferenceController({ url: new URL("http://localhost/?gfx=high&pr=2&seed=9"), caps, storage: null,
      apply: selection => { received = selection.url; return new Promise(resolve => { finish = resolve; }); } });
    const pending = controller.select("low");
    expect(controller.get()).toMatchObject({ requested: "high", applying: true });
    await expect(controller.select("auto")).rejects.toThrow("Wait for the graphics change");
    expect(received!.search).toBe("?seed=9");
    finish({ tier: "low", reason: "applied" }); await pending;
    expect(controller.get()).toMatchObject({ requested: "low", applying: false, overrides: [] });
  });
  it("retains the previous preference and URL override when application fails, then permits retry", async () => {
    const prefs = storage('{"version":1,"requested":"standard"}');
    let fail = true;
    const controller = new GfxPreferenceController({ url: new URL("http://localhost/?gfx=high"), caps, storage: prefs, apply: selection => { if (fail) throw new Error("device lost"); return apply(selection); } });
    await expect(controller.select("low")).rejects.toThrow("Graphics could not be changed");
    expect(controller.get()).toMatchObject({ requested: "high", tier: "high", applying: false, overrides: ["gfx"] });
    expect(loadGfxPreference(prefs)).toBe("standard");
    fail = false; await controller.select("low");
    expect(controller.get()).toMatchObject({ requested: "low", error: null, overrides: [] });
  });
  it("applies for the session when browser storage is blocked", async () => {
    const controller = new GfxPreferenceController({ url: url(), caps, storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); } }, apply });
    await controller.select("low");
    expect(controller.get()).toMatchObject({ requested: "low", tier: "low", persisted: false, error: null });
  });
  it("reports governor/recovery state without changing the manual preference or notifying disposed subscribers", async () => {
    const prefs = storage(), controller = new GfxPreferenceController({ url: url(), caps, storage: prefs, apply });
    await controller.select("high");
    let calls = 0;
    const unsubscribe = controller.subscribe(() => { calls++; });
    controller.reportApplied({ tier: "low", reason: "GPU reset", safetyFallback: true });
    expect(controller.get()).toMatchObject({ requested: "high", tier: "low" });
    expect(loadGfxPreference(prefs)).toBe("high");
    unsubscribe(); controller.reportApplied({ tier: "standard", reason: "restored", safetyFallback: false });
    expect(calls).toBe(1);
  });
});
