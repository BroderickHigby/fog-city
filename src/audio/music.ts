// Contextual music: which track fits the moment (pure, tested), and a streaming two-deck player
// that crossfades between them (browser).
//
// Tracks are never preloaded: a deck's <audio> gets its src only when the track first plays,
// and the browser streams it from there. Each track resumes where it left off when it comes
// back. In a car the radio (radio.ts) picks the track. A track that fails to load (both formats) stays silent; the game carries on.

export type MusicContext = "driving" | "foot" | "mission" | "combat" | "menu";

export interface MusicSignals {
  /** A menu, the phone, the pause screen or a mission dialog is open: the music ducks, never switches. */
  menu: boolean;
  onFoot: boolean;
  /** A timed mission step (a goto or an objective against the clock) is running. */
  missionUrgent: boolean;
  /** The player is spraying, or a robot fight involving them happened this frame. */
  combat: boolean;
}

/** Combat music holds this long after the last combat signal (a pause in a fight is not its end). */
export const COMBAT_HOLD_MS = 12_000;
/** A wanted change must hold this long before the music follows (no flapping at a car door). */
export const SETTLE_MS = 2000;
/** Combat settles faster: it should arrive with the fight. */
export const COMBAT_SETTLE_MS = 400;
/** At least this long between two switches, whatever the signals do. */
export const MIN_DWELL_MS = 6000;
/** Crossfade length: the old track fades out only once the new one is actually playing. */
export const CROSSFADE_S = 3;
/** If the new deck has not started this long after it was asked to, fade anyway. */
export const START_TIMEOUT_MS = 4000;
/** Music volume under a menu or dialog (about -8 dB). */
export const MENU_DUCK = 0.4;

/**
 * The context the moment calls for. Menus never pick a track (they duck whatever plays), so a
 * dialog popping up mid-mission cannot cut the music. In a car the radio plays, whatever is
 * happening outside (radio.ts picks the station).
 */
export function desiredContext(s: Omit<MusicSignals, "menu">, combatHeld: boolean): Exclude<MusicContext, "menu"> {
  if (!s.onFoot) return "driving";
  if (s.combat || combatHeld) return "combat";
  if (s.missionUrgent) return "mission";
  return "foot";
}

/** Signals over time to a context, with the combat hold, the settle delay and a minimum dwell. */
export class MusicContextTracker {
  private lastCombatMs = Number.NEGATIVE_INFINITY;
  private current: Exclude<MusicContext, "menu"> | null = null;
  private candidate: Exclude<MusicContext, "menu"> | null = null;
  private candidateSinceMs = 0;
  private lastSwitchMs = Number.NEGATIVE_INFINITY;

  update(signals: MusicSignals, nowMs: number): Exclude<MusicContext, "menu"> {
    if (signals.combat) this.lastCombatMs = nowMs;
    const want = desiredContext(signals, nowMs - this.lastCombatMs < COMBAT_HOLD_MS);
    if (this.current === null) {
      this.current = want;
      this.lastSwitchMs = nowMs;
      return want;
    }
    if (want === this.current) {
      this.candidate = null;
      return this.current;
    }
    if (this.candidate !== want) {
      this.candidate = want;
      this.candidateSinceMs = nowMs;
    }
    const settle = want === "combat" ? COMBAT_SETTLE_MS : SETTLE_MS;
    if (nowMs - this.candidateSinceMs >= settle && nowMs - this.lastSwitchMs >= MIN_DWELL_MS) {
      this.current = want;
      this.candidate = null;
      this.lastSwitchMs = nowMs;
    }
    return this.current;
  }

  reset(): void {
    this.lastCombatMs = Number.NEGATIVE_INFINITY;
    this.lastSwitchMs = Number.NEGATIVE_INFINITY;
    this.current = null;
    this.candidate = null;
  }
}

/** A context's own track, or "radio": a track only a car radio station plays (radio.ts). */
export type MusicTrackContext = MusicContext | "radio";

