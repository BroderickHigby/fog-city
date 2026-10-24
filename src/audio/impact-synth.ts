// Collision sounds, synthesised live in Web Audio (no files, no licence), from the cues in
// impact-sound.ts: metal crunches with glass for cars and robotaxis, clanks, clatters and a
// power-down for robots, thuds and cracks for street props, scrapes for grinding contact, and the
// hiss of a gushing hydrant. Variation comes from each cue's id, so no two crunches are the same.

import type { ImpactCue } from "./impact-sound.ts";

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

/** A small seeded random sequence (per cue). */
const rng = (seed: number): (() => number) => {
  let s = (Math.imul(seed >>> 0, 2654435761) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

export class ImpactSynth {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly noise: AudioBuffer;
  private hiss: { gain: GainNode; pan: StereoPannerNode | null; source: AudioBufferSourceNode } | null = null;

  constructor(ctx: AudioContext, bus: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(bus);
    this.noise = noiseBuffer(ctx, 2, 0x7a11c0de);
  }

  play(cue: ImpactCue): void {
    const r = rng(cue.id);
    const dest = this.panned(cue.pan);
    const t = this.ctx.currentTime + 0.005;
    const h = cue.hardness, g = cue.gain;
    if (cue.scrape) {
      this.burst(dest, t, 0.25 + 0.25 * h, g * 0.5, "bandpass", 1800 + 1400 * r(), 3, 9 + 10 * r());
      return;
    }
    switch (cue.material) {
      case "metal": {
        // Body: a low thump. Panel: a band of noise, brighter and longer the harder the hit.
        this.thump(dest, t, 90 - 30 * h, g * (0.6 + 0.4 * h), 0.12 + 0.18 * h);
        this.burst(dest, t, 0.08 + 0.4 * h, g * 0.8, "bandpass", 900 + 1600 * h + 300 * r(), 0.8);
        if (cue.tier !== "bump") this.burst(dest, t + 0.02, 0.05 + 0.2 * h, g * 0.35, "highpass", 3500, 0.7);
        // Glass: a smash scatters it.
        if (cue.tier === "smash") for (let i = 0; i < 7; i++) this.ping(dest, t + 0.03 + 0.35 * r() * r(), 3200 + 3600 * r(), g * 0.12, 0.05 + 0.08 * r());
        break;
      }
      case "robot": {
        this.clank(dest, t, g, 0.9 + 0.2 * r());
        if (cue.fell) for (let i = 0, at = 0.18; i < 5; i++, at += 0.07 + 0.12 * r()) this.clank(dest, t + at, g * (0.55 - 0.08 * i), 1.1 + 0.4 * r());
        if (cue.disabled) this.powerDown(dest, t + 0.1, g * 0.5);
        break;
      }
      case "wood": {
        this.thump(dest, t, 120, g * 0.8, 0.14);
        this.burst(dest, t, 0.1, g * 0.4, "lowpass", 900, 0.7);
        if (cue.broke) {
          // Crack, then splinters.
          this.burst(dest, t + 0.01, 0.03, g * 0.9, "highpass", 1800, 0.7);
          for (let i = 0; i < 6; i++) this.burst(dest, t + 0.05 + 0.5 * r(), 0.015 + 0.02 * r(), g * 0.3 * r(), "bandpass", 1200 + 2000 * r(), 2);
        }
        break;
      }
      case "post": {
        // A pole rings; one knocked off its base clatters down as well.
        for (const [hz, lvl] of [[260, 0.5], [712, 0.35], [1347, 0.2]] as const) this.ping(dest, t, hz * (0.95 + 0.1 * r()), g * lvl, 0.5 + 0.4 * h);
        this.thump(dest, t, 80, g * 0.5, 0.1);
        if (cue.broke) for (let i = 0, at = 0.3; i < 3; i++, at += 0.12 + 0.1 * r()) this.burst(dest, t + at, 0.06, g * 0.4, "bandpass", 1500 + 800 * r(), 1.5);
        break;
      }
    }
  }

  /** The nearest gushing hydrant (null: none in earshot). */
  setHiss(h: { gain: number; pan: number } | null): void {
    const ctx = this.ctx, t = ctx.currentTime;
    if (!h) {
      this.hiss?.gain.gain.setTargetAtTime(0, t, 0.4);
      return;
    }
    if (!this.hiss) {
      const source = ctx.createBufferSource();
      source.buffer = this.noise;
      source.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2600;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = typeof ctx.createStereoPanner === "function" ? ctx.createStereoPanner() : null;
      source.connect(hp);
      hp.connect(gain);
      if (pan) {
        gain.connect(pan);
        pan.connect(this.out);
      } else gain.connect(this.out);
      source.start();
      this.hiss = { gain, pan, source };
    }
    this.hiss.gain.gain.setTargetAtTime(h.gain, t, 0.3);
    this.hiss.pan?.pan.setTargetAtTime(Math.max(-1, Math.min(1, h.pan)), t, 0.2);
  }

  hissing(): boolean {
    return this.hiss !== null && this.hiss.gain.gain.value > 1e-3;
  }

  private panned(pan: number): AudioNode {
    if (pan === 0 || typeof this.ctx.createStereoPanner !== "function") return this.out;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.out);
    return p;
  }

  /** A filtered noise burst; `wobbleHz` sweeps the filter (a scrape). */
  private burst(dest: AudioNode, t: number, dur: number, gain: number, type: BiquadFilterType, hz: number, q: number, wobbleHz = 0): void {
    if (gain <= 0) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    if (wobbleHz > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = wobbleHz;
      const depth = ctx.createGain();
      depth.gain.value = hz * 0.4;
      lfo.connect(depth);
      depth.connect(f.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + Math.min(0.004, dur / 4));
    env.gain.exponentialRampToValueAtTime(Math.max(1e-4, gain * 0.01), t + dur);
    src.connect(f);
    f.connect(env);
    env.connect(dest);
    src.start(t, (t * 7.3) % 1.5);
    src.stop(t + dur + 0.05);
    src.onended = () => env.disconnect();
  }

  /** A low body thump: a sine dropping in pitch. */
  private thump(dest: AudioNode, t: number, hz: number, gain: number, dur: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(hz * 1.8, t);
    o.frequency.exponentialRampToValueAtTime(hz, t + dur * 0.6);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.005);
    env.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    o.connect(env);
    env.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    o.onended = () => env.disconnect();
  }

  /** A decaying sine (glass, a ringing pole). */
  private ping(dest: AudioNode, t: number, hz: number, gain: number, dur: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.value = hz;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.002);
    env.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    o.connect(env);
    env.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    o.onended = () => env.disconnect();
  }

  /** A robot's shell: a few inharmonic partials and a tick of noise. */
  private clank(dest: AudioNode, t: number, gain: number, pitch: number): void {
    for (const [hz, lvl, dur] of [[420, 0.45, 0.25], [1130, 0.3, 0.18], [1870, 0.2, 0.12], [2960, 0.12, 0.08]] as const) this.ping(dest, t, hz * pitch, gain * lvl, dur);
    this.burst(dest, t, 0.03, gain * 0.5, "bandpass", 2400 * pitch, 1.2);
  }

  /** A robot switching off: a falling buzz. */
  private powerDown(dest: AudioNode, t: number, gain: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(620, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.9);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 1400;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(1e-4, t + 1);
    o.connect(f);
    f.connect(env);
    env.connect(dest);
    o.start(t);
    o.stop(t + 1.05);
    o.onended = () => env.disconnect();
  }

  dispose(): void {
    try {
      this.hiss?.source.stop();
    } catch {
      // Already stopped.
    }
    this.hiss = null;
    this.out.disconnect();
  }
}
