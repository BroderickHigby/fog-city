// The mission voice queue: one line at a time, by priority, with interruption, retry, reset and
// a subtitle fallback on any failure. Presentation only: it reads nothing back into the sim, and
// a slow, failed, muted or locked line simply shows its text for its estimated length, so no
// playback problem can hold a mission up.
//
// Time is passed in (update(nowMs)), and playback goes through an injected VoicePlayer, so the
// queue runs the same in a browser and in a unit test.

import type { SubtitleCue } from "./voice-lines.ts";

/** 3 interrupts 2 interrupts 1; equal priorities queue in order. */
export type VoicePriority = 1 | 2 | 3;
export const PRIORITY = { ambient: 1, story: 2, critical: 3 } as const satisfies Record<string, VoicePriority>;

export interface VoiceItem {
  /** The line id (voice-lines.ts). */
  id: string;
  /** Groups lines for cancel(): "<missionId>:<stepId>:<visit>". */
  group: string;
  speaker: string;
  speakerName: string;
  text: string;
  /** The voiced file, or null for subtitles only. */
  url: string | null;
  durationS: number;
  cues: SubtitleCue[];
  priority: VoicePriority;
}

/** What the subtitle overlay shows; null when nothing is speaking. */
export interface SubtitleView {
  lineId: string;
  speaker: string;
  speakerName: string;
  text: string;
  /** "voice": the audio is playing; "text": subtitles only (no file, muted, locked or failed). */
  mode: "voice" | "text";
  /** Whether the overlay must show even when the player turned subtitles off (a failed line). */
  required: boolean;
}

export interface VoiceHandle {
  stop(): void;
  /** Hold playback while the game is paused (optional: a player without it keeps playing). */
  pause?(): void;
  resume?(): void;
}

/** Plays one file. Calls exactly one of onStart then onEnd, or onError, at most once each. */
export interface VoicePlayer {
  play(url: string, callbacks: { onStart(): void; onEnd(): void; onError(reason: string): void }): VoiceHandle;
}

export interface VoiceQueueOptions {
  player: VoicePlayer;
  /** Whether audio may play now (unlocked by a gesture, voice bus audible). False: text only. */
  canPlay: () => boolean;
  /** Attempts per line before falling back to text (1 = no retry). */
  attempts?: number;
  /** A line whose audio has not started this long after it was asked for falls back to text. */
  startTimeoutMs?: number;
  /** A queued line older than this is dropped as stale (the moment it belonged to has passed). */
  staleMs?: number;
  /** Lines waiting at most; the lowest priority, oldest, goes first when it overflows. */
  maxQueued?: number;
  /** Subtitles stay up this long after the audio ends. */
  holdMs?: number;
  /** For diagnostics and tests: every outcome. */
  onEvent?: (event: VoiceQueueEvent) => void;
}

export type VoiceQueueEvent =
  | { kind: "start"; id: string; mode: "voice" | "text" }
  | { kind: "end"; id: string; mode: "voice" | "text" }
  | { kind: "retry"; id: string; attempt: number; reason: string }
  | { kind: "fallback"; id: string; reason: string }
  | { kind: "interrupted"; id: string; by: string }
  | { kind: "dropped"; id: string; reason: "stale" | "overflow" | "cancelled" | "reset" };

interface Current {
  item: VoiceItem;
  startedMs: number;
  /** Wall-clock end of the subtitles: the estimate in text mode, audio end + hold in voice mode. */
  endsMs: number;
  mode: "voice" | "text";
  /** Audio state: waiting to start, playing, done (ended, failed or stopped). */
  audio: "pending" | "playing" | "done";
  attempt: number;
  requestedMs: number;
  handle: VoiceHandle | null;
  required: boolean;
  /** Bumped on every (re)play, so callbacks from a stopped attempt are ignored. */
  token: number;
}

interface Waiting {
  item: VoiceItem;
  queuedMs: number;
  order: number;
}

export class VoiceQueue {
  private readonly opts: Required<Omit<VoiceQueueOptions, "onEvent">> & Pick<VoiceQueueOptions, "onEvent">;
  private current: Current | null = null;
  private waiting: Waiting[] = [];
  private order = 0;
  private token = 0;
  private now = 0;
  private pausedAt: number | null = null;

