// Robots and UI sounds: the nearest robots whirr and beep the same whatever their firmware; a bad
// robot is audible only through its designed audio tells; firmware-only combat events never
// drive the music; the heap lands with a clatter; every synth cue is defined.
import { describe, expect, it } from "vitest";
import { MAX_ROBOT_VOICES, PAIRING_INTERVAL_MS, ROBOT_VOICES, RobotChirpClock, robotWhirrs, type SoundingActor } from "../../src/audio/robot-sound.ts";
import { SYNTH_CUES, beepTones } from "../../src/audio/synth-sfx.ts";
import { FIGHT_EVENTS } from "../../src/audio/index.ts";
import { EffectCueTracker } from "../../src/audio/cues.ts";
import type { CombatState } from "../../src/sim/combat-contract.ts";
import { readJson } from "../helpers.ts";

const listener = { x: 0, z: 0, heading: 0 };
const bot = (id: string, o: Partial<SoundingActor> = {}): SoundingActor => ({ id, model: "footman", x: 5, z: 0, speed: 1, retired: false, tellIds: [], hiddenTellId: null, ...o });
const none = (): boolean => false;

describe("robot whirrs", () => {
  it("voice the nearest robots only, louder and higher when moving, silent when out of action", () => {
    const bots = Array.from({ length: 8 }, (_, i) => bot(`b${i}`, { x: 2 + i * 2 }));
    const w = robotWhirrs(bots, listener, none);
    expect(w.map((x) => x.id)).toEqual(["b0", "b1", "b2"]);
    expect(w).toHaveLength(MAX_ROBOT_VOICES);
    const still = robotWhirrs([bot("s", { speed: 0 })], listener, none)[0]!;
    const moving = robotWhirrs([bot("s", { speed: 1.5 })], listener, none)[0]!;
    expect(moving.gain).toBeGreaterThan(still.gain);
    expect(moving.hz).toBeGreaterThan(still.hz);
    expect(robotWhirrs([bot("s")], listener, (id) => id === "s")).toEqual([]);
    expect(robotWhirrs([bot("far", { x: 100 })], listener, none)).toEqual([]);
    expect(robotWhirrs([bot("p", { model: "person" }), bot("t", { model: "robotaxi" })], listener, none)).toEqual([]);
  });

  it("sound identical for a good and a bad robot of the same model (no firmware leak)", () => {
    // SoundingActor has no firmware field at all; extra fields on a runtime actor change nothing.
    const good = { ...bot("x"), firmware: "good" } as SoundingActor;
    const bad = { ...bot("x"), firmware: "bad" } as SoundingActor;
    expect(robotWhirrs([good], listener, none)).toEqual(robotWhirrs([bad], listener, none));
    const a = new RobotChirpClock(), b = new RobotChirpClock();
    for (let t = 0; t < 60_000; t += 100) expect(a.update([good], listener, none, t)).toEqual(b.update([bad], listener, none, t));
  });

  it("every voiced model has a beep pattern, and models sound different", () => {
    const models = Object.keys(ROBOT_VOICES);
    expect(models.length).toBeGreaterThanOrEqual(5);
    expect(new Set(models.map((m) => ROBOT_VOICES[m]!.servoHz)).size).toBe(models.length);
    for (const m of models) expect(beepTones(ROBOT_VOICES[m]!.beeps).length).toBeGreaterThan(0);
  });
});

describe("robot chirps", () => {
  it("each robot beeps on its own fixed rhythm while near", () => {
    const clock = new RobotChirpClock();
    const beeps: Record<string, number[]> = { a: [], b: [] };
    for (let t = 0; t < 120_000; t += 50)
      for (const c of clock.update([bot("a"), bot("b", { x: -6 })], listener, none, t)) if (c.kind === "beep") beeps[c.id]!.push(t);
    for (const id of ["a", "b"]) {
      expect(beeps[id]!.length, id).toBeGreaterThanOrEqual(6);
      const gaps = beeps[id]!.slice(1).map((t, i) => t - beeps[id]![i]!);
      expect(Math.max(...gaps) - Math.min(...gaps), id).toBeLessThanOrEqual(50);
      expect(gaps[0]!).toBeGreaterThanOrEqual(7000);
      expect(gaps[0]!).toBeLessThan(16_050);
    }
  });

  it("the tryCarDoors tell chimes 'pairing...' every 20 s nearby, unless the tell is hidden", () => {
    const tells = readJson<{ tells: Array<{ id: string; channel: string; behaviour: { intervalS?: number } }> }>("content/bot-tells.json").tells;
    expect(tells.find((t) => t.id === "tryCarDoors")).toMatchObject({ channel: "audio", behaviour: { intervalS: PAIRING_INTERVAL_MS / 1000 } });
    const run = (a: SoundingActor): number[] => {
      const clock = new RobotChirpClock(), out: number[] = [];
      for (let t = 0; t < 90_000; t += 100) for (const c of clock.update([a], listener, none, t)) if (c.kind === "pairing") out.push(t);
      return out;
    };
    const shows = run(bot("p", { tellIds: ["tryCarDoors"] }));
    expect(shows.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < shows.length; i++) expect(shows[i]! - shows[i - 1]!).toBe(PAIRING_INTERVAL_MS);
    expect(run(bot("p", { tellIds: ["tryCarDoors"], hiddenTellId: "tryCarDoors" }))).toEqual([]);
    expect(run(bot("p"))).toEqual([]);
    expect(run(bot("p", { tellIds: ["tryCarDoors"], x: 40 }))).toEqual([]);
  });
});

describe("fairness and events", () => {
  it("music never follows a firmware-only combat event", () => {
    for (const leak of ["robot.alert", "robot.wary", "robot.blinded", "robot.glance"]) expect(FIGHT_EVENTS.has(leak), leak).toBe(false);
    expect(FIGHT_EVENTS.has("robot.seized")).toBe(true);
  });

  it("a robot collapsing into a heap clatters as well as fizzing", () => {
    const t = new EffectCueTracker();
    const state = { version: 1, tick: 1, projectiles: [], events: [{ id: 1, tick: 1, kind: "robot.heap", sourceId: "p1", targetId: "r1", amount: 0, detail: "" }], targets: {} } as unknown as CombatState;
    const cues = t.update(state, listener, [{ id: "r1", x: 0, z: -5, retired: false, tellIds: [], hiddenTellId: null }], 0, false);
    expect(cues.map((c) => c.sound).sort()).toEqual(["impact", "melt-fizz"]);
    expect(cues.find((c) => c.sound === "impact")!.rate).toBeLessThan(1);
  });

  it("every UI and game cue is defined with audible, in-range tones", () => {
    for (const [name, tones] of Object.entries(SYNTH_CUES)) {
      expect(tones.length, name).toBeGreaterThan(0);
      for (const t of tones) {
        expect(t.hz, name).toBeGreaterThan(100);
        expect(t.hz, name).toBeLessThan(8000);
        expect(t.dur, name).toBeGreaterThan(0.01);
      }
    }
  });
});
