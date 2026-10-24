// Preferences, bus gains and ducking, music context, and which effects a sim frame asks for.
import { describe, expect, it } from "vitest";
import { AudioPrefsStore, AUDIO_PREFS_KEY, DEFAULT_AUDIO_PREFS, loadAudioPrefs, sanitizeAudioPrefs } from "../../src/audio/prefs.ts";
import { MUSIC_DUCK, audible, busGain, masterGain, sliderGain } from "../../src/audio/buses.ts";
import { COMBAT_HOLD_MS, MIN_DWELL_MS, MusicContextTracker, SETTLE_MS, desiredContext, musicUrl, type MusicSignals } from "../../src/audio/music.ts";
import { EffectCueTracker, JINGLE_INTERVAL_MS, SPLASH_PER_S, distanceGain, panOf, type HummingActor } from "../../src/audio/cues.ts";
import { effectUrl } from "../../src/audio/mixer.ts";
import { DEFAULT_STATION, RADIO_STATIONS, stationById, tune } from "../../src/audio/radio.ts";
import { ROBOTAXI_HORN_COOLDOWN_MS, type HonkingAgent } from "../../src/audio/cues.ts";
import type { CombatEvent, CombatState, Projectile } from "../../src/sim/combat-contract.ts";

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, map };
}

describe("audio preferences", () => {
  it("clamps and repairs anything it reads", () => {
    expect(sanitizeAudioPrefs(undefined)).toEqual(DEFAULT_AUDIO_PREFS);
    expect(sanitizeAudioPrefs({ master: 3, music: -1, voice: Number.NaN, effects: "loud", musicMuted: "yes", subtitles: false, extra: 1 }))
      .toEqual({ ...DEFAULT_AUDIO_PREFS, master: 1, music: 0, subtitles: false });
    expect(sanitizeAudioPrefs({ station: "pivot" }).station).toBe("pivot");
    expect(sanitizeAudioPrefs({ station: "no-such-station" }).station).toBe(DEFAULT_STATION);
  });

  it("persists every change and loads it back; a corrupt or blocked store gives the defaults", () => {
    const storage = memoryStorage();
    const store = new AudioPrefsStore(storage);
    const seen: number[] = [];
    store.subscribe((p) => seen.push(p.music));
    store.set({ music: 0.25, voiceMuted: true });
    expect(seen).toEqual([0.25]);
    expect(new AudioPrefsStore(storage).get()).toMatchObject({ music: 0.25, voiceMuted: true });
    storage.map.set(AUDIO_PREFS_KEY, "{not json");
    expect(loadAudioPrefs(storage)).toEqual(DEFAULT_AUDIO_PREFS);
    const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
    const blocked = new AudioPrefsStore(throwing);
    expect(blocked.set({ effects: 0.1 }).effects).toBe(0.1);
    expect(new AudioPrefsStore(null).get()).toEqual(DEFAULT_AUDIO_PREFS);
  });
});

describe("bus gains", () => {
  const prefs = { ...DEFAULT_AUDIO_PREFS, music: 0.5, effects: 1, voice: 1 };

  it("tapers sliders, mutes each bus and the master on its own", () => {
    expect(sliderGain(0)).toBe(0);
    expect(sliderGain(1)).toBe(1);
    expect(sliderGain(0.5)).toBeCloseTo(0.25);
    expect(busGain(prefs, "music", false)).toBeCloseTo(0.25);
    expect(busGain({ ...prefs, musicMuted: true }, "music", false)).toBe(0);
    expect(busGain({ ...prefs, musicMuted: true }, "effects", false)).toBe(1);
    expect(masterGain({ ...prefs, masterMuted: true })).toBe(0);
    expect(audible({ ...prefs, masterMuted: true }, "voice")).toBe(false);
    expect(audible({ ...prefs, voice: 0 }, "voice")).toBe(false);
    expect(audible(prefs, "voice")).toBe(true);
  });

  it("ducks music and effects, never the voice, while a line plays", () => {
    expect(busGain(prefs, "music", true)).toBeCloseTo(0.25 * MUSIC_DUCK);
    expect(busGain(prefs, "effects", true)).toBeLessThan(1);
    expect(busGain(prefs, "voice", true)).toBe(1);
  });
});

