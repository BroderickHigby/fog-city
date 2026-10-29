// node scripts/audio/compose-radio.ts [--out DIR] [id ...]
//
// Six original car-radio tracks, composed and synthesised in code (scripts/audio/radio-synth.ts):
// three hip-hop (boom-bap, trap, a West Coast bounce) and three pop (four-on-the-floor dance-pop,
// half-time synth-pop, nu-disco). No sample, recording, cover or quotation of anyone else's music
// is used: every note below is written here, every sound is an oscillator or seeded noise.
//
// Each song renders as one seamless loop (a whole number of bars; tails wrap onto the start).
// scripts/audio/build-music.ts calls renderSong for the sources marked "generated" in
// assets/audio/music-sources.json, then normalises and encodes them like the recorded tracks.
// This CLI only writes the raw loops as WAV, for listening before a build (default
// assets/audio/.cache/).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Bus, SR, TAIL_S, bass808, bell, biquad, clap, crash, epiano, hat, kick, lead, master, midi, pad, pingPong, pluck, prng,
  repitch, reverb, riser, samplerColour, shaker, sidechain, snare, synthBass, tom, upright, vibes, vinyl, wav, whistle, wrapTail,
} from "./radio-synth.ts";

export type Genre = "hip-hop" | "pop";

export interface SongMix {
  reverbRoom: number;
  reverbDamp: number;
  /** Ping-pong delay time in sixteenth steps. */
  delaySteps: number;
  delayFeedback: number;
  /** Sidechain depth on the ducked bus (0: none). */
  duckDepth: number;
  /** Sampled-record colour on the colour bus (boom-bap chords). */
  colour?: boolean;
  /** Record crackle level (0: none). */
  vinyl?: number;
}

export interface RadioSong {
  id: string;
  title: string;
  genre: Genre;
  style: string;
  bpm: number;
  bars: number;
  /** Swing as a fraction of a sixteenth that every off-beat sixteenth is late by. */
  swing: number;
  seed: number;
  key: string;
  mix: SongMix;
  compose(s: Score): void;
}

interface PlayOptions { pan?: number; rev?: number; dly?: number; nudge?: number }

/** A step grid over `bars` bars of 16 sixteenths, with the buses the voices are placed on. */
export class Score {
  readonly stepS: number;
  /** One loop period in samples (even, so the sampler's sample-and-hold is periodic). */
  readonly loop: number;
  readonly len: number;
  readonly main: Bus;
  /** Pumped by the sidechain. */
  readonly ducked: Bus;
  /** Coloured by the sampler (wow, grit, band-limit). */
  readonly colour: Bus;
  readonly rev: Bus;
  readonly dly: Bus;
  readonly kicks: number[] = [];
  readonly rand: () => number;
  private readonly memo = new Map<string, unknown>();
  readonly song: RadioSong;
  readonly bars: number;

  constructor(song: RadioSong, bars: number) {
    this.song = song;
    this.bars = bars;
    this.stepS = 60 / song.bpm / 4;
    this.loop = 2 * Math.round((bars * 16 * this.stepS * SR) / 2);
    this.len = this.loop + Math.round(TAIL_S * SR);
    this.main = new Bus(this.len);
    this.ducked = new Bus(this.len);
    this.colour = new Bus(this.len);
    this.rev = new Bus(this.len);
    this.dly = new Bus(this.len);
    this.rand = prng(song.seed);
  }

  /** The sample a step starts on; whole odd sixteenths are swung late. */
  at(bar: number, step: number): number {
    const swung = Number.isInteger(step) && step % 2 === 1 ? this.song.swing : 0;
    return Math.round((bar * 16 + step + swung) * this.stepS * SR);
  }

  /** `steps` sixteenths in seconds. */
  s(steps: number): number {
    return steps * this.stepS;
  }

  cache<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }

  play(bus: Bus, voice: Float32Array, bar: number, step: number, gain: number, o: PlayOptions = {}): void {
    let at = this.at(bar, step) + Math.round((o.nudge ?? 0) * SR);
    // A hit pushed ahead of the first downbeat belongs to the loop's end.
    if (at < 0) at += this.loop;
    bus.add(voice, at, gain, o.pan ?? 0);
    if (o.rev) this.rev.add(voice, at, gain * o.rev, o.pan ?? 0);
    if (o.dly) this.dly.add(voice, at, gain * o.dly, o.pan ?? 0);
  }

  playStereo(bus: Bus, voice: readonly [Float32Array, Float32Array], bar: number, step: number, gain: number, rev = 0): void {
    const at = this.at(bar, step);
    bus.addStereo(voice, at, gain);
    if (rev) this.rev.addStereo(voice, at, gain * rev);
  }

  /** A kick the sidechain follows. */
  pump(bar: number, step: number): void {
    this.kicks.push(this.at(bar, step));
  }
}

/** "x" full, "o" medium, "g" ghost, "." rest: 16 characters to [step, velocity]. */
export function grid(pattern: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "x") out.push([i, 1]);
    else if (c === "o") out.push([i, 0.7]);
    else if (c === "g") out.push([i, 0.35]);
  }
  return out;
}

/** [step, note, length in steps] */
type Line = ReadonlyArray<readonly [number, string, number]>;

const vary = (s: Score, v: number, amount = 0.12): number => v * (1 - amount / 2 + amount * s.rand());

// ---------------------------------------------------------------- 1. boom-bap

