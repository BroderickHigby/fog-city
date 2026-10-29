// The player car's continuous sound, synthesised in Web Audio from no files (so no licence to
// track). The engine works the way game engines play recorded engine loops: a set of loops at
// fixed rpms, each in an on-load and an off-load take, crossfaded by rpm and pitched only a little
// around the rpm it was made at, with the load crossfading the takes. The loops are not recordings:
// each one is rendered once from physically shaped exhaust pulses, one per cylinder firing, with
// per-cylinder differences and per-pulse jitter, so the idle lopes and the note never repeats a
// single waveform. The method follows the combustion loops in Mr.doob's Slop New York (MIT,
// js/audio-synthesis.js at 819a0ad; see assets/imports/slop-new-york/README.md).
//
// Live, on top of the loops: an exhaust resonance filter pair and a low-pass that open with load,
// a saturation stage mixed in with load, intake roar, a slow idle wander, and pops and crackle on
// a lift-off from high rpm. Road roar and tyre squeal are filtered noise. Parameters come from
// vehicle-sound.ts each frame and are smoothed, so nothing clicks or steps.

import { IDLE_RPM, REDLINE_RPM, type EngineParams } from "./vehicle-sound.ts";

export const CYLINDERS = 4;
/** An inline four fires 1-3-4-2 (0-based cylinder indexes). */
const FIRING_ORDER = [0, 2, 3, 1] as const;
/** Four-stroke cycles in every loop. The same count at every bank keeps the banks' firings in step. */
export const LOOP_CYCLES = 32;
/** The rpms the loops are made at. Neighbours are about 1.45 apart, so no loop is pitched more than about 20%. */
export const BANK_RPMS = [900, 1350, 2000, 2900, 4100, 5600] as const;
/** RMS of an on-load and an off-load loop: a closed throttle fires softer. */
export const ON_LOAD_RMS = 0.3;
export const OFF_LOAD_RMS = 0.2;
export const LOOP_PEAK = 0.95;
const LOOP_SEED = 0x46c17e;
/** One pulse's length, s: long enough for the pipe resonance to ring out. */
const PULSE_S = 0.055;

/** Smoothing time constant for the level and tone parameters, s. */
const SMOOTH_S = 0.08;
/** The rpm follows faster, so an upshift's drop is a quick fall, not a slow sag. */
const RPM_SMOOTH_S = 0.05;
/** Level of the engine against the gain vehicle-sound.ts asks for: keeps it as loud as the old synth. */
const ENGINE_TRIM = 1.85;
const ENGINE_HIGHPASS_HZ = 55;

const clamp = (v: number, lo: number, hi: number): number => (v <= lo ? lo : v >= hi ? hi : v);
const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** Firing pulses per second: each cylinder fires once every two turns. */
export function firingHz(rpm: number): number {
  return (rpm / 60) * (CYLINDERS / 2);
}

/** A fixed LCG in 0..1, so every run renders the same loops (no Math.random in the repo's style). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One exhaust pulse at the tailpipe, for one cylinder: blowdown, the pipe's ring, the shell's ring, the rasp. */
function pulseKernel(rate: number, cylinder: number, loaded: boolean, pipeHz: number): Float32Array<ArrayBuffer> {
  const n = Math.round(PULSE_S * rate);
  const k = new Float32Array(n);
  const release = loaded ? 0.0028 : 0.0017;
  const shellHz = 420 * (1 + 0.03 * cylinder);
  const fade = Math.round(0.006 * rate);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const attack = 1 - Math.exp(-t / 0.00035);
    // The blowdown push, then the rarefaction that follows it down the pipe.
    const blow = Math.exp(-t / release) - 0.4 * Math.exp(-t / 0.011);
    const pipe = Math.sin(2 * Math.PI * pipeHz * t) * Math.exp(-t / 0.011) * (loaded ? 0.55 : 0.36);
    const shell = Math.sin(2 * Math.PI * shellHz * t) * Math.exp(-t / 0.0065) * (loaded ? 0.2 : 0.1);
    const rasp = Math.sin(2 * Math.PI * 1350 * t + cylinder) * Math.exp(-t / 0.0018) * (loaded ? 0.14 : 0.03);
    k[i] = attack * (blow + pipe + shell + rasp) * Math.min(1, (n - 1 - i) / fade);
  }
  return k;
}