  constructor(options: VoiceQueueOptions) {
    this.opts = { attempts: 2, startTimeoutMs: 2500, staleMs: 20_000, maxQueued: 8, holdMs: 350, ...options };
  }

  /** Queue a line; a higher priority than the line playing interrupts it. */
  enqueue(item: VoiceItem, nowMs: number = this.now): void {
    this.now = Math.max(this.now, nowMs);
    if (this.current?.item.id === item.id && this.current.item.group === item.group) return;
    if (this.waiting.some((w) => w.item.id === item.id && w.item.group === item.group)) return;
    if (this.current && item.priority > this.current.item.priority && this.pausedAt === null) {
      this.opts.onEvent?.({ kind: "interrupted", id: this.current.item.id, by: item.id });
      this.stopCurrent();
      this.begin(item);
      return;
    }
    this.waiting.push({ item, queuedMs: this.now, order: this.order++ });
    this.waiting.sort((a, b) => b.item.priority - a.item.priority || a.order - b.order);
    while (this.waiting.length > this.opts.maxQueued) {
      // Lowest priority first, then the oldest of those.
      let worst = 0;
      for (let i = 1; i < this.waiting.length; i++) {
        const w = this.waiting[i]!, v = this.waiting[worst]!;
        if (w.item.priority < v.item.priority || (w.item.priority === v.item.priority && w.order < v.order)) worst = i;
      }
      const [gone] = this.waiting.splice(worst, 1);
      this.opts.onEvent?.({ kind: "dropped", id: gone!.item.id, reason: "overflow" });
    }
    if (!this.current && this.pausedAt === null) this.advance();
  }

  /** Drop every line (playing or waiting) whose group matches; for a mission that moved on. */
  cancel(match: (group: string) => boolean): void {
    for (const w of this.waiting.filter((w) => match(w.item.group))) this.opts.onEvent?.({ kind: "dropped", id: w.item.id, reason: "cancelled" });
    this.waiting = this.waiting.filter((w) => !match(w.item.group));
    if (this.current && match(this.current.item.group)) {
      this.opts.onEvent?.({ kind: "dropped", id: this.current.item.id, reason: "cancelled" });
      this.stopCurrent();
      this.advance();
    }
  }

  /** Stop and forget everything: a save restore or a reload into another moment. */
  reset(): void {
    for (const w of this.waiting) this.opts.onEvent?.({ kind: "dropped", id: w.item.id, reason: "reset" });
    if (this.current) this.opts.onEvent?.({ kind: "dropped", id: this.current.item.id, reason: "reset" });
    this.waiting = [];
    this.stopCurrent();
  }

  /**
   * Pause or resume with the game: the line playing holds where it is (audio and subtitle
   * clock), and nothing starts, times out or goes stale until the game resumes.
   */
  setPaused(paused: boolean, nowMs: number = this.now): void {
    this.now = Math.max(this.now, nowMs);
    if (paused && this.pausedAt === null) {
      this.pausedAt = this.now;
      this.current?.handle?.pause?.();
    } else if (!paused && this.pausedAt !== null) {
      const shift = this.now - this.pausedAt;
      this.pausedAt = null;
      const c = this.current;
      if (c) {
        c.startedMs += shift;
        c.requestedMs += shift;
        c.endsMs += shift;
        c.handle?.resume?.();
      }
      for (const w of this.waiting) w.queuedMs += shift;
    }
  }

  paused(): boolean {
    return this.pausedAt !== null;
  }

  /** Advance timers: start-timeouts, subtitle ends, stale lines. Call every frame. */
  update(nowMs: number): void {
    this.now = Math.max(this.now, nowMs);
    if (this.pausedAt !== null) return;
    const c = this.current;
    if (c) {
      if (c.audio === "pending" && this.now - c.requestedMs >= this.opts.startTimeoutMs) this.fail(c, "start timeout");
      // A stalled stream that never reports its end: give up well past the line's length.
      if (c.audio === "playing" && this.now - c.startedMs > c.item.durationS * 2000 + 4000) {
        c.handle?.stop();
        c.token = ++this.token;
        c.audio = "done";
        c.endsMs = this.now;
      }
      if (this.current === c && (c.audio === "done" || c.mode === "text") && this.now >= c.endsMs) this.finish(c);
    }
    if (!this.current) this.advance();
  }