const SEED_ROUND_VIBES: Line[] = [
  [[0, "E5", 3], [3, "G5", 1], [4, "A5", 4], [10, "G5", 2], [12, "E5", 4]],
  [[2, "D5", 2], [4, "E5", 2], [6, "C5", 4], [12, "A4", 4]],
  [[0, "C5", 3], [3, "E5", 1], [4, "G5", 4], [10, "E5", 2], [12, "C5", 2], [14, "D5", 2]],
  [[0, "B4", 4], [6, "D5", 2], [8, "G#4", 8]],
  [[0, "E5", 3], [3, "G5", 1], [4, "A5", 4], [10, "G5", 2], [12, "E5", 4]],
  [[2, "D5", 2], [4, "E5", 2], [6, "C5", 4], [12, "A4", 4]],
  [[0, "C5", 3], [3, "E5", 1], [4, "G5", 4], [10, "E5", 2], [12, "C5", 2], [14, "D5", 2]],
  [[0, "B4", 4], [4, "C5", 2], [6, "D5", 2], [8, "E5", 8]],
];

const seedRoundCypher: RadioSong = {
  id: "radio-boom-bap", title: "Seed Round Cypher", genre: "hip-hop", style: "boom-bap", bpm: 90, bars: 16, swing: 0.2, seed: 9011, key: "A minor",
  mix: { reverbRoom: 0.78, reverbDamp: 0.35, delaySteps: 3, delayFeedback: 0.32, duckDepth: 0, colour: true, vinyl: 0.02 },
  compose(s) {
    const K = s.cache("k", () => kick({ from: 150, to: 52, pitchTau: 0.035, ampTau: 0.22, click: 0.25, drive: 2.2, len: 0.5 }, s.rand));
    const S = s.cache("s", () => snare({ tone: 190, toneTau: 0.06, noiseTau: 0.11, hp: 900, lp: 7000, toneMix: 0.35, len: 0.4 }, s.rand));
    const H = [0, 1, 2].map((i) => s.cache(`h${i}`, () => hat(prng(s.song.seed + i), 0.028)));
    const OH = s.cache("oh", () => hat(prng(s.song.seed + 9), 0.16));
    const SH = s.cache("sh", () => shaker(s.rand));
    const chords = [
      { root: "A1", notes: ["G3", "B3", "C4", "E4"] }, // Am9
      { root: "D2", notes: ["F#3", "A3", "C4", "E4"] }, // D9
      { root: "F2", notes: ["E3", "G3", "A3", "C4"] }, // Fmaj9
      { root: "E2", notes: ["G#3", "D4", "G4"] }, // E7#9
    ];
    for (let bar = 0; bar < s.bars; bar++) {
      const b = bar % 16, hook = b >= 8, fill = b % 8 === 7, c = chords[b % 4]!;
      const kicks = fill ? "x.........x..x.." : b % 2 ? "x......o..x...o." : "x......o..x.....";
      for (const [st, v] of grid(kicks)) s.play(s.main, K, bar, st, vary(s, 0.85 * v, 0.08), { nudge: -0.002 });
      for (const [st, v] of grid(fill ? "....x.......x.gx" : hook ? "....x..g....x..." : "....x.......x...")) s.play(s.main, S, bar, st, vary(s, 0.72 * v, 0.08), { rev: 0.12 });
      for (const [st, v] of grid(b % 2 ? "x.o.x.o.x.o.x.og" : "x.o.x.o.x.o.x.o.")) {
        if (st === 14 && b % 4 === 3) continue;
        s.play(s.main, H[(bar + st) % 3]!, bar, st, vary(s, 0.22 * v, 0.2), { pan: 0.25 });
      }
      if (b % 4 === 3) s.play(s.main, OH, bar, 14, 0.12, { pan: 0.25 });
      if (hook) for (const [st] of grid("..x...x...x...x.")) s.play(s.main, SH, bar, st, vary(s, 0.08), { pan: -0.35 });
      // The chopped chord "sample": three hits a bar through the sampler colour.
      for (const [st, len, vel] of [[0, 5, 1], [6, 3, 0.7], [10, 5, 0.85]] as const) {
        for (const nn of c.notes) s.play(s.colour, s.cache(`ep:${nn}:${len}:${vel}`, () => epiano(midi(nn), s.s(len), vel)), bar, st, 0.19, { rev: 0.25 });
      }
      const R = midi(c.root);
      for (const [st, iv, len] of [[0, 0, 5], [7, 0, 2], [10, 7, 3], [13, 12, 2]] as const) {
        if (fill && st === 13) continue;
        s.play(s.main, s.cache(`ub:${R + iv}:${len}`, () => upright(R + iv, s.s(len))), bar, st, 0.4);
      }
      if (hook) for (const [st, nn, len] of SEED_ROUND_VIBES[b - 8]!) s.play(s.main, s.cache(`vb:${nn}:${len}`, () => vibes(midi(nn), s.s(len))), bar, st, 0.25, { pan: 0.3, rev: 0.3, dly: 0.25 });
    }
  },
};

// ---------------------------------------------------------------- 2. trap

