// Audio preferences: per-bus volume and mute, master, subtitles and the car radio station. Presentation only: the sim
// never reads them. Persisted per browser in localStorage; a missing, blocked or corrupt store
// gives the defaults, and every value is clamped on the way in and out.

import { DEFAULT_STATION, RADIO_STATIONS } from "./radio.ts";

export type AudioBus = "music" | "effects" | "voice";
export const AUDIO_BUSES: readonly AudioBus[] = ["music", "effects", "voice"];

export interface AudioPrefs {
  version: 1;
  master: number;
  music: number;
  effects: number;
  voice: number;
  masterMuted: boolean;
  musicMuted: boolean;
  effectsMuted: boolean;
  voiceMuted: boolean;
  /** Show subtitles while a line plays. A line whose audio fails always shows its text. */
  subtitles: boolean;
  /** Car radio station id (radio.ts), "off" included. */
  station: string;
}

export const AUDIO_PREFS_KEY = "fogcity.audio.v1";

export const DEFAULT_AUDIO_PREFS: Readonly<AudioPrefs> = Object.freeze({
  version: 1,
  master: 0.8,
  music: 0.55,
  effects: 0.8,
  voice: 0.9,
  masterMuted: false,
  musicMuted: false,
  effectsMuted: false,
  voiceMuted: false,
  subtitles: true,
  station: DEFAULT_STATION,
});

const unit = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/** Any value to valid prefs: unknown keys dropped, bad values replaced by the defaults. */
export function sanitizeAudioPrefs(raw: unknown): AudioPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_AUDIO_PREFS;
  return {
    version: 1,
    master: unit(r.master, d.master),
    music: unit(r.music, d.music),
    effects: unit(r.effects, d.effects),
    voice: unit(r.voice, d.voice),
    masterMuted: flag(r.masterMuted, d.masterMuted),
    musicMuted: flag(r.musicMuted, d.musicMuted),
    effectsMuted: flag(r.effectsMuted, d.effectsMuted),
    voiceMuted: flag(r.voiceMuted, d.voiceMuted),
    subtitles: flag(r.subtitles, d.subtitles),
    station: typeof r.station === "string" && RADIO_STATIONS.some((s) => s.id === r.station) ? r.station : d.station,
  };
}

/** The storage the prefs live in; `null` (no storage, private mode) keeps them in memory. */
export type PrefsStorage = Pick<Storage, "getItem" | "setItem"> | null;

export function browserStorage(): PrefsStorage {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadAudioPrefs(storage: PrefsStorage): AudioPrefs {
  try {
    const text = storage?.getItem(AUDIO_PREFS_KEY);
    return sanitizeAudioPrefs(text ? JSON.parse(text) : undefined);
  } catch {
    return sanitizeAudioPrefs(undefined);
  }
}

export function saveAudioPrefs(storage: PrefsStorage, prefs: AudioPrefs): void {
  try {
    storage?.setItem(AUDIO_PREFS_KEY, JSON.stringify(sanitizeAudioPrefs(prefs)));
  } catch {
    // Quota or a blocked store: the prefs still apply for this session.
  }
}

/** Live prefs with change listeners: the settings panel writes, the mixer listens. */
export class AudioPrefsStore {
  private value: AudioPrefs;
  private readonly listeners = new Set<(prefs: AudioPrefs) => void>();
  private readonly storage: PrefsStorage;
  constructor(storage: PrefsStorage = browserStorage()) {
    this.storage = storage;
    this.value = loadAudioPrefs(storage);
  }
  get(): AudioPrefs {
    return { ...this.value };
  }
  set(patch: Partial<AudioPrefs>): AudioPrefs {
    this.value = sanitizeAudioPrefs({ ...this.value, ...patch });
    saveAudioPrefs(this.storage, this.value);
    for (const listener of this.listeners) listener(this.get());
    return this.get();
  }
  subscribe(listener: (prefs: AudioPrefs) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
