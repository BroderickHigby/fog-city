// The DSP behind the original radio tracks (scripts/audio/compose-radio.ts): oscillators,
// filters, drum and instrument voices, a score that places them on a swung step grid, and the
// mix (sidechain, reverb, ping-pong delay, sampler colour, soft-knee master).
//
// Everything is deterministic: noise comes from a seeded PRNG, and nothing reads the clock.
// A song renders as one loop period. Linear effects run over the loop plus a tail, and the tail
// is then added back onto the loop's start, so the loop's end flows into its start with the
// reverb, the delay and the released notes intact. Time-varying effects (sidechain, wow,
// sample-and-hold) are periodic in the loop, so the wrap stays exact for them too.

export const SR = 48_000;
/** Release tails past the loop end (reverb, delay, long notes) wrap onto the loop's start. */
export const TAIL_S = 6;

const TAU = 2 * Math.PI;

/** mulberry32: a small, fast, seeded PRNG in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTE_OFFSET: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** A note name ("C4", "F#5", "Bb1") to its MIDI number (C4 = 60). */
export function midi(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`not a note: ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE_OFFSET[m[1]!]! + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

export const hz = (note: number): number => 440 * 2 ** ((note - 69) / 12);

function polyblep(t: number, dt: number): number {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

/** Band-limited sawtooth at phase t in [0, 1) with phase step dt. */
export function saw(t: number, dt: number): number {
  return 2 * t - 1 - polyblep(t, dt);
}

/** Band-limited pulse with duty `w` at phase t. */
export function pulse(t: number, dt: number, w = 0.5): number {
  let v = t < w ? 1 : -1;
  v += polyblep(t, dt);
  v -= polyblep((t + 1 - w) % 1, dt);
  return v;
}

/** Topology-preserving state-variable filter (Zavalishin): lp, bp and hp per step. */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  lp = 0;
  bp = 0;
  hp = 0;
  step(x: number, cutoff: number, q: number): void {
    const g = Math.tan((Math.PI * Math.min(Math.max(cutoff, 10), SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - k * v1 - v2;
  }
}

export type BiquadKind = "lowpass" | "highpass" | "bandpass";

/** An RBJ biquad over a whole buffer, in place. */
export function biquad(buf: Float32Array, kind: BiquadKind, freq: number, q: number): Float32Array {
  const w = (TAU * freq) / SR, cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (kind === "lowpass") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else if (kind === "highpass") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; }
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  b0 /= a0; b1 /= a0; b2 /= a0;
  const c1 = a1 / a0, c2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!;
    const y = b0 * x + b1 * x1 + b2 * x2 - c1 * y1 - c2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[i] = y;
  }
  return buf;
}

const samples = (seconds: number): number => Math.max(1, Math.round(seconds * SR));

/** Attack-hold-release gate: 0 -> 1 over `a` s, held until `hold` s, released over `r` s. */
function gate(t: number, a: number, hold: number, r: number): number {
  if (t < a) return t / a;
  if (t < hold) return 1;
  return Math.max(0, 1 - (t - hold) / r);
}

// ---------------------------------------------------------------- drums

export interface KickOptions { from: number; to: number; pitchTau: number; ampTau: number; click: number; drive: number; len: number }

export function kick(o: KickOptions, rand: () => number): Float32Array {
  const n = samples(o.len), out = new Float32Array(n);
  let ph = 0;
  const norm = Math.tanh(o.drive);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = o.to + (o.from - o.to) * Math.exp(-t / o.pitchTau);
    ph += (TAU * f) / SR;
    const env = Math.exp(-t / o.ampTau) * Math.min(1, t / 0.0015) * Math.min(1, (o.len - t) / 0.01);
    let v = Math.tanh(Math.sin(ph) * env * o.drive) / norm;
    v += o.click * (rand() * 2 - 1) * Math.exp(-t / 0.0018);
    out[i] = v;
  }
  return out;
}

export interface SnareOptions { tone: number; toneTau: number; noiseTau: number; hp: number; lp: number; toneMix: number; len: number; gateS?: number }

export function snare(o: SnareOptions, rand: () => number): Float32Array {
  const n = samples(o.len), tone = new Float32Array(n), noise = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (TAU * o.tone * (1 + 0.5 * Math.exp(-t / 0.01))) / SR;
    tone[i] = Math.sin(ph) * Math.exp(-t / o.toneTau);
    // A gated snare holds its noise flat, then shuts (the 80s gated-room sound).
    const nEnv = o.gateS ? (t < o.gateS ? 0.55 + 0.45 * Math.exp(-t / 0.03) : Math.max(0, 1 - (t - o.gateS) / 0.012) * 0.55) : Math.exp(-t / o.noiseTau);
    noise[i] = (rand() * 2 - 1) * nEnv;
  }
  biquad(noise, "highpass", o.hp, 0.7);
  biquad(noise, "lowpass", o.lp, 0.7);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (tone[i]! * o.toneMix + noise[i]! * (1 - o.toneMix)) * Math.min(1, i / 48) * Math.min(1, (n - i) / 240);
  return out;
}

export function clap(rand: () => number, bright = 1200, tail = 0.14): Float32Array {
  const n = samples(0.05 + tail * 4), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let env = 0;
    for (const at of [0, 0.011, 0.022]) if (t >= at) env = Math.max(env, Math.exp(-(t - at) / 0.0045));
    if (t >= 0.031) env = Math.max(env, 0.75 * Math.exp(-(t - 0.031) / tail));
    out[i] = (rand() * 2 - 1) * env;
  }
  biquad(out, "bandpass", bright, 0.9);
  biquad(out, "highpass", 500, 0.7);
  return scaleTo(out, 0.9);
}

/** 808-style metallic hat: six detuned squares, high-passed, plus a little noise. */
export function hat(rand: () => number, decay: number, brightness = 1): Float32Array {
  const n = samples(decay * 6 + 0.01), out = new Float32Array(n);
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 1.7 * brightness);
  const ph = freqs.map(() => rand());
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 0; k < freqs.length; k++) {
      ph[k] = (ph[k]! + freqs[k]! / SR) % 1;
      v += ph[k]! < 0.5 ? 1 : -1;
    }
    v = v / 6 * 0.6 + (rand() * 2 - 1) * 0.4;
    out[i] = v * Math.exp(-t / decay) * Math.min(1, t / 0.0008);
  }
  biquad(out, "highpass", 7000, 0.7);
  biquad(out, "highpass", 6000, 0.7);
  return scaleTo(out, 0.9);
}

export function shaker(rand: () => number): Float32Array {
  const n = samples(0.12), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (rand() * 2 - 1) * Math.min(1, t / 0.012) * Math.exp(-t / 0.035);
  }
  biquad(out, "bandpass", 6500, 1.2);
  return scaleTo(out, 0.8);
}

export function crash(rand: () => number, len = 2.2): Float32Array {
  const n = samples(len), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (rand() * 2 - 1) * Math.exp(-t / (len / 4)) * Math.min(1, t / 0.002);
  }
  biquad(out, "highpass", 4500, 0.7);
  return scaleTo(out, 0.8);
}

export function tom(note: number, rand: () => number): Float32Array {
  return kick({ from: hz(note) * 2.2, to: hz(note), pitchTau: 0.04, ampTau: 0.18, click: 0.15, drive: 1.6, len: 0.6 }, rand);
}

/** Rising filtered noise into a section change. */
export function riser(len: number, rand: () => number): Float32Array {
  const n = samples(len), out = new Float32Array(n), f = new Svf();
  for (let i = 0; i < n; i++) {
    const x = i / n;
    f.step(rand() * 2 - 1, 300 * 30 ** x, 2.5);
    out[i] = f.bp * x * x;
  }
  return scaleTo(out, 0.8);
}

// ---------------------------------------------------------------- tonal voices

export interface BassOptions { glideTo?: number; glideAt?: number; glideS?: number; tau?: number; drive?: number }

/** 808 bass: a driven sine with an optional glide to another note. */
export function bass808(note: number, len: number, o: BassOptions = {}): Float32Array {
  const rel = 0.05, n = samples(len + rel), out = new Float32Array(n);
  const drive = o.drive ?? 2.2, norm = Math.tanh(drive), tau = o.tau ?? 1.4;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let f = hz(note);
    if (o.glideTo !== undefined && t > (o.glideAt ?? 0)) f = hz(note + (o.glideTo - note) * Math.min(1, (t - (o.glideAt ?? 0)) / (o.glideS ?? 0.08)));
    ph += (TAU * f) / SR;
    const env = Math.min(1, t / 0.003) * Math.exp(-t / tau) * gate(t, 0, len, rel);
    out[i] = (Math.tanh(Math.sin(ph) * drive) / norm) * env;
  }
  return out;
}

/** Plucked upright-style bass: sine with a few harmonics and a fast thump. */
export function upright(note: number, len: number): Float32Array {
  const rel = 0.06, n = samples(len + rel), out = new Float32Array(n), f = hz(note);
  for (let i = 0; i < n; i++) {
    const t = i / SR, w = TAU * f * t;
    const body = Math.sin(w) + 0.35 * Math.sin(2 * w) * Math.exp(-t / 0.15) + 0.12 * Math.sin(3 * w) * Math.exp(-t / 0.08);
    out[i] = body * Math.min(1, t / 0.004) * Math.exp(-t / 0.9) * gate(t, 0, len, rel);
  }
  return out;
}

export interface SynthBassOptions { wave?: "saw" | "pulse"; cutoff: number; envAmt: number; decay: number; q?: number; glideFrom?: number; glideS?: number; sub?: number }

/** Analogue-style bass: saw or pulse through a resonant low-pass with a decaying envelope. */
export function synthBass(note: number, len: number, o: SynthBassOptions): Float32Array {
  const rel = 0.04, n = samples(len + rel), out = new Float32Array(n), flt = new Svf();
  let ph = 0, sph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const m = o.glideFrom !== undefined ? o.glideFrom + (note - o.glideFrom) * Math.min(1, t / (o.glideS ?? 0.06)) : note;
    const f = hz(m), dt = f / SR;
    ph = (ph + dt) % 1;
    sph = (sph + dt / 2) % 1;
    const osc = o.wave === "pulse" ? pulse(ph, dt, 0.45) : saw(ph, dt);
    flt.step(osc, o.cutoff + o.envAmt * Math.exp(-t / o.decay), o.q ?? 1.2);
    const v = flt.lp + (o.sub ?? 0.4) * Math.sin(TAU * sph * 2);
    out[i] = v * Math.min(1, t / 0.003) * gate(t, 0, len, rel);
  }
  return out;
}

/** FM electric piano: a bell-like tine over a soft body, velocity opening the brightness. */
export function epiano(note: number, len: number, vel = 0.8): Float32Array {
  const rel = 0.25, n = samples(len + rel), out = new Float32Array(n), f = hz(note);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const index = (0.9 + vel * 1.4) * Math.exp(-t / 0.4) + 0.12;
    const mod = Math.sin(TAU * f * t) * index;
    const tine = 0.12 * vel * Math.sin(TAU * f * 14.02 * t) * Math.exp(-t / 0.015);
    const v = Math.sin(TAU * f * t + mod) * 0.8 + 0.2 * Math.sin(TAU * f * 2 * t) * Math.exp(-t / 0.6) + tine;
    out[i] = v * Math.min(1, t / 0.002) * Math.exp(-t / 2.2) * gate(t, 0, len, rel);
  }
  return out;
}

/** Vibraphone-ish mallet: sine with a fast-fading fourth partial and a gentle tremolo. */
export function vibes(note: number, len: number): Float32Array {
  const rel = 0.6, n = samples(len + rel), out = new Float32Array(n), f = hz(note);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * f * 4 * t) * Math.exp(-t / 0.08) + 0.1 * Math.sin(TAU * f * 10 * t) * Math.exp(-t / 0.01);
    out[i] = v * (0.85 + 0.15 * Math.sin(TAU * 5.2 * t)) * Math.min(1, t / 0.001) * Math.exp(-t / 1.3) * gate(t, 0, len, rel);
  }
  return out;
}

/** FM bell for trap and pop leads. */
export function bell(note: number, len: number, ratio = 3.5): Float32Array {
  const rel = 0.5, n = samples(len + rel), out = new Float32Array(n), f = hz(note);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const mod = Math.sin(TAU * f * ratio * t) * (2.4 * Math.exp(-t / 0.18) + 0.25);
    out[i] = Math.sin(TAU * f * t + mod) * Math.min(1, t / 0.001) * Math.exp(-t / 0.9) * gate(t, 0, len, rel);
  }
  return out;
}

export interface PluckOptions { from: number; to: number; decay: number; q?: number; wave?: "saw" | "pulse"; ampTau?: number }

/** A filter pluck (arpeggios, clav stabs). */
export function pluck(note: number, len: number, o: PluckOptions): Float32Array {
  const rel = 0.05, n = samples(len + rel), out = new Float32Array(n), flt = new Svf(), f = hz(note), dt = f / SR;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph = (ph + dt) % 1;
    const osc = o.wave === "pulse" ? pulse(ph, dt, 0.3) : saw(ph, dt);
    flt.step(osc, o.to + (o.from - o.to) * Math.exp(-t / o.decay), o.q ?? 1.4);
    out[i] = flt.lp * Math.min(1, t / 0.002) * Math.exp(-t / (o.ampTau ?? 0.35)) * gate(t, 0, len, rel);
  }
  return out;
}

export interface LeadOptions { wave?: "saw" | "square" | "mix"; cutoff?: number; vibrato?: number; glideFrom?: number; glideS?: number; attack?: number; release?: number; brass?: boolean }

/** A monophonic synth lead with delayed vibrato and an optional glide. */
export function lead(note: number, len: number, o: LeadOptions = {}): Float32Array {
  const release = o.release ?? 0.12, n = samples(len + release), out = new Float32Array(n), flt = new Svf();
  let ph = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let m = o.glideFrom !== undefined ? o.glideFrom + (note - o.glideFrom) * Math.min(1, t / (o.glideS ?? 0.07)) : note;
    m += (o.vibrato ?? 0.2) * Math.sin(TAU * 5.4 * t) * Math.min(1, Math.max(0, t - 0.18) / 0.25);
    const f = hz(m), dt = f / SR;
    ph = (ph + dt) % 1;
    ph2 = (ph2 + dt * 1.004) % 1;
    const w = o.wave ?? "mix";
    const osc = w === "saw" ? saw(ph, dt) * 0.6 + saw(ph2, dt) * 0.4 : w === "square" ? pulse(ph, dt, 0.5) : saw(ph, dt) * 0.5 + pulse(ph2, dt, 0.5) * 0.5;
    const cut = (o.cutoff ?? 4200) * (o.brass ? 0.35 + 0.65 * Math.min(1, t / 0.08) : 1);
    flt.step(osc, cut, 0.9);
    out[i] = flt.lp * gate(t, o.attack ?? 0.008, len, release);
  }
  return out;
}

/** The g-funk "whistle": a near-sine lead that slides between notes, with a wide vibrato. */
export function whistle(note: number, len: number, glideFrom?: number): Float32Array {
  const rel = 0.15, n = samples(len + rel), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let m = glideFrom !== undefined ? glideFrom + (note - glideFrom) * Math.min(1, t / 0.12) : note;
    m += 0.3 * Math.sin(TAU * 5.6 * t) * Math.min(1, Math.max(0, t - 0.2) / 0.3);
    ph += (TAU * hz(m)) / SR;
    out[i] = (Math.sin(ph) + 0.06 * Math.sin(3 * ph)) * gate(t, 0.04, len, rel);
  }
  return out;
}

export interface PadOptions { voices?: number; detune?: number; cutoff: number; attack: number; release: number; seed: number }

/** Supersaw pad over a chord, stereo (voices spread left to right). */
export function pad(notes: readonly number[], len: number, o: PadOptions): [Float32Array, Float32Array] {
  const n = samples(len + o.release), l = new Float32Array(n), r = new Float32Array(n);
  const rand = prng(o.seed), voices = o.voices ?? 5, detune = o.detune ?? 0.12;
  for (const note of notes) {
    for (let v = 0; v < voices; v++) {
      const spread = voices === 1 ? 0 : (v / (voices - 1)) * 2 - 1;
      const f = hz(note + spread * detune), dt = f / SR;
      const pan = (spread + 1) * Math.PI / 4, gl = Math.cos(pan), gr = Math.sin(pan);
      let ph = rand();
      for (let i = 0; i < n; i++) {
        ph += dt;
        if (ph >= 1) ph -= 1;
        const s = saw(ph, dt);
        l[i] = l[i]! + s * gl;
        r[i] = r[i]! + s * gr;
      }
    }
  }
  const fl = new Svf(), fr = new Svf(), k = 1 / (notes.length * Math.sqrt(voices));
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = gate(t, o.attack, len, o.release) * k;
    fl.step(l[i]!, o.cutoff, 0.7);
    fr.step(r[i]!, o.cutoff, 0.7);
    l[i] = fl.lp * env;
    r[i] = fr.lp * env;
  }
  return [l, r];
}

// ---------------------------------------------------------------- buffers

export function scaleTo(buf: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (const v of buf) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < buf.length; i++) buf[i] = (buf[i]! / m) * peak;
  return buf;
}

/** Play a buffer faster (ratio > 1, higher) or slower, linear interpolation. */
export function repitch(buf: Float32Array, ratio: number): Float32Array {
  const n = Math.floor(buf.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, j = Math.floor(x), f = x - j;
    out[i] = (buf[j] ?? 0) * (1 - f) + (buf[j + 1] ?? 0) * f;
  }
  return out;
}

export class Bus {
  readonly l: Float32Array;
  readonly r: Float32Array;
  constructor(len: number) {
    this.l = new Float32Array(len);
    this.r = new Float32Array(len);
  }
  /** Add a mono voice at sample `at`, equal-power panned (-1 left .. 1 right). */
  add(mono: Float32Array, at: number, gain: number, pan = 0): void {
    const a = ((pan + 1) * Math.PI) / 4, gl = Math.cos(a) * gain, gr = Math.sin(a) * gain;
    const end = Math.min(mono.length, this.l.length - at);
    for (let i = Math.max(0, -at); i < end; i++) {
      const v = mono[i]!;
      this.l[at + i] = this.l[at + i]! + v * gl;
      this.r[at + i] = this.r[at + i]! + v * gr;
    }
  }
  addStereo(pair: readonly [Float32Array, Float32Array], at: number, gain: number): void {
    const end = Math.min(pair[0].length, this.l.length - at);
    for (let i = Math.max(0, -at); i < end; i++) {
      this.l[at + i] = this.l[at + i]! + pair[0][i]! * gain;
      this.r[at + i] = this.r[at + i]! + pair[1][i]! * gain;
    }
  }
}

// ---------------------------------------------------------------- effects

/** Freeverb (Jezar's public-domain design): eight combs and four allpasses per side, wet only. */
export function reverb(bus: Bus, room: number, damp: number): Bus {
  const n = bus.l.length, out = new Bus(n), scale = SR / 44_100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aps = [556, 441, 341, 225];
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (bus.l[i]! + bus.r[i]!) * 0.015;
  for (const [dest, spread] of [[out.l, 0], [out.r, 23]] as const) {
    const cb = combs.map((c) => new Float32Array(Math.round((c + spread) * scale)));
    const ci = combs.map(() => 0), cs = combs.map(() => 0);
    const ab = aps.map((a) => new Float32Array(Math.round((a + spread) * scale)));
    const ai = aps.map(() => 0);
    for (let j = 0; j < n; j++) {
      const x = mono[j]!;
      let acc = 0;
      for (let k = 0; k < 8; k++) {
        const b = cb[k]!, i = ci[k]!, y = b[i]!;
        cs[k] = y * (1 - damp) + cs[k]! * damp;
        b[i] = x + cs[k]! * room;
        ci[k] = i + 1 === b.length ? 0 : i + 1;
        acc += y;
      }
      for (let k = 0; k < 4; k++) {
        const b = ab[k]!, i = ai[k]!, bo = b[i]!;
        b[i] = acc + bo * 0.5;
        ai[k] = i + 1 === b.length ? 0 : i + 1;
        acc = bo - acc;
      }
      dest[j] = acc * 3;
    }
  }
  return out;
}

/** Ping-pong delay, wet only: the input enters left, each repeat crosses sides, darkening. */
export function pingPong(bus: Bus, delaySamples: number, feedback: number, tone = 0.35): Bus {
  const n = bus.l.length, out = new Bus(n), bl = new Float32Array(delaySamples), br = new Float32Array(delaySamples);
  let i = 0, zl = 0, zr = 0;
  for (let j = 0; j < n; j++) {
    const yl = bl[i]!, yr = br[i]!;
    zl += tone * (yl - zl);
    zr += tone * (yr - zr);
    bl[i] = (bus.l[j]! + bus.r[j]!) * 0.5 + feedback * zr;
    br[i] = feedback * zl;
    out.l[j] = yl;
    out.r[j] = yr;
    i = i + 1 === delaySamples ? 0 : i + 1;
  }
  return out;
}

/**
 * Sidechain "pump": the bus dips after every kick and recovers. The kicks are given as loop
 * positions; each also counts one loop earlier and later, so the envelope is periodic.
 */
export function sidechain(bus: Bus, kicks: readonly number[], loop: number, depth: number, recoverS = 0.12): void {
  const n = bus.l.length, env = new Float32Array(n).fill(1), a = Math.round(0.004 * SR), w = Math.round(0.45 * SR);
  for (const k0 of kicks) for (const k of [k0 - loop, k0, k0 + loop]) {
    for (let i = 0; i < w; i++) {
      const j = k + i;
      if (j < 0 || j >= n) continue;
      const v = 1 - depth * (i < a ? i / a : Math.exp(-(i - a) / (recoverS * SR)));
      if (v < env[j]!) env[j] = v;
    }
  }
  for (let i = 0; i < n; i++) { bus.l[i] = bus.l[i]! * env[i]!; bus.r[i] = bus.r[i]! * env[i]!; }
}

/**
 * The sampled-record colour for boom-bap chords: tape wow (a slow periodic pitch drift, a whole
 * number of cycles per loop), a 24 kHz sample-and-hold for grit, and a telephone-ish band.
 */
export function samplerColour(bus: Bus, loop: number): void {
  const n = bus.l.length, cycles = Math.max(1, Math.round((loop / SR) * 0.55)), rate = cycles / loop;
  const depth = 0.0014 * SR, base = depth + 8;
  for (const ch of [bus.l, bus.r]) {
    const src = ch.slice();
    for (let i = 0; i < n; i++) {
      const d = base + depth * Math.sin(TAU * rate * i);
      const x = i - d, j = Math.floor(x), f = x - j;
      ch[i] = j < 0 ? 0 : (src[j]! * (1 - f) + (src[j + 1] ?? 0) * f);
    }
    for (let i = 1; i < n; i += 2) ch[i] = ch[i - 1]!;
    biquad(ch, "highpass", 160, 0.7);
    biquad(ch, "lowpass", 4800, 0.7);
  }
}

/** Quiet record crackle and surface noise for the whole loop (periodic: it is wrapped like the rest). */
export function vinyl(len: number, loop: number, rand: () => number, level: number): Bus {
  const out = new Bus(len), hiss = new Float32Array(len);
  for (let i = 0; i < loop; i++) hiss[i] = (rand() * 2 - 1) * 0.12;
  biquad(hiss, "lowpass", 2600, 0.7);
  biquad(hiss, "highpass", 400, 0.7);
  for (let i = 0; i < loop; i++) { out.l[i] = hiss[i]! * level; out.r[i] = hiss[(i + 977) % loop]! * level; }
  const clicks = Math.round((loop / SR) * 7);
  for (let c = 0; c < clicks; c++) {
    const at = Math.floor(rand() * (loop - 400)), amp = level * (0.5 + rand() * 1.5) * (rand() < 0.5 ? -1 : 1), side = rand();
    for (let i = 0; i < 300; i++) {
      const v = amp * Math.exp(-i / 18) * (i % 2 ? -0.6 : 1);
      out.l[at + i] = out.l[at + i]! + v * (1 - side * 0.6);
      out.r[at + i] = out.r[at + i]! + v * (0.4 + side * 0.6);
    }
  }
  return out;
}

/** Add the tail past `loop` back onto the start, and cut to one loop period. */
export function wrapTail(ch: Float32Array, loop: number): Float32Array {
  const out = ch.slice(0, loop);
  for (let i = loop; i < ch.length; i++) out[(i - loop) % loop] = out[(i - loop) % loop]! + ch[i]!;
  return out;
}

/**
 * Master: a gain that puts the loudest 0.1 % of samples at `drive`, then a soft knee above
 * `knee` that never passes `ceiling`. Memoryless, so it cannot break the loop seam.
 */
export function master(l: Float32Array, r: Float32Array, drive = 0.85, knee = 0.6, ceiling = 0.94): void {
  const probe: number[] = [];
  for (let i = 0; i < l.length; i += 5) probe.push(Math.max(Math.abs(l[i]!), Math.abs(r[i]!)));
  probe.sort((a, b) => a - b);
  const p999 = probe[Math.floor(probe.length * 0.999)] ?? 1;
  const g = p999 > 0 ? drive / p999 : 1, room = ceiling - knee;
  for (const ch of [l, r]) for (let i = 0; i < ch.length; i++) {
    const x = ch[i]! * g, a = Math.abs(x);
    ch[i] = a <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((a - knee) / room));
  }
}

/** 16-bit PCM stereo WAV. */
export function wav(l: Float32Array, r: Float32Array): Uint8Array {
  const n = l.length, bytes = new Uint8Array(44 + n * 4), v = new DataView(bytes.buffer);
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, SR, true);
  v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, l[i]!)) * 32767), true);
    v.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, r[i]!)) * 32767), true);
  }
  return bytes;
}
