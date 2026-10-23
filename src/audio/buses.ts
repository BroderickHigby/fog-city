// Bus gain maths, shared by the Web Audio graph and its tests. Pure.

import type { AudioBus, AudioPrefs } from "./prefs.ts";

/** Music gain while a voice line plays (about -9 dB): the line stays intelligible over the bed. */
export const MUSIC_DUCK = 0.35;
/** Effects dip a little under voice too (about -3 dB). */
export const EFFECTS_DUCK = 0.7;
/** Ramp times, seconds: duck fast, recover slowly so the music swells back after the line. */
export const DUCK_ATTACK_S = 0.12;
export const DUCK_RELEASE_S = 0.6;

/**
 * Slider position (0..1) to linear gain. A squared taper: the ear hears loudness roughly
 * logarithmically, so a linear slider would crowd all the audible change into its bottom end.
 */
export function sliderGain(value: number): number {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return v * v;
}

/** The master gain after mute. */
export function masterGain(prefs: AudioPrefs): number {
  return prefs.masterMuted ? 0 : sliderGain(prefs.master);
}

/** One bus's gain after its mute and, for music and effects, ducking under a playing voice. */
export function busGain(prefs: AudioPrefs, bus: AudioBus, voiceActive: boolean): number {
  const muted = bus === "music" ? prefs.musicMuted : bus === "effects" ? prefs.effectsMuted : prefs.voiceMuted;
  if (muted) return 0;
  const base = sliderGain(prefs[bus]);
  if (!voiceActive) return base;
  return bus === "music" ? base * MUSIC_DUCK : bus === "effects" ? base * EFFECTS_DUCK : base;
}

/** Whether anything on this bus can be heard at all (skip work, and voice falls back to text). */
export function audible(prefs: AudioPrefs, bus: AudioBus): boolean {
  return masterGain(prefs) > 0 && busGain(prefs, bus, false) > 0;
}
