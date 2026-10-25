// Procedural sound effects, made live in Web Audio (no files, no licence): robot servo whirrs,
// robot beeps and the tryCarDoors "pairing..." chime, UI clicks, the phone, mission stingers,
// money and the scanner's result. Everything goes to the effects bus.

import type { RobotWhirr } from "./robot-sound.ts";

export type SynthCue = "click" | "phone" | "mission-start" | "mission-complete" | "money" | "scan-good" | "scan-bad" | "pairing";

interface Tone { hz: number; at: number; dur: number; type?: OscillatorType; glideTo?: number; level?: number }

/** The notes of each cue: frequency, start (s), length (s). */
export const SYNTH_CUES: Readonly<Record<SynthCue, readonly Tone[]>> = {
  click: [{ hz: 1800, at: 0, dur: 0.025, type: "triangle", level: 0.5 }],
  phone: [{ hz: 988, at: 0, dur: 0.08 }, { hz: 1319, at: 0.09, dur: 0.12 }],
  // C5 E5 G5: something to do.
  "mission-start": [{ hz: 523.25, at: 0, dur: 0.14, type: "triangle" }, { hz: 659.25, at: 0.12, dur: 0.14, type: "triangle" }, { hz: 783.99, at: 0.24, dur: 0.3, type: "triangle" }],
  // C5 E5 G5 C6 and a held major chord: done.
  "mission-complete": [
    { hz: 523.25, at: 0, dur: 0.12, type: "triangle" }, { hz: 659.25, at: 0.1, dur: 0.12, type: "triangle" }, { hz: 783.99, at: 0.2, dur: 0.12, type: "triangle" },
    { hz: 1046.5, at: 0.3, dur: 0.9, type: "triangle" }, { hz: 659.25, at: 0.3, dur: 0.9, level: 0.4 }, { hz: 783.99, at: 0.3, dur: 0.9, level: 0.4 },
  ],
  // Two bright bell strikes: ka-ching.
  money: [{ hz: 2637, at: 0, dur: 0.18, level: 0.7 }, { hz: 3136, at: 0.07, dur: 0.35, level: 0.8 }, { hz: 6272, at: 0.07, dur: 0.12, level: 0.2 }],
  "scan-good": [{ hz: 1318.5, at: 0, dur: 0.07 }, { hz: 1760, at: 0.09, dur: 0.12 }],
  "scan-bad": [{ hz: 880, at: 0, dur: 0.09, type: "square", level: 0.5 }, { hz: 622.25, at: 0.11, dur: 0.18, type: "square", level: 0.5 }],
  // "pairing..." : a hopeful rising glide, then three soft dots.
  pairing: [{ hz: 880, at: 0, dur: 0.22, glideTo: 1320 }, { hz: 1760, at: 0.34, dur: 0.05, level: 0.5 }, { hz: 1760, at: 0.48, dur: 0.05, level: 0.4 }, { hz: 1760, at: 0.62, dur: 0.05, level: 0.3 }],
};

/** Plays tones with short attack/decay envelopes into `dest`. Returns the end time. */
export function playTones(ctx: AudioContext, dest: AudioNode, tones: readonly Tone[], gain: number, pan = 0, when = ctx.currentTime): number {
  if (gain <= 0) return when;
  let out: AudioNode = dest;
  if (pan !== 0 && typeof ctx.createStereoPanner === "function") {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(dest);
    out = p;
  }
  let end = when;
  for (const tone of tones) {
    const t0 = when + tone.at, t1 = t0 + tone.dur, level = gain * (tone.level ?? 1) * 0.5;
    const osc = ctx.createOscillator();
    osc.type = tone.type ?? "sine";
    osc.frequency.setValueAtTime(tone.hz, t0);
    if (tone.glideTo) osc.frequency.exponentialRampToValueAtTime(tone.glideTo, t1);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(level, t0 + Math.min(0.008, tone.dur / 4));
    env.gain.exponentialRampToValueAtTime(Math.max(1e-4, level * 0.02), t1);
    osc.connect(env);
    env.connect(out);
    osc.start(t0);
    osc.stop(t1 + 0.02);
    osc.onended = () => env.disconnect();
    end = Math.max(end, t1);
  }
  return end;
}

/** A robot's beep pattern: each note 70 ms, 110 ms apart, square through the tone envelope. */
export function beepTones(notes: readonly number[]): Tone[] {
  return notes.map((hz, i) => ({ hz, at: i * 0.11, dur: 0.07, type: "square", level: 0.35 }));
}

interface Slot { id: string; osc: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; pan: StereoPannerNode | null; wave: OscillatorType }

/** Up to N servo whirr voices for the nearest robots, smoothly reassigned as robots come and go. */
export class RobotVoices {
  private readonly ctx: AudioContext;
  private readonly bus: AudioNode;
  private slots: Slot[] = [];

  constructor(ctx: AudioContext, bus: AudioNode) {
    this.ctx = ctx;
    this.bus = bus;
  }

  update(whirrs: readonly RobotWhirr[]): void {
    const t = this.ctx.currentTime;
    const keep = new Set(whirrs.map((w) => w.id));
    // Robots no longer heard fade out and free their slot.
    for (const s of this.slots.filter((s) => !keep.has(s.id))) this.release(s, t);
    this.slots = this.slots.filter((s) => keep.has(s.id));
    for (const w of whirrs) {
      let slot = this.slots.find((s) => s.id === w.id);
      if (!slot) {
        slot = this.create(w);
        this.slots.push(slot);
      }
      slot.osc.frequency.setTargetAtTime(w.hz, t, 0.12);
      slot.filter.frequency.setTargetAtTime(w.hz * 3, t, 0.12);
      slot.gain.gain.setTargetAtTime(w.gain, t, 0.1);
      slot.pan?.pan.setTargetAtTime(w.pan, t, 0.1);
    }
  }

  private create(w: RobotWhirr): Slot {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = w.wave;
    osc.frequency.value = w.hz;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 2.5;
    filter.frequency.value = w.hz * 3;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = typeof ctx.createStereoPanner === "function" ? ctx.createStereoPanner() : null;
    osc.connect(filter);
    filter.connect(gain);
    if (pan) {
      gain.connect(pan);
      pan.connect(this.bus);
    } else gain.connect(this.bus);
    osc.start();
    return { id: w.id, osc, filter, gain, pan, wave: w.wave };
  }

  private release(s: Slot, t: number): void {
    s.gain.gain.setTargetAtTime(0, t, 0.12);
    try {
      s.osc.stop(t + 0.8);
    } catch {
      // Already stopped.
    }
    s.osc.onended = () => (s.pan ?? s.gain).disconnect();
  }

  /** How many robots are audible now (tests, diagnostics). */
  count(): number {
    return this.slots.length;
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    for (const s of this.slots) this.release(s, t);
    this.slots = [];
  }
}
