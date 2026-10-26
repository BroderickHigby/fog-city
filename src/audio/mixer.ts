// The Web Audio graph: master <- music / effects / voice buses, each with its volume and mute
// from the prefs, music and effects ducked under a playing voice. Effects are decoded buffers
// with a bounded number of voices; music streams through <audio> decks (music.ts); voice lines
// stream through their own <audio> (VoicePlayer for voice-queue.ts).
//
// Nothing can sound before the user-gesture unlock: the AudioContext is created (or resumed)
// inside unlock(), which main.ts calls from the first pointerdown or keydown. A browser without
// Web Audio gets silence; voice lines then show as subtitles and the game is unaffected.

import { DUCK_ATTACK_S, DUCK_RELEASE_S, audible, busGain, masterGain } from "./buses.ts";
import type { EffectCue, EffectSound } from "./cues.ts";
import { MusicPlayer, type MusicTrack } from "./music.ts";
import { RecordedDrivingAudio, type DrivingManifest } from "./vehicle-recordings.ts";
import recordingManifest from "./vehicle-recording-manifest.json" with { type: "json" };
import { RobotVoices, SYNTH_CUES, beepTones, playTones, type SynthCue } from "./synth-sfx.ts";
import type { RobotWhirr } from "./robot-sound.ts";
import { AmbienceSynth } from "./ambience-synth.ts";
import { ImpactSynth } from "./impact-synth.ts";
import type { ImpactCue } from "./impact-sound.ts";
import type { AmbienceLevels, AmbientEvent } from "./ambience.ts";
import type { EngineParams } from "./vehicle-sound.ts";
import type { AudioBus, AudioPrefs } from "./prefs.ts";
import type { VoiceHandle, VoicePlayer } from "./voice-queue.ts";

export type Sound = EffectSound | "spray" | "horn";
export const SOUNDS: readonly Sound[] = [
  "spray", "splash", "melt-fizz", "rust-creak", "moat-jingle", "horn", "robotaxi-horn",
  "door-open", "door-close", "impact", "step-1", "step-2", "step-3", "step-4",
];
/** Effect voices sounding at once, all sounds together, and per sound. */
export const MAX_EFFECT_VOICES = 8;
export const MAX_PER_SOUND: Readonly<Record<EffectSound, number>> = {
  splash: 3, "melt-fizz": 3, "rust-creak": 3, "moat-jingle": 1, "robotaxi-horn": 2,
  "door-open": 1, "door-close": 1, impact: 2, "step-1": 1, "step-2": 1, "step-3": 1, "step-4": 1,
};

interface ActiveEffect {
  sound: EffectSound;
  source: AudioBufferSourceNode;
  startedAt: number;
}

type ContextCtor = new () => AudioContext;