describe("music context", () => {
  const sig = (s: Partial<MusicSignals> = {}): MusicSignals => ({ menu: false, onFoot: false, missionUrgent: false, combat: false, ...s });

  it("the car radio > combat > urgent mission > on foot; menus are not a context", () => {
    expect(desiredContext(sig(), false)).toBe("driving");
    // In a car the radio plays whatever is going on.
    expect(desiredContext(sig({ missionUrgent: true, combat: true }), true)).toBe("driving");
    expect(desiredContext(sig({ onFoot: true }), false)).toBe("foot");
    expect(desiredContext(sig({ onFoot: true, missionUrgent: true }), false)).toBe("mission");
    expect(desiredContext(sig({ onFoot: true, missionUrgent: true, combat: true }), false)).toBe("combat");
    expect(desiredContext(sig({ onFoot: true, missionUrgent: true }), true)).toBe("combat");
    expect(desiredContext(sig({ onFoot: true, combat: true, menu: true }), true)).toBe("combat");
  });

  it("tunes the radio round the dial, Off included, and every station plays a shipped track", () => {
    expect(stationById(undefined).id).toBe(DEFAULT_STATION);
    expect(tune("runway", 1).id).toBe("series-a");
    expect(tune("runway", -1).id).toBe("off");
    expect(tune("off", 1).id).toBe("runway");
    let id = DEFAULT_STATION;
    for (let i = 0; i < RADIO_STATIONS.length; i++) id = tune(id, 1).id;
    expect(id).toBe(DEFAULT_STATION);
    expect(stationById("off").trackId).toBeNull();
    // Invented call signs only: no real station names.
    for (const s of RADIO_STATIONS) expect(s.name).not.toMatch(/\bK[A-Z]{2,3}\b|KFOG|KQED|KALW|Alice|Live 105/);
  });

  it("settles, keeps a minimum dwell between switches, ignores menus and holds combat", () => {
    const t = new MusicContextTracker();
    expect(t.update(sig(), 0)).toBe("driving");
    expect(t.update(sig({ onFoot: true }), 100)).toBe("driving");
    expect(t.update(sig(), 200)).toBe("driving"); // back in the car: no flap
    expect(t.update(sig({ onFoot: true }), 300)).toBe("driving");
    expect(t.update(sig({ onFoot: true }), 300 + SETTLE_MS)).toBe("driving"); // settled, but inside the dwell
    expect(t.update(sig({ onFoot: true }), MIN_DWELL_MS)).toBe("foot");
    const t0 = MIN_DWELL_MS;
    expect(t.update(sig({ onFoot: true, menu: true }), t0 + 100)).toBe("foot"); // menus duck, never switch
    // Combat wants in at once, but waits out the dwell.
    expect(t.update(sig({ onFoot: true, combat: true }), t0 + 1000)).toBe("foot");
    expect(t.update(sig({ onFoot: true, combat: true }), t0 + MIN_DWELL_MS)).toBe("combat");
    const c = t0 + MIN_DWELL_MS;
    expect(t.update(sig({ onFoot: true }), c + COMBAT_HOLD_MS - 1)).toBe("combat");
    expect(t.update(sig({ onFoot: true }), c + COMBAT_HOLD_MS + 1)).toBe("combat"); // settling
    expect(t.update(sig({ onFoot: true }), c + COMBAT_HOLD_MS + 1 + SETTLE_MS)).toBe("foot");
  });

  it("streams Ogg Opus where supported, else the MP3", () => {
    const track = { id: "drive", context: "driving" as const, title: "", author: "", licence: "", durationS: 1, files: { ogg: "audio/music/drive.ogg", mp3: "audio/music/drive.mp3" } };
    expect(musicUrl(track, () => "probably")).toBe("audio/music/drive.ogg");
    expect(musicUrl(track, () => "")).toBe("audio/music/drive.mp3");
    expect(effectUrl("splash", () => "maybe")).toBe("audio/splash.ogg");
    expect(effectUrl("splash", () => "")).toBe("audio/splash.mp3");
  });
});

