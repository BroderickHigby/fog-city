import { describe, expect, it } from "vitest";
import { replayPolicyTrace } from "./replay-fixture.ts";

describe("lane-3 policy replay fixture", () => {
  it("reproduces thirty per-second state hashes across brain, reaction and fidelity transitions", () => {
    const first = replayPolicyTrace();
    expect(first).toHaveLength(30);
    expect(new Set(first).size).toBeGreaterThan(20);
    expect(replayPolicyTrace()).toEqual(first);
  });
});