const downRoundDrip: RadioSong = {
  id: "radio-trap", title: "Down Round Drip", genre: "hip-hop", style: "trap", bpm: 140, bars: 24, swing: 0, seed: 1403, key: "C minor",
  mix: { reverbRoom: 0.86, reverbDamp: 0.3, delaySteps: 3, delayFeedback: 0.38, duckDepth: 0.35 },
  compose(s) {
    const K = s.cache("k", () => kick({ from: 220, to: 60, pitchTau: 0.02, ampTau: 0.09, click: 0.35, drive: 3, len: 0.25 }, s.rand));
    const CL = s.cache("cl", () => clap(s.rand, 1400, 0.12));
    const SN = s.cache("sn", () => snare({ tone: 210, toneTau: 0.04, noiseTau: 0.09, hp: 1500, lp: 9000, toneMix: 0.25, len: 0.3 }, s.rand));
    const H = [0, 1, 2].map((i) => s.cache(`h${i}`, () => hat(prng(s.song.seed + i), 0.022, 1.1)));
    const OH = s.cache("oh", () => hat(prng(s.song.seed + 7), 0.2, 1.1));
    const chords = [
      { root: "C2", pad: ["C4", "Eb4", "G4"], tones: ["C5", "Eb5", "G5", "Bb5"] }, // Cm7
      { root: "Ab1", pad: ["Ab3", "C4", "Eb4"], tones: ["Ab4", "C5", "Eb5", "G5"] }, // Abmaj7
      { root: "F1", pad: ["F3", "Ab3", "C4"], tones: ["F4", "Ab4", "C5", "Eb5"] }, // Fm7
      { root: "G1", pad: ["G3", "B3", "D4"], tones: ["G4", "B4", "D5", "F5"] }, // G7
    ];
    // The bell motif, written in chord tones (0..3) so it follows the changes.
    const motifA = [[0, 2, 2], [3, 1, 2], [6, 0, 2], [8, 1, 1], [10, 2, 2], [12, 3, 3]] as const;
    const motifB = [[0, 2, 3], [4, 1, 2], [7, 0, 1], [8, 1, 2], [11, 2, 1], [12, 1, 4]] as const;
    for (let bar = 0; bar < s.bars; bar++) {
      const b = bar % 24, second = b % 2 === 1, c = chords[Math.floor(b / 2) % 4]!, R = midi(c.root);
      const full = b >= 8, last = b >= 16, drop = b === 23;
      // 808 and kick.
      const bassLine = second
        ? [[0, 0, 3, undefined], [3, 0, 3, undefined], [8, 12, 2, undefined], [11, 7, 3, 0], [14, 0, 2, undefined]] as const
        : [[0, 0, 6, undefined], [7, 0, 2, undefined], [10, 0, 4, 12]] as const;
      for (const [st, iv, len, to] of bassLine) {
        if (drop && st >= 12) continue;
        const v = s.cache(`808:${R + iv}:${len}:${to === undefined ? "" : R + to}`, () => bass808(R + iv, s.s(len), to === undefined ? {} : { glideTo: R + to, glideAt: s.s(1.5), glideS: 0.07 }));
        s.play(s.main, v, bar, st, 0.45);
        if (iv !== 12) { s.play(s.main, K, bar, st, 0.75); s.pump(bar, st); }
      }
      // Clap and snare on beat 3 (half-time).
      s.play(s.main, CL, bar, 8, 0.5, { rev: 0.15 });
      s.play(s.main, SN, bar, 8, 0.35);
      if (b % 4 === 3 && !drop) s.play(s.main, CL, bar, 15, 0.22);
      // Hats: eighths, sixteenths, sextuplet and 32nd rolls.
      const hats: Array<[number, number, number]> = [];
      for (let st = 0; st < 12; st += 2) hats.push([st, st % 4 ? 0.6 : 1, 1]);
      if (b % 8 === 7 || (last && b % 4 === 3)) for (let k = 0; k < 8; k++) hats.push([12 + k * 0.5, 0.5 + k * 0.06, 1 + k * 0.05]);
      else if (b % 4 === 3) for (let k = 0; k < 6; k++) hats.push([12 + (k * 2) / 3, 0.75, 1]);
      else if (second || last) for (let st = 12; st < 16; st++) hats.push([st, st % 2 ? 0.55 : 0.85, 1]);
      else hats.push([12, 1, 1], [14, 0.6, 1]);
      for (const [st, v, pitch] of hats) {
        const h = H[Math.floor(st * 2) % 3]!;
        s.play(s.main, pitch === 1 ? h : s.cache(`hp:${pitch}`, () => repitch(h, pitch)), bar, st, vary(s, 0.2 * v, 0.15), { pan: 0.2 });
      }
      if (b % 4 === 1) s.play(s.main, OH, bar, 6, 0.1, { pan: 0.2 });
      // The bell.
      for (const [st, t, len] of second ? motifB : motifA) {
        const note = midi(c.tones[t]!);
        s.play(s.main, s.cache(`bell:${note}:${len}`, () => bell(note, s.s(len))), bar, st, 0.2, { pan: -0.2, rev: 0.3, dly: 0.3 });
        if (last) s.play(s.main, s.cache(`bell:${note + 12}:${len}`, () => bell(note + 12, s.s(len))), bar, st, 0.06, { pan: 0.35, rev: 0.4 });
      }
      // Pad and slow lead from bar 8.
      if (full && !second) s.playStereo(s.ducked, s.cache(`pad:${c.root}`, () => pad(c.pad.map(midi), s.s(32), { cutoff: 1400, attack: 0.3, release: 0.6, seed: R })), bar, 0, 0.35, 0.3);
      if (full && b < 16) {
        const top = midi(c.tones[second ? 1 : 2]!) + 12, from = second ? midi(c.tones[2]!) + 12 : undefined;
        s.play(s.main, s.cache(`ld:${top}:${from}`, () => lead(top, s.s(14), { wave: "saw", cutoff: 2400, vibrato: 0.25, glideFrom: from, glideS: 0.12, attack: 0.05, release: 0.3 })), bar, 0, 0.1, { pan: 0.15, rev: 0.35, dly: 0.3 });
      }
    }
  },
};

