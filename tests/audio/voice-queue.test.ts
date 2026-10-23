// The voice queue: priority, interruption, retry, reset, staleness and the subtitle fallback.
// A fake player stands in for <audio>; time is passed in.
import { describe, expect, it } from "vitest";
import { PRIORITY, VoiceQueue, type VoiceItem, type VoicePlayer, type VoicePriority, type VoiceQueueEvent } from "../../src/audio/voice-queue.ts";
import { subtitleCues } from "../../src/audio/voice-lines.ts";

interface Call {
  url: string;
  start(): void;
  end(): void;
  error(reason?: string): void;
  stopped: boolean;
}

function fakePlayer(): { player: VoicePlayer; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    player: {
      play(url, cb) {
        const call: Call = { url, start: cb.onStart, end: cb.onEnd, error: (r = "boom") => cb.onError(r), stopped: false };
        calls.push(call);
        return { stop: () => { call.stopped = true; } };
      },
    },
  };
}

const item = (id: string, opts: { priority?: VoicePriority; url?: string | null; durationS?: number; group?: string; text?: string } = {}): VoiceItem => {
  const text = opts.text ?? `line ${id}.`;
  const durationS = opts.durationS ?? 2;
  return { id, group: opts.group ?? "m:s:1", speaker: "cofounder", speakerName: "Your cofounder", text, url: opts.url === undefined ? `audio/voice/${id}.ogg` : opts.url, durationS, cues: subtitleCues(text, durationS), priority: opts.priority ?? PRIORITY.story };
};

function setup(canPlay = true, extra: Partial<ConstructorParameters<typeof VoiceQueue>[0]> = {}) {
  const fake = fakePlayer();
  const events: VoiceQueueEvent[] = [];
  let allowed = canPlay;
  const queue = new VoiceQueue({ player: fake.player, canPlay: () => allowed, onEvent: (e) => events.push(e), ...extra });
  return { queue, calls: fake.calls, events, allow: (v: boolean) => { allowed = v; } };
}

