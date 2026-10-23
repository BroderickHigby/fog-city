// The game's audio, as one object main.ts drives: effects, contextual music, mission voices with
// subtitles, preferences and the settings panel. Everything here is presentation: it reads the
// sim state after each step and never feeds anything back, so slow, failed or muted audio
// cannot change what the sim decides.

import type { Mission } from "../content/missions.ts";
import type { SimState } from "../sim/contract.ts";
import { agentsRuntimeOf } from "../sim/agents/runtime.ts";
import { agentsOf } from "../sim/agents.ts";
import { isTextEntry } from "../input/keyboard.ts";
import { mountRadioToast, type MountedRadioToast } from "../ui/radio-toast.ts";
import { RADIO_STATIONS, stationById, tune, type RadioStation } from "./radio.ts";
import { gameplaySnapshot } from "../sim/player/adapter.ts";
import { capacity } from "../sim/combat/shared.ts";
import type { CombatPlayer } from "../sim/combat-contract.ts";
import { InnerVoice } from "./inner-voice.ts";
import { mountAudioSettings } from "../ui/audio-settings.ts";
import { mountSubtitles, type MountedSubtitles } from "../ui/subtitles.ts";
import { audible } from "./buses.ts";
import { EffectCueTracker, type HummingActor } from "./cues.ts";
import { GameAudio } from "./mixer.ts";
import { MissionVoice } from "./mission-voice.ts";
import { MUSIC_MANIFEST_PATH, MusicContextTracker, type MusicContext, type MusicManifestFile, type MusicTrack } from "./music.ts";
import { AudioPrefsStore, type AudioPrefs } from "./prefs.ts";
import { VOICE_MANIFEST_PATH, type VoiceManifest } from "./voice-lines.ts";
import { PRIORITY, VoiceQueue, type SubtitleView, type VoiceQueueEvent } from "./voice-queue.ts";

export { GameAudio } from "./mixer.ts";
export { AudioPrefsStore } from "./prefs.ts";

export interface GameAudioDirectorOptions {
  /** Where the subtitle overlay mounts (the game container). */
  host: HTMLElement;
  missions: readonly Mission[];
  prefs?: AudioPrefsStore;
  /** URL prefix for audio/ (relative to the page; "" in dev and in the static build). */
  base?: string;
}

export interface AudioFrame {
  state: SimState;
  playerId: string;
  /** A menu or the pause screen is open (the sim is paused). */
  paused: boolean;
  nowMs: number;
}

export interface AudioDebugInfo {
  unlocked: boolean;
  context: string;
  musicContext: MusicContext | null;
  musicTrack: string | null;
  station: string;
  horn: boolean;
  music: { trackId: string; paused: boolean; src: string } | null;
  musicTracks: number;
  effectsLoaded: number;
  effectsPlayed: Record<string, number>;
  voice: { current: string | null; mode: string | null; waiting: string[]; status: string; files: number };
  subtitle: SubtitleView | null;
  subtitleShown: boolean;
  voiceEvents: VoiceQueueEvent[];
  ducked: boolean;
  prefs: AudioPrefs;
  gains: Record<string, number>;
}

export interface GameAudioDirector {
  load(): Promise<void>;
  /** Call from a user gesture (pointerdown / keydown): nothing sounds before it. */
  unlock(): void;
  update(frame: AudioFrame): void;
  /**
   * The local player's horn button is held: call every tick or frame while it is. The horn
   * sounds while calls keep coming (released ~150 ms after the last), only in a car.
   */
  horn(): void;
  /** Tune the car radio (M / Shift+M call this): +1 next station, -1 previous. */
  tuneRadio(step: number): RadioStation;
  /** The player answered a dialogue question (UI callback): the speaker replies. */
  answered(questionId: string, answerId: string): void;
  /** A save restore jumped the game to another moment. */
  restore(state?: SimState): void;
  readonly prefs: AudioPrefsStore;
  /** For the pause screen and the phone's Settings app. */
  mountSettings(doc: Document): { element: HTMLElement; dispose(): void };
  info(): AudioDebugInfo;
  dispose(): void;
}

/** Combat events that mean the local player is in a robot fight. */
const FIGHT_EVENTS = new Set(["robot.seized", "robot.slumping", "robot.heap", "robot.knockdown", "robot.alert", "robot.blinded", "player.stumble", "player.handshake"]);
const VOICE_EVENT_LOG = 64;
/** The horn keeps sounding this long after the last horn() call (frames under load are slow). */
const HORN_HOLD_MS = 150;