export interface MusicTrack {
  id: string;
  context: MusicTrackContext;
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

/** The parts of an <audio> element a deck uses (a fake in tests). */
export interface MusicElement {
  src: string;
  currentSrc?: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  loop: boolean;
  preload: string;
  crossOrigin: string | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  canPlayType(type: string): string;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
}

export interface MusicPlayerOptions {
  base?: string;
  /** A new media element (default: new Audio()). */
  createElement?: () => MusicElement;
  /** Connects an element to the deck's gain (default: a MediaElementAudioSourceNode). */
  connect?: (element: MusicElement, gain: GainNode) => void;
  /** Wall clock in ms (default performance.now). */
  now?: () => number;
}

interface Deck {
  element: MusicElement;
  gain: GainNode;
  track: MusicTrack | null;
  failedOgg: boolean;
  /** When this deck was last asked to start (ms), and whether it has started since. */
  askedMs: number;
  started: boolean;
}

/**
 * Two streamed decks through Web Audio gains into the music bus, playing a track by id. A switch
 * starts the new deck, and only once it is actually playing (or START_TIMEOUT_MS passed)
 * crossfades over CROSSFADE_S, so a slow stream never leaves a silent gap. Each track resumes
 * where it left off. A watchdog (tick) restarts a deck the browser paused or stalled.
 */
export class MusicPlayer {
  private readonly decks: [Deck, Deck];
  private active = 0;
  private readonly tracks: Map<string, MusicTrack>;
  private readonly resumeAt = new Map<string, number>();
  private readonly failed = new Set<string>();
  private readonly ctx: AudioContext;
  private readonly duck: GainNode;
  /** The track id asked for ("" = silence), or null before the first request. */
  private playing: string | null = null;
  private enabled = false;
  private ducked = false;
  private readonly base: string;
  private readonly now: () => number;
  /** A crossfade waiting for the new deck to start: the deck to fade out. */
  private pendingFadeOut: Deck | null = null;
  private lastNudgeMs = Number.NEGATIVE_INFINITY;
  /** Switches made, for diagnostics and tests. */
  switches = 0;

  constructor(ctx: AudioContext, bus: AudioNode, tracks: readonly MusicTrack[], options: MusicPlayerOptions | string = {}) {
    const opts: MusicPlayerOptions = typeof options === "string" ? { base: options } : options;
    this.ctx = ctx;
    this.base = opts.base ?? "";
    this.now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.tracks = new Map(tracks.map((t) => [t.id, t]));
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(bus);
    const createElement = opts.createElement ?? (() => new Audio() as unknown as MusicElement);
    const connect = opts.connect ?? ((element, gain) => ctx.createMediaElementSource(element as unknown as HTMLMediaElement).connect(gain));
    const make = (): Deck => {
      const element = createElement();
      element.preload = "none";
      element.loop = true;
      element.crossOrigin = "anonymous";
      const gain = ctx.createGain();
      gain.gain.value = 0;
      connect(element, gain);
      gain.connect(this.duck);
      const deck: Deck = { element, gain, track: null, failedOgg: false, askedMs: 0, started: false };
      element.addEventListener("error", () => this.onError(deck));
      element.addEventListener("playing", () => this.onPlaying(deck));
      // A loop should never end; if a browser ends it anyway, start it over.
      element.addEventListener("ended", () => { if (this.isWanted(deck)) { element.currentTime = 0; void element.play().catch(() => {}); } });
      return deck;
    };
    this.decks = [make(), make()];
  }

  private deck(i: number): Deck {
    return i === 0 ? this.decks[0] : this.decks[1];
  }

  private isWanted(deck: Deck): boolean {
    return this.enabled && this.deck(this.active) === deck && !!deck.track && deck.track.id === this.playing;
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
      this.pendingFadeOut = null;
      return;
    }
    const id = this.playing;
    if (!id) return;
    const deck = this.deck(this.active);
    if (deck.track?.id === id && !this.failed.has(id)) {
      this.ramp(deck, 1, 0.05);
      this.start(deck);
    } else {
      this.playing = null;
      this.play(id);
    }
  }

  /** Duck under a menu or dialog (the track keeps playing; nothing switches). */
  setDucked(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    const t = this.ctx.currentTime;
    this.duck.gain.cancelScheduledValues(t);
    this.duck.gain.setValueAtTime(this.duck.gain.value, t);
    this.duck.gain.linearRampToValueAtTime(on ? MENU_DUCK : 1, t + (on ? 0.25 : 0.8));
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
    this.switches++;
    const track = this.tracks.get(id);
    const playable = !!track && !this.failed.has(id);
    if (this.pendingFadeOut) {
      // A switch while the last one is still buffering: the audible deck is the one waiting to
      // fade out, and the active deck has not started. Never touch the audible deck's stream.
      const audible = this.pendingFadeOut, loading = this.deck(this.active);
      this.pendingFadeOut = null;
      if (audible.track?.id === id || !playable) {
        // Back to what is heard (cancel the switch), or to silence (fade what is heard).
        this.active = this.decks.indexOf(audible);
        this.ramp(loading, 0, 0.3);
        loading.element.pause();
        if (playable) this.ramp(audible, 1, 0.3);
        else this.fadeOut(audible);
        return;
      }
      this.load(loading, track!);
      this.start(loading);
      this.pendingFadeOut = audible;
      return;
    }
    const old = this.deck(this.active);
    if (!playable) {
      // Silence (radio off) or nothing playable: fade out what plays.
      if (old.track) this.fadeOut(old);
      return;
    }
    if (old.track?.id === id) {
      // Back to the track the active deck holds (after a silence): fade it back in where it is.
      this.ramp(old, 1, CROSSFADE_S);
      this.start(old);
      return;
    }
    this.active = 1 - this.active;
    const deck = this.deck(this.active);
    this.load(deck, track!);
    this.start(deck);
    // The old deck keeps playing at full until the new one starts (onPlaying, or the timeout).
    if (old.track && !old.element.paused) {
      if (deck.started && !deck.element.paused) this.crossfade(old, deck);
      else this.pendingFadeOut = old;
    } else this.ramp(deck, 1, CROSSFADE_S);
  }