/** The pulse shapes depend only on the sample rate and the take, not the bank: made once. */
const kernelCache = new Map<string, Float32Array<ArrayBuffer>[]>();

/**
 * One engine loop's samples: LOOP_CYCLES four-stroke cycles at `rpm`, on load (full, harsh pulses
 * with intake roar) or off load (soft, uneven pulses with more valve tick). Pure. Every bank and
 * both takes draw the same firing times and strengths, so a crossfade between them stays in step.
 */
export function renderEngineLoop(rate: number, rpm: number, loaded: boolean): Float32Array<ArrayBuffer> {
  const length = Math.round(((LOOP_CYCLES * 120) / rpm) * rate);
  const out = new Float32Array(length);
  const firings = LOOP_CYCLES * CYLINDERS;
  const interval = length / firings;
  const timing = lcg(LOOP_SEED);
  const noise = lcg(LOOP_SEED ^ 0x9e3779b9);
  // Each cylinder is a little different: its strength, its timing, its header pipe's length.
  const strength = FIRING_ORDER.map(() => 0.86 + timing() * 0.28);
  const offset = FIRING_ORDER.map(() => (timing() - 0.5) * 0.05);
  const pipeHz = FIRING_ORDER.map(() => 108 * (0.92 + timing() * 0.16));
  const key = `${rate}:${loaded}`;
  let kernels = kernelCache.get(key);
  if (!kernels) kernelCache.set(key, (kernels = FIRING_ORDER.map((_, c) => pulseKernel(rate, c, loaded, pipeHz[c]!))));
  const kn = kernels[0]!.length;
  const tickN = Math.round(0.005 * rate), intakeN = Math.round(0.04 * rate);
  const noiseEnv = new Float32Array(kn), intakeEnv = new Float32Array(intakeN), tick = new Float32Array(tickN);
  for (let i = 0; i < kn; i++) {
    const t = i / rate;
    noiseEnv[i] = (1 - Math.exp(-t / 0.00035)) * Math.exp(-t / (loaded ? 0.006 : 0.004));
    if (i < intakeN) intakeEnv[i] = (1 - Math.exp(-t / 0.002)) * Math.exp(-t / 0.008) * Math.min(1, (intakeN - 1 - i) / 64);
    if (i < tickN) tick[i] = Math.sin(2 * Math.PI * 4800 * t) * Math.exp(-t / 0.0006);
  }
  // A table of low-passed noise (the combustion's roughness) and its high-passed rest (intake
  // hiss); each firing reads it from its own random place.
  const table = 1 << 16;
  const lowNoise = new Float32Array(table), highNoise = new Float32Array(table);
  let low = 0;
  for (let i = 0; i < table; i++) {
    const white = noise() * 2 - 1;
    low += (white - low) * 0.25;
    lowNoise[i] = low;
    highNoise[i] = white - low;
  }
  const mask = table - 1;
  const noiseLevel = loaded ? 0.42 : 0.6;
  const intakeLevel = loaded ? 0.22 : 0.05;
  const tickLevel = loaded ? 0.05 : 0.09;
  // Pulses are written into a padded strip, then the overhang is folded round, so the loop is seamless.
  const pad = kn;
  const strip = new Float32Array(length + 2 * pad);
  for (let f = 0; f < firings; f++) {
    const c = FIRING_ORDER[f % CYLINDERS]!;
    // The same three draws per firing for every bank and take.
    const jitter = (timing() - 0.5) * 0.024;
    const swing = 0.9 + timing() * 0.2;
    const burble = 0.55 + timing() * 0.9;
    const amp = strength[c]! * swing * (loaded ? 1 : 0.5 * burble);
    const start = pad + Math.round((f + offset[c]! + jitter) * interval);
    const kernel = kernels[c]!;
    const nAmp = amp * noiseLevel;
    let n0 = Math.floor(noise() * table);
    for (let i = 0; i < kn; i++) strip[start + i]! += amp * kernel[i]! + nAmp * lowNoise[(n0 + i) & mask]! * noiseEnv[i]!;
    const valve = start + Math.round(0.4 * interval), tickAmp = strength[c]! * tickLevel;
    for (let i = 0; i < tickN; i++) strip[valve + i]! += tickAmp * tick[i]!;
    const intake = start + Math.round(0.5 * interval), intakeAmp = strength[c]! * intakeLevel;
    n0 = Math.floor(noise() * table);
    for (let i = 0; i < intakeN; i++) strip[intake + i]! += intakeAmp * highNoise[(n0 + i) & mask]! * intakeEnv[i]!;
  }
  for (let j = 0; j < strip.length; j++) out[(((j - pad) % length) + length) % length]! += strip[j]!;
  normalise(out, loaded ? ON_LOAD_RMS : OFF_LOAD_RMS);
  if (loaded) {
    // Combustion under load is harsh: a soft clip adds the odd harmonics a pulling engine has.
    for (let i = 0; i < length; i++) out[i] = Math.tanh(1.7 * out[i]!);
    normalise(out, ON_LOAD_RMS);
  }
  return out;
}

