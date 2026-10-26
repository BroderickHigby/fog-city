import { PRIORITY, type VoiceItem, type VoiceQueue } from "./voice-queue.ts";
import { subtitleCues } from "./voice-lines.ts";

export interface OpeningLine { id: string; text: string; file: string | null; durationS: number }
export interface OpeningManifest { version: 1; title: string; disclosure: string; lines: OpeningLine[] }
export interface OpeningStatus { active: boolean; line: number; total: number; title: string; disclosure: string }

/** One segment at a time uses the existing voice queue, timeout/fallback and ducking.
 * No timer, simulation mutation or game-input blocking belongs to the narration. */
export class OpeningNarration {
  private index = -1;
  private playing = false;
  private generation = 0;
  private group = "";
  private currentId: string | null = null;
  private readonly queue: VoiceQueue;
  private readonly manifest: OpeningManifest;
  constructor(queue: VoiceQueue, manifest: OpeningManifest) { this.queue=queue;this.manifest=manifest; }

  start(nowMs: number): void {
    this.skip();
    this.queue.cancel(() => true);
    this.group = `opening:${++this.generation}`;
    this.index = 0;
    this.playing = this.manifest.lines.length > 0;
    if (this.playing) this.enqueue(nowMs);
  }

  skip(): void {
    this.playing = false;
    this.currentId = null;
    const group = this.group;
    if (group) this.queue.cancel(value => value === group);
  }

  update(nowMs: number): void {
    if (!this.playing) return;
    const snapshot = this.queue.snapshot();
    if (snapshot.current === this.currentId || this.currentId !== null && snapshot.waiting.includes(this.currentId)) return;
    if (++this.index >= this.manifest.lines.length) {
      this.playing = false;
      this.currentId = null;
      return;
    }
    this.enqueue(nowMs);
  }

  status(): OpeningStatus {
    return { active: this.playing, line: this.playing ? this.index + 1 : 0, total: this.manifest.lines.length,
      title: this.manifest.title, disclosure: this.manifest.disclosure };
  }

  private enqueue(nowMs: number): void {
    const line = this.manifest.lines[this.index]!;
    this.currentId = `${line.id}:play${this.generation}`;
    const item: VoiceItem = { id: this.currentId, group: this.group, speaker: "narrator", speakerName: "Fog City narrator",
      text: line.text, url: line.file, durationS: line.durationS, cues: subtitleCues(line.text, line.durationS), priority: PRIORITY.critical };
    this.queue.enqueue(item, nowMs);
  }
}