// ---------------------------------------------------------------- 3. West Coast bounce

const BOUNCE_WHISTLE: Line[] = [
  [[0, "C6", 6], [6, "Eb6", 2], [8, "F6", 8]],
  [[0, "Eb6", 4], [4, "D6", 4], [8, "C6", 6], [14, "Bb5", 2]],
  [[0, "C6", 8], [8, "Ab5", 4], [12, "G5", 4]],
  [[0, "F5", 12]],
  [[0, "Ab5", 4], [4, "C6", 4], [8, "Eb6", 8]],
  [[0, "Eb6", 4], [4, "Db6", 4], [8, "C6", 8]],
  [[0, "C6", 6], [6, "Ab5", 2], [8, "G5", 4], [12, "F5", 4]],
  [[0, "F5", 8]],
];

const outerSunsetBounce: RadioSong = {
  id: "radio-bounce", title: "Outer Sunset Bounce", genre: "hip-hop", style: "West Coast bounce", bpm: 96, bars: 16, swing: 0.14, seed: 9602, key: "F minor",
  mix: { reverbRoom: 0.8, reverbDamp: 0.3, delaySteps: 3, delayFeedback: 0.3, duckDepth: 0 },
  compose(s) {
    const K = s.cache("k", () => kick({ from: 170, to: 50, pitchTau: 0.03, ampTau: 0.2, click: 0.2, drive: 2.4, len: 0.45 }, s.rand));
    const SN = s.cache("sn", () => snare({ tone: 175, toneTau: 0.05, noiseTau: 0.13, hp: 700, lp: 6500, toneMix: 0.3, len: 0.45 }, s.rand));
    const CL = s.cache("cl", () => clap(s.rand, 1100, 0.15));
    const H = [0, 1, 2].map((i) => s.cache(`h${i}`, () => hat(prng(s.song.seed + i), 0.03, 0.9)));
    const prog = [
      { root: "F1", notes: ["Ab3", "C4", "Eb4", "G4"] }, // Fm9
      { root: "Bb1", notes: ["Ab3", "C4", "D4", "F4"] }, // Bb9
      { root: "F1", notes: ["Ab3", "C4", "Eb4", "G4"] },
      { root: "Bb1", notes: ["Ab3", "C4", "D4", "F4"] },
      { root: "Db2", notes: ["F3", "Ab3", "C4", "Eb4"] }, // Dbmaj9
      { root: "C2", notes: ["E3", "Bb3", "Eb4"] }, // C7#9
      { root: "F1", notes: ["Ab3", "C4", "Eb4", "G4"] },
      { root: "Bb1", notes: ["Ab3", "C4", "D4", "F4"] },
    ];
    const bassLine = [[0, 0, 3], [3, 12, 1], [5, 0, 2], [8, 7, 2], [10, 10, 1], [11, 12, 2], [14, 7, 2]] as const;
    for (let bar = 0; bar < s.bars; bar++) {
      const b = bar % 16, hook = b >= 8, c = prog[b % 8]!, R = midi(c.root);
      for (const [st, v] of grid(b % 4 === 3 ? "x..x......x.x.x." : "x..x......x..x..")) s.play(s.main, K, bar, st, vary(s, 0.8 * v, 0.06));
      for (const st of [4, 12]) { s.play(s.main, SN, bar, st, 0.45, { rev: 0.15 }); s.play(s.main, CL, bar, st, 0.4, { rev: 0.2 }); }
      for (const [st, v] of grid("xgogxgogxgogxgog")) s.play(s.main, H[(bar + st) % 3]!, bar, st, vary(s, 0.18 * v, 0.2), { pan: -0.2 });
      let prev: number | undefined;
      for (const [st, iv, len] of bassLine) {
        const note = R + iv, from = iv === 12 || iv === 10 ? prev : undefined;
        s.play(s.main, s.cache(`sb:${note}:${len}:${from}`, () => synthBass(note, s.s(len), { wave: "saw", cutoff: 280, envAmt: 1400, decay: 0.09, q: 2.2, sub: 0.55, glideFrom: from, glideS: 0.05 })), bar, st, 0.32);
        prev = note;
      }
      for (const [st, len, vel] of [[2, 3, 0.7], [6, 2, 0.5], [10, 4, 0.75]] as const) {
        for (const nn of c.notes) s.play(s.main, s.cache(`ep:${nn}:${len}:${vel}`, () => epiano(midi(nn), s.s(len), vel)), bar, st, 0.12, { pan: 0.2, rev: 0.25 });
      }
      s.playStereo(s.main, s.cache(`pad:${b % 8}`, () => pad(c.notes.map((n) => midi(n) + 12), s.s(16), { voices: 3, detune: 0.08, cutoff: 1900, attack: 0.15, release: 0.4, seed: 70 + b % 8 })), bar, 0, hook ? 0.22 : 0.14, 0.3);
      if (hook) {
        let last: number | undefined;
        for (const [st, nn, len] of BOUNCE_WHISTLE[b - 8]!) {
          const note = midi(nn), from = st === 0 ? undefined : last;
          s.play(s.main, s.cache(`wh:${note}:${len}:${from}`, () => whistle(note, s.s(len), from)), bar, st, 0.16, { pan: 0.25, rev: 0.4, dly: 0.3 });
          last = note;
        }
      }
    }
  },
};