/** Remove the DC and scale to an RMS, never past LOOP_PEAK. */
function normalise(data: Float32Array, rms: number): void {
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i]!;
  mean /= data.length || 1;
  let energy = 0, peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]! - mean;
    data[i] = v;
    energy += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const scale = Math.min(LOOP_PEAK / Math.max(peak, 1e-6), rms / Math.max(Math.sqrt(energy / (data.length || 1)), 1e-6));
  for (let i = 0; i < data.length; i++) data[i]! *= scale;
}

/**
 * How much of each bank plays at an rpm: the two banks either side, crossfaded at equal power on a
 * log scale (so the level holds through the blend). Below the first bank or above the last, that
 * bank alone. A non-finite rpm reads as idle.
 */
export function bankWeights(rpm: number): number[] {
  const first = BANK_RPMS[0], last = BANK_RPMS[BANK_RPMS.length - 1]!;
  const r = clamp(finite(rpm, IDLE_RPM), first, last);
  const w = BANK_RPMS.map(() => 0);
  let i = 0;
  while (i < BANK_RPMS.length - 2 && r > BANK_RPMS[i + 1]!) i++;
  const lo = BANK_RPMS[i]!, hi = BANK_RPMS[i + 1]!;
  const x = clamp(Math.log(r / lo) / Math.log(hi / lo), 0, 1);
  const s = x * x * (3 - 2 * x);
  w[i] = Math.cos((s * Math.PI) / 2);
  w[i + 1] = Math.sin((s * Math.PI) / 2);
  return w;
}

/** The on-load and off-load takes' levels at a load (0..1), at equal power. Even idle carries a little load. */
export function loadWeights(load: number): { on: number; off: number } {
  const l = 0.1 + 0.9 * clamp(finite(load, 0), 0, 1);
  return { on: Math.sin((l * Math.PI) / 2), off: Math.cos((l * Math.PI) / 2) };
}

export interface Pop {
  /** Start this long into the frame, s. */
  delayS: number;
  gain: number;
  rate: number;
  variant: number;
}

/** Over this rpm a lift-off pops (unburnt fuel lighting in a hot exhaust). */
export const CRACKLE_RPM = 2400;
/** The throttle counts as lifted under this. */
const LIFT_POWER = 0.2;
/**
 * Pops start once the throttle has stayed lifted this long. An upshift's power cut (0.16 s) is
 * shorter, so a shift never pops.
 */
export const LIFT_DELAY_S = 0.22;
/** The throttle must have been at least this high just before, so cruising and coasting never pop. */
const LIFT_FROM_POWER = 0.45;
export const POP_VARIANTS = 3;
/** A pop's level against the engine loops: a crack you hear over the road, not a gunshot. */
const POP_LEVEL = 2.2;

/**
 * Pops and crackle after a lift-off from high rpm. Pure apart from its own state and a fixed
 * random sequence: step it once a frame with the rpm and the pulling power (the `throttle` of
 * EngineParams), and it returns the pops to play this frame.
 */
export class OverrunCrackle {
  private readonly rand: () => number;
  private peakPower = 0;
  private liftS = 0;
  private fired = false;
  private energy = 0;
  private untilPopS = 0;

  constructor(seed = 0x0c7ac41e) {
    this.rand = lcg(seed);
  }

