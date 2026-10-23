// Contextual music: which track fits the moment (pure, tested), and a streaming two-deck player
// that crossfades between them (browser).
//
// Tracks are never preloaded: a deck's <audio> gets its src only when the track first plays,
// and the browser streams it from there. Each track resumes where it left off when it comes
// back. In a car the radio (radio.ts) picks the track. A track that fails to load (both formats) stays silent; the game carries on.

export type MusicContext = "driving" | "foot" | "mission" | "combat" | "menu";

export interface MusicSignals {
  /** A menu, the phone or the pause screen is open. */
  menu: boolean;
  onFoot: boolean;
  /** A timed mission step (a goto or an objective against the clock) is running. */
  missionUrgent: boolean;
  /** The player is spraying, or a robot fight involving them happened this frame. */
  combat: boolean;
}

/** Combat music holds this long after the last combat signal. */
export const COMBAT_HOLD_MS = 9000;
/** Any other change must hold this long before the music follows (no flapping at a car door). */
export const SETTLE_MS = 1500;
export const CROSSFADE_S = 1.6;

export function desiredContext(s: MusicSignals, combatHeld: boolean): MusicContext {
  if (s.menu) return "menu";
  // In a car the radio plays, whatever is happening outside (radio.ts picks the station).
  if (!s.onFoot) return "driving";
  if (s.combat || combatHeld) return "combat";
  if (s.missionUrgent) return "mission";
  return "foot";
}

/** Signals over time to a context, with the combat hold and the settle delay. */
export class MusicContextTracker {
  private lastCombatMs = Number.NEGATIVE_INFINITY;
  private current: MusicContext | null = null;
  private candidate: MusicContext | null = null;
  private candidateSinceMs = 0;

  update(signals: MusicSignals, nowMs: number): MusicContext {
    if (signals.combat) this.lastCombatMs = nowMs;
    const want = desiredContext(signals, nowMs - this.lastCombatMs < COMBAT_HOLD_MS);
    if (this.current === null || want === this.current) {
      this.current = want;
      this.candidate = null;
      return want;
    }
    // Menus open instantly and combat cuts in at once; everything else settles first.
    if (want === "menu" || this.current === "menu" || want === "combat") {
      this.current = want;
      this.candidate = null;
      return want;
    }
    if (this.candidate !== want) {
      this.candidate = want;
      this.candidateSinceMs = nowMs;
    }
    if (nowMs - this.candidateSinceMs >= SETTLE_MS) {
      this.current = want;
      this.candidate = null;
    }
    return this.current;
  }

  reset(): void {
    this.lastCombatMs = Number.NEGATIVE_INFINITY;
    this.current = null;
    this.candidate = null;
  }
}

export interface MusicTrack {
  id: string;
  context: MusicContext;
  title: string;
  author: string;
  licence: string;
  files: { ogg: string; mp3: string };
  durationS: number;
}

export interface MusicManifestFile {
  version: 1;
  tracks: MusicTrack[];
}

export const MUSIC_MANIFEST_PATH = "audio/music/manifest.json";

/** Ogg Opus where the browser plays it, else the MP3. */
export function musicUrl(track: MusicTrack, canPlayType: (type: string) => string): string {
  return canPlayType('audio/ogg; codecs="opus"') ? track.files.ogg : track.files.mp3;
}

interface Deck {
  element: HTMLAudioElement;
  gain: GainNode;
  track: MusicTrack | null;
  failedOgg: boolean;
}

/** Two <audio> decks through Web Audio gains into the music bus, playing a track by id. */
export class MusicPlayer {
  private readonly decks: [Deck, Deck];
  private active = 0;
  private readonly tracks: Map<string, MusicTrack>;
  private readonly resumeAt = new Map<string, number>();
  private readonly failed = new Set<string>();
  private readonly ctx: AudioContext;
  /** The track id asked for ("" = silence), or null before the first request. */
  private playing: string | null = null;
  private enabled = false;
  private readonly base: string;