// ---------------------------------------------------------------- 4. dance-pop

const UP_RIGHT_HOOK: Line[] = [
  [[0, "A4", 2], [2, "A4", 1], [3, "C5", 2], [5, "D5", 3], [8, "F5", 2], [10, "E5", 2], [12, "D5", 2], [14, "C5", 2]],
  [[0, "D5", 4], [4, "C5", 2], [6, "A4", 2], [8, "F4", 4], [12, "G4", 2], [14, "A4", 2]],
  [[0, "C5", 2], [2, "C5", 1], [3, "D5", 2], [5, "F5", 3], [8, "A5", 2], [10, "G5", 2], [12, "F5", 2], [14, "E5", 2]],
  [[0, "G5", 4], [4, "F5", 2], [6, "E5", 2], [8, "C5", 6]],
];

const upAndToTheRight: RadioSong = {
  id: "radio-dance-pop", title: "Up and to the Right", genre: "pop", style: "four-on-the-floor dance-pop", bpm: 122, bars: 24, swing: 0, seed: 1224, key: "F major",
  mix: { reverbRoom: 0.84, reverbDamp: 0.25, delaySteps: 3, delayFeedback: 0.35, duckDepth: 0.55 },
  compose(s) {
    const K = s.cache("k", () => kick({ from: 180, to: 48, pitchTau: 0.025, ampTau: 0.13, click: 0.3, drive: 2.6, len: 0.32 }, s.rand));
    const CL = s.cache("cl", () => clap(s.rand, 1300, 0.13));
    const SN = s.cache("sn", () => snare({ tone: 200, toneTau: 0.04, noiseTau: 0.1, hp: 1200, lp: 9000, toneMix: 0.25, len: 0.3 }, s.rand));
    const H = [0, 1].map((i) => s.cache(`h${i}`, () => hat(prng(s.song.seed + i), 0.02, 1.15)));
    const OH = s.cache("oh", () => hat(prng(s.song.seed + 5), 0.11, 1.1));
    const CR = s.cache("cr", () => crash(s.rand));
    const RS = s.cache("rs", () => riser(s.s(16), s.rand));
    const prog = [
      { root: "D2", notes: ["D4", "F4", "A4"] }, // Dm
      { root: "Bb1", notes: ["D4", "F4", "Bb4"] }, // Bb
      { root: "F2", notes: ["C4", "F4", "A4"] }, // F
      { root: "C2", notes: ["C4", "E4", "G4"] }, // C
    ];
    const arp = [0, 1, 2, 3, 1, 2, 3, 2, 0, 1, 2, 3, 1, 2, 3, 2];
    for (let bar = 0; bar < s.bars; bar++) {
      const b = bar % 24, c = prog[b % 4]!, R = midi(c.root);
      const verse = b < 8, hook = (b >= 8 && b < 16) || b >= 20, breakdown = b >= 16 && b < 20;
      if (b === 0 || b === 8 || b === 20) s.play(s.main, CR, bar, 0, 0.18, { rev: 0.2 });
      if (!breakdown) for (const st of [0, 4, 8, 12]) { s.play(s.main, K, bar, st, 0.8); s.pump(bar, st); }
      if (!breakdown || b === 19) for (const st of [4, 12]) { s.play(s.main, CL, bar, st, 0.45, { rev: 0.18 }); s.play(s.main, SN, bar, st, 0.25); }
      if (b === 19) for (let st = 0; st < 16; st++) s.play(s.main, SN, bar, st, 0.08 + st * 0.012, { rev: 0.2 });
      if (b === 19) s.play(s.main, RS, bar, 0, 0.18, { rev: 0.3 });
      if (!breakdown) {
        for (const [st, v] of grid("gogogogogogogogo")) s.play(s.main, H[st % 2]!, bar, st, vary(s, 0.12 * v, 0.2), { pan: 0.3 });
        for (const st of [2, 6, 10, 14]) s.play(s.main, OH, bar, st, 0.14, { pan: -0.15 });
        for (const st of hook ? [0, 2, 6, 10, 14] : [2, 6, 10, 14]) {
          const note = st === 0 ? R : R + 12;
          s.play(s.ducked, s.cache(`bs:${note}`, () => synthBass(note, s.s(1.6), { wave: "pulse", cutoff: 450, envAmt: 1800, decay: 0.07, q: 1.3, sub: 0.5 })), bar, st, 0.38);
        }
      }
      const cutoff = hook ? 4200 : breakdown ? 1500 : 2300;
      s.playStereo(s.ducked, s.cache(`pad:${b % 4}:${cutoff}`, () => pad(c.notes.map(midi), s.s(16), { cutoff, attack: 0.02, release: 0.25, seed: 300 + b % 4 })), bar, 0, hook ? 0.4 : 0.32, 0.25);
      if (verse || breakdown) {
        const tones = [...c.notes.map((n) => midi(n) + 12), midi(c.notes[0]!) + 24];
        for (let st = 0; st < 16; st++) {
          const note = tones[arp[st]!]!;
          s.play(s.main, s.cache(`pl:${note}`, () => pluck(note, s.s(1.5), { from: 5000, to: 400, decay: 0.12, ampTau: 0.2 })), bar, st, vary(s, 0.11, 0.2), { pan: st % 2 ? 0.35 : -0.35, dly: 0.2 });
        }
      }
      const phrase = UP_RIGHT_HOOK[b % 4]!;
      if (hook) for (const [st, nn, len] of phrase) {
        const note = midi(nn);
        s.play(s.main, s.cache(`ld:${note}:${len}`, () => lead(note, s.s(len), { wave: "mix", cutoff: 5200, vibrato: 0.15 })), bar, st, 0.2, { rev: 0.2, dly: 0.25 });
        if (b >= 12) s.play(s.main, s.cache(`bell:${note + 12}:${len}`, () => bell(note + 12, s.s(len), 2)), bar, st, 0.06, { pan: 0.3, rev: 0.3 });
      }
      if (breakdown) for (const [st, nn, len] of phrase) {
        const note = midi(nn);
        s.play(s.main, s.cache(`bell:${note}:${len}`, () => bell(note, s.s(len), 2)), bar, st, 0.12, { rev: 0.45, dly: 0.35 });
      }
    }
  },
};