  step(rpm: number, power: number, dtS: number): Pop[] {
    const r = finite(rpm, IDLE_RPM);
    const l = clamp(finite(power, 0), 0, 1);
    const dt = clamp(finite(dtS, 0), 0, 0.25);
    this.peakPower = Math.max(l, this.peakPower * Math.exp(-dt / 2.5));
    if (l < LIFT_POWER) this.liftS += dt;
    else {
      // Back on the throttle: the overrun ends at once.
      this.liftS = 0;
      this.fired = false;
      this.energy = 0;
    }
    if (!this.fired && this.liftS >= LIFT_DELAY_S && this.peakPower > LIFT_FROM_POWER && r > CRACKLE_RPM) {
      this.fired = true;
      this.energy = Math.min(1, 0.45 + (r - CRACKLE_RPM) / 3000);
      this.untilPopS = 0;
    }
    this.energy *= Math.exp(-dt / (r < 1700 ? 0.1 : 0.9));
    const pops: Pop[] = [];
    if (this.energy < 0.04) return pops;
    this.untilPopS -= dt;
    while (this.untilPopS <= 0) {
      pops.push({
        delayS: this.rand() * dt,
        gain: this.energy * (0.35 + 0.65 * this.rand()),
        rate: 0.8 + this.rand() * 0.45,
        variant: Math.floor(this.rand() * POP_VARIANTS) % POP_VARIANTS,
      });
      // Gaps widen as the overrun dies away.
      this.untilPopS += 0.03 + this.rand() * (0.08 + 0.18 * (1 - this.energy));
    }
    return pops;
  }
}

/** One exhaust pop: a sharp crack of noise with a short low thump. */
function renderPop(rate: number, variant: number): Float32Array<ArrayBuffer> {
  const n = Math.round(0.045 * rate);
  const out = new Float32Array(n);
  const rand = lcg(0x9097 + variant * 7919);
  const bodyHz = [210, 290, 360][variant % 3]!;
  let low = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const attack = 1 - Math.exp(-t / 0.0002);
    low += (rand() * 2 - 1 - low) * 0.35;
    const crack = low * Math.exp(-t / (0.0035 + variant * 0.001));
    const thump = Math.sin(2 * Math.PI * bodyHz * t) * Math.exp(-t / 0.011) * 0.6;
    out[i] = attack * (crack + thump) * Math.min(1, (n - 1 - i) / (0.004 * rate));
  }
  normalise(out, 0.25);
  return out;
}

interface EngineBuffers {
  on: AudioBuffer[];
  off: AudioBuffer[];
  pops: AudioBuffer[];
}

/** Rendered once per audio context: every synth on that context shares them. */
const rendered = new WeakMap<BaseAudioContext, EngineBuffers>();

function buffers(ctx: BaseAudioContext): EngineBuffers {
  const have = rendered.get(ctx);
  if (have) return have;
  const rate = ctx.sampleRate;
  const make = (data: Float32Array<ArrayBuffer>): AudioBuffer => {
    const b = ctx.createBuffer(1, data.length, rate);
    b.copyToChannel(data, 0);
    return b;
  };
  const made: EngineBuffers = {
    on: BANK_RPMS.map((rpm) => make(renderEngineLoop(rate, rpm, true))),
    off: BANK_RPMS.map((rpm) => make(renderEngineLoop(rate, rpm, false))),
    pops: Array.from({ length: POP_VARIANTS }, (_, v) => make(renderPop(rate, v))),
  };
  rendered.set(ctx, made);
  return made;
}

/** A tanh soft clip for the live saturation stage. */
function softClip(drive: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return curve;
}

export class VehicleSynth {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly buf: EngineBuffers;
  private readonly loops: AudioBufferSourceNode[] = [];
  private readonly onGains: GainNode[] = [];
  private readonly offGains: GainNode[] = [];
  private readonly dry: GainNode;
  private readonly driveIn: GainNode;
  private readonly driveOut: GainNode;
  private readonly body: BiquadFilterNode;
  private readonly bark: BiquadFilterNode;
  private readonly engineFilter: BiquadFilterNode;
  private readonly post: BiquadFilterNode;
  private readonly engineGain: GainNode;
  private readonly wanderDepth: GainNode;
  private readonly intakeFilter: BiquadFilterNode;
  private readonly intakeGain: GainNode;
  private readonly roarFilter: BiquadFilterNode;
  private readonly roarGain: GainNode;
  private readonly squealGain: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly pops = new Set<AudioBufferSourceNode>();
  private readonly crackle = new OverrunCrackle();
  private lastTime: number | null = null;

