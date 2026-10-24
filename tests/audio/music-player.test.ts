// Music consistency: the real MusicPlayer and MusicContextTracker under a fake clock, fake Web
// Audio gains (scheduled ramps evaluated in time) and fake streams that take a random while to
// start. Rapid, random context changes must give at most one switch per MIN_DWELL_MS, and while
// music is enabled the audible level must never drop out for longer than MAX_GAP_MS.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CROSSFADE_S, MIN_DWELL_MS, MusicContextTracker, MusicPlayer, type MusicElement, type MusicSignals, type MusicTrack } from "../../src/audio/music.ts";

/** Longest tolerated drop below AUDIBLE while a track is wanted. */
const MAX_GAP_MS = 150;
const AUDIBLE = 0.5;

let nowMs = 0;

/** An AudioParam that evaluates setValueAtTime / linearRampToValueAtTime / cancelScheduledValues. */
class FakeParam {
  private events: Array<{ t: number; v: number; ramp: boolean }> = [];
  private initial: number;
  constructor(v: number) { this.initial = v; }
  get value(): number { return this.at(nowMs / 1000); }
  set value(v: number) { this.initial = v; this.events = []; }
  at(t: number): number {
    let v = this.initial, tPrev = 0;
    for (const e of this.events) {
      if (e.t > t) {
        if (e.ramp) return v + (e.v - v) * Math.min(1, Math.max(0, (t - tPrev) / Math.max(1e-9, e.t - tPrev)));
        return v;
      }
      v = e.v;
      tPrev = e.t;
    }
    return v;
  }
  setValueAtTime(v: number, t: number): void { this.insert({ t, v, ramp: false }); }
  linearRampToValueAtTime(v: number, t: number): void { this.insert({ t, v, ramp: true }); }
  cancelScheduledValues(t: number): void {
    const keep = this.at(t);
    this.events = this.events.filter((e) => e.t < t);
    if (this.events.length === 0) this.initial = keep;
  }
  setTargetAtTime(v: number, t: number): void { this.insert({ t, v, ramp: false }); }
  private insert(e: { t: number; v: number; ramp: boolean }): void {
    this.events.push(e);
    this.events.sort((a, b) => a.t - b.t);
  }
}

interface FakeGain { gain: FakeParam; connect(): void; disconnect(): void }
const fakeCtx = () => ({
  get currentTime() { return nowMs / 1000; },
  createGain(): FakeGain { return { gain: new FakeParam(1), connect() {}, disconnect() {} }; },
}) as unknown as AudioContext;

/** A streamed <audio>: starts playing a random latency after play(), loops, keeps its position. */
class FakeElement implements MusicElement {
  src = "";
  currentTime = 0;
  readonly duration = 120;
  loop = true;
  preload = "none";
  crossOrigin: string | null = null;
  private playingSince: number | null = null;
  private startAt: number | null = null;
  private readonly listeners = new Map<string, Array<{ fn: () => void; once: boolean }>>();
  private readonly latency: () => number;
  constructor(latency: () => number) { this.latency = latency; }
  get paused(): boolean { return this.playingSince === null; }
  get audible(): boolean { return this.playingSince !== null; }
  play(): Promise<void> {
    if (this.playingSince === null && this.startAt === null) this.startAt = nowMs + this.latency();
    return Promise.resolve();
  }
  pause(): void { this.playingSince = null; this.startAt = null; }
  load(): void {}
  removeAttribute(): void { this.src = ""; }
  canPlayType(): string { return "probably"; }
  addEventListener(type: string, fn: () => void, options?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once: !!options?.once });
    this.listeners.set(type, list);
  }
  advance(): void {
    if (this.startAt !== null && nowMs >= this.startAt) {
      this.startAt = null;
      this.playingSince = nowMs;
      this.emit("playing");
    }
  }
  emit(type: string): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((l) => !l.once));
    for (const l of list) l.fn();
  }
}

const TRACKS: MusicTrack[] = (["drive", "foot", "mission", "combat", "menu"] as const).map((id, i) => ({
  id, context: (["driving", "foot", "mission", "combat", "menu"] as const)[i]!, title: id, author: "a", licence: "CC0 1.0",
  files: { ogg: `audio/music/${id}.ogg`, mp3: `audio/music/${id}.mp3` }, durationS: 60,
}));
const TRACK_FOR: Record<string, string> = { driving: "drive", foot: "foot", mission: "mission", combat: "combat" };