// ---------------------------------------------------------------- 5. half-time synth-pop

const DEMO_DAY_HOOK: Line[] = [
  [[0, "F#5", 3], [3, "A5", 3], [6, "F#5", 2], [8, "E5", 4], [12, "D5", 4]],
  [[0, "D5", 2], [2, "E5", 2], [4, "F#5", 6], [10, "E5", 2], [12, "D5", 2], [14, "B4", 2]],
  [[0, "B4", 3], [3, "D5", 3], [6, "G5", 4], [10, "F#5", 2], [12, "E5", 4]],
  [[0, "E5", 6], [6, "A4", 2], [8, "C#5", 4], [12, "E5", 4]],
  [[0, "F#5", 3], [3, "A5", 3], [6, "F#5", 2], [8, "E5", 4], [12, "D5", 4]],
  [[0, "D5", 2], [2, "E5", 2], [4, "F#5", 6], [10, "E5", 2], [12, "D5", 2], [14, "B4", 2]],
  [[0, "B4", 3], [3, "D5", 3], [6, "G5", 4], [10, "F#5", 2], [12, "E5", 4]],
  [[0, "E5", 4], [4, "F#5", 4], [8, "A5", 8]],
];

const demoDayHeart: RadioSong = {
  id: "radio-synth-pop", title: "Demo Day Heart", genre: "pop", style: "half-time synth-pop", bpm: 100, bars: 20, swing: 0, seed: 1005, key: "D major",
  mix: { reverbRoom: 0.88, reverbDamp: 0.2, delaySteps: 3, delayFeedback: 0.4, duckDepth: 0.2 },
  compose(s) {
    const K = s.cache("k", () => kick({ from: 160, to: 50, pitchTau: 0.03, ampTau: 0.16, click: 0.25, drive: 2.2, len: 0.4 }, s.rand));
    const SN = s.cache("sn", () => snare({ tone: 185, toneTau: 0.07, noiseTau: 0.1, hp: 600, lp: 8000, toneMix: 0.3, len: 0.4, gateS: 0.26 }, s.rand));
    const H = [0, 1].map((i) => s.cache(`h${i}`, () => hat(prng(s.song.seed + i), 0.025)));
    const CR = s.cache("cr", () => crash(s.rand));
    const T = ["A2", "F2", "D2", "A1"].map((n) => s.cache(`tom:${n}`, () => tom(midi(n), s.rand)));
    const main = [
      { root: "D2", notes: ["D4", "F#4", "A4"] }, { root: "B1", notes: ["D4", "F#4", "B4"] },
      { root: "G1", notes: ["D4", "G4", "B4"] }, { root: "A1", notes: ["C#4", "E4", "A4"] },
    ];
    const bridge = [
      { root: "E2", notes: ["E4", "G4", "B4"] }, { root: "G1", notes: ["D4", "G4", "B4"] },
      { root: "A1", notes: ["D4", "E4", "A4"] }, { root: "A1", notes: ["C#4", "E4", "A4"] },
    ];
    const arp = [0, 1, 2, 1, 3, 2, 1, 2, 0, 1, 2, 3, 2, 1, 2, 1];
    for (let bar = 0; bar < s.bars; bar++) {
      const b = bar % 20, isBridge = b >= 12 && b < 16, c = (isBridge ? bridge : main)[b % 4]!, R = midi(c.root);
      const hookBar = b >= 4 && b < 12 ? b - 4 : b >= 16 ? b - 16 + 4 : -1;
      if (b === 0 || b === 4 || b === 16) s.play(s.main, CR, bar, 0, 0.16, { rev: 0.25 });
      for (const st of b % 2 ? [0, 7, 10] : [0, 10]) { s.play(s.main, K, bar, st, 0.85); s.pump(bar, st); }
      if (b >= 2) s.play(s.main, SN, bar, 8, 0.6, { rev: 0.45 });
      if (b === 11 || b === 19) T.forEach((t, i) => s.play(s.main, t, bar, 12 + i, 0.4, { pan: 0.4 - i * 0.27, rev: 0.25 }));
      for (const [st, v] of grid("x.o.x.o.x.o.x.o.")) if (!((b === 11 || b === 19) && st >= 12)) s.play(s.main, H[st % 4 ? 1 : 0]!, bar, st, vary(s, 0.13 * v, 0.15), { pan: 0.25 });
      for (let st = 0; st < 16; st += 2) {
        const note = st === 0 || st === 8 ? R : R + 12;
        s.play(s.ducked, s.cache(`bs:${note}`, () => synthBass(note, s.s(1.8), { wave: "saw", cutoff: 380, envAmt: 1500, decay: 0.08, q: 1.1, sub: 0.45 })), bar, st, 0.42);
      }
      const tones = [...c.notes.map((n) => midi(n) + 12), midi(c.notes[1]!) + 24];
      for (let st = 0; st < 16; st++) {
        const note = tones[arp[st]!]!;
        s.play(s.main, s.cache(`pl:${note}`, () => pluck(note, s.s(1.2), { from: 7000, to: 900, decay: 0.08, ampTau: 0.18, wave: "pulse" })), bar, st, vary(s, 0.09, 0.15), { pan: st % 2 ? -0.4 : 0.4, dly: 0.25 });
      }
      if (b >= 4) s.playStereo(s.ducked, s.cache(`pad:${isBridge}:${b % 4}`, () => pad(c.notes.map(midi), s.s(16), { cutoff: isBridge ? 3600 : 2600, attack: 0.08, release: 0.5, seed: 500 + b % 4 })), bar, 0, 0.3, 0.3);
      if (hookBar >= 0) for (const [st, nn, len] of DEMO_DAY_HOOK[hookBar]!) {
        const note = midi(nn);
        s.play(s.main, s.cache(`ld:${note}:${len}`, () => lead(note, s.s(len), { wave: "saw", cutoff: 4600, vibrato: 0.22, attack: 0.015, release: 0.18 })), bar, st, 0.19, { rev: 0.3, dly: 0.3 });
        if (b >= 16) s.play(s.main, s.cache(`bell:${note + 12}:${len}`, () => bell(note + 12, s.s(len))), bar, st, 0.05, { pan: -0.3, rev: 0.3 });
      }
    }
  },
};