  constructor(ctx: AudioContext, bus: AudioNode) {
    this.ctx = ctx;
    this.buf = buffers(ctx);
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(bus);
    const t0 = ctx.currentTime;

    // Engine: the loops, a dry path and a saturated path mixed by load, the exhaust's two
    // resonances, a low-pass that opens with rpm and load, then a rumble cut and the level.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.out);
    this.post = ctx.createBiquadFilter();
    this.post.type = "highpass";
    this.post.frequency.value = ENGINE_HIGHPASS_HZ;
    this.post.Q.value = 0.7;
    this.post.connect(this.engineGain);
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 1200;
    this.engineFilter.Q.value = 0.6;
    this.engineFilter.connect(this.post);
    this.bark = ctx.createBiquadFilter();
    this.bark.type = "peaking";
    this.bark.frequency.value = 520;
    this.bark.Q.value = 1.2;
    this.bark.gain.value = 0;
    this.bark.connect(this.engineFilter);
    this.body = ctx.createBiquadFilter();
    this.body.type = "peaking";
    this.body.frequency.value = 130;
    this.body.Q.value = 0.9;
    this.body.gain.value = 2;
    this.body.connect(this.bark);
    const sum = ctx.createGain();
    this.dry = ctx.createGain();
    this.dry.gain.value = 1;
    this.driveIn = ctx.createGain();
    this.driveIn.gain.value = 0.3;
    this.driveOut = ctx.createGain();
    this.driveOut.gain.value = 0;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip(3);
    shaper.oversample = "2x";
    sum.connect(this.dry);
    this.dry.connect(this.body);
    sum.connect(this.driveIn);
    this.driveIn.connect(shaper);
    shaper.connect(this.driveOut);
    this.driveOut.connect(this.body);

    // The loops start together at the same point, and their rates stay in proportion, so every
    // bank's firings land at the same moments and a crossfade never smears them.
    this.wanderDepth = ctx.createGain();
    this.wanderDepth.gain.value = 9;
    BANK_RPMS.forEach((rpm, i) => {
      for (const [take, gains] of [[this.buf.on[i]!, this.onGains], [this.buf.off[i]!, this.offGains]] as const) {
        const src = ctx.createBufferSource();
        src.buffer = take;
        src.loop = true;
        src.playbackRate.value = IDLE_RPM / rpm;
        this.wanderDepth.connect(src.detune);
        const g = ctx.createGain();
        g.gain.value = 0;
        src.connect(g);
        g.connect(sum);
        gains.push(g);
        this.loops.push(src);
      }
    });
    // An idle never sits dead still: two slow sines nudge the rpm a few cents.
    const wanderA = ctx.createOscillator(), wanderB = ctx.createOscillator();
    wanderA.frequency.value = 0.9;
    wanderB.frequency.value = 0.31;
    const halfB = ctx.createGain();
    halfB.gain.value = 0.6;
    wanderA.connect(this.wanderDepth);
    wanderB.connect(halfB);
    halfB.connect(this.wanderDepth);

    // One second of white noise, looped, shared by the intake, the roar and the squeal.
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    const rand = lcg(0x2545f491);
    for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1;
    const intakeSrc = ctx.createBufferSource(), roarSrc = ctx.createBufferSource(), squealSrc = ctx.createBufferSource();
    for (const [src, r] of [[intakeSrc, 1.03], [roarSrc, 1], [squealSrc, 0.97]] as const) {
      src.buffer = noise;
      src.loop = true;
      src.playbackRate.value = r; // decorrelate the three layers
    }
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = "bandpass";
    this.intakeFilter.frequency.value = 800;
    this.intakeFilter.Q.value = 1.1;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    intakeSrc.connect(this.intakeFilter);
    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(this.post);
    this.roarFilter = ctx.createBiquadFilter();
    this.roarFilter.type = "lowpass";
    this.roarFilter.frequency.value = 300;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    roarSrc.connect(this.roarFilter);
    this.roarFilter.connect(this.roarGain);
    this.roarGain.connect(this.out);
    const squealFilter = ctx.createBiquadFilter();
    squealFilter.type = "bandpass";
    squealFilter.frequency.value = 1900;
    squealFilter.Q.value = 9;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    squealSrc.connect(squealFilter);
    squealFilter.connect(this.squealGain);
    this.squealGain.connect(this.out);
    for (const s of [...this.loops, wanderA, wanderB, intakeSrc, roarSrc, squealSrc]) {
      s.start(t0);
      this.sources.push(s);
    }
  }

