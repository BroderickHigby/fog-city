// Collision sounds, from the sim's impact events (state.ext.impacts, src/sim/impacts.ts). Pure
// and read-only. Read defensively: before the impacts system lands there is no ext.impacts and
// this stays silent.
//
// - Each event plays once (deduped by its durable id); events already there when the game loads
//   or a save restores never play.
// - Loudness and timbre follow `dv` (how hard it felt): a bump below 3 m/s, a crunch from 3 to 8,
//   a smash above 8.
// - The surface hit (the part of `kind` after the dash) picks the timbre: car and taxi crunch
//   metal and glass, a robot clanks (a clatter as it falls over, a sad power-down when the hit
//   disabled it), a prop thuds when it holds and cracks when it breaks (wood for trees).
// - The same two bodies touching again within SCRAPE_WINDOW_TICKS scrape rather than crunch.
// - A knocked-off hydrant hisses while it gushes (ext.impacts.props).

export type ImpactSurface = "car" | "taxi" | "robot" | "prop";
export type ImpactTier = "bump" | "crunch" | "smash";
export type ImpactMaterial = "metal" | "robot" | "wood" | "post";

/** The event fields this reads (src/sim/impacts.ts ImpactEvent). */
export interface ImpactEventLike {
  id: number;
  tick: number;
  kind: string;
  a: string;
  b: string;
  x: number;
  z: number;
  speed: number;
  dv: number;
  fell?: boolean;
  disabled?: boolean;
  broke?: boolean;
}

export interface ImpactsLike {
  events?: readonly ImpactEventLike[];
  props?: Readonly<Record<string, { kind: string }>>;
}

export interface ImpactCue {
  id: number;
  tier: ImpactTier;
  material: ImpactMaterial;
  /** 0..1 how hard (dv over SMASH_DV), for the synth's brightness and length. */
  hardness: number;
  gain: number;
  pan: number;
  /** The same bodies grinding on: a scrape instead of a crunch. */
  scrape: boolean;
  /** A robot knocked over: a clatter after the clank. */
  fell: boolean;
  /** A robot disabled: a falling power-down tone. */
  disabled: boolean;
  /** A prop broke (a crack; a tree splinters). */
  broke: boolean;
  /** The local player's own car was one of the bodies (the car's own impact one-shot stands down). */
  self: boolean;
}

export const BUMP_DV = 3;
export const SMASH_DV = 8;
/** Impacts are heard within this. */
export const IMPACT_HEAR_M = 90;
/** At most this many new impacts play per frame (a pile-up does not stack twenty crunches). */
export const MAX_IMPACTS_PER_FRAME = 3;
/** The same pair again within this many ticks (60 a second) is a scrape. */
export const SCRAPE_WINDOW_TICKS = 30;
/** A gushing hydrant is heard within this. */
export const HYDRANT_HEAR_M = 40;

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

export function tierOf(dv: number): ImpactTier {
  return dv < BUMP_DV ? "bump" : dv <= SMASH_DV ? "crunch" : "smash";
}

/** The surface hit: the part of the kind after the dash ("car-robot" -> "robot"). */
export function surfaceOf(kind: string): ImpactSurface | null {
  const s = kind.slice(kind.indexOf("-") + 1);
  return s === "car" || s === "taxi" || s === "robot" || s === "prop" ? s : null;
}

function materialOf(e: ImpactEventLike, surface: ImpactSurface, props: ImpactsLike["props"]): ImpactMaterial {
  if (surface === "robot") return "robot";
  if (surface !== "prop") return "metal";
  // Prop bodies are keyed "prop:<prop id>"; tree ids start "tree:".
  const id = e.b.startsWith("prop:") ? e.b.slice(5) : e.b;
  const kind = props?.[id]?.kind ?? (id.startsWith("tree:") ? "tree" : "post");
  return kind === "tree" ? "wood" : "post";
}

const panOf = (listener: { x: number; z: number; heading: number }, x: number, z: number): number => {
  const dx = x - listener.x, dz = z - listener.z, d = Math.hypot(dx, dz);
  return d < 1e-6 ? 0 : Math.max(-1, Math.min(1, (dx * Math.cos(listener.heading) + dz * Math.sin(listener.heading)) / d)) * 0.8;
};

