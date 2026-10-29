import { describe, expect, it } from "vitest";
import { Action } from "../../src/sim/contract.ts";
import { coitViewerInput } from "../../src/ui/coit-viewer.ts";
import { COIT_GUIDE_LINES } from "../../src/content/coit-guide.ts";
import { COIT_VIEW } from "../../src/sim/activities/coit-viewer.ts";

describe("Coit input and subtitle contract", () => {
  it("leaves ordinary play unchanged outside the viewer and records only bounded aim while active", () => {
    const input = { throttle: 1, steer: 1, brake: 0, actions: Action.fire | Action.enterExit };
    expect(coitViewerInput(input, null)).toBe(input);
    expect(coitViewerInput(input, { yaw: 0, pitch: 99 })).toEqual({ throttle: 0, steer: 0, brake: 1, actions: 0, aimYaw: COIT_VIEW.yawMin, aimPitch: COIT_VIEW.pitchMax });
    expect(input.actions).toBe(Action.fire | Action.enterExit);
  });
  it("has a complete original caption script for every static guide voice ID without audio assets", () => {
    expect(new Set(COIT_GUIDE_LINES.map(line => line.id)).size).toBe(7);
    expect(COIT_GUIDE_LINES.every(line => line.text && line.speaker === "coit-guide")).toBe(true);
    expect(COIT_GUIDE_LINES.filter(line => line.id.startsWith("coit:correct:")).every(line => line.text.startsWith("You're absolutely right!"))).toBe(true);
  });
});
