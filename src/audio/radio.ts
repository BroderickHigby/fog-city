// The car radio: in a car the music is a station, chosen with M (next) and Shift+M (previous),
// with an Off position. Stations are invented (no real call signs); each plays one track in
// public/audio/music: the four CC0 tracks, then six original hip-hop and pop tracks made in code
// (scripts/audio/compose-radio.ts). The station persists with the audio prefs. Pure.

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
  { id: "cap-table", name: "Cap Table 97.1", tagline: "Boom-bap for the bootstrapped", trackId: "radio-boom-bap" },
  { id: "down-round", name: "Down Round 103.9", tagline: "Trap at a flat valuation", trackId: "radio-trap" },
  { id: "fog-bank", name: "Fog Bank 100.7", tagline: "West Coast bounce, rent-controlled", trackId: "radio-bounce" },
  { id: "unicorn", name: "Unicorn 99.5", tagline: "Four on the floor, a billion post-money", trackId: "radio-dance-pop" },
  { id: "hockey-stick", name: "Hockey Stick 92.3", tagline: "Half-time synth-pop, up and to the right", trackId: "radio-synth-pop" },
  { id: "lock-up", name: "Lock-Up 105.5", tagline: "Disco-pop for the lock-up period", trackId: "radio-nu-disco" },
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
