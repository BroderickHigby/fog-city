// The player car's continuous sound, synthesised live in Web Audio (no files, no licence): an
// EV motor whine (two detuned partials through a low-pass), road roar (looped noise through a
// speed-tracking low-pass) and tyre squeal (noise through a narrow band-pass). Parameters come
// from vehicle-sound.ts each frame and are smoothed, so nothing clicks or steps.

import type { EngineParams } from "./vehicle-sound.ts";

/** Smoothing time constant for every parameter, seconds. */
const SMOOTH_S = 0.08;

export class VehicleSynth {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly whine: [OscillatorNode, OscillatorNode];
  private readonly whineGain: GainNode;
  private readonly roarFilter: BiquadFilterNode;
  private readonly roarGain: GainNode;
  private readonly squealGain: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];

  constructor(ctx: AudioContext, bus: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(bus);
    // Motor whine.
    const whineFilter = ctx.createBiquadFilter();
    whineFilter.type = "lowpass";
    whineFilter.frequency.value = 2200;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    whineFilter.connect(this.whineGain);
    this.whineGain.connect(this.out);
    const a = ctx.createOscillator(), b = ctx.createOscillator();
    a.type = "sawtooth";
    b.type = "sine";
    const bLevel = ctx.createGain();
    bLevel.gain.value = 0.6;
    a.connect(whineFilter);
    b.connect(bLevel);
    bLevel.connect(whineFilter);
    this.whine = [a, b];
    // One second of white noise, looped, shared by the roar and the squeal.
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    // A fixed LCG so the noise is the same every run (no Math.random in the repo's style).
    let seed = 0x2545f491;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = seed / 2147483648 - 1;
    }
    const roarSrc = ctx.createBufferSource(), squealSrc = ctx.createBufferSource();
    roarSrc.buffer = noise;
    roarSrc.loop = true;
    squealSrc.buffer = noise;
    squealSrc.loop = true;
    squealSrc.playbackRate.value = 0.97; // decorrelate from the roar
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
    for (const s of [a, b, roarSrc, squealSrc]) {
      s.start();
      this.sources.push(s);
    }
  }

  /** This frame's parameters, or null for silence (on foot, paused). */
  set(p: EngineParams | null): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(p ? 1 : 0, t, p ? SMOOTH_S : 0.15);
    if (!p) return;
    this.whine[0].frequency.setTargetAtTime(p.whineHz, t, SMOOTH_S);
    this.whine[1].frequency.setTargetAtTime(p.whineHz * 2.01, t, SMOOTH_S);
    this.whineGain.gain.setTargetAtTime(p.whineGain, t, SMOOTH_S);
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
