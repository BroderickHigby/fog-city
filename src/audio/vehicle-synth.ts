// The player car's continuous sound, synthesised live in Web Audio (no files, no licence): a
// four-cylinder engine (firing pulses at the engine's RPM, a half-order lope for an uneven idle,
// soft-clipped and low-passed, brighter under throttle, with a little exhaust breath), road roar
// (looped noise through a speed-tracking low-pass) and tyre squeal (noise through a narrow
// band-pass). Parameters come from vehicle-sound.ts each frame and are smoothed, so nothing
// clicks or steps.

import { IDLE_RPM, type EngineParams } from "./vehicle-sound.ts";

/** Smoothing time constant for every parameter, seconds. */
const SMOOTH_S = 0.08;
/** The engine low-pass never closes below this, so the idle's harmonics reach small speakers (its 28 Hz fundamental does not). */
const ENGINE_FILTER_FLOOR_HZ = 500;
const ENGINE_HIGHPASS_HZ = 80;
/** Depth of the half-order lope: the level swings by this much either side of 1. */
const LOPE_DEPTH = 0.18;

/** Firing pulses per second at idle: the oscillators start here, so the first set() does not sweep down from 440 Hz. */
const IDLE_FIRING_HZ = (IDLE_RPM / 60) * 2;

/** A tanh soft clip: rounds the pulse tops the way a muffled exhaust does. */
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
  /** Firing pulses, the half-order, the body sine, the lope. */
  private readonly firing: OscillatorNode;
  private readonly halfOrder: OscillatorNode;
  private readonly body: OscillatorNode;
  private readonly lope: OscillatorNode;
  private readonly engineFilter: BiquadFilterNode;
  private readonly engineGain: GainNode;
  private readonly breathFilter: BiquadFilterNode;
  private readonly breathGain: GainNode;
  private readonly roarFilter: BiquadFilterNode;
  private readonly roarGain: GainNode;
  private readonly squealGain: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];

  constructor(ctx: AudioContext, bus: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(bus);
    // Engine: pulses and half-order through a soft clip and a low-pass, then the level and the lope.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    // Below this the energy is felt, not heard: small speakers drop it and it only eats headroom.
    const rumbleCut = ctx.createBiquadFilter();
    rumbleCut.type = "highpass";
    rumbleCut.frequency.value = ENGINE_HIGHPASS_HZ;
    rumbleCut.Q.value = 0.7;
    rumbleCut.connect(this.engineGain);
    const loped = ctx.createGain();
    loped.gain.value = 1;
    this.engineGain.connect(loped);
    loped.connect(this.out);
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = ENGINE_FILTER_FLOOR_HZ;
    this.engineFilter.Q.value = 0.8;
    this.engineFilter.connect(rumbleCut);
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip(2.5);
    shaper.oversample = "2x";
    shaper.connect(this.engineFilter);
    this.firing = ctx.createOscillator();
    this.firing.type = "sawtooth";
    this.firing.connect(shaper);
    this.halfOrder = ctx.createOscillator();
    this.halfOrder.type = "square";
    const halfLevel = ctx.createGain();
    halfLevel.gain.value = 0.35;
    this.halfOrder.connect(halfLevel);
    halfLevel.connect(shaper);
    this.body = ctx.createOscillator();
    this.body.type = "sine";
    const bodyLevel = ctx.createGain();
    bodyLevel.gain.value = 0.3;
    this.body.connect(bodyLevel);
    bodyLevel.connect(rumbleCut);
    this.lope = ctx.createOscillator();
    this.lope.type = "sine";
    const lopeDepth = ctx.createGain();
    lopeDepth.gain.value = LOPE_DEPTH;
    this.lope.connect(lopeDepth);
    lopeDepth.connect(loped.gain);
    // One second of white noise, looped, shared by the breath, the roar and the squeal.
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    // A fixed LCG so the noise is the same every run (no Math.random in the repo's style).
    let seed = 0x2545f491;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = seed / 2147483648 - 1;
    }
    const breathSrc = ctx.createBufferSource(), roarSrc = ctx.createBufferSource(), squealSrc = ctx.createBufferSource();
    for (const [src, rate] of [[breathSrc, 1.03], [roarSrc, 1], [squealSrc, 0.97]] as const) {
      src.buffer = noise;
      src.loop = true;
      src.playbackRate.value = rate; // decorrelate the three layers
    }
    this.breathFilter = ctx.createBiquadFilter();
    this.breathFilter.type = "bandpass";
    this.breathFilter.frequency.value = 200;
    this.breathFilter.Q.value = 1.2;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    breathSrc.connect(this.breathFilter);
    this.breathFilter.connect(this.breathGain);
    this.breathGain.connect(loped);
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
    for (const [osc, hz] of [[this.firing, IDLE_FIRING_HZ], [this.halfOrder, IDLE_FIRING_HZ / 2], [this.body, IDLE_FIRING_HZ], [this.lope, IDLE_FIRING_HZ / 2]] as const)
      osc.frequency.value = hz;
    for (const s of [this.firing, this.halfOrder, this.body, this.lope, breathSrc, roarSrc, squealSrc]) {
      s.start();
      this.sources.push(s);
    }
  }

  /** This frame's parameters, or null for silence (on foot, paused). */
  set(p: EngineParams | null): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(p ? 1 : 0, t, p ? SMOOTH_S : 0.15);
    if (!p) return;
    const hz = p.firingHz;
    this.firing.frequency.setTargetAtTime(hz, t, SMOOTH_S);
    this.halfOrder.frequency.setTargetAtTime(hz / 2, t, SMOOTH_S);
    this.body.frequency.setTargetAtTime(hz, t, SMOOTH_S);
    this.lope.frequency.setTargetAtTime(hz / 2, t, SMOOTH_S);
    this.engineFilter.frequency.setTargetAtTime(ENGINE_FILTER_FLOOR_HZ + 900 * p.throttle + 3 * hz, t, SMOOTH_S);
    this.engineGain.gain.setTargetAtTime(p.engineGain, t, SMOOTH_S);
    this.breathFilter.frequency.setTargetAtTime(4 * hz, t, SMOOTH_S);
    this.breathGain.gain.setTargetAtTime(p.engineGain * (0.15 + 0.5 * p.throttle), t, SMOOTH_S);
    this.roarFilter.frequency.setTargetAtTime(p.roarCutoff, t, SMOOTH_S);
    this.roarGain.gain.setTargetAtTime(p.roarGain, t, SMOOTH_S);
    this.squealGain.gain.setTargetAtTime(p.squealGain, t, 0.04);
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
    }
    this.out.disconnect();
  }
}
