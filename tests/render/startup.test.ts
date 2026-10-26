import { describe, expect, it } from "vitest";
import { prepareStartingStreets } from "../../src/render/startup.ts";

describe("starting street presentation", () => {
  it("does not finish while the starting surface is missing, then renders it before release", async () => {
    let ready = false, clock = 0, renders = 0, done = false;
    const waits: Array<() => void> = [];
    const boot = prepareStartingStreets({
      render: () => { renders++; }, ready: () => ready,
      now: () => clock, nextFrame: () => new Promise<void>(resolve => waits.push(resolve)),
    }).then(() => { done = true; });
    expect(renders).toBe(1); expect(done).toBe(false);
    clock++; waits.shift()!(); await Promise.resolve();
    expect(renders).toBe(2); expect(done).toBe(false);
    ready = true; clock++; waits.shift()!(); await Promise.resolve();
    expect(done).toBe(false); // One frame alone cannot release the view.
    clock++; waits.shift()!(); await boot;
    expect(done).toBe(true); expect(renders).toBe(4);
  });

  it("requires consecutive rendered ready frames", async () => {
    const readiness = [true, false, true, true]; let renders = 0;
    await prepareStartingStreets({render: () => { renders++; }, ready: () => readiness.shift()!, nextFrame: async () => {}});
    expect(renders).toBe(4);
  });

  it("fails within its deadline instead of exposing an unfinished city", async () => {
    let now = 0;
    await expect(prepareStartingStreets({render: () => {}, ready: () => false,
      now: () => now, nextFrame: async () => { now += 10; }, timeoutMs: 30,
    })).rejects.toThrow("Starting streets did not finish loading");
    expect(now).toBe(30);
  });

  it("propagates renderer failures", async () => {
    await expect(prepareStartingStreets({render: () => { throw new Error("device lost"); }, ready: () => true})).rejects.toThrow("device lost");
  });
});
