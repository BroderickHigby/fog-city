// What nearby robots sound like this frame. Pure and read-only.
//
// Fairness: nothing here reads a robot's firmware. Every robot of a model whirrs and beeps the
// same way; a bad robot is only audible through its designed audio tells (content/bot-tells.json
// channel "audio": humJingle in cues.ts, tryCarDoors here), and only while the tell is showing.

/** The fields of a runtime actor this reads (src/sim/agents/runtime.ts RuntimeActor). */
export interface SoundingActor {
  id: string;
  model: string;
  x: number;
  z: number;
  speed: number;
  retired: boolean;
  tellIds: readonly string[];
  hiddenTellId: string | null;
}

/** Each model's servo voice: base pitch, and the beep pattern it chirps now and then. */
export interface RobotVoice {
  /** Servo whirr pitch at walking speed, Hz. */
  servoHz: number;
  /** Oscillator shape for the whirr. */
  wave: OscillatorType;
  /** Beep pattern, Hz per note (each 70 ms, 40 ms apart). */
  beeps: readonly number[];
}

export const ROBOT_VOICES: Readonly<Record<string, RobotVoice>> = {
  footman: { servoHz: 260, wave: "square", beeps: [1760, 2093] },
  trundle: { servoHz: 170, wave: "sawtooth", beeps: [1318, 1046] },
  patrol: { servoHz: 210, wave: "square", beeps: [1568, 1568, 1975] },
  tidy: { servoHz: 300, wave: "triangle", beeps: [2349, 1975, 2349] },
  drone: { servoHz: 140, wave: "sawtooth", beeps: [2637] },
  "sign-spinner": { servoHz: 240, wave: "triangle", beeps: [1174, 1396, 1760] },
};

/** Whirrs are heard within this, at most this many at once (the nearest). */
export const ROBOT_HEAR_M = 32;
export const MAX_ROBOT_VOICES = 3;

export interface RobotWhirr {
  id: string;
  model: string;
  /** Servo pitch now, Hz (rises with speed). */
  hz: number;
  wave: OscillatorType;
  gain: number;
  pan: number;
}

const panOf = (lx: number, lz: number, heading: number, x: number, z: number): number => {
  const dx = x - lx, dz = z - lz, d = Math.hypot(dx, dz);
  return d < 1e-6 ? 0 : Math.max(-1, Math.min(1, (dx * Math.cos(heading) + dz * Math.sin(heading)) / d)) * 0.8;
};

/**
 * The nearest robots' whirrs. A standing robot idles quietly; a moving one whirrs louder and
 * higher. Robots out of action (seized, slumping, heaped: `inactive`) are silent.
 */
export function robotWhirrs(actors: readonly SoundingActor[], listener: { x: number; z: number; heading: number }, inactive: (id: string) => boolean): RobotWhirr[] {
  const near: Array<{ a: SoundingActor; d: number }> = [];
  for (const a of actors) {
    if (a.retired || !ROBOT_VOICES[a.model] || inactive(a.id)) continue;
    const d = Math.hypot(a.x - listener.x, a.z - listener.z);
    if (d <= ROBOT_HEAR_M) near.push({ a, d });
  }
  near.sort((p, q) => p.d - q.d || (p.a.id < q.a.id ? -1 : 1));
  return near.slice(0, MAX_ROBOT_VOICES).map(({ a, d }) => {
    const v = ROBOT_VOICES[a.model]!;
    const moving = Math.min(1, Math.abs(a.speed) / 1.5);
    const fall = 1 - d / ROBOT_HEAR_M;
    return {
      id: a.id,
      model: a.model,
      hz: v.servoHz * (0.85 + 0.3 * moving),
      wave: v.wave,
      gain: (0.025 + 0.06 * moving) * fall * fall,
      pan: panOf(listener.x, listener.z, listener.heading, a.x, a.z),
    };
  });
}

/** content/bot-tells.json tryCarDoors: a hopeful "pairing..." chime every 20 s. */
export const PAIRING_TELL = "tryCarDoors";
export const PAIRING_INTERVAL_MS = 20_000;
export const PAIRING_RANGE_M = 15;
/** Idle beeps: each robot chirps every 7 to 16 s (fixed per robot), when within this. */
export const BEEP_RANGE_M = 24;

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

export interface RobotChirp {
  kind: "beep" | "pairing";
  id: string;
  /** Beep notes (Hz) for "beep". */
  notes: readonly number[];
  gain: number;
  pan: number;
}

/** Idle beeps and the pairing tell, each robot on its own fixed rhythm. */
export class RobotChirpClock {
  private readonly next = new Map<string, number>();
  private readonly nextPairing = new Map<string, number>();

  update(actors: readonly SoundingActor[], listener: { x: number; z: number; heading: number }, inactive: (id: string) => boolean, nowMs: number): RobotChirp[] {
    const out: RobotChirp[] = [];
    for (const a of actors) {
      const v = ROBOT_VOICES[a.model];
      if (a.retired || !v || inactive(a.id)) continue;
      const d = Math.hypot(a.x - listener.x, a.z - listener.z);
      const pan = panOf(listener.x, listener.z, listener.heading, a.x, a.z);
      if (d <= BEEP_RANGE_M) {
        const h = hash(a.id);
        const period = 7000 + (h % 9000);
        const due = this.next.get(a.id);
        if (due === undefined) this.next.set(a.id, nowMs + (h % period));
        else if (nowMs >= due) {
          this.next.set(a.id, nowMs + period);
          out.push({ kind: "beep", id: a.id, notes: v.beeps, gain: 0.18 * (1 - d / BEEP_RANGE_M), pan });
        }
      } else this.next.delete(a.id);
      if (a.tellIds.includes(PAIRING_TELL) && a.hiddenTellId !== PAIRING_TELL && d <= PAIRING_RANGE_M) {
        const due = this.nextPairing.get(a.id);
        if (due === undefined) this.nextPairing.set(a.id, nowMs + 3000 + (hash(a.id) % 6000));
        else if (nowMs >= due) {
          this.nextPairing.set(a.id, nowMs + PAIRING_INTERVAL_MS);
          out.push({ kind: "pairing", id: a.id, notes: [], gain: 0.35 * (1 - d / PAIRING_RANGE_M), pan });
        }
      }
    }
    return out;
  }

  reset(): void {
    this.next.clear();
    this.nextPairing.clear();
  }
}
