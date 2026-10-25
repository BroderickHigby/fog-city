// City ambience, synthesised live in Web Audio (no files, no licence): four continuous noise
// layers (traffic rumble, crowd murmur, wind, rain) and two events (a foghorn across the bay,
// gulls). Levels come from ambience.ts and are smoothed over a second or two, so walking from a
// quiet street into a busy one swells rather than switches.

import type { AmbienceLevels } from "./ambience.ts";

const SMOOTH_S = 0.9;

function noiseBuffer(ctx: AudioContext, seconds: number, seed: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = seed >>> 0;
  for (let i = 0; i < d.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    d[i] = s / 2147483648 - 1;
  }
  return buf;
}

interface Layer { gain: GainNode }

export class AmbienceSynth {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly layers: Record<"traffic" | "crowd" | "wind" | "rain", Layer>;
  private readonly sources: AudioScheduledSourceNode[] = [];

  constructor(ctx: AudioContext, bus: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(bus);
    const noise = noiseBuffer(ctx, 3, 0x1234567);
    const src = (rate = 1): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      s.playbackRate.value = rate;
      this.sources.push(s);
      return s;
    };
    const filter = (type: BiquadFilterType, hz: number, q = 0.7): BiquadFilterNode => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      return f;
    };
    const layer = (): Layer => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.out);
      return { gain };
    };
    const lfo = (hz: number, depth: number, target: AudioParam): void => {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g);
      g.connect(target);
      this.sources.push(o);
    };
    // Traffic: low rumble, slowly breathing as cars pass.
    const traffic = layer();
    const tf = filter("lowpass", 320);
    src(0.5).connect(tf);
    const tAm = ctx.createGain();
    tAm.gain.value = 1;
    tf.connect(tAm);
    tAm.connect(traffic.gain);
    lfo(0.07, 0.35, tAm.gain);
    // Crowd: three speech-band formants, each wavering at its own syllable rate.
    const crowd = layer();
    for (const [hz, rate, wobble] of [[520, 0.9, 3.1], [1150, 1.03, 4.3], [2400, 1.11, 5.7]] as const) {
      const f = filter("bandpass", hz, 1.4);
      const am = ctx.createGain();
      am.gain.value = 0.6;
      src(rate).connect(f);
      f.connect(am);
      am.connect(crowd.gain);
      lfo(wobble, 0.4, am.gain);
    }
    // Wind: a band of noise whose centre drifts slowly.
    const wind = layer();
    const wf = filter("bandpass", 420, 0.9);
    src(0.8).connect(wf);
    wf.connect(wind.gain);
    lfo(0.11, 180, wf.frequency);
    // Rain: bright hiss.
    const rain = layer();
    const rf = filter("highpass", 1400);
    const rf2 = filter("lowpass", 9000);
    src(1.0).connect(rf);
    rf.connect(rf2);
    rf2.connect(rain.gain);
    this.layers = { traffic, crowd, wind, rain };
    for (const s of this.sources) s.start();
  }

  set(levels: AmbienceLevels | null): void {
    const t = this.ctx.currentTime;
    for (const key of ["traffic", "crowd", "wind", "rain"] as const)
      this.layers[key].gain.gain.setTargetAtTime(levels ? levels[key] : 0, t, levels ? SMOOTH_S : 0.3);
  }

  /** A ship's foghorn across the bay: a long low two-tone call with a distant echo. */
  foghorn(gain: number, pan: number): void {
    const ctx = this.ctx, t = ctx.currentTime;
    const dest = this.panned(pan);
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.45;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(dest);
    for (const [hz, at, dur] of [[98, 0, 2.2], [73.4, 2.3, 2.6]] as const) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = hz;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 420;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t + at);
      env.gain.linearRampToValueAtTime(gain * 0.5, t + at + 0.35);
      env.gain.setValueAtTime(gain * 0.5, t + at + dur - 0.5);
      env.gain.linearRampToValueAtTime(0, t + at + dur);
      o.connect(f);
      f.connect(env);
      env.connect(dest);
      env.connect(delay);
      o.start(t + at);
      o.stop(t + at + dur + 0.05);
    }
  }

  /** A gull: two or three falling squawks (a frequency-modulated cry). */
  gull(gain: number, pan: number): void {
    const ctx = this.ctx, t = ctx.currentTime;
    const dest = this.panned(pan);
    const calls = 2 + Math.round(Math.abs(pan) * 2) % 2;
    for (let i = 0; i < calls; i++) {
      const at = t + i * 0.32, dur = 0.24;
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(1900 - i * 120, at);
      o.frequency.exponentialRampToValueAtTime(1150 - i * 80, at + dur);
      const vib = ctx.createOscillator();
      vib.frequency.value = 28;
      const vibDepth = ctx.createGain();
      vibDepth.gain.value = 110;
      vib.connect(vibDepth);
      vibDepth.connect(o.frequency);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(gain * 0.4, at + 0.03);
      env.gain.exponentialRampToValueAtTime(1e-4, at + dur);
      o.connect(env);
      env.connect(dest);
      o.start(at);
      vib.start(at);
      o.stop(at + dur + 0.02);
      vib.stop(at + dur + 0.02);
    }
  }

  private panned(pan: number): AudioNode {
    if (typeof this.ctx.createStereoPanner !== "function") return this.out;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.out);
    return p;
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
