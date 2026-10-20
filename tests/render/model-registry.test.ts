import { describe, expect, it, vi } from "vitest";
import { MODEL_FILES, ModelRegistry } from "../../src/render/model-registry.ts";

interface FakeModel {
  kind: "file" | "fallback";
  key?: string;
  url?: string;
  copy: number;
}

function setup(opts: { available?: Set<string> | null; fail?: Set<string> } = {}) {
  let copies = 0;
  const load = vi.fn(async (url: string): Promise<FakeModel> => {
    if (opts.fail?.has(url)) throw new Error("404 Not Found");
    return { kind: "file", url, copy: 0 };
  });
  const reg = new ModelRegistry<FakeModel>({
    load,
    fallback: (key) => ({ kind: "fallback", key, copy: ++copies }),
    clone: (p) => ({ ...p, copy: ++copies }),
    available: opts.available ?? null,
  });
  return { reg, load };
}

describe("ModelRegistry", () => {
  it("knows where the shared models live", () => {
    expect(MODEL_FILES["player-car"]).toBe("models/player-car.glb");
    for (const k of ["robotaxi", "robot", "bus"]) expect(MODEL_FILES[k]).toMatch(/^models\/.+\.glb$/);
  });

  it("returns independent clones of a model that loads", async () => {
    const { reg, load } = setup();
    const a = await reg.get("player-car");
    const b = await reg.get("player-car");
    expect(a.source).toBe("file");
    expect(a.model.url).toBe("models/player-car.glb");
    expect(a.model).not.toBe(b.model);
    expect(load).toHaveBeenCalledTimes(1);
    expect(reg.status("player-car")).toBe("file");
  });

  it("falls back without a request when the asset listing lacks the file", async () => {
    const { reg, load } = setup({ available: new Set(["models/bus.glb"]) });
    const car = await reg.get("player-car");
    expect(car.source).toBe("fallback");
    expect(car.model.kind).toBe("fallback");
    expect(car.reason).toMatch(/not in the asset listing/);
    expect((await reg.get("bus")).source).toBe("file");
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("models/bus.glb");
  });

  it("falls back when the file fails to load, and does not retry", async () => {
    const { reg, load } = setup({ fail: new Set(["models/robotaxi.glb"]) });
    const r1 = await reg.get("robotaxi");
    const r2 = await reg.get("robotaxi");
    expect(r1.source).toBe("fallback");
    expect(r1.reason).toMatch(/404/);
    expect(r1.model).not.toBe(r2.model);
    expect(load).toHaveBeenCalledTimes(1);
    expect(reg.status("robotaxi")).toBe("fallback");
  });

  it("falls back for keys nobody registered", async () => {
    const { reg, load } = setup();
    const r = await reg.get("hoverboard");
    expect(r.source).toBe("fallback");
    expect(r.model.key).toBe("hoverboard");
    expect(load).not.toHaveBeenCalled();
  });

  it("hands out a fallback immediately, then the file once it has loaded", async () => {
    const { reg } = setup();
    expect(reg.status("robot")).toBe("unknown");
    expect(reg.now("robot").source).toBe("fallback");
    const p = reg.get("robot");
    expect(reg.status("robot")).toBe("loading");
    await p;
    expect(reg.now("robot").source).toBe("file");
  });

  it("re-registering a key with a new URL forgets the old result", async () => {
    const { reg, load } = setup({ fail: new Set(["models/a.glb"]) });
    reg.register("landmark:x", "models/a.glb");
    expect((await reg.get("landmark:x")).source).toBe("fallback");
    reg.register("landmark:x", "models/b.glb");
    expect((await reg.get("landmark:x")).source).toBe("file");
    expect(load).toHaveBeenLastCalledWith("models/b.glb");
  });
});
