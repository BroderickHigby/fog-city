// The horn: which players honked this tick, read from the same input frame the sim stepped
// with (keyboard H, pad L3 and the touch button all set Action.horn), and a short synthesized
// two-tone horn. People and robots react inside the sim (src/sim/agents/reactions.ts, robot
// hearing in src/sim/robots/brain.ts); this file only makes it audible. Read-only: playing
// or failing to play never changes the sim.

import { Action, type InputFrame, type SimState } from "../sim/contract.ts";

export interface HornBlast {
  playerId: string;
  x: number;
  z: number;
  /** A car horn from the driver's seat; on foot a smaller pocket air horn. */
  inVehicle: boolean;
}

/** design.md: the horn is heard within 40 m; the player hears it a little further. */
export const HORN_HEARD_M = 60;

/** Every player whose stepped input this tick carried the horn, in player-id order. */
export function hornBlasts(frame: InputFrame, state: Readonly<SimState>): HornBlast[] {
  const out: HornBlast[] = [];
  for (const id of Object.keys(frame).sort()) {
    const input = frame[id];
    const player = state.players[id];
    if (!input || !player || (input.actions & Action.horn) === 0) continue;
    const foot = player.mode === "foot" && player.foot !== null;
    const body = foot ? player.foot! : player.car;
    out.push({ playerId: id, x: body.x, z: body.z, inVehicle: !foot });
  }
  return out;
}

/** 1 at the listener, fading linearly to 0 at HORN_HEARD_M. */
export function hornGain(blast: HornBlast, listener: { x: number; z: number }): number {
  const d = Math.hypot(blast.x - listener.x, blast.z - listener.z);
  return d >= HORN_HEARD_M ? 0 : 1 - d / HORN_HEARD_M;
}

type AudioContextCtor = new () => AudioContext;

/** A synthesized horn (no sample file): two detuned square tones through a low-pass. */
export class HornVoice {
  private context: AudioContext | null = null;
  private volume = 0.35;
  /** Horns started so far (the browser test reads it through the page). */
  played = 0;

  /** Call from a user gesture: browsers start audio only after one. */
  unlock(): void {
    const Ctor = (globalThis as { AudioContext?: AudioContextCtor }).AudioContext;
    if (!this.context && Ctor) {
      try {
        this.context = new Ctor();
      } catch {
        this.context = null;
      }
    }
    void this.context?.resume().catch(() => {});
  }

  setVolume(volume: number): void {
    this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.35;
  }

  play(blast: HornBlast, listener: { x: number; z: number }): void {
    const ctx = this.context;
    const level = hornGain(blast, listener) * this.volume;
    if (!ctx || level <= 0) return;
    const t = ctx.currentTime;
    const length = blast.inVehicle ? 0.42 : 0.26;
    const tones = blast.inVehicle ? [392, 494] : [784, 988];
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(level, t + 0.015);
    out.gain.setValueAtTime(level, t + length - 0.06);
    out.gain.linearRampToValueAtTime(0, t + length);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = blast.inVehicle ? 1800 : 3200;
    filter.connect(out);
    out.connect(ctx.destination);
    for (const hz of tones) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = hz;
      const voice = ctx.createGain();
      voice.gain.value = 0.5;
      osc.connect(voice);
      voice.connect(filter);
      osc.start(t);
      osc.stop(t + length + 0.02);
    }
    this.played++;
  }

  dispose(): void {
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
