import { describe, expect, it } from "vitest";
import { LOOK_COUNT, LOOK_NAMES, LOOK_SWATCHES, loadIdentity, profileName, randomName, saveIdentity, validProfile } from "../../src/net/identity.ts";
import { CAR_COLORS } from "../../src/render/actors.ts";

function memory(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

describe("guest identity", () => {
  it("names come only from vetted name parts and pass the content lint", () => {
    expect(profileName("quiet", "heron")).toBe("Quiet Heron");
    expect(profileName("quiet", "nosuch")).toBeNull();
    expect(profileName("Quiet", "heron")).toBeNull();
    expect(profileName("quiet heron", "x")).toBeNull();
    for (let i = 0; i < 25; i++) { const [a, b] = randomName(); expect(profileName(a, b)).not.toBeNull(); }
    expect(validProfile({ name: ["quiet", "heron"], look: LOOK_COUNT - 1 })).toBe(true);
    for (const bad of [{ name: ["quiet", "heron"], look: LOOK_COUNT }, { name: ["quiet", "heron"], look: 1.5 }, { name: "Quiet Heron", look: 0 }, { name: ["quiet", "heron"], look: 0, extra: 1 }, null])
      expect(validProfile(bad)).toBe(false);
  });

  it("keeps one device token and profile per device, and replaces a corrupt record", () => {
    const store = memory();
    const first = loadIdentity(store);
    expect(first.token).toMatch(/^[a-f0-9]{32}$/);
    expect(loadIdentity(store)).toEqual(first);
    saveIdentity(store, { ...first, look: 2, name: ["salty", "pumice"] });
    expect(loadIdentity(store)).toMatchObject({ token: first.token, look: 2, name: ["salty", "pumice"] });
    store.data.set("fog-city.identity", JSON.stringify({ token: first.token, name: ["free", "text!"], look: 0 }));
    expect(loadIdentity(store).token).not.toBe(first.token);
    expect(loadIdentity(null).token).toMatch(/^[a-f0-9]{32}$/);
  });

  it("shows the renderer's own player colours as the look swatches", () => {
    expect([...LOOK_SWATCHES]).toEqual(CAR_COLORS);
    expect(LOOK_COUNT).toBe(CAR_COLORS.length);
    expect(LOOK_NAMES).toHaveLength(LOOK_COUNT);
  });

  it("keeps saved look indices, names, paint and device tokens while adding six looks", () => {
    expect(LOOK_NAMES.slice(0, 6)).toEqual(["Persimmon", "Bay Blue", "Mustard", "Eucalyptus", "Fog", "Ube"]);
    expect(CAR_COLORS.slice(0, 6)).toEqual([0xe0552b, 0x2d6fc8, 0xe0b23a, 0x3a9a6a, 0xe8e4da, 0x6a3fa0]);
    expect(LOOK_COUNT).toBe(12);
    for (let look = 0; look < LOOK_COUNT; look++) {
      const store = memory(), identity = { token: "a".repeat(32), name: ["quiet", "heron"] as const, look };
      saveIdentity(store, identity);
      expect(loadIdentity(store)).toEqual(identity);
      expect(validProfile({ name: identity.name, look })).toBe(true);
    }
  });
});