  /** Point a deck at a track (keeping the position of the one it held), unless it holds it already. */
  private load(deck: Deck, track: MusicTrack): void {
    if (deck.track?.id === track.id) return;
    if (deck.track) this.resumeAt.set(deck.track.id, deck.element.currentTime || 0);
    deck.track = track;
    deck.failedOgg = false;
    deck.started = false;
    deck.element.src = this.base + musicUrl(track, (type) => deck.element.canPlayType(type));
    const resume = this.resumeAt.get(track.id) ?? 0;
    if (resume > 0) deck.element.addEventListener("loadedmetadata", () => { try { deck.element.currentTime = resume % Math.max(1, deck.element.duration || track.durationS); } catch { /* seek refused: start over */ } }, { once: true });
  }

  /** Watchdog: call every frame. Restarts a stalled or browser-paused deck; times out a waiting crossfade. */
  tick(): void {
    const now = this.now();
    const deck = this.deck(this.active);
    if (this.pendingFadeOut && now - deck.askedMs >= START_TIMEOUT_MS) {
      const old = this.pendingFadeOut;
      this.pendingFadeOut = null;
      this.crossfade(old, deck);
    }
    if (this.isWanted(deck) && deck.element.paused && now - this.lastNudgeMs > 2000) {
      this.lastNudgeMs = now;
      void deck.element.play().catch(() => {});
    }
  }

  private start(deck: Deck): void {
    deck.askedMs = this.now();
    void deck.element.play().catch(() => {});
  }

  private onPlaying(deck: Deck): void {
    deck.started = true;
    if (this.deck(this.active) === deck && this.pendingFadeOut) {
      const old = this.pendingFadeOut;
      this.pendingFadeOut = null;
      this.crossfade(old, deck);
    } else if (this.deck(this.active) === deck && deck.gain.gain.value < 1e-3 && this.isWanted(deck)) this.ramp(deck, 1, CROSSFADE_S);
  }

  private crossfade(old: Deck, next: Deck): void {
    this.ramp(next, 1, CROSSFADE_S);
    this.fadeOut(old);
  }

  private fadeOut(deck: Deck): void {
    if (deck.track) this.resumeAt.set(deck.track.id, deck.element.currentTime || 0);
    this.ramp(deck, 0, CROSSFADE_S);
    const el = deck.element, was = deck.track;
    setTimeout(() => {
      // Its track is no longer wanted (another track, or silence): stop streaming it.
      if (deck.track === was && (this.deck(this.active) !== deck || this.playing !== was?.id)) el.pause();
    }, CROSSFADE_S * 1000 + 100);
  }

  private ramp(deck: Deck, to: number, seconds: number): void {
    const t = this.ctx.currentTime;
    deck.gain.gain.cancelScheduledValues(t);
    deck.gain.gain.setValueAtTime(deck.gain.gain.value, t);
    deck.gain.gain.linearRampToValueAtTime(to, t + seconds);
  }

  private onError(deck: Deck): void {
    const track = deck.track;
    if (!track) return;
    if (!deck.failedOgg && deck.element.src.endsWith(track.files.ogg)) {
      deck.failedOgg = true;
      deck.element.src = this.base + track.files.mp3;
      if (this.isWanted(deck)) void deck.element.play().catch(() => {});
      return;
    }
    this.failed.add(track.id);
    // Nothing to fade to: keep whatever was playing.
    if (this.pendingFadeOut && this.deck(this.active) === deck) {
      const old = this.pendingFadeOut;
      this.pendingFadeOut = null;
      this.active = this.decks.indexOf(old);
      this.ramp(old, 1, 0.5);
    }
  }

  dispose(): void {
    for (const d of this.decks) {
      d.element.pause();
      d.element.removeAttribute("src");
      d.element.load();
      d.gain.disconnect();
    }
    this.duck.disconnect();
  }
}
