// The game's audio, as one object main.ts drives: effects, contextual music, mission voices with
// subtitles, preferences and the settings panel. Everything here is presentation: it reads the
// sim state after each step and never feeds anything back, so slow, failed or muted audio
// cannot change what the sim decides.

import type { Mission } from "../content/missions.ts";
import type { SimState } from "../sim/contract.ts";
import { playerPose } from "../sim/ride.ts";
import { agentsRuntimeOf } from "../sim/agents/runtime.ts";
import { agentsOf } from "../sim/agents.ts";
import { hornGain, type HornBlast } from "./horn.ts";
import { panOf } from "./cues.ts";
import { isTextEntry } from "../input/keyboard.ts";
import { mountRadioToast, type MountedRadioToast } from "../ui/radio-toast.ts";
import { RADIO_STATIONS, stationById, tune, type RadioStation } from "./radio.ts";
import { gameplaySnapshot, playerView } from "../sim/player/adapter.ts";
import { RobotChirpClock, robotWhirrs, type SoundingActor } from "./robot-sound.ts";
import { AmbientEventClock, CROWD_M, TRAFFIC_M, ambienceLevels, districtAt, type AmbienceLevels } from "./ambience.ts";
import { InnerVoice } from "./inner-voice.ts";
import { FootstepClock, carOneShots, doorOneShots, engineParams, rideEngineParams } from "./vehicle-sound.ts";
import type { CarState } from "../sim/contract.ts";
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
  /** The sim's weather at a point (src/sim/fog weatherView), for rain, fog and the hour. */
  weather?: (state: SimState, x: number, z: number) => { fog: number; rain: number; sheltered: boolean; hour: number };
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
  music: { trackId: string; paused: boolean; src: string } | null;
  musicTracks: number;
  musicSwitches: number;
  /** The car's live engine sound is running. */
  engine: boolean;
  /** Robots whose servos are audible now. */
  robotVoices: number;
  /** The ambience layer levels now (null before the first sample). */
  ambience: AmbienceLevels | null;
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
   * One horn blast (src/audio/horn.ts hornBlasts, per stepped frame): any player's, heard from
   * the local player, through the effects bus. Presentation only.
   */
  playHorn(blast: HornBlast): void;
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
/**
 * Combat events that mean the local player is in a robot fight. Never robot.alert, robot.wary,
 * robot.blinded or robot.glance: those fire for one firmware only, so music following them would
 * tell the player which robots are bad.
 */