// ---------------------------------------------------------------- 6. nu-disco

const LOCK_UP_HOOK: Line[] = [
  [[0, "B4", 2], [2, "D5", 2], [4, "E5", 4], [10, "D5", 2], [12, "B4", 4]],
  [[0, "C#5", 2], [2, "E5", 2], [4, "F#5", 3], [7, "E5", 1], [8, "C#5", 4], [12, "A4", 4]],
  [[0, "B4", 2], [2, "D5", 2], [4, "E5", 4], [10, "G5", 2], [12, "F#5", 4]],
  [[0, "E5", 4], [4, "C#5", 2], [6, "A4", 2], [8, "B4", 8]],
  [[0, "G5", 4], [4, "E5", 2], [6, "D5", 2], [8, "E5", 6]],
  [[0, "F#5", 4], [4, "D5", 4], [8, "B4", 8]],
  [[0, "E5", 2], [2, "G5", 2], [4, "A5", 4], [10, "G5", 2], [12, "E5", 4]],
  [[0, "F#5", 4], [4, "D#5", 4], [8, "B4", 8]],
];

const lockUpPeriod: RadioSong = {
  id: "radio-nu-disco", title: "Lock-Up Period", genre: "pop", style: "nu-disco pop", bpm: 116, bars: 24, swing: 0.06, seed: 1166, key: "E minor",
  mix: { reverbRoom: 0.8, reverbDamp: 0.3, delaySteps: 3, delayFeedback: 0.3, duckDepth: 0.3 },
  compose(s) {
    const K = s.cache("k", () => kick({ from: 170, to: 52, pitchTau: 0.028, ampTau: 0.14, click: 0.25, drive: 2.3, len: 0.35 }, s.rand));
    const CL = s.cache("cl", () => clap(s.rand, 1250, 0.12));
    const H = [0, 1, 2].map((i) => s.cache(`h${i}`, () => hat(prng(s.song.seed + i), 0.024, 1.05)));
    const OH = s.cache("oh", () => hat(prng(s.song.seed + 4), 0.12, 1.05));
    const SH = s.cache("sh", () => shaker(s.rand));
    const CR = s.cache("cr", () => crash(s.rand));
    const prog = [
      { root: "E2", notes: ["G3", "B3", "D4", "F#4"] }, // Em9
      { root: "A1", notes: ["G3", "C#4", "F#4"] }, // A13
      { root: "E2", notes: ["G3", "B3", "D4", "F#4"] },
      { root: "A1", notes: ["G3", "C#4", "F#4"] },
      { root: "C2", notes: ["E3", "G3", "B3", "D4"] }, // Cmaj9
      { root: "B1", notes: ["A3", "D4", "F#4"] }, // Bm7
      { root: "A1", notes: ["G3", "B3", "C4", "E4"] }, // Am9
      { root: "B1", notes: ["A3", "D#4", "F#4"] }, // B7
    ];
    const octaves = [[0, 0, 1.5], [2, 12, 1.5], [4, 0, 1.5], [6, 12, 1], [7, 12, 1], [8, 0, 1.5], [10, 12, 1.5], [12, 0, 1.5], [14, 12, 1], [15, 10, 1]] as const;
    for (let bar = 0; bar < s.bars; bar++) {
      const b = bar % 24, c = prog[b % 8]!, R = midi(c.root), strings = b >= 8, hook = b >= 8, top = b >= 16;
      if (b === 0 || b === 8 || b === 16) s.play(s.main, CR, bar, 0, 0.15, { rev: 0.2 });
      for (const st of [0, 4, 8, 12]) { s.play(s.main, K, bar, st, 0.78); s.pump(bar, st); }
      for (const st of [4, 12]) s.play(s.main, CL, bar, st, 0.42, { rev: 0.2 });
      for (const [st, v] of grid("xgogxgogxgogxgog")) s.play(s.main, H[(st + bar) % 3]!, bar, st, vary(s, 0.11 * v, 0.2), { pan: 0.3 });
      if (hook) for (const st of [2, 6, 10, 14]) s.play(s.main, OH, bar, st, 0.1, { pan: -0.2 });
      if (top) for (let st = 0; st < 16; st++) s.play(s.main, SH, bar, st, vary(s, st % 2 ? 0.05 : 0.08, 0.2), { pan: -0.4 });
      for (const [st, iv, len] of octaves) {
        const note = R + iv;
        s.play(s.ducked, s.cache(`bs:${note}:${len}`, () => synthBass(note, s.s(len), { wave: "saw", cutoff: 550, envAmt: 2200, decay: 0.06, q: 1.6, sub: 0.35 })), bar, st, 0.3);
      }
      for (const [st] of grid("..x..x.x..x..x.x")) {
        for (const nn of c.notes) {
          const note = midi(nn) + 12;
          s.play(s.main, s.cache(`clav:${note}`, () => pluck(note, s.s(1), { from: 3200, to: 700, decay: 0.05, q: 3, wave: "pulse", ampTau: 0.12 })), bar, st, vary(s, 0.055, 0.2), { pan: -0.3 });
        }
      }
      if (strings) s.playStereo(s.ducked, s.cache(`pad:${b % 8}`, () => pad(c.notes.map((n) => midi(n) + 12), s.s(16), { cutoff: 3000, attack: 0.25, release: 0.5, seed: 800 + b % 8 })), bar, 0, 0.3, 0.3);
      if (hook) for (const [st, nn, len] of LOCK_UP_HOOK[b % 8]!) {
        const note = midi(nn);
        s.play(s.main, s.cache(`ld:${note}:${len}`, () => lead(note, s.s(len), { wave: "saw", cutoff: 3800, vibrato: 0.18, brass: true, release: 0.15 })), bar, st, 0.17, { pan: 0.1, rev: 0.25, dly: 0.2 });
        if (top) s.play(s.main, s.cache(`bell:${note + 12}:${len}`, () => bell(note + 12, s.s(len), 2)), bar, st, 0.06, { pan: 0.35, rev: 0.3 });
      }
    }
  },
};