/** A seeded PRNG (mulberry32), so every run sees the same "random" play session. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(seed: number, maxLatencyMs: number, latency?: () => number) {
  const random = rng(seed);
  const elements: FakeElement[] = [];
  const gains: FakeGain[] = [];
  const player = new MusicPlayer(fakeCtx(), { connect() {} } as unknown as AudioNode, TRACKS, {
    createElement: () => { const e = new FakeElement(latency ?? (() => random() * maxLatencyMs)); elements.push(e); return e; },
    connect: (_e, g) => { gains.push(g as unknown as FakeGain); },
    now: () => nowMs,
  });
  // gains[0..1] are the decks (in element order); the duck gain is created first, separately.
  const level = (): number => elements.reduce((sum, e, i) => sum + (e.audible ? gains[i]!.gain.value : 0), 0);
  const step = (ms: number): void => {
    nowMs += ms;
    vi.advanceTimersByTime(ms);
    for (const e of elements) e.advance();
    player.tick();
  };
  return { player, level, step, random };
}

beforeEach(() => { vi.useFakeTimers(); nowMs = 0; });
afterEach(() => { vi.useRealTimers(); });

describe("music consistency", () => {
  it("rapid random context changes: at most one switch per MIN_DWELL_MS, and no audible gap", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { player, level, step, random } = setup(seed, 2500);
      const tracker = new MusicContextTracker();
      player.setEnabled(true);
      let signals: MusicSignals = { menu: false, onFoot: true, missionUrgent: false, combat: false };
      let current = "";
      const switches: number[] = [];
      let quietSince: number | null = null, worstGap = 0, started = false;
      for (let t = 0; t < 10 * 60_000; t += 10) {
        // Flip a random signal every ~300 ms on average: far faster than any real play.
        if (random() < 0.033) {
          const k = Math.floor(random() * 4);
          signals = { ...signals, ...(k === 0 ? { menu: !signals.menu } : k === 1 ? { onFoot: !signals.onFoot } : k === 2 ? { missionUrgent: !signals.missionUrgent } : { combat: random() < 0.5 }) };
        }
        const context = tracker.update(signals, nowMs);
        const want = TRACK_FOR[context]!;
        if (want !== current) {
          switches.push(nowMs);
          current = want;
        }
        player.play(want);
        step(10);
        const l = level();
        if (l >= AUDIBLE) { started = true; quietSince = null; }
        else if (started) {
          quietSince ??= nowMs;
          worstGap = Math.max(worstGap, nowMs - quietSince);
        }
      }
      expect(switches.length, `seed ${seed}: some switching happened`).toBeGreaterThan(10);
      for (let i = 2; i < switches.length; i++) expect(switches[i]! - switches[i - 1]!, `seed ${seed}: switch ${i}`).toBeGreaterThanOrEqual(MIN_DWELL_MS);
      expect(worstGap, `seed ${seed}: longest drop below ${AUDIBLE}`).toBeLessThanOrEqual(MAX_GAP_MS);
    }
  });

  it("menus and dialogs never switch the track", () => {
    const tracker = new MusicContextTracker();
    let t = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++, t += 50) seen.add(tracker.update({ menu: i % 7 < 3, onFoot: true, missionUrgent: false, combat: false }, t));
    expect([...seen]).toEqual(["foot"]);
  });

  it("a slow stream: the old track plays on at full until the new one starts, then crossfades", () => {
    // The first stream starts at once; the second takes 2.5 s to start.
    const latencies = [0, 2500];
    const { player, level, step } = setup(9, 0, () => latencies.shift() ?? 0);
    player.setEnabled(true);
    player.play("foot");
    for (let i = 0; i < 400; i++) step(10);
    expect(level()).toBeCloseTo(1, 2);
    player.play("combat");
    let min = 1;
    const decks = (player as unknown as { decks: Array<{ element: FakeElement; track: MusicTrack | null }> }).decks;
    for (let i = 0; i < 240; i++) { step(10); min = Math.min(min, level()); }
    // Still buffering: the old track is still the one heard, at full.
    expect(decks.find((d) => d.track?.id === "foot")!.element.audible).toBe(true);
    for (let i = 0; i < 600; i++) { step(10); min = Math.min(min, level()); }
    expect(min).toBeGreaterThanOrEqual(0.99); // equal-sum linear crossfade: it never dips
    expect(decks.find((d) => d.track?.id === "foot")!.element.audible).toBe(false); // faded, then stopped streaming
    expect(CROSSFADE_S).toBeGreaterThanOrEqual(2);
  });

  it("resumes a track where it left off when its context comes back", () => {
    const { player, step } = setup(11, 0);
    player.setEnabled(true);
    player.play("foot");
    for (let i = 0; i < 100; i++) step(10);
    const decks = (player as unknown as { decks: Array<{ element: FakeElement; track: MusicTrack | null }> }).decks;
    decks[0]!.element.currentTime = 42;
    player.play("combat");
    for (let i = 0; i < 500; i++) step(10);
    player.play("mission"); // reloads deck 0, saving "foot" at 42 s
    for (let i = 0; i < 500; i++) step(10);
    player.play("foot");
    const deck = decks.find((d) => d.track?.id === "foot")!;
    // The resume seek runs on loadedmetadata.
    deck.element.emit("loadedmetadata");
    expect(deck.element.currentTime).toBe(42);
  });

  it("restarts a stream the browser paused (watchdog)", () => {
    const { player, step, level } = setup(12, 0);
    player.setEnabled(true);
    player.play("drive");
    for (let i = 0; i < 400; i++) step(10);
    const decks = (player as unknown as { decks: Array<{ element: FakeElement }> }).decks;
    decks.find((d) => d.element.audible)!.element.pause();
    expect(level()).toBe(0);
    for (let i = 0; i < 300; i++) step(10);
    expect(level()).toBeCloseTo(1, 2);
  });
});