describe("effect cues", () => {
  const listener = { x: 0, z: 0, heading: 0 };
  let nextEvent = 1;
  const event = (kind: string, extra: Partial<CombatEvent> = {}): CombatEvent => ({ id: nextEvent++, tick: 1, kind, sourceId: "p1", targetId: "", amount: 0, detail: "", ...extra });
  const water = (id: number, x: number, z: number): Projectile => ({ id, kind: "water", ownerId: "p1", x, y: 1, z, vx: 0, vy: 0, vz: 0, distance: 0, range: 10, bornTick: 1, volume: 0.1, salt: false, vehicle: false } as Projectile);
  const combat = (projectiles: Projectile[], events: CombatEvent[], targets: CombatState["targets"] = {}): CombatState =>
    ({ version: 1, tick: 1, projectiles, events, targets, players: {}, gadgets: [], attacks: [], attackSequence: {}, nextId: 1, pauseUntil: 0 } as unknown as CombatState);

  it("splashes where a water projectile lands, at most a few per second, quieter far away", () => {
    const t = new EffectCueTracker();
    const drops = Array.from({ length: 8 }, (_, i) => water(100 + i, 30, 0));
    expect(t.update(combat(drops, []), listener, [], 0, false)).toEqual([]);
    const ended = drops.map((p) => event("projectile.ended", { amount: p.id, detail: "ground" }));
    const cues = t.update(combat([], ended), listener, [], 10, false);
    expect(cues).toHaveLength(SPLASH_PER_S);
    expect(cues[0]!.sound).toBe("splash");
    expect(cues[0]!.gain).toBeGreaterThan(0);
    expect(cues[0]!.gain).toBeLessThan(1);
    expect(cues[0]!.pan).toBeGreaterThan(0); // east of a listener facing north: right
    // Only once per event.
    expect(t.update(combat([], ended), listener, [], 20, false)).toEqual([]);
  });

  it("does not splash for a drop that ran out of range or was never water", () => {
    const t = new EffectCueTracker();
    t.update(combat([water(1, 1, 1), { ...water(2, 1, 1), kind: "flower" }], []), listener, [], 0, false);
    expect(t.update(combat([], [event("projectile.ended", { amount: 1, detail: "range" }), event("projectile.ended", { amount: 2, detail: "actor" })]), listener, [], 1, false)).toEqual([]);
  });

  it("creaks on a seize and fizzes once from slump to heap", () => {
    const t = new EffectCueTracker();
    const robot: HummingActor = { id: "r1", x: 0, z: -20, retired: false, tellIds: [], hiddenTellId: null };
    const cues = t.update(combat([], [event("robot.seized", { targetId: "r1" }), event("robot.slumping", { targetId: "r1" }), event("robot.heap", { targetId: "r1" })]), listener, [robot], 0, false);
    expect(cues.map((c) => c.sound)).toEqual(["rust-creak", "melt-fizz"]);
    expect(Math.abs(cues[0]!.pan)).toBeLessThan(0.01); // straight ahead
  });

  it("consumes events while paused, so nothing plays late on resume", () => {
    const t = new EffectCueTracker();
    const seized = event("robot.seized", { targetId: "r9" });
    expect(t.update(combat([], [seized]), listener, [], 0, true)).toEqual([]);
    expect(t.update(combat([], [seized]), listener, [], 1, false)).toEqual([]);
  });

  it("a bad robot showing the jingle tell hums it nearby every 25 s; hidden, far, rusted or retired ones do not", () => {
    const t = new EffectCueTracker();
    const hummer: HummingActor = { id: "bad-1", x: 5, z: 0, retired: false, tellIds: ["humJingle"], hiddenTellId: null };
    const others: HummingActor[] = [
      { ...hummer, id: "hidden", hiddenTellId: "humJingle" },
      { ...hummer, id: "far", x: 40 },
      { ...hummer, id: "gone", retired: true },
      { ...hummer, id: "good", tellIds: ["holdDoor"] },
      { ...hummer, id: "rusted" },
    ];
    const state = combat([], [], { rusted: { phase: "seized" } as CombatState["targets"][string] });
    const hums: number[] = [];
    for (let ms = 0; ms <= 80_000; ms += 250) for (const c of t.update(state, listener, [hummer, ...others], ms, false)) { expect(c.sound).toBe("moat-jingle"); hums.push(ms); }
    expect(hums.length).toBeGreaterThanOrEqual(3);
    expect(hums[0]).toBeLessThan(10_000);
    for (let i = 1; i < hums.length; i++) expect(hums[i]! - hums[i - 1]!).toBeGreaterThanOrEqual(JINGLE_INTERVAL_MS);
  });

  it("a robotaxi honking chirps once per few seconds, quieter far away, and never while paused", () => {
    const t = new EffectCueTracker();
    const taxi = (mode: string, x = 0, z = -20): HonkingAgent => ({ id: 7, kind: "robotaxi", mode, x, z });
    const walker: HonkingAgent = { id: 8, kind: "person", mode: "honk", x: 0, z: -5 };
    expect(t.update(undefined, listener, [], 0, false, [taxi("go"), walker])).toEqual([]);
    const first = t.update(undefined, listener, [], 100, false, [taxi("honk")]);
    expect(first.map((c) => c.sound)).toEqual(["robotaxi-horn"]);
    expect(first[0]!.gain).toBeGreaterThan(0);
    expect(t.update(undefined, listener, [], 200, false, [taxi("honk")])).toEqual([]);
    expect(t.update(undefined, listener, [], 100 + ROBOTAXI_HORN_COOLDOWN_MS, false, [taxi("honk")])).toHaveLength(1);
    expect(t.update(undefined, listener, [], 20_000, false, [taxi("honk", 0, -500)])).toEqual([]); // out of earshot
    const p = new EffectCueTracker();
    expect(p.update(undefined, listener, [], 0, true, [taxi("honk")])).toEqual([]);
  });

  it("distance and pan helpers", () => {
    expect(distanceGain(0, 5, 10)).toBe(1);
    expect(distanceGain(7.5, 5, 10)).toBeCloseTo(0.5);
    expect(distanceGain(20, 5, 10)).toBe(0);
    expect(panOf({ x: 0, z: 0, heading: 0 }, -10, 0)).toBeLessThan(0); // west: left
    expect(panOf({ x: 0, z: 0, heading: Math.PI / 2 }, 0, 10)).toBeGreaterThan(0); // facing east, south is right
  });
});