export const RADIO_SONGS: readonly RadioSong[] = [seedRoundCypher, downRoundDrip, outerSunsetBounce, upAndToTheRight, demoDayHeart, lockUpPeriod];

export function songById(id: string): RadioSong {
  const song = RADIO_SONGS.find((s) => s.id === id);
  if (!song) throw new Error(`no radio song ${id}`);
  return song;
}

/** Loop length in seconds of a song's full form. */
export const loopSeconds = (song: RadioSong): number => (2 * Math.round((song.bars * 16 * (60 / song.bpm / 4) * SR) / 2)) / SR;

export interface RenderedSong { left: Float32Array; right: Float32Array; loopSamples: number }

/** Render one loop period of a song (or its first `bars` bars, as their own loop, for tests). */
export function renderSong(song: RadioSong, bars = song.bars): RenderedSong {
  const s = new Score(song, bars);
  song.compose(s);
  if (song.mix.duckDepth > 0) sidechain(s.ducked, s.kicks, s.loop, song.mix.duckDepth);
  if (song.mix.colour) samplerColour(s.colour, s.loop);
  const wet = reverb(s.rev, song.mix.reverbRoom, song.mix.reverbDamp);
  const echo = pingPong(s.dly, Math.round(song.mix.delaySteps * s.stepS * SR), song.mix.delayFeedback);
  const crackle = song.mix.vinyl ? vinyl(s.len, s.loop, prng(song.seed + 77), song.mix.vinyl) : null;
  const L = new Float32Array(s.len), R = new Float32Array(s.len);
  for (const bus of [s.main, s.ducked, s.colour, wet, echo, ...(crackle ? [crackle] : [])]) {
    for (let i = 0; i < s.len; i++) { L[i] = L[i]! + bus.l[i]!; R[i] = R[i]! + bus.r[i]!; }
  }
  // Linear filters before the wrap, so the seam stays exact.
  biquad(L, "highpass", 28, 0.7);
  biquad(R, "highpass", 28, 0.7);
  const left = wrapTail(L, s.loop), right = wrapTail(R, s.loop);
  master(left, right);
  return { left, right, loopSamples: s.loop };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1]! : join(import.meta.dirname, "..", "..", "assets", "audio", ".cache");
  const ids = args.filter((a, i) => !a.startsWith("--") && i !== outAt + 1);
  mkdirSync(out, { recursive: true });
  for (const song of RADIO_SONGS) {
    if (ids.length && !ids.includes(song.id)) continue;
    const t0 = performance.now();
    const r = renderSong(song);
    writeFileSync(join(out, `${song.id}.wav`), wav(r.left, r.right));
    console.log(`${song.id}: "${song.title}" (${song.style}, ${song.bpm} BPM, ${song.key}) ${(r.loopSamples / SR).toFixed(2)} s in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
}
