// The car radio: in a car the music is a station, chosen with M (next) and Shift+M (previous),
// with an Off position. Stations are invented (no real call signs); each plays one of the CC0
// tracks in public/audio/music. The station persists with the audio prefs. Pure.

export interface RadioStation {
  id: string;
  /** Shown when tuning in ("Runway FM 88.5"). */
  name: string;
  /** Genre line under the name. */
  tagline: string;
  /** A track id in public/audio/music/manifest.json; null for Off. */
  trackId: string | null;
}

export const RADIO_STATIONS: readonly RadioStation[] = [
  { id: "runway", name: "Runway FM 88.5", tagline: "Funk for founders with 18 months left", trackId: "drive" },
  { id: "series-a", name: "Series A 101.3", tagline: "Synthwave, fully diluted", trackId: "menu" },
  { id: "pivot", name: "Pivot 94.9", tagline: "Electro for when the roadmap changes", trackId: "foot" },
  { id: "burn-rate", name: "Burn Rate 107.7", tagline: "Hard business synth, all day", trackId: "mission" },
  { id: "off", name: "Radio off", tagline: "Just the fog", trackId: null },
];

export const DEFAULT_STATION = "runway";

export function stationById(id: string | undefined): RadioStation {
  return RADIO_STATIONS.find((s) => s.id === id) ?? RADIO_STATIONS[0]!;
}

/** The station `step` places along the dial from `id`, wrapping (Off included). */
export function tune(id: string, step: number): RadioStation {
  const n = RADIO_STATIONS.length;
  const i = Math.max(0, RADIO_STATIONS.findIndex((s) => s.id === id));
  return RADIO_STATIONS[(((i + step) % n) + n) % n]!;
}