describe("voice queue", () => {
  it("plays a voiced line: subtitles follow the audio, it speaks (ducking) until it ends", () => {
    const { queue, calls } = setup();
    queue.enqueue(item("a"), 0);
    expect(calls).toHaveLength(1);
    expect(queue.subtitle()).toMatchObject({ lineId: "a", mode: "voice", required: false });
    expect(queue.speaking()).toBe(false); // requested, not yet audible
    calls[0]!.start();
    expect(queue.speaking()).toBe(true);
    queue.update(6_000); // longer than the estimate: the audio, not the estimate, ends it
    expect(queue.snapshot().current).toBe("a");
    calls[0]!.end();
    expect(queue.speaking()).toBe(false);
    queue.update(6_100);
    expect(queue.snapshot().current).toBe("a"); // the subtitle holds briefly
    queue.update(6_400);
    expect(queue.snapshot().current).toBeNull();
    expect(queue.subtitle()).toBeNull();
  });

  it("queues equal priorities in order and moves on as each ends", () => {
    const { queue, calls } = setup();
    queue.enqueue(item("a"), 0);
    queue.enqueue(item("b"), 0);
    queue.enqueue(item("c"), 0);
    expect(queue.snapshot()).toMatchObject({ current: "a", waiting: ["b", "c"] });
    calls[0]!.start();
    calls[0]!.end();
    queue.update(1000);
    expect(queue.snapshot()).toMatchObject({ current: "b", waiting: ["c"] });
    expect(calls.map((c) => c.url)).toEqual(["audio/voice/a.ogg", "audio/voice/b.ogg"]);
  });

  it("a higher priority interrupts the line playing; a lower one waits", () => {
    const { queue, calls, events } = setup();
    queue.enqueue(item("bark", { priority: PRIORITY.ambient }), 0);
    calls[0]!.start();
    queue.enqueue(item("story", { priority: PRIORITY.story }), 100);
    expect(calls[0]!.stopped).toBe(true);
    expect(queue.snapshot().current).toBe("story");
    expect(events).toContainEqual({ kind: "interrupted", id: "bark", by: "story" });
    queue.enqueue(item("bark2", { priority: PRIORITY.ambient }), 200);
    expect(queue.snapshot()).toMatchObject({ current: "story", waiting: ["bark2"] });
    // A late callback from the interrupted line changes nothing.
    calls[0]!.end();
    expect(queue.snapshot().current).toBe("story");
  });

  it("a line with no file shows its text for its estimated length, and never touches the player", () => {
    const { queue, calls } = setup();
    queue.enqueue(item("t", { url: null, durationS: 3 }), 0);
    expect(calls).toHaveLength(0);
    expect(queue.subtitle()).toMatchObject({ mode: "text" });
    expect(queue.speaking()).toBe(false);
    queue.update(2999);
    expect(queue.snapshot().current).toBe("t");
    queue.update(3000);
    expect(queue.snapshot().current).toBeNull();
  });

  it("locked or muted audio (canPlay false) falls back to text", () => {
    const { queue, calls } = setup(false);
    queue.enqueue(item("a"), 0);
    expect(calls).toHaveLength(0);
    expect(queue.subtitle()?.mode).toBe("text");
  });

  it("retries a failed start once, then plays", () => {
    const { queue, calls, events } = setup();
    queue.enqueue(item("a"), 0);
    calls[0]!.error("network");
    expect(calls).toHaveLength(2);
    expect(events).toContainEqual({ kind: "retry", id: "a", attempt: 2, reason: "network" });
    calls[1]!.start();
    expect(queue.subtitle()?.mode).toBe("voice");
    // The first attempt's late callbacks are ignored.
    calls[0]!.start();
    calls[0]!.end();
    expect(queue.speaking()).toBe(true);
  });

  it("falls back to required text when every attempt fails, and keeps the line's full length", () => {
    const { queue, calls, events } = setup();
    queue.enqueue(item("a", { durationS: 4 }), 0);
    calls[0]!.error();
    queue.update(500);
    calls[1]!.error("decode");
    expect(events).toContainEqual({ kind: "fallback", id: "a", reason: "decode" });
    expect(queue.subtitle()).toMatchObject({ mode: "text", required: true });
    queue.update(4499);
    expect(queue.snapshot().current).toBe("a");
    queue.update(4500);
    expect(queue.snapshot().current).toBeNull();
  });

  it("a stalled start times out into text, so slow audio never holds the queue", () => {
    const { queue, calls, events } = setup(true, { attempts: 1, startTimeoutMs: 1000 });
    queue.enqueue(item("slow", { durationS: 2 }), 0);
    queue.enqueue(item("next", { url: null, durationS: 1 }), 0);
    queue.update(999);
    expect(queue.subtitle()?.mode).toBe("voice");
    queue.update(1000);
    expect(calls[0]!.stopped).toBe(true);
    expect(events).toContainEqual({ kind: "fallback", id: "slow", reason: "start timeout" });
    queue.update(3000);
    expect(queue.snapshot().current).toBe("next");
  });

  it("a stream that never reports its end is given up well past its length", () => {
    const { queue, calls } = setup();
    queue.enqueue(item("hang", { durationS: 2 }), 0);
    calls[0]!.start();
    queue.update(7_999);
    expect(queue.snapshot().current).toBe("hang");
    queue.update(8_001);
    expect(calls[0]!.stopped).toBe(true);
    queue.update(8_002);
    expect(queue.snapshot().current).toBeNull();
  });

  it("reset (save reload) stops the line, clears the queue and plays the next one fresh", () => {
    const { queue, calls, events } = setup();
    queue.enqueue(item("a"), 0);
    queue.enqueue(item("b"), 0);
    calls[0]!.start();
    queue.reset();
    expect(calls[0]!.stopped).toBe(true);
    expect(queue.snapshot()).toEqual({ current: null, mode: null, waiting: [] });
    expect(queue.subtitle()).toBeNull();
    expect(events.filter((e) => e.kind === "dropped").map((e) => e.id)).toEqual(["b", "a"]);
    // The same line can play again after a reload.
    queue.enqueue(item("a"), 100);
    expect(queue.snapshot().current).toBe("a");
    expect(calls).toHaveLength(2);
  });

  it("does not queue a duplicate of a line already playing or waiting", () => {
    const { queue } = setup();
    queue.enqueue(item("a"), 0);
    queue.enqueue(item("a"), 0);
    queue.enqueue(item("b"), 0);
    queue.enqueue(item("b"), 0);
    expect(queue.snapshot()).toMatchObject({ current: "a", waiting: ["b"] });
  });

  it("drops stale lines and, on overflow, the lowest priority first", () => {
    const { queue, events } = setup(true, { staleMs: 5000, maxQueued: 2 });
    queue.enqueue(item("now", { url: null, durationS: 10 }), 0);
    queue.enqueue(item("old", { url: null }), 0);
    queue.enqueue(item("amb", { url: null, priority: PRIORITY.ambient }), 0);
    queue.enqueue(item("newer", { url: null }), 0);
    expect(events).toContainEqual({ kind: "dropped", id: "amb", reason: "overflow" });
    queue.update(10_000);
    expect(events).toContainEqual({ kind: "dropped", id: "old", reason: "stale" });
    expect(queue.snapshot().current).toBeNull();
  });

  it("cancel drops a group's lines, including the one playing", () => {
    const { queue, calls } = setup();
    queue.enqueue(item("a", { group: "m1:s:1" }), 0);
    queue.enqueue(item("b", { group: "m1:s:1" }), 0);
    queue.enqueue(item("c", { group: "m2:s:1", url: null }), 0);
    queue.cancel((g) => g.startsWith("m1:"));
    expect(calls[0]!.stopped).toBe(true);
    expect(queue.snapshot()).toMatchObject({ current: "c", waiting: [] });
  });

  it("subtitle cues advance with the audio clock", () => {
    const { queue, calls } = setup();
    const text = "first sentence is here. and the second sentence is right here, a little longer than the first.";
    queue.enqueue(item("long", { text, durationS: 6 }), 0);
    queue.update(1500); // before onStart: the cue clock waits for the audio
    calls[0]!.start();
    expect(queue.subtitle()?.text).toBe("first sentence is here.");
    queue.update(1500 + 5000);
    expect(queue.subtitle()?.text).toMatch(/^and the second/);
  });

  it("holds the line, its audio and the queue while the game is paused", () => {
    const fake = fakePlayer();
    let paused = 0, resumed = 0;
    const player: VoicePlayer = { play: (url, cb) => { const h = fake.player.play(url, cb); return { ...h, pause: () => { paused++; }, resume: () => { resumed++; } }; } };
    const queue = new VoiceQueue({ player, canPlay: () => true, startTimeoutMs: 1000 });
    queue.enqueue(item("t", { url: null, durationS: 2 }), 0);
    queue.update(1000);
    queue.setPaused(true, 1000);
    expect(queue.paused()).toBe(true);
    queue.update(60_000); // a long menu visit: nothing ends
    queue.enqueue(item("high", { priority: PRIORITY.critical, url: null }), 60_000);
    expect(queue.snapshot()).toMatchObject({ current: "t", waiting: ["high"] });
    queue.setPaused(false, 60_000);
    queue.update(60_999);
    expect(queue.snapshot().current).toBe("t"); // one second of the line was left
    queue.update(61_000);
    expect(queue.snapshot().current).toBe("high");
    // A voiced line's audio is paused and resumed with it, and a paused start never times out.
    queue.reset();
    queue.enqueue(item("v"), 70_000);
    queue.setPaused(true, 70_000);
    queue.update(90_000);
    queue.setPaused(false, 90_000);
    expect([paused, resumed]).toEqual([1, 1]);
    expect(queue.subtitle()?.mode).toBe("voice");
  });

  it("a player that throws counts as a failure", () => {
    const events: VoiceQueueEvent[] = [];
    const queue = new VoiceQueue({ player: { play() { throw new Error("no audio"); } }, canPlay: () => true, onEvent: (e) => events.push(e) });
    queue.enqueue(item("a"), 0);
    expect(queue.subtitle()).toMatchObject({ mode: "text", required: true });
    expect(events.filter((e) => e.kind === "retry")).toHaveLength(1);
  });
});