  /** This frame's parameters, or null for silence (on foot, paused). */
  set(p: EngineParams | null): void {
    const t = this.ctx.currentTime;
    const dt = this.lastTime === null ? 0 : Math.max(0, t - this.lastTime);
    this.lastTime = t;
    this.out.gain.setTargetAtTime(p ? 1 : 0, t, p ? SMOOTH_S : 0.15);
    if (!p) return;
    const rpm = clamp(finite(p.firingHz, firingHz(IDLE_RPM)) * (120 / CYLINDERS), IDLE_RPM * 0.5, REDLINE_RPM * 1.1);
    const load = clamp(finite(p.load, finite(p.throttle, 0)), 0, 1);
    const level = Math.max(0, finite(p.engineGain, 0)) * ENGINE_TRIM;
    const rev = clamp((rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM), 0, 1);
    const banks = bankWeights(rpm);
    const takes = loadWeights(load);
    BANK_RPMS.forEach((bankRpm, i) => {
      const rate = rpm / bankRpm;
      this.loops[2 * i]!.playbackRate.setTargetAtTime(rate, t, RPM_SMOOTH_S);
      this.loops[2 * i + 1]!.playbackRate.setTargetAtTime(rate, t, RPM_SMOOTH_S);
      this.onGains[i]!.gain.setTargetAtTime(banks[i]! * takes.on, t, SMOOTH_S);
      this.offGains[i]!.gain.setTargetAtTime(banks[i]! * takes.off, t, SMOOTH_S);
    });
    this.wanderDepth.gain.setTargetAtTime(9 * (1 - rev) * (1 - 0.7 * load) + 1, t, SMOOTH_S);
    this.dry.gain.setTargetAtTime(1 - 0.4 * load, t, SMOOTH_S);
    this.driveIn.gain.setTargetAtTime(0.3 + 1.3 * load, t, SMOOTH_S);
    this.driveOut.gain.setTargetAtTime(0.45 * load, t, SMOOTH_S);
    this.body.gain.setTargetAtTime(2 + 3 * load, t, SMOOTH_S);
    this.bark.gain.setTargetAtTime(1 + 4 * load, t, SMOOTH_S);
    this.engineFilter.frequency.setTargetAtTime(Math.min(9000, 950 + 0.3 * rpm + 1800 * load), t, SMOOTH_S);
    this.engineGain.gain.setTargetAtTime(level, t, SMOOTH_S);
    this.intakeFilter.frequency.setTargetAtTime(600 + 0.22 * rpm, t, SMOOTH_S);
    this.intakeGain.gain.setTargetAtTime(0.07 * load * (0.3 + rev), t, SMOOTH_S);
    this.roarFilter.frequency.setTargetAtTime(Math.max(20, finite(p.roarCutoff, 300)), t, SMOOTH_S);
    this.roarGain.gain.setTargetAtTime(Math.max(0, finite(p.roarGain, 0)), t, SMOOTH_S);
    this.squealGain.gain.setTargetAtTime(Math.max(0, finite(p.squealGain, 0)), t, 0.04);
    // Pops follow the pulling power, not the load: a coast at speed has road load but no throttle.
    for (const pop of this.crackle.step(rpm, clamp(finite(p.throttle, 0), 0, 1), dt)) this.pop(pop, t);
  }

  private pop(p: Pop, t: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buf.pops[p.variant] ?? this.buf.pops[0]!;
    src.playbackRate.value = p.rate;
    const g = this.ctx.createGain();
    g.gain.value = POP_LEVEL * p.gain;
    src.connect(g);
    // Into the rumble cut, so the pops follow the engine's level and cabin.
    g.connect(this.post);
    src.onended = () => {
      this.pops.delete(src);
      g.disconnect();
    };
    this.pops.add(src);
    src.start(t + p.delayS);
  }

  dispose(): void {
    for (const s of [...this.sources, ...this.pops]) {
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
    }
    this.pops.clear();
    this.out.disconnect();
  }
}
