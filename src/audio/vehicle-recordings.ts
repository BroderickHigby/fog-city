/** Original recorded layers only. No oscillator/noise fallback or AudioContext creation. */
export type RecordingId = "idle" | "roll" | "road" | "brake" | "accel";
export type DrivingProfile = "light-ice" | "utility-ice" | "road-only";
export interface RecordingSource {
  url: string;
  sha256: string;
  /** Explicit decoded loop region; needed especially for MP3 encoder padding. */
  loopStartS: number;
  loopEndS: number;
}
export interface DrivingRecording {
  id: RecordingId;
  sources: readonly RecordingSource[];
  maxDecodedSeconds: number;
  author: string;
  sourcePage: string;
  licence: "CC0-1.0";
}
export interface DrivingManifest {
  schema: 1;
  status: "draft" | "candidate" | "ready";
  /** Set only after source listening, seam/level checks and native browser decoding. */
  qualityApproved: boolean;
  recordings: readonly DrivingRecording[];
}
export interface DrivingFrame {
  /** Occupied body identity, e.g. p:<id> or a:<taxi id>; never the parked own car. */
  identity: string;
  profile: DrivingProfile;
  speedMps: number;
  grounded: boolean;
  lateralMps: number;
  grip: number;
  dtS: number;
  cabin?: boolean;
}
export interface DrivingMix {
  idle: number; roll: number; road: number;
  rate: number; roadCutoff: number; brake: number; accelerate: boolean;
}
const clamp = (x: number, a = 0, b = 1): number => Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : a;
/** Read-only presentation model. Unknown/reset/long frame histories never invent load/braking. */
export function drivingMix(frame: DrivingFrame, prev: DrivingFrame | null): DrivingMix {
  const speed = clamp(Math.abs(frame.speedMps), 0, 45), moving = clamp(speed / 18);
  const same = prev?.identity === frame.identity && prev.profile === frame.profile;
  const acceleration = same && frame.dtS > 0 && frame.dtS <= .25
    ? (speed - Math.abs(prev!.speedMps)) / frame.dtS : 0;
  const cabin = frame.cabin ? .6 : 1;
  const mechanical = frame.profile !== "road-only";
  const utility = frame.profile === "utility-ice" ? .92 : 1;
  // Two genuine steady recordings crossfade; pitch stays within +/-5%, never octave shifting.
  const blend = clamp((speed - 1) / 14);
  return {
    idle: mechanical ? .18 * Math.cos(blend * Math.PI / 2) * cabin : 0,
    roll: mechanical ? .30 * Math.sin(blend * Math.PI / 2) * cabin : 0,
    road: frame.grounded ? .28 * Math.pow(moving, 1.2) * cabin : 0,
    rate: clamp(utility + .06 * moving, .95, 1.05),
    roadCutoff: 350 + 1000 * moving,
    brake: frame.grounded && speed > 5
      ? .3 * Math.max(clamp((Math.abs(frame.lateralMps) - 1) / 4), clamp((.7 - frame.grip) / .5), clamp((-acceleration - 6) / 7)) * cabin : 0,
    accelerate: mechanical && frame.grounded && speed > 2 && acceleration > 2.5,
  };
}
interface Playing { source: AudioBufferSourceNode; gain: GainNode; filter?: BiquadFilterNode; closed: boolean; stopping: boolean }
interface Loaded { buffer: AudioBuffer; source: RecordingSource }
export interface RecordedDrivingOptions {
  base?: string;
  fetcher?: typeof fetch;
  /** Test seam only; default verifies SHA-256 through Web Crypto. */
  digest?: (bytes: ArrayBuffer) => Promise<string>;
}
export const MAX_DRIVING_SOURCES = 8;
export const MAX_RECORDING_BYTES = 1_500_000;
export const MAX_DECODED_DRIVING_BYTES = 16 * 1024 * 1024;
export class RecordedDrivingAudio {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly manifest: DrivingManifest;
  private readonly options: RecordedDrivingOptions;
  private readonly abort = new AbortController();
  private readonly buffers = new Map<RecordingId, Loaded>();
  private readonly loops = new Map<RecordingId, Playing>();
  private readonly active = new Set<Playing>();
  private readonly errors = new Map<RecordingId, string>();
  private loadPromise: Promise<void> | null = null;
  private desired: DrivingFrame | null = null;
  private previous: DrivingFrame | null = null;
  private enabled = true;
  private visible = true;
  private disposed = false;
  private decodedBytes = 0;
  private nextBrakeS = 0;
  private nextAccelS = 0;
  constructor(ctx: AudioContext, bus: AudioNode, manifest: DrivingManifest, options: RecordedDrivingOptions = {}) {
    this.ctx = ctx; this.manifest = manifest; this.options = options;
    this.out = ctx.createGain(); this.out.connect(bus);
  }
  /** Call only after the owning GameAudio's gesture unlock. Never rejects or revives a disposed graph. */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    if (this.manifest.status === "draft") {
      for (const r of this.manifest.recordings) this.errors.set(r.id, "Recording not approved");
      return Promise.resolve();
    }
    const ids = this.manifest.recordings.map(r => r.id);
    if (ids.length !== 5 || new Set(ids).size !== 5 || !["idle","roll","road","brake","accel"].every(id => ids.includes(id as RecordingId))) {
      for (const id of ["idle","roll","road","brake","accel"] as const) this.errors.set(id, "Invalid recording manifest");
      return Promise.resolve();
    }
    // Sequential decode caps temporary memory and avoids contending with scene startup.
    this.loadPromise = (async () => {
      for (const recording of this.manifest.recordings) {
        if (this.disposed) return;
        if (!this.buffers.has(recording.id)) await this.loadOne(recording);
      }
      if (!this.disposed && this.enabled && this.visible) this.apply(this.desired, false);
    })();
    return this.loadPromise;
  }
  /** Explicit retry, e.g. after a failed fetch; no retry storm from per-frame updates. */
  retry(): Promise<void> { this.loadPromise = null; return this.load(); }
  set(frame: DrivingFrame | null): void {
    if (this.disposed) return;
    this.desired = frame ? { ...frame } : null;
    this.apply(this.desired, true);
  }
  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled; this.previous = null; this.apply(this.desired, false);
  }
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible; this.previous = null; this.apply(this.desired, false);
  }
  /** Restore/new game: forget acceleration history and delayed one-shots, await a fresh occupied body. */
  reset(): void {
    this.desired = null; this.previous = null; this.nextBrakeS = this.nextAccelS = 0;
    for (const p of [...this.active]) this.close(p, true);
    this.loops.clear();
  }
  info(): { kind: "recorded"; ready: number; activeSources: number; missing: Record<string, string>; enabled: boolean; qualityApproved: boolean } {
    return { kind: "recorded", ready: this.buffers.size, activeSources: this.active.size, missing: Object.fromEntries(this.errors), enabled: this.enabled && this.visible && !this.disposed, qualityApproved: this.manifest.qualityApproved };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.abort.abort(); this.reset();
    this.buffers.clear(); this.decodedBytes = 0; this.out.disconnect();
  }
  private async loadOne(recording: DrivingRecording): Promise<void> {
    if (recording.licence !== "CC0-1.0" || recording.sources.length < 1 || recording.sources.length > 2 ||
      !Number.isFinite(recording.maxDecodedSeconds) || recording.maxDecodedSeconds <= 0 || recording.maxDecodedSeconds > 12) {
      this.errors.set(recording.id, "Invalid recording metadata"); return;
    }
    for (const source of recording.sources) {
      try {
        if (!/^audio\/vehicle\/[a-z0-9.-]+\.(ogg|mp3)$/.test(source.url) ||
          !Number.isFinite(source.loopStartS) || !Number.isFinite(source.loopEndS)) throw Error("Invalid recording source");
        if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw Error("Missing output hash");
        const response = await (this.options.fetcher ?? fetch)((this.options.base ?? "") + source.url, { signal: this.abort.signal });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const length = Number(response.headers.get("content-length"));
        if (length > MAX_RECORDING_BYTES) throw Error("Encoded recording exceeds budget");
        const bytes = await response.arrayBuffer();
        if (this.disposed) return;
        if (bytes.byteLength > MAX_RECORDING_BYTES) throw Error("Encoded recording exceeds budget");
        const digest = this.options.digest ?? (async (b: ArrayBuffer): Promise<string> => {
          const hash = await globalThis.crypto.subtle.digest("SHA-256", b);
          return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
        });
        if (await digest(bytes) !== source.sha256) throw Error("Output hash mismatch");
        if (this.disposed) return;
        const buffer = await this.ctx.decodeAudioData(bytes);
        if (this.disposed) return;
        const cost = buffer.length * buffer.numberOfChannels * 4;
        if (buffer.duration > recording.maxDecodedSeconds || this.decodedBytes + cost > MAX_DECODED_DRIVING_BYTES) throw Error("Decoded recording exceeds budget");
        if (source.loopStartS < 0 || source.loopEndS <= source.loopStartS || source.loopEndS > buffer.duration + 1 / buffer.sampleRate) throw Error("Invalid decoded loop region");
        this.buffers.set(recording.id, { buffer, source }); this.decodedBytes += cost; this.errors.delete(recording.id); return;
      } catch (error) {
        if (this.disposed) return;
        this.errors.set(recording.id, error instanceof Error ? error.message : String(error));
      }
    }
  }
  private apply(frame: DrivingFrame | null, transient: boolean): void {
    if (!frame || !this.enabled || !this.visible || this.disposed) {
      this.previous = null;
      for (const p of [...this.active]) this.close(p, false);
      this.loops.clear(); return;
    }
    if (this.ctx.state === "closed") { this.reset(); return; }
    if (this.previous && (this.previous.identity !== frame.identity || this.previous.profile !== frame.profile)) {
      for (const p of [...this.active]) this.close(p, true);
      this.previous = null; this.nextBrakeS = this.nextAccelS = 0;
    }
    const mix = drivingMix(frame, this.previous), time = this.ctx.currentTime;
    for (const id of ["idle", "roll", "road"] as const) {
      let playing = this.loops.get(id);
      if (mix[id] > .0001 && !playing) {
        playing = this.start(id, true) ?? undefined;
        if (playing) this.loops.set(id, playing);
      }
      if (!playing) continue;
      playing.gain.gain.setTargetAtTime(mix[id], time, .08);
      playing.source.playbackRate.setTargetAtTime(id === "road" ? 1 : mix.rate, time, .08);
      playing.filter?.frequency.setTargetAtTime(mix.roadCutoff, time, .08);
    }
    if (transient && mix.brake > .03 && time >= this.nextBrakeS) {
      const p = this.start("brake", false);
      if (p) { p.gain.gain.setTargetAtTime(mix.brake, time, .012); this.nextBrakeS = time + 1.8; }
    }
    if (transient && mix.accelerate && time >= this.nextAccelS) {
      const p = this.start("accel", false);
      if (p) { p.gain.gain.setTargetAtTime(frame.cabin ? .045 : .075, time, .03); this.nextAccelS = time + 4.5; }
    }
    this.previous = { ...frame };
  }
  private start(id: RecordingId, loop: boolean): Playing | null {
    const loaded = this.buffers.get(id);
    if (!loaded || this.active.size >= MAX_DRIVING_SOURCES || this.disposed) return null;
    const source = this.ctx.createBufferSource(), gain = this.ctx.createGain();
    source.buffer = loaded.buffer; source.loop = loop;
    source.loopStart = loaded.source.loopStartS; source.loopEnd = loaded.source.loopEndS;
    gain.gain.value = 0;
    const playing: Playing = { source, gain, closed: false, stopping: false };
    if (id === "road") { const filter = this.ctx.createBiquadFilter(); filter.type = "lowpass"; source.connect(filter); filter.connect(gain); playing.filter = filter; }
    else source.connect(gain);
    gain.connect(this.out); this.active.add(playing);
    source.onended = () => this.close(playing, true, true);
    try { if (loop) source.start(0, loaded.source.loopStartS); else source.start(0, loaded.source.loopStartS, loaded.source.loopEndS - loaded.source.loopStartS); }
    catch (error) { this.close(playing, true); this.errors.set(id, error instanceof Error ? error.message : String(error)); return null; }
    return playing;
  }
  private close(p: Playing, immediate: boolean, ended = false): void {
    if (p.closed) return;
    if (!immediate) {
      if (p.stopping) return;
      p.stopping = true;
      p.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      p.gain.gain.setTargetAtTime(0, this.ctx.currentTime, .025);
      try { p.source.stop(this.ctx.currentTime + .12); } catch { this.close(p, true, true); }
      return;
    }
    p.closed = true; p.source.onended = null;
    if (!ended) try { p.source.stop(); } catch { /* Already stopped. */ }
    p.source.disconnect(); p.gain.disconnect(); p.filter?.disconnect(); this.active.delete(p);
    for (const [id, value] of this.loops) if (value === p) this.loops.delete(id);
  }
}