export const FIGHT_EVENTS: ReadonlySet<string> = new Set(["robot.seized", "robot.slumping", "robot.heap", "robot.knockdown", "player.stumble", "player.handshake"]);
const VOICE_EVENT_LOG = 64;

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
  /** The context the station card last announced (the card shows on entering "driving"). */
  let announced: MusicContext | null = null;
  let now = 0;
  let listener = { x: 0, z: 0, heading: 0 };
  // The player's car and mode last frame, for engine load, impacts, landings and doors.
  let prevCar: CarState | null = null;
  let prevRideSpeed: number | null = null;
  let prevMode: string | undefined;
  let lastFrameMs: number | null = null;
  const footsteps = new FootstepClock();
  const chirps = new RobotChirpClock();
  const ambientEvents = new AmbientEventClock();
  let ambience: AmbienceLevels | null = null;
  let ambienceFog = 0;
  let nextAmbienceMs = 0;
  // Last-seen values for one-shot UI and game cues (null: not yet seen, so nothing plays on load).
  let lastMissionKey: string | null = null;
  let lastMissionStatus: string | null = null;
  let lastCash: number | null = null;
  let lastScanTick: number | null = null;
  let phoneOpen = false;
  const onClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (target?.closest?.(".fc-ui button")) mixer.playSynth("click", 0.6);
  };
  if (typeof document !== "undefined") document.addEventListener("click", onClick, true);
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
    // Tuning works in menus too; only typing in a text field is left alone.
    if (!inCar || isTextEntry(event.target)) return;
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
      const body = player ? playerPose(player) : undefined;
      listener = { x: body?.x ?? 0, z: body?.z ?? 0, heading: body?.heading ?? 0 };
      const combat = state.ext.combat;
      // Effects.
      const spraying = !frame.paused && !!combat?.projectiles.some((p) => p.ownerId === playerId && p.kind === "water" && p.bornTick >= combat.tick - 12);
      mixer.setSpray(spraying);
      mixer.setPaused(frame.paused);
      // The car (engine, road, tyres, impacts), the doors and footsteps.
      const dtS = lastFrameMs === null ? 0 : Math.min(0.25, Math.max(0, (frame.nowMs - lastFrameMs) / 1000));
      lastFrameMs = frame.nowMs;
      if (player && !frame.paused) {
        // Riding a robotaxi, the taxi's motor is heard; the player's own car is parked elsewhere.
        const ride = player.ride ?? null;
        mixer.setEngine(ride ? rideEngineParams(ride.speed, prevRideSpeed, dtS) : inCar ? engineParams(player.car, prevCar, dtS) : null);
        if (inCar && !ride) for (const s of carOneShots(player.car, prevCar)) mixer.play({ sound: s.sound, gain: s.gain, pan: 0, rate: s.rate });
        for (const s of doorOneShots(prevMode, player.mode)) mixer.play({ sound: s.sound, gain: s.gain, pan: 0, delayS: s.delayS });
        const step = footsteps.update(onFoot ? player.foot : null, dtS);
        if (step) mixer.play({ sound: `step-${step.variant}`, gain: step.gain, pan: 0, rate: 0.94 + 0.03 * step.variant });
      } else mixer.setEngine(null);
      prevCar = player ? { ...player.car } : null;
      prevRideSpeed = player?.ride?.speed ?? null;
      prevMode = player?.mode;
      const runtime = agentsRuntimeOf(state);
      const actors: HummingActor[] & SoundingActor[] = runtime ? Object.values(runtime.actors) : [];
      // City ambience: traffic, crowd, wind and rain, sampled four times a second; foghorns and gulls.
      if (frame.paused) mixer.setAmbience(null);
      else {
        if (frame.nowMs >= nextAmbienceMs) {
          nextAmbienceMs = frame.nowMs + 250;
          const vehiclesNear: number[] = [], peopleNear: number[] = [];
          for (const a of agentsOf(state)) {
            const d = Math.hypot(a.x - listener.x, a.z - listener.z);
            if (a.kind === "robotaxi" && d <= TRAFFIC_M) vehiclesNear.push(d);
            else if (a.kind === "person" && d <= CROWD_M) peopleNear.push(d);
          }
          for (const a of runtime ? Object.values(runtime.actors) : []) {
            if (a.retired) continue;
            const d = Math.hypot(a.x - listener.x, a.z - listener.z);
            if ((a.model === "robotaxi" || a.model === "van" || a.model === "bus") && d <= TRAFFIC_M) vehiclesNear.push(d);
            else if ((a.model === "person" || a.model === "associate" || a.model === "walker") && d <= CROWD_M) peopleNear.push(d);
          }
          const weather = options.weather?.(state, listener.x, listener.z) ?? null;
          ambienceFog = weather?.fog ?? 0;
          ambience = ambienceLevels({ vehiclesNear, peopleNear, district: districtAt(listener.x, listener.z), weather, inCar });
        }
        if (ambience) {
          mixer.setAmbience(ambience);
          for (const e of ambientEvents.update(ambience, ambienceFog, frame.nowMs / 1000)) mixer.playAmbientEvent(e);
        }
      }
      // Robots: the nearest servos whirr, each model beeps on its own rhythm, and the tryCarDoors
      // tell chimes "pairing...". Nothing reads firmware (robot-sound.ts).
      const inactive = (id: string): boolean => { const phase = combat?.targets[id]?.phase; return !!phase && phase !== "active"; };
      mixer.setRobots(frame.paused ? [] : robotWhirrs(actors, listener, inactive));
      if (!frame.paused)
        for (const c of chirps.update(actors, listener, inactive, frame.nowMs)) {
          if (c.kind === "pairing") mixer.playSynth("pairing", c.gain, c.pan);
          else mixer.playBeep(c.notes, c.gain, c.pan);
        }
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
      // Stingers: a mission starting and completing. Money: cash going up. The scanner's verdict.
      const missionKey = missions?.missionId ?? "";
      if (lastMissionKey !== null && missionKey && missionKey !== lastMissionKey && missions?.status === "active") mixer.playSynth("mission-start", 0.7);
      if (lastMissionStatus !== null && missions?.status === "complete" && lastMissionStatus !== "complete") mixer.playSynth("mission-complete", 0.8);
      lastMissionKey = missionKey;
      lastMissionStatus = missions?.status ?? "";
      const cash = playerView(snapshot, playerId).cashCents;
      if (lastCash !== null && cash >= lastCash + 100) mixer.playSynth("money", 0.6);
      lastCash = cash;
      const scan = combat?.players[playerId]?.scan;
      if (scan && lastScanTick !== null && scan.tick !== lastScanTick) mixer.playSynth(scan.bad ? "scan-bad" : "scan-good", 0.6);
      lastScanTick = scan?.tick ?? (lastScanTick ?? -1);
      const phoneNow = typeof document !== "undefined" && !!document.querySelector(".fc-phone-apps");
      if (phoneNow && !phoneOpen) mixer.playSynth("phone", 0.6);
      phoneOpen = phoneNow;
      const mission = missions ? options.missions.find((m) => m.id === missions.missionId) : undefined;
      const step = mission?.steps.find((s) => s.id === missions?.stepId);
      const missionUrgent = missions?.status === "active" && !!step && ((step.type === "goto") || (step.type === "objective" && step.timeLimitS !== undefined));
      // Menus and dialogs duck the music; they never switch it (a mission dialog must not cut the track).
      mixer.setMusicDucked(frame.paused);
      const nextContext = musicTracker.update({ menu: frame.paused, onFoot, missionUrgent, combat: fight }, frame.nowMs);
      // Tuning in as the player gets into a car, or as audio unlocks in one.
      const unlocked = mixer.isUnlocked();
      if (nextContext === "driving" && unlocked && announced !== "driving") showStation(stationById(prefs.get().station));
      if (unlocked) announced = nextContext;
      musicContext = nextContext;
      musicTrack = trackFor(musicContext);
      mixer.setMusicTrack(musicTrack);
      toast.update(clock());
      mixer.tick();
      // Voices and subtitles.
      queue.setPaused(frame.paused, frame.nowMs);
      missionVoice.observe(missions, frame.nowMs);
      if (!frame.paused && missions) {
        // The player's inner voice, behind (and interrupted by) the mission's own lines.
        const own = combat?.players[playerId];
        const line = inner.observe({
          missionId: missions.missionId, stepId: missions.stepId, status: missions.status, visits: missions.visits,
          player: body ? { x: body.x, z: body.z } : null,
          salt: own ? own.salt : null,
          badScanTick: own?.scan?.bad ? own.scan.tick : null,
        }, frame.nowMs / 1000);
        if (line) queue.enqueue({ ...missionVoice.item(line, "inner"), priority: PRIORITY.ambient }, frame.nowMs);
      }
      queue.update(frame.nowMs);
      mixer.setVoiceActive(queue.speaking());
      subtitles.update(queue.subtitle(), prefs.get().subtitles);
    },
    playHorn(blast) {
      if (paused) return;
      mixer.playHorn(hornGain(blast, listener), panOf(listener, blast.x, blast.z), blast.inVehicle);
    },
    tuneRadio,
    answered(questionId, answerId) {
      missionVoice.answered(questionId, answerId, now);
    },
    restore(state) {
      missionVoice.reset();
      inner.reset();
      prevCar = null;
      prevRideSpeed = null;
      prevMode = undefined;
      chirps.reset();
      ambientEvents.reset();
      ambience = null;
      nextAmbienceMs = 0;
      lastMissionKey = null;
      lastMissionStatus = null;
      lastCash = null;
      lastScanTick = null;
      lastFrameMs = null;
      footsteps.reset();
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
        music: m.music,
        musicTracks: tracks.length,
        musicSwitches: m.musicSwitches,
        engine: m.engine,
        robotVoices: m.robotVoices,
        ambience: m.ambience,
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
      if (typeof document !== "undefined") document.removeEventListener("click", onClick, true);
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