function audioContextCtor(): ContextCtor | null {
  const w = globalThis as unknown as { AudioContext?: ContextCtor; webkitAudioContext?: ContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Vorbis where the browser plays it (the gapless spray loop), else the MP3 fallback. */
export function effectUrl(id: Sound, canPlayType: (type: string) => string): string {
  return `audio/${id}.${canPlayType('audio/ogg; codecs="vorbis"') ? "ogg" : "mp3"}`;
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buses = new Map<AudioBus, GainNode>();
  private readonly bytes = new Map<Sound, ArrayBuffer>();
  private readonly buffers = new Map<Sound, AudioBuffer>();
  private active: ActiveEffect[] = [];
  private spray: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wantSpray = false;
  private music: MusicPlayer | null = null;
  private musicTracks: readonly MusicTrack[] = [];
  private musicTrack: string | null | undefined = undefined;
  private musicDucked = false;
  private vehicle: RecordedDrivingAudio | null = null;
  private robots: RobotVoices | null = null;
  private ambience: AmbienceSynth | null = null;
  private ambienceLevels: AmbienceLevels | null = null;
  private impacts: ImpactSynth | null = null;
  private engineOn = false;
  private disposed = false;
  private readonly onVisibilityChange = (): void => {
    const visible = typeof document === "undefined" || document.visibilityState === "visible";
    this.vehicle?.setVisible(visible);
    if (visible && !this.disposed) void this.ctx?.resume().catch(() => {});
  };
  private prefs: AudioPrefs;
  private ducked = false;
  private unlocked = false;
  private readonly base: string;
  private readonly played = new Map<string, number>();

  constructor(prefs: AudioPrefs, base = "") {
    this.prefs = prefs;
    this.base = base;
  }

  /** Fetch the effect files (small); decoding waits for the unlock. Never rejects. */
  async load(): Promise<void> {
    const probe = typeof Audio === "undefined" ? null : new Audio();
    await Promise.all(SOUNDS.map(async (id) => {
      try {
        const r = await fetch(this.base + effectUrl(id, (t) => probe?.canPlayType(t) ?? ""));
        if (!r.ok) return;
        const bytes=await r.arrayBuffer();
        if(this.disposed)return;
        this.bytes.set(id,bytes);
        if (this.ctx) await this.decode(id);
      } catch {
        // A missing effect stays silent.
      }
    }));
  }

  setMusicTracks(tracks: readonly MusicTrack[]): void {
    this.musicTracks = tracks;
    if (this.ctx && this.buses.get("music") && !this.music) this.startMusic();
  }

  /** Create or resume the context: call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      const Ctor = audioContextCtor();
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      for (const bus of ["music", "effects", "voice"] as const) {
        const g = ctx.createGain();
        g.connect(this.master);
        this.buses.set(bus, g);
      }
      this.applyGains(true);
      // A backgrounded tab can leave the context suspended: resume it when the page shows again.
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibilityChange);
      for (const id of this.bytes.keys()) void this.decode(id);
      this.startMusic();
    }
    void this.ctx.resume().catch(() => {});
    this.unlocked = true;
    this.music?.setEnabled(audible(this.prefs, "music"));
    if (this.wantSpray) this.startSpray();
  }

  isUnlocked(): boolean {
    return this.unlocked && this.ctx !== null;
  }

  setPrefs(prefs: AudioPrefs): void {
    this.prefs = prefs;
    this.applyGains(false);
    // Silent music stops streaming; turning it back up resumes where it was.
    this.music?.setEnabled(this.unlocked && audible(prefs, "music"));
    this.vehicle?.setEnabled(audible(prefs,"effects"));
    if(audible(prefs,"effects")) void this.vehicle?.load();
  }

  /** Back-compat: the master volume, 0..1. */
  setVolume(volume: number): void {
    this.setPrefs({ ...this.prefs, master: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : this.prefs.master });
  }

  /** Duck music and effects while a voice line plays. */
  setVoiceActive(active: boolean): void {
    if (active === this.ducked) return;
    this.ducked = active;
    this.applyGains(false);
  }

  /** The player car's live engine, road and tyre sound; null silences it (on foot, paused). */
  setEngine(params: EngineParams | null): void {
    const ctx = this.ctx, bus = this.buses.get("effects");
    if (!ctx || !bus || !this.unlocked) return;
    if (!this.vehicle && params) {
      try {
        this.vehicle = new RecordedDrivingAudio(ctx,bus,recordingManifest as unknown as DrivingManifest,{base:this.base});
        this.vehicle.setEnabled(audible(this.prefs,"effects"));
        this.vehicle.setVisible(typeof document === "undefined" || document.visibilityState === "visible");
        if(audible(this.prefs,"effects")) void this.vehicle.load();
      } catch {
        return;
      }
    }
    this.engineOn = params !== null;
    const frame = params?.recording ?? (params ? {identity:"legacy-car",profile:"light-ice" as const,speedMps:Math.max(0,(params.whineHz-110)/21),grounded:params.roarGain>0,lateralMps:0,grip:1,dtS:0} : null);
    this.vehicle?.set(frame);
  }

  /** Save restore/new game must cancel old occupied-body one-shots immediately. */
  resetDriving(): void { this.engineOn=false;this.vehicle?.reset(); }

  /** A procedural cue (UI, stingers, money, scan result, the pairing tell) on the effects bus. */
  playSynth(cue: SynthCue, gain = 1, pan = 0): void {
    const ctx = this.ctx, bus = this.buses.get("effects");
    if (!ctx || !bus || !this.unlocked) return;
    playTones(ctx, bus, SYNTH_CUES[cue], gain, pan);
    this.played.set(cue, (this.played.get(cue) ?? 0) + 1);
  }

  /** A robot's beep pattern. */
  playBeep(notes: readonly number[], gain: number, pan: number): void {
    const ctx = this.ctx, bus = this.buses.get("effects");
    if (!ctx || !bus || !this.unlocked) return;
    playTones(ctx, bus, beepTones(notes), gain, pan);
    this.played.set("robot-beep", (this.played.get("robot-beep") ?? 0) + 1);
  }

  /** The city ambience layers (null: silence, e.g. paused). */
  setAmbience(levels: AmbienceLevels | null): void {
    const ctx = this.ctx, bus = this.buses.get("effects");
    if (!ctx || !bus || !this.unlocked) return;
    if (!this.ambience) {
      if (!levels) return;
      try {
        this.ambience = new AmbienceSynth(ctx, bus);
      } catch {
        return;
      }
    }
    this.ambienceLevels = levels;
    this.ambience.set(levels);
  }

  /** A foghorn or gulls. */
  playAmbientEvent(e: AmbientEvent): void {
    if (!this.ambience || !this.unlocked) return;
    if (e.kind === "foghorn") this.ambience.foghorn(e.gain, e.pan);
    else this.ambience.gull(e.gain, e.pan);
    this.played.set(e.kind, (this.played.get(e.kind) ?? 0) + 1);
  }

  private impactSynth(): ImpactSynth | null {
    const ctx = this.ctx, bus = this.buses.get("effects");
    if (!ctx || !bus || !this.unlocked) return null;
    if (!this.impacts) {
      try {
        this.impacts = new ImpactSynth(ctx, bus);
      } catch {
        return null;
      }
    }
    return this.impacts;
  }

  /** A collision (impact-sound.ts). */
  playImpact(cue: ImpactCue): void {
    const synth = this.impactSynth();
    if (!synth) return;
    synth.play(cue);
    const key = cue.scrape ? "impact-scrape" : `impact-${cue.material}`;
    this.played.set(key, (this.played.get(key) ?? 0) + 1);
  }

  /** A gushing hydrant's hiss (null: none near). */
  setHydrant(h: { gain: number; pan: number } | null): void {
    if (!h && !this.impacts) return;
    this.impactSynth()?.setHiss(h);
  }

  /** The nearest robots' servo whirrs (empty: silence). */
  setRobots(whirrs: readonly RobotWhirr[]): void {
    const ctx = this.ctx, bus = this.buses.get("effects");
    if (!ctx || !bus || !this.unlocked) return;
    if (!this.robots) {
      if (whirrs.length === 0) return;
      this.robots = new RobotVoices(ctx, bus);
    }
    this.robots.update(whirrs);
  }

  /** Duck the music under a menu or dialog (nothing switches). */
  setMusicDucked(on: boolean): void {
    this.musicDucked = on;
    this.music?.setDucked(on);
  }

  /** Per-frame upkeep: the music watchdog (stalled streams, waiting crossfades). */
  tick(): void {
    this.music?.tick();
  }

  /** The music track to play by id (null: silence, the radio switched off). */
  setMusicTrack(trackId: string | null): void {
    this.musicTrack = trackId;
    this.music?.play(trackId);
  }

  /**
   * One horn blast through the effects bus: the car horn sample for `length` seconds (it is a
   * seamless loop, so any length works), or an octave up for the pocket air horn on foot.
   */
  playHorn(gain: number, pan: number, inVehicle: boolean): void {
    const ctx = this.ctx, bus = this.buses.get("effects"), buffer = this.buffers.get("horn");
    if (!ctx || !bus || !buffer || !this.unlocked || gain <= 0) return;
    const t = ctx.currentTime, length = inVehicle ? 0.42 : 0.26, level = 0.8 * Math.min(1, gain);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = inVehicle ? 1 : 2;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + 0.012);
    env.gain.setValueAtTime(level, t + length - 0.06);
    env.gain.linearRampToValueAtTime(0, t + length);
    let tail: AudioNode = env;
    if (typeof ctx.createStereoPanner === "function") {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      env.connect(p);
      tail = p;
    }
    source.connect(env);
    tail.connect(bus);
    source.onended = () => tail.disconnect();
    source.start(t);
    source.stop(t + length + 0.01);
    this.played.set("horn", (this.played.get("horn") ?? 0) + 1);
  }

  setSpray(on: boolean): void {
    if (on === this.wantSpray) return;
    this.wantSpray = on;
    if (on) this.startSpray();
    else this.stopSpray();
  }

  /** Pause or resume all sound with the game's pause (music keeps playing under the menu). */
  setPaused(paused: boolean): void {
    if (paused) {this.stopSpray();this.vehicle?.set(null);this.engineOn=false;}
    else if (this.wantSpray) this.startSpray();
  }

  play(cue: EffectCue): void {
    const ctx = this.ctx, bus = this.buses.get("effects"), buffer = this.buffers.get(cue.sound);
    if (!ctx || !bus || !buffer || !this.unlocked || cue.gain <= 0) return;
    const now = ctx.currentTime, at = now + Math.max(0, cue.delayS ?? 0);
    this.active = this.active.filter((a) => a.startedAt + (a.source.buffer?.duration ?? 0) > now);
    const same = this.active.filter((a) => a.sound === cue.sound);
    if (same.length >= MAX_PER_SOUND[cue.sound]) this.stopEffect(same[0]!);
    if (this.active.length >= MAX_EFFECT_VOICES) this.stopEffect(this.active[0]!);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (cue.rate !== undefined) source.playbackRate.value = Math.max(0.25, Math.min(4, cue.rate));
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, cue.gain));
    let tail: AudioNode = gain;
    if (typeof ctx.createStereoPanner === "function") {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, cue.pan));
      gain.connect(pan);
      tail = pan;
    }
    source.connect(gain);
    tail.connect(bus);
    const entry: ActiveEffect = { sound: cue.sound, source, startedAt: at };
    source.onended = () => {
      tail.disconnect();
      this.active = this.active.filter((a) => a !== entry);
    };
    this.active.push(entry);
    source.start(at);
    this.played.set(cue.sound, (this.played.get(cue.sound) ?? 0) + 1);
  }

  /** The voice-line player: each line streams through its own <audio> into the voice bus. */
  voicePlayer(): VoicePlayer {
    return {
      play: (url, cb) => {
        const ctx = this.ctx, bus = this.buses.get("voice");
        if (!ctx || !bus) {
          cb.onError("audio is locked");
          return { stop() {} };
        }
        const element = new Audio();
        element.preload = "auto";
        element.crossOrigin = "anonymous";
        let node: MediaElementAudioSourceNode | null = null;
        let done = false;
        const finish = (fn: () => void): void => {
          if (done) return;
          done = true;
          fn();
        };
        const cleanup = (): void => {
          element.pause();
          element.removeAttribute("src");
          node?.disconnect();
        };
        try {
          node = ctx.createMediaElementSource(element);
          node.connect(bus);
        } catch (err) {
          cb.onError(err instanceof Error ? err.message : String(err));
          return { stop() {} };
        }
        element.addEventListener("playing", () => { if (!done) cb.onStart(); });
        element.addEventListener("ended", () => finish(() => { cleanup(); cb.onEnd(); }));
        element.addEventListener("error", () => finish(() => { cleanup(); cb.onError(`media error ${element.error?.code ?? "?"}`); }));
        element.src = this.base + url;
        void element.play().catch((err: unknown) => finish(() => { cleanup(); cb.onError(err instanceof Error ? err.message : String(err)); }));
        const handle: VoiceHandle = {
          stop: () => { done = true; cleanup(); },
          pause: () => { if (!done) element.pause(); },
          resume: () => { if (!done) void element.play().catch(() => {}); },
        };
        return handle;
      },
    };
  }

  /** For tests and the debug handle. */
  info(): { unlocked: boolean; state: string; effectsLoaded: number; effectsPlayed: Record<string, number>; spray: boolean; engine: boolean; driving: ReturnType<RecordedDrivingAudio["info"]> | null; robotVoices: number; ambience: AmbienceLevels | null; music: ReturnType<MusicPlayer["nowPlaying"]>; musicSwitches: number; ducked: boolean; gains: Record<string, number> } {
    return {
      unlocked: this.isUnlocked(),
      state: this.ctx?.state ?? "none",
      effectsLoaded: this.buffers.size,
      effectsPlayed: Object.fromEntries(this.played),
      spray: this.spray !== null,
      engine: this.engineOn,
      driving: this.vehicle?.info() ?? null,
      robotVoices: this.robots?.count() ?? 0,
      ambience: this.ambienceLevels,
      music: this.music?.nowPlaying() ?? null,
      musicSwitches: this.music?.switches ?? 0,
      ducked: this.ducked,
      gains: {
        master: masterGain(this.prefs),
        music: busGain(this.prefs, "music", this.ducked),
        effects: busGain(this.prefs, "effects", this.ducked),
        voice: busGain(this.prefs, "voice", this.ducked),
      },
    };
  }

  dispose(): void {
    if(this.disposed)return;
    this.disposed=true;this.engineOn=false;
    if(typeof document!=="undefined")document.removeEventListener("visibilitychange",this.onVisibilityChange);
    this.stopSpray();
    this.vehicle?.dispose();
    this.vehicle = null;
    this.robots?.dispose();
    this.robots = null;
    this.ambience?.dispose();
    this.ambience = null;
    this.impacts?.dispose();
    this.impacts = null;
    for (const a of this.active) this.stopEffect(a);
    this.music?.dispose();
    this.music = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.buses.clear();
    this.buffers.clear();
    this.bytes.clear();
    this.unlocked = false;
  }

  private startMusic(): void {
    const ctx = this.ctx, bus = this.buses.get("music");
    if (!ctx || !bus || this.music || this.musicTracks.length === 0 || typeof Audio === "undefined") return;
    try {
      this.music = new MusicPlayer(ctx, bus, this.musicTracks, this.base);
    } catch {
      return;
    }
    if (this.musicTrack !== undefined) this.music.play(this.musicTrack);
    this.music.setDucked(this.musicDucked);
    this.music.setEnabled(this.unlocked && audible(this.prefs, "music"));
  }

  private async decode(id: Sound): Promise<void> {
    const ctx = this.ctx, bytes = this.bytes.get(id);
    if (!ctx || !bytes || this.buffers.has(id)) return;
    try {
      // decodeAudioData detaches its argument: decode a copy.
      const decoded=await ctx.decodeAudioData(bytes.slice(0));
      if(this.disposed||this.ctx!==ctx)return;
      this.buffers.set(id,decoded);
      if (id === "spray" && this.wantSpray) this.startSpray();
    } catch {
      // An undecodable effect stays silent.
    }
  }

  private applyGains(immediate: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    this.master.gain.setTargetAtTime(masterGain(this.prefs), t, 0.02);
    for (const [bus, node] of this.buses) {
      const target = busGain(this.prefs, bus, this.ducked);
      node.gain.cancelScheduledValues(t);
      if (immediate) node.gain.setValueAtTime(target, t);
      else node.gain.setTargetAtTime(target, t, (this.ducked ? DUCK_ATTACK_S : DUCK_RELEASE_S) / 3);
    }
  }

  private startSpray(): void {
    const ctx = this.ctx, bus = this.buses.get("effects"), buffer = this.buffers.get("spray");
    if (this.spray || !ctx || !bus || !buffer || !this.unlocked) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.8;
    source.connect(gain);
    gain.connect(bus);
    source.start();
    this.spray = { source, gain };
    this.played.set("spray", (this.played.get("spray") ?? 0) + 1);
  }

  private stopSpray(): void {
    if (!this.spray) return;
    try {
      this.spray.source.stop();
    } catch {
      // Already stopped.
    }
    this.spray.gain.disconnect();
    this.spray = null;
  }

  private stopEffect(a: ActiveEffect): void {
    try {
      a.source.stop();
    } catch {
      // Already stopped.
    }
    this.active = this.active.filter((x) => x !== a);
  }
}