declare global {
  interface Window {
    /** Read-only audio diagnostics for tests and the console. */
    __fogcityAudio?: { info(): AudioDebugInfo };
  }
}

export function createGameAudioDirector(options: GameAudioDirectorOptions): GameAudioDirector {
  const base = options.base ?? "";
  const prefs = options.prefs ?? new AudioPrefsStore();
  const mixer = new GameAudio(prefs.get(), base);
  const voiceEvents: VoiceQueueEvent[] = [];
  const queue = new VoiceQueue({
    player: mixer.voicePlayer(),
    canPlay: () => mixer.isUnlocked() && audible(prefs.get(), "voice"),
    onEvent: (event) => {
      voiceEvents.push(event);
      if (voiceEvents.length > VOICE_EVENT_LOG) voiceEvents.shift();
    },
  });
  const missionVoice = new MissionVoice(queue, options.missions);
  const inner = new InnerVoice(options.missions);
  const cues = new EffectCueTracker();
  const musicTracker = new MusicContextTracker();
  const subtitles: MountedSubtitles = mountSubtitles(options.host);
  const toast: MountedRadioToast = mountRadioToast(options.host);
  let manifest: VoiceManifest | null = null;
  let tracks: readonly MusicTrack[] = [];
  let musicContext: MusicContext | null = null;
  let musicTrack: string | null = null;
  let now = 0;
  let hornUntil = Number.NEGATIVE_INFINITY;
  let inCar = false;
  let paused = false;
  const clock = (): number => (typeof performance !== "undefined" ? performance.now() : now);
  const showStation = (station: RadioStation): void => toast.show(station.name, station.tagline, clock());
  /** The track a context plays: in a car the radio station, else the context's own track. */
  const trackFor = (context: MusicContext): string | null =>
    context === "driving" ? stationById(prefs.get().station).trackId : (tracks.find((t) => t.context === context)?.id ?? null);
  const tuneRadio = (step: number): RadioStation => {
    const station = tune(prefs.get().station, step);
    prefs.set({ station: station.id });
    showStation(station);
    if (musicContext === "driving") {
      musicTrack = station.trackId;
      mixer.setMusicTrack(musicTrack);
    }
    return station;
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.code !== "KeyM" || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (paused || !inCar || isTextEntry(event.target)) return;
    tuneRadio(event.shiftKey ? -1 : 1);
  };
  if (typeof window !== "undefined") window.addEventListener("keydown", onKey);
  let lastFightEvent = 0;
  let disposed = false;
  const unsubscribe = prefs.subscribe((p) => mixer.setPrefs(p));

  const fetchJson = async <T>(path: string): Promise<T | null> => {
    try {
      const r = await fetch(base + path);
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  };

  const director: GameAudioDirector = {
    prefs,
    async load() {
      const [voice, music] = await Promise.all([
        fetchJson<VoiceManifest>(VOICE_MANIFEST_PATH),
        fetchJson<MusicManifestFile>(MUSIC_MANIFEST_PATH),
        mixer.load(),
      ]);
      if (disposed) return;
      manifest = voice;
      missionVoice.setManifest(voice);
      tracks = music?.tracks ?? [];
      mixer.setMusicTracks(tracks);
    },
    unlock() {
      mixer.unlock();
    },
    update(frame) {
      now = frame.nowMs;
      const { state, playerId } = frame;
      const player = state.players[playerId];
      const onFoot = player?.mode === "foot" && !!player.foot;
      inCar = !!player && !onFoot;
      paused = frame.paused;
      mixer.setHorn(!frame.paused && inCar && clock() < hornUntil);
      const body = onFoot ? player!.foot! : player?.car;
      const listener = { x: body?.x ?? 0, z: body?.z ?? 0, heading: body?.heading ?? 0 };
      const combat = state.ext.combat;
      // Effects.
      const spraying = !frame.paused && !!combat?.projectiles.some((p) => p.ownerId === playerId && p.kind === "water" && p.bornTick >= combat.tick - 12);
      mixer.setSpray(spraying);
      mixer.setPaused(frame.paused);
      const runtime = agentsRuntimeOf(state);
      const actors: HummingActor[] = runtime ? Object.values(runtime.actors) : [];
      for (const cue of cues.update(combat, listener, actors, frame.nowMs, frame.paused, agentsOf(state))) mixer.play(cue);
      // Music context.
      let fight = spraying;
      for (const e of combat?.events ?? []) {
        if (e.id <= lastFightEvent) continue;
        lastFightEvent = e.id;
        if (FIGHT_EVENTS.has(e.kind) && (e.sourceId === playerId || e.targetId === playerId)) fight = true;
      }
      const snapshot = gameplaySnapshot({ state });
      const missions = snapshot.missions.players[playerId];
      const mission = missions ? options.missions.find((m) => m.id === missions.missionId) : undefined;
      const step = mission?.steps.find((s) => s.id === missions?.stepId);
      const missionUrgent = missions?.status === "active" && !!step && ((step.type === "goto") || (step.type === "objective" && step.timeLimitS !== undefined));
      const nextContext = musicTracker.update({ menu: frame.paused, onFoot, missionUrgent, combat: fight }, frame.nowMs);
      // Tuning in as the player gets into a car (once audio can play).
      if (nextContext === "driving" && musicContext !== "driving" && mixer.isUnlocked()) showStation(stationById(prefs.get().station));
      musicContext = nextContext;
      musicTrack = trackFor(musicContext);
      mixer.setMusicTrack(musicTrack);
      toast.update(clock());
      // Voices and subtitles.
      queue.setPaused(frame.paused, frame.nowMs);
      missionVoice.observe(missions, frame.nowMs);
      if (!frame.paused && missions) {
        // The player's inner voice, behind (and interrupted by) the mission's own lines.
        const own = combat?.players[playerId], progression = snapshot.progression.players[playerId];
        const tank = progression ? capacity({ tankTier: progression.tankTier, perks: progression.perks } as unknown as CombatPlayer) : 0;
        const line = inner.observe({
          missionId: missions.missionId, stepId: missions.stepId, status: missions.status, visits: missions.visits,
          player: body ? { x: body.x, z: body.z } : null,
          water: own && tank > 0 ? own.water / tank : null,
          badScanTick: own?.scan?.bad ? own.scan.tick : null,
        }, frame.nowMs / 1000);
        if (line) queue.enqueue({ ...missionVoice.item(line, "inner"), priority: PRIORITY.ambient }, frame.nowMs);
      }
      queue.update(frame.nowMs);
      mixer.setVoiceActive(queue.speaking());
      subtitles.update(queue.subtitle(), prefs.get().subtitles);
    },
    horn() {
      hornUntil = clock() + HORN_HOLD_MS;
    },
    tuneRadio,
    answered(questionId, answerId) {
      missionVoice.answered(questionId, answerId, now);
    },
    restore(state) {
      missionVoice.reset();
      inner.reset();
      cues.reset(state?.ext.combat);
      lastFightEvent = state?.ext.combat?.events.reduce((m, e) => Math.max(m, e.id), 0) ?? 0;
      musicTracker.reset();
      subtitles.update(null, false);
    },
    mountSettings(doc) {
      return mountAudioSettings(doc, {
        store: prefs,
        stations: RADIO_STATIONS.map((s) => ({ id: s.id, name: s.name })),
        nowPlaying: () => {
          const playing = mixer.info().music;
          const track = playing ? tracks.find((t) => t.id === playing.trackId) : undefined;
          return track ? `"${track.title}" by ${track.author} (${track.licence})` : null;
        },
      });
    },
    info() {
      const m = mixer.info();
      const sub = queue.subtitle();
      return {
        unlocked: m.unlocked,
        context: m.state,
        musicContext,
        musicTrack,
        station: prefs.get().station,
        horn: m.horn,
        music: m.music,
        musicTracks: tracks.length,
        effectsLoaded: m.effectsLoaded,
        effectsPlayed: m.effectsPlayed,
        voice: { ...queue.snapshot(), status: manifest?.status ?? "missing", files: manifest?.lines.filter((l) => l.file).length ?? 0 },
        subtitle: sub,
        subtitleShown: !subtitles.element.hidden,
        voiceEvents: [...voiceEvents],
        ducked: m.ducked,
        prefs: prefs.get(),
        gains: m.gains,
      };
    },
    dispose() {
      disposed = true;
      unsubscribe();
      queue.reset();
      if (typeof window !== "undefined") window.removeEventListener("keydown", onKey);
      toast.dispose();
      subtitles.dispose();
      mixer.dispose();
      if (typeof window !== "undefined" && window.__fogcityAudio?.info === info) delete window.__fogcityAudio;
    },
  };
  const info = (): AudioDebugInfo => director.info();
  if (typeof window !== "undefined") window.__fogcityAudio = { info };
  return director;
}