  /** Whether a voice is audibly playing (the mixer ducks music under it). */
  speaking(): boolean {
    return this.current?.mode === "voice" && this.current.audio === "playing";
  }

  subtitle(): SubtitleView | null {
    const c = this.current;
    if (!c) return null;
    const elapsedS = ((this.pausedAt ?? this.now) - c.startedMs) / 1000;
    const cue = c.item.cues.find((q) => elapsedS < q.endS) ?? c.item.cues[c.item.cues.length - 1];
    return { lineId: c.item.id, speaker: c.item.speaker, speakerName: c.item.speakerName, text: cue?.text ?? c.item.text, mode: c.mode, required: c.required };
  }

  /** For tests and diagnostics. */
  snapshot(): { current: string | null; mode: "voice" | "text" | null; waiting: string[] } {
    return { current: this.current?.item.id ?? null, mode: this.current?.mode ?? null, waiting: this.waiting.map((w) => w.item.id) };
  }

  private advance(): void {
    while (!this.current && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      if (this.now - next.queuedMs > this.opts.staleMs) {
        this.opts.onEvent?.({ kind: "dropped", id: next.item.id, reason: "stale" });
        continue;
      }
      this.begin(next.item);
    }
  }

  private begin(item: VoiceItem): void {
    const textEnd = this.now + item.durationS * 1000;
    const voice = item.url !== null && this.opts.canPlay();
    const c: Current = { item, startedMs: this.now, endsMs: textEnd, mode: voice ? "voice" : "text", audio: voice ? "pending" : "done", attempt: 0, requestedMs: this.now, handle: null, required: false, token: 0 };
    this.current = c;
    this.opts.onEvent?.({ kind: "start", id: item.id, mode: c.mode });
    if (voice) this.play(c);
  }

  private play(c: Current): void {
    c.attempt++;
    c.requestedMs = this.now;
    c.audio = "pending";
    const token = (c.token = ++this.token);
    const live = (): boolean => this.current === c && c.token === token;
    try {
      c.handle = this.opts.player.play(c.item.url!, {
        onStart: () => {
          if (!live() || c.audio !== "pending") return;
          c.audio = "playing";
          // Subtitles follow the audio from here: restart the cue clock at the real start.
          c.startedMs = this.now;
          c.endsMs = Number.POSITIVE_INFINITY;
        },
        onEnd: () => {
          if (!live() || c.audio === "done") return;
          c.audio = "done";
          c.endsMs = this.now + this.opts.holdMs;
        },
        onError: (reason) => {
          if (live()) this.fail(c, reason);
        },
      });
    } catch (err) {
      this.fail(c, err instanceof Error ? err.message : String(err));
    }
  }

  /** A failed attempt: retry while attempts remain and the line has not begun, else text. */
  private fail(c: Current, reason: string): void {
    c.handle?.stop();
    c.handle = null;
    c.token = ++this.token;
    const neverStarted = c.audio === "pending";
    if (neverStarted && c.attempt < this.opts.attempts && this.opts.canPlay()) {
      this.opts.onEvent?.({ kind: "retry", id: c.item.id, attempt: c.attempt + 1, reason });
      this.play(c);
      return;
    }
    this.opts.onEvent?.({ kind: "fallback", id: c.item.id, reason });
    c.mode = "text";
    c.audio = "done";
    c.required = true;
    // The text stays up for the line's full length from when the fallback began.
    c.startedMs = this.now;
    c.endsMs = this.now + c.item.durationS * 1000;
  }

  private finish(c: Current): void {
    this.opts.onEvent?.({ kind: "end", id: c.item.id, mode: c.mode });
    this.current = null;
  }

  private stopCurrent(): void {
    const c = this.current;
    if (!c) return;
    c.token = ++this.token;
    c.handle?.stop();
    this.current = null;
  }
}
