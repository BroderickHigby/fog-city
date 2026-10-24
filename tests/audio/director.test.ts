// Spatial audio and the inner voice follow the body the player occupies, including rides.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGameAudioDirector } from "../../src/audio/index.ts";
import { EffectCueTracker } from "../../src/audio/cues.ts";
import { hornBlasts } from "../../src/audio/horn.ts";
import { Action } from "../../src/sim/contract.ts";
import { InnerVoice } from "../../src/audio/inner-voice.ts";
import { GameAudio } from "../../src/audio/mixer.ts";
import { AudioPrefsStore } from "../../src/audio/prefs.ts";
import { MISSIONS } from "../../src/content/catalog.ts";
import { SIM_VERSION, type SimState } from "../../src/sim/contract.ts";
import saved10 from "../golden/legacy-saves/v10-gameplay.json";

vi.mock("../../src/ui/subtitles.ts", () => ({
  mountSubtitles: () => ({ element: { hidden: true }, update() {}, dispose() {} }),
}));
vi.mock("../../src/ui/radio-toast.ts", () => ({
  mountRadioToast: () => ({ show() {}, update() {}, dispose() {} }),
}));

afterEach(() => vi.restoreAllMocks());

describe("audio director occupied body", () => {
  it("hears horns and places inner-voice observations at the taxi while the own car stays parked", () => {
    const state = JSON.parse(JSON.stringify(saved10.state)) as SimState;
    state.version = SIM_VERSION;
    const player = state.players.p!;
    player.mode = "vehicle";
    player.foot = null;
    player.car = { ...player.car, x: -2000, z: 3000, heading: 0 };
    player.ride = { agentId: 7, x: 100, y: 0, z: 200, heading: Math.PI / 2, speed: 4, goal: { x: 400, z: 200 }, exitPending: false };
    const cues = vi.spyOn(EffectCueTracker.prototype, "update").mockReturnValue([]);
    const inner = vi.spyOn(InnerVoice.prototype, "observe").mockReturnValue(null);
    const horn = vi.spyOn(GameAudio.prototype, "playHorn").mockImplementation(() => {});
    const director = createGameAudioDirector({ host: {} as HTMLElement, missions: MISSIONS, prefs: new AudioPrefsStore(null) });
    try {
      director.update({ state, playerId: "p", paused: false, nowMs: 0 });
      expect(cues.mock.calls[0]?.[1]).toEqual({ x: 100, z: 200, heading: Math.PI / 2 });
      expect(inner.mock.calls[0]?.[0].player).toEqual({ x: 100, z: 200 });
      // This blast is near the ridden taxi and thousands of metres from the parked car.
      director.playHorn({ playerId: "other", x: 105, z: 200, inVehicle: true });
      expect(horn.mock.calls[0]?.[0]).toBeGreaterThan(0);
      expect(horn.mock.calls[0]?.[1]).toBeCloseTo(0, 5);
      expect(hornBlasts({ p: { throttle: 0, steer: 0, brake: 0, actions: Action.horn } }, state)).toEqual([{ playerId: "p", x: 100, z: 200, inVehicle: true }]);
      expect(player.car).toMatchObject({ x: -2000, z: 3000 });
    } finally {
      director.dispose();
    }
  });

  it("while riding, the engine follows the taxi and the parked car's hits stay silent", () => {
    const state = JSON.parse(JSON.stringify(saved10.state)) as SimState;
    state.version = SIM_VERSION;
    const player = state.players.p!;
    player.mode = "vehicle";
    player.foot = null;
    player.car = { ...player.car, x: -2000, z: 3000, heading: 0, speed: 0, hits: 0 };
    player.ride = { agentId: 7, x: 100, y: 0, z: 200, heading: Math.PI / 2, speed: 12, goal: null, exitPending: false };
    const engine = vi.spyOn(GameAudio.prototype, "setEngine");
    const play = vi.spyOn(GameAudio.prototype, "play").mockImplementation(() => {});
    const director = createGameAudioDirector({ host: {} as HTMLElement, missions: MISSIONS, prefs: new AudioPrefsStore(null) });
    try {
      director.update({ state, playerId: "p", paused: false, nowMs: 0 });
      // Something bumps the parked car while its owner rides elsewhere.
      player.car = { ...player.car, hits: 1, impactSpeed: 9 };
      director.update({ state, playerId: "p", paused: false, nowMs: 16 });
      const last = engine.mock.calls.at(-1)?.[0];
      expect(last).not.toBeNull();
      expect(last!.whineHz).toBeGreaterThan(300);
      expect(last!.squealGain).toBe(0);
      expect(play.mock.calls.some(([cue]) => cue.sound === "impact")).toBe(false);
    } finally {
      director.dispose();
    }
  });
});