/** Turns new impact events into sounds, once each. */
export class ImpactSoundTracker {
  private lastId: number | null = null;
  /** Ticks of the last hit between each pair of bodies, for scrapes. */
  private readonly lastPair = new Map<string, number>();
  /** Where props broke (from their events), for the hydrant hiss after the event rolls off. */
  private readonly brokeAt = new Map<string, { x: number; z: number }>();

  update(impacts: ImpactsLike | undefined | null, listener: { x: number; z: number; heading: number }, selfKey: string, paused: boolean): ImpactCue[] {
    const events = Array.isArray(impacts?.events) ? impacts!.events! : [];
    const newest = events.reduce((m, e) => Math.max(m, typeof e.id === "number" ? e.id : 0), 0);
    // First sight (load, restore): everything already there has happened.
    if (this.lastId === null || paused) {
      this.lastId = Math.max(this.lastId ?? 0, newest);
      return [];
    }
    const out: ImpactCue[] = [];
    for (const e of events) {
      if (typeof e.id !== "number" || e.id <= this.lastId) continue;
      const surface = surfaceOf(e.kind);
      if (!surface || !Number.isFinite(e.dv)) continue;
      if (e.broke === true && e.b.startsWith("prop:")) this.brokeAt.set(e.b.slice(5), { x: e.x, z: e.z });
      const pair = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
      const before = this.lastPair.get(pair);
      this.lastPair.set(pair, e.tick);
      const self = e.a === selfKey || e.b === selfKey;
      const d = self ? 0 : Math.hypot(e.x - listener.x, e.z - listener.z);
      if (d > IMPACT_HEAR_M) continue;
      const hardness = clamp01(e.dv / SMASH_DV);
      const fall = 1 - d / IMPACT_HEAR_M;
      const scrape = before !== undefined && e.tick - before <= SCRAPE_WINDOW_TICKS && e.dv < SMASH_DV;
      out.push({
        id: e.id,
        tier: tierOf(e.dv),
        material: materialOf(e, surface, impacts?.props),
        hardness,
        gain: (0.2 + 0.8 * Math.sqrt(hardness)) * fall * fall * (scrape ? 0.6 : 1),
        pan: self ? 0 : panOf(listener, e.x, e.z),
        scrape,
        fell: e.fell === true,
        disabled: e.disabled === true,
        broke: e.broke === true,
        self,
      });
    }
    this.lastId = Math.max(this.lastId, newest);
    // Forget old pairs.
    const latest = events.length > 0 ? events[events.length - 1]!.tick : 0;
    for (const [k, t] of this.lastPair) if (latest - t > SCRAPE_WINDOW_TICKS * 4) this.lastPair.delete(k);
    // The player's own first, then the loudest few.
    return out.sort((p, q) => Number(q.self) - Number(p.self) || q.gain - p.gain || p.id - q.id).slice(0, MAX_IMPACTS_PER_FRAME);
  }

  /** A save restore: the next sight starts fresh (nothing replays). */
  reset(): void {
    this.lastId = null;
    this.lastPair.clear();
    this.brokeAt.clear();
  }

  /** The hiss of the nearest gushing hydrant heard breaking (ext.impacts.props), or null. */
  hydrant(impacts: ImpactsLike | undefined | null, listener: { x: number; z: number; heading: number }): { gain: number; pan: number } | null {
    const props = impacts?.props;
    for (const id of [...this.brokeAt.keys()]) if (!props?.[id]) this.brokeAt.delete(id);
    return hydrantHiss(impacts, listener, (id) => this.brokeAt.get(id) ?? null);
  }
}

/**
 * The hiss of the nearest gushing hydrant (a knocked-off hydrant in ext.impacts.props), or null.
 * `where` gives a prop's position; props it does not know are not heard.
 */
export function hydrantHiss(impacts: ImpactsLike | undefined | null, listener: { x: number; z: number; heading: number }, where: (id: string) => { x: number; z: number } | null): { gain: number; pan: number } | null {
  const props = impacts?.props;
  if (!props) return null;
  let best: { d: number; x: number; z: number } | null = null;
  for (const id of Object.keys(props)) {
    if (props[id]?.kind !== "hydrant") continue;
    const p = where(id);
    if (!p) continue;
    const d = Math.hypot(p.x - listener.x, p.z - listener.z);
    if (d <= HYDRANT_HEAR_M && (!best || d < best.d)) best = { d, x: p.x, z: p.z };
  }
  if (!best) return null;
  const fall = 1 - best.d / HYDRANT_HEAR_M;
  return { gain: 0.3 * fall * fall, pan: panOf(listener, best.x, best.z) };
}