  constructor(ctx: AudioContext, bus: AudioNode, tracks: readonly MusicTrack[], base = "") {
    this.ctx = ctx;
    this.base = base;
    this.tracks = new Map(tracks.map((t) => [t.id, t]));
    const make = (): Deck => {
      const element = new Audio();
      element.preload = "none";
      element.loop = true;
      element.crossOrigin = "anonymous";
      const gain = ctx.createGain();
      gain.gain.value = 0;
      ctx.createMediaElementSource(element).connect(gain);
      gain.connect(bus);
      const deck: Deck = { element, gain, track: null, failedOgg: false };
      element.addEventListener("error", () => this.onError(deck));
      return deck;
    };
    this.decks = [make(), make()];
  }

  private deck(i: number): Deck {
    return i === 0 ? this.decks[0] : this.decks[1];
  }

  /**
   * Music may play (unlocked and audible) or must stop streaming (locked, or muted to silence).
   * Re-enabling resumes the deck that was playing, where it was.
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      for (const d of this.decks) d.element.pause();
      return;
    }
    const id = this.playing;
    if (!id) return;
    const deck = this.deck(this.active);
    if (deck.track?.id === id && !this.failed.has(id)) {
      const t = this.ctx.currentTime;
      deck.gain.gain.cancelScheduledValues(t);
      deck.gain.gain.setValueAtTime(1, t);
      void deck.element.play().catch(() => {});
    } else {
      this.playing = null;
      this.play(id);
    }
  }

  /** The track now heard, for diagnostics. */
  nowPlaying(): { trackId: string; paused: boolean; src: string } | null {
    const d = this.deck(this.active);
    if (!this.playing || !d.track || d.track.id !== this.playing) return null;
    return { trackId: d.track.id, paused: d.element.paused, src: d.element.currentSrc || d.element.src };
  }

  /** Crossfade to a track by id; null fades to silence (radio off). */
  play(trackId: string | null): void {
    const id = trackId ?? "";
    if (id === this.playing) return;
    this.playing = id;
    if (!this.enabled) return;
    const track = this.tracks.get(id);
    const t = this.ctx.currentTime;
    const old = this.deck(this.active);
    if (old.track && old.track.id !== id) {
      this.resumeAt.set(old.track.id, old.element.currentTime || 0);
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setValueAtTime(old.gain.gain.value, t);
      old.gain.gain.linearRampToValueAtTime(0, t + CROSSFADE_S);
      const el = old.element, was = old.track!;
      setTimeout(() => {
        // Its track is no longer wanted (another track, or silence): stop streaming it.
        if (old.track === was && this.playing !== was.id) el.pause();
      }, CROSSFADE_S * 1000 + 100);
    }
    if (!track || this.failed.has(track.id)) return;
    if (old.track?.id === id) {
      // Back to the track the active deck holds (after a silence): fade it back in where it is.
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setValueAtTime(old.gain.gain.value, t);
      old.gain.gain.linearRampToValueAtTime(1, t + CROSSFADE_S);
      void old.element.play().catch(() => {});
      return;
    }
    this.active = 1 - this.active;
    const deck = this.deck(this.active);
    if (deck.track?.id !== track.id) {
      deck.track = track;
      deck.failedOgg = false;
      deck.element.src = this.base + musicUrl(track, (type) => deck.element.canPlayType(type));
      const resume = this.resumeAt.get(track.id) ?? 0;
      if (resume > 0) deck.element.addEventListener("loadedmetadata", () => { try { deck.element.currentTime = resume % Math.max(1, deck.element.duration || track.durationS); } catch { /* seek refused: start over */ } }, { once: true });
    }
    deck.gain.gain.cancelScheduledValues(t);
    deck.gain.gain.setValueAtTime(deck.gain.gain.value, t);
    deck.gain.gain.linearRampToValueAtTime(1, t + CROSSFADE_S);
    void deck.element.play().catch(() => {});
  }

  private onError(deck: Deck): void {
    const track = deck.track;
    if (!track) return;
    if (!deck.failedOgg && deck.element.src.endsWith(track.files.ogg)) {
      deck.failedOgg = true;
      deck.element.src = this.base + track.files.mp3;
      if (this.enabled && this.deck(this.active) === deck) void deck.element.play().catch(() => {});
      return;
    }
    this.failed.add(track.id);
  }

  dispose(): void {
    for (const d of this.decks) {
      d.element.pause();
      d.element.removeAttribute("src");
      d.element.load();
      d.gain.disconnect();
    }
  }
}
