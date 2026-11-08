// Car-by-car traffic on the corridor: the Intelligent Driver Model (Treiber, Hennecke and Helbing,
// 2000) in each lane, signals as stop lines, cars turning off and on at the cross streets, and the
// cross streets themselves as queues. Deterministic: every random draw comes from the seed and
// is made before the run, so two signal plans see exactly the same cars ("common random numbers").
import { nextFloat, seedRng } from "../sim/rng.ts";
import type { RngState } from "../sim/contract.ts";
import type { Corridor } from "./corridor.ts";
import type { Demand } from "./demand.ts";
import { co2GramsFromFuelMl, fuelRateMlPerS, stopPenaltyMl } from "./emissions.ts";
import { ARRB } from "./data.ts";
import { adaptiveAspects, adaptiveStep, fixedAspects, type AdaptiveState, type Aspect, type ControlPlan } from "./signals.ts";

/** IDM parameters for a city car. */
export const IDM = Object.freeze({ v0: 12.5, a: 1.4, b: 2.0, T: 1.3, s0: 2.0, len: 4.6, turnV0: 5, stopDecel: 3.0 });
/** Stop lines sit this far before the intersection's centre. */
export const STOP_BACK_M = 9;
/** A cross-street lane discharges this many cars per second of green (1,800 per hour). */
export const CROSS_SAT_PER_S = 0.5;

export interface Car {
  id: number;
  dir: 0 | 1;
  lane: number;
  s: number;
  v: number;
  acc: number;
  /** Signal index (east-to-west) where it turns off, or -1 to drive the whole corridor. */
  exitAt: number;
  /** Next stop line, as a position in the direction's stop list. */
  next: number;
  /** Committed to cross the next stop line on yellow; or decided to stop for it. */
  goNext: boolean;
  stopNext: boolean;
  enteredAt: number;
  fromEnd: boolean;
  stops: number;
  moving: boolean;
}

export interface Snapshot {
  t: number;
  cars: readonly Car[];
  /** Lombard's aspect at each signal (east-to-west). */
  main: readonly Aspect[];
  cross: readonly Aspect[];
  crossQueue: readonly number[];
  entryQueue: readonly [number, number];
}

export interface Metrics {
  plan: string;
  demand: string;
  /** Average time to drive the whole corridor, seconds: [westbound, eastbound]. */
  travelTimeS: [number, number];
  /** Cars that drove the whole corridor and were counted. */
  through: [number, number];
  /** Average stops per car on Lombard. */
  stopsPerCar: number;
  /** Hours lost to waiting, per hour simulated: Lombard (incl. waiting to get on) and cross streets. */
  delayHoursPerHour: { main: number; cross: number };
  co2KgPerHour: { main: number; cross: number; total: number };
  fuelLitresPerHour: number;
  /** Cars delivered per hour off the west end (to the bridge) and the east end. */
  exitsPerHour: [number, number];
  /** Longest wait to get onto Lombard at either end, cars. */
  maxEntryQueue: number;
  /** One value per simulated minute after warm-up. */
  perMinute: { co2KgPerHour: number[]; meanSpeedKmh: number[] };
  meanSpeedKmh: number;
}

export interface RunOptions {
  seed?: number;
  dt?: number;
  warmupS?: number;
  durationS?: number;
}

interface Stop { idx: number; at: number }

function exponential(rng: RngState, rate: number): [number, RngState] {
  const [u, n] = nextFloat(rng);
  return [-Math.log(1 - u) / rate, n];
}

/** Poisson arrivals, drawn one at a time from their own seeded stream. */
class Arrivals {
  private rng: RngState;
  private readonly rate: number;
  next: number;
  count = 0;
  constructor(seed: number, ratePerHour: number) {
    this.rng = seedRng(seed); this.rate = ratePerHour / 3600; this.next = Infinity;
    if (this.rate > 0) this.advance();
  }
  private advance(): void {
    const [gap, n] = exponential(this.rng, this.rate); this.rng = n;
    this.next = (Number.isFinite(this.next) ? this.next : 0) + gap;
  }
  /** Arrival times up to t, oldest first. */
  take(t: number, into: (at: number) => void): void {
    while (this.next <= t) { into(this.next); this.count++; this.advance(); }
  }
}

export class CorridorSim {
  readonly corridor: Corridor;
  readonly demand: Demand;
  readonly plan: ControlPlan;
  readonly dt: number;
  readonly warmupS: number;
  readonly endS: number;
  t = 0;
  private nextId = 1;
  /** Lanes per direction, each sorted front (furthest along) first. */
  readonly lanes: [Car[][], Car[][]];
  /** Stop lines per direction, in driving order. */
  readonly stops: [Stop[], Stop[]];
  private readonly entryArrivals: [Arrivals, Arrivals];
  private entryWaiting: [number[], number[]] = [[], []];
  private readonly inArrivals: Arrivals[][];
  private readonly inWaiting: number[][];
  private exitDraw: [RngState, RngState];
  readonly crossQueue: number[];
  private readonly crossGreenFor: number[];
  private readonly adaptive: AdaptiveState[];
  readonly main: Aspect[];
  readonly cross: Aspect[];
  private readonly stopPenalty: number;
  // Accumulators, from the end of warm-up.
  private fuelMl = 0;
  private crossFuelMl = 0;
  private delayMain = 0;
  private delayCross = 0;
  private stopsCounted = 0;
  private carsCounted = 0;
  private exits: [number, number] = [0, 0];
  private readonly travel: [number[], number[]] = [[], []];
  private maxEntry = 0;
  private minuteFuel = 0;
  private minuteSpeed = 0;
  private minuteSamples = 0;
  private readonly perMinute = { co2KgPerHour: [] as number[], meanSpeedKmh: [] as number[] };
  private speedSum = 0;
  private speedSamples = 0;

  constructor(corridor: Corridor, demand: Demand, plan: ControlPlan, opts: RunOptions = {}) {
    this.corridor = corridor; this.demand = demand; this.plan = plan;
    this.dt = opts.dt ?? 0.5;
    this.warmupS = opts.warmupS ?? 300;
    this.endS = this.warmupS + (opts.durationS ?? 3600);
    const seed = opts.seed ?? 1;
    const n = corridor.signals.length, L = corridor.length, lanes = corridor.lanesPerDirection;
    this.lanes = [Array.from({ length: lanes }, () => []), Array.from({ length: lanes }, () => [])];
    // Westbound passes every signal but Van Ness (it enters there, already turned); eastbound all of them.
    const wb: Stop[] = [], eb: Stop[] = [];
    for (let i = 1; i < n; i++) wb.push({ idx: i, at: corridor.signals[i]!.s - STOP_BACK_M });
    for (let i = n - 1; i >= 0; i--) eb.push({ idx: i, at: L - corridor.signals[i]!.s - STOP_BACK_M });
    this.stops = [wb, eb];
    this.entryArrivals = [new Arrivals(seed * 101 + 1, demand.entry[0]), new Arrivals(seed * 101 + 2, demand.entry[1])];
    this.inArrivals = [0, 1].map((d) => corridor.signals.map((_, i) => new Arrivals(seed * 1009 + d * 97 + i * 7 + 3, demand.inRate[d]![i]!)));
    this.inWaiting = [new Array<number>(n).fill(0), new Array<number>(n).fill(0)];
    this.exitDraw = [seedRng(seed * 31 + 5), seedRng(seed * 31 + 6)];
    this.crossQueue = new Array<number>(n).fill(0);
    this.crossGreenFor = new Array<number>(n).fill(0);
    this.adaptive = corridor.signals.map(() => ({ phase: "main", elapsed: 0 }));
    this.main = new Array<Aspect>(n).fill("green");
    this.cross = new Array<Aspect>(n).fill("red");
    this.stopPenalty = stopPenaltyMl(IDM.v0 * 0.8);
  }

  private stopLine(dir: 0 | 1, k: number): Stop | undefined { return this.stops[dir][k]; }

  /** Where along its direction a car turning off at signal idx leaves (just past the stop line). */
  private exitDecision(dir: 0 | 1, fromStop: number): number {
    const shares = this.demand.outShare[dir];
    for (let k = fromStop; k < this.stops[dir].length; k++) {
      const idx = this.stops[dir][k]!.idx;
      const p = shares[idx] ?? 0;
      if (p <= 0) continue;
      const [u, n] = nextFloat(this.exitDraw[dir]); this.exitDraw[dir] = n;
      if (u < p) return idx;
    }
    return -1;
  }

  private gapAt(dir: 0 | 1, lane: number, s: number): { ahead: number; behind: number; leader: Car | undefined } {
    const cars = this.lanes[dir][lane]!;
    let leader: Car | undefined, follower: Car | undefined;
    for (const c of cars) { if (c.s >= s) leader = c; else { follower = c; break; } }
    return { ahead: leader ? leader.s - IDM.len - s : Infinity, behind: follower ? s - IDM.len - follower.s : Infinity, leader };
  }

  private insert(dir: 0 | 1, s: number, v: number, fromEnd: boolean, firstStop: number): Car | null {
    let best = -1, bestGap = -Infinity;
    for (let l = 0; l < this.lanes[dir].length; l++) {
      const g = this.gapAt(dir, l, s);
      const ok = g.ahead > IDM.s0 + 4 && g.behind > IDM.s0 + 6;
      if (ok && g.ahead > bestGap) { best = l; bestGap = g.ahead; }
    }
    if (best < 0) return null;
    const g = this.gapAt(dir, best, s);
    const car: Car = { id: this.nextId++, dir, lane: best, s, v: Math.min(v, g.leader ? g.leader.v + 2 : v), acc: 0,
      exitAt: this.exitDecision(dir, firstStop), next: firstStop, goNext: false, stopNext: false, enteredAt: this.t, fromEnd, stops: 0, moving: true };
    const cars = this.lanes[dir][best]!;
    let i = 0;
    while (i < cars.length && cars[i]!.s >= s) i++;
    cars.splice(i, 0, car);
    return car;
  }

  private updateSignals(): void {
    const plan = this.plan, dt = this.dt;
    for (let i = 0; i < this.corridor.signals.length; i++) {
      let a: { main: Aspect; cross: Aspect };
      if (plan.kind === "fixed") a = fixedAspects(plan, i, this.t);
      else {
        const demand = this.mainDemandAt(i);
        adaptiveStep(plan, this.adaptive[i]!, dt, demand, this.crossQueue[i]! + this.inWaitingAt(i));
        a = adaptiveAspects(this.adaptive[i]!);
      }
      this.main[i] = a.main; this.cross[i] = a.cross;
    }
  }

  private inWaitingAt(i: number): number { return this.inWaiting[0]![i]! + this.inWaiting[1]![i]!; }

  /** For the adaptive controller: is a Lombard car about to arrive at signal i, and how many soon? */
  private mainDemandAt(i: number): { gap: boolean; platoon: number } {
    let gap = false, platoon = 0;
    const plan = this.plan;
    if (plan.kind !== "adaptive") return { gap, platoon };
    for (const dir of [0, 1] as const) {
      const k = this.stops[dir].findIndex((st) => st.idx === i);
      if (k < 0) continue;
      const at = this.stops[dir][k]!.at;
      for (const lane of this.lanes[dir]) for (const c of lane) {
        if (c.next !== k) continue;
        const d = at - c.s;
        if (d < 0) continue;
        const eta = d / Math.max(c.v, 3);
        if (eta <= plan.gapS) gap = true;
        if (eta <= plan.lookAheadS) platoon++;
      }
    }
    return { gap, platoon };
  }

  private aspectFor(dir: 0 | 1, k: number): Aspect {
    const st = this.stopLine(dir, k);
    return st ? this.main[st.idx]! : "green";
  }

  /** Advance one step. */
  step(): void {
    const dt = this.dt, measuring = this.t >= this.warmupS;
    this.updateSignals();
    // Cross streets: a queue that fills all the time and empties at saturation flow on green.
    for (let i = 0; i < this.crossQueue.length; i++) {
      const arrive = this.demand.crossRate[i]! / 3600 * dt;
      const green = this.cross[i] === "green";
      this.crossGreenFor[i] = green ? this.crossGreenFor[i]! + dt : 0;
      const lanes = Math.min(4, this.corridor.signals[i]!.crossLanes);
      const leave = green && this.crossGreenFor[i]! > 2 ? Math.min(this.crossQueue[i]! + arrive, CROSS_SAT_PER_S * lanes * dt) : 0;
      if (measuring) {
        this.delayCross += this.crossQueue[i]! * dt;
        this.crossFuelMl += this.crossQueue[i]! * ARRB.alphaMlPerS * dt;
        if (!green) this.crossFuelMl += arrive * this.stopPenalty;
      }
      this.crossQueue[i] = Math.max(0, this.crossQueue[i]! + arrive - leave);
    }
    // Cars arriving at each end join the waiting line, then get on when there is room.
    for (const dir of [0, 1] as const) {
      this.entryArrivals[dir].take(this.t, (at) => this.entryWaiting[dir].push(at));
      while (this.entryWaiting[dir].length) {
        const car = this.insert(dir, 0, IDM.v0 * 0.8, true, 0);
        if (!car) break;
        car.enteredAt = this.entryWaiting[dir].shift()!;
      }
      if (measuring) {
        const waiting = this.entryWaiting[dir].length;
        this.delayMain += waiting * dt;
        this.fuelMl += waiting * ARRB.alphaMlPerS * dt;
        this.maxEntry = Math.max(this.maxEntry, waiting);
      }
      // Cars turning onto Lombard from the cross street, released on the cross street's green.
      for (let k = 0; k < this.stops[dir].length; k++) {
        const idx = this.stops[dir][k]!.idx;
        this.inArrivals[dir]![idx]!.take(this.t, () => { this.inWaiting[dir]![idx]!++; });
        if (this.inWaiting[dir]![idx]! > 0 && this.cross[idx] === "green" && this.crossGreenFor[idx]! > 2) {
          if (this.insert(dir, this.stops[dir][k]!.at + STOP_BACK_M * 2, 4, false, k + 1) !== null) this.inWaiting[dir]![idx]!--;
        }
        if (measuring) { this.delayCross += this.inWaiting[dir]![idx]! * dt; this.crossFuelMl += this.inWaiting[dir]![idx]! * ARRB.alphaMlPerS * dt; }
      }
    }
    // Every car: acceleration from its leader or the next red light, then move.
    for (const dir of [0, 1] as const) {
      for (const lane of this.lanes[dir]) {
        for (let j = 0; j < lane.length; j++) {
          const c = lane[j]!, leader = j > 0 ? lane[j - 1] : undefined;
          let gap = leader ? leader.s - IDM.len - c.s : Infinity, dv = leader ? c.v - leader.v : 0;
          const st = this.stopLine(dir, c.next);
          let v0: number = IDM.v0;
          if (st) {
            const dist = st.at - c.s;
            if (c.exitAt === st.idx && dist < 40) v0 = IDM.turnV0;
            const aspect = this.aspectFor(dir, c.next);
            if (aspect === "green") { c.stopNext = false; }
            else if (!c.goNext && dist >= -0.5) {
              if (aspect === "yellow" && !c.stopNext && c.v * c.v / (2 * IDM.stopDecel) > dist) c.goNext = true;
              else c.stopNext = true;
            }
            if (c.stopNext && !c.goNext && dist >= -0.5 && Math.max(0, dist) < gap) { gap = Math.max(0, dist); dv = c.v; }
          }
          c.acc = idmAccel(c.v, gap, dv, v0);
        }
      }
      for (const lane of this.lanes[dir]) {
        for (const c of lane) {
          const vNew = c.v + c.acc * dt;
          if (vNew < 0) { c.s += c.v * c.v / (2 * -c.acc || 1); c.v = 0; }
          else { c.s += c.v * dt + 0.5 * c.acc * dt * dt; c.v = vNew; }
          if (c.moving && c.v < 0.5) { c.moving = false; c.stops++; }
          else if (!c.moving && c.v > 3) c.moving = true;
          if (measuring) {
            const ml = fuelRateMlPerS(c.v, c.acc) * dt;
            this.fuelMl += ml; this.minuteFuel += ml;
            this.delayMain += Math.max(0, 1 - c.v / IDM.v0) * dt;
            this.speedSum += c.v; this.speedSamples++;
            this.minuteSpeed += c.v; this.minuteSamples++;
          }
        }
      }
      // Pass stop lines, turn off, leave the far end.
      const L = this.corridor.length;
      for (const lane of this.lanes[dir]) {
        for (let j = lane.length - 1; j >= 0; j--) {
          const c = lane[j]!;
          const st = this.stopLine(dir, c.next);
          if (st && c.s > st.at + 1) {
            if (c.exitAt === st.idx) { this.retire(c, lane, j, false); continue; }
            c.next++; c.goNext = false; c.stopNext = false;
          }
          if (c.s >= L) this.retire(c, lane, j, true);
        }
      }
    }
    if (measuring) {
      // Entry and turn-in waiting fuel is already in fuelMl; record a minute's figures.
      const elapsed = this.t - this.warmupS;
      if (Math.floor((elapsed + dt) / 60) > Math.floor(elapsed / 60)) {
        this.perMinute.co2KgPerHour.push(co2GramsFromFuelMl(this.minuteFuel) / 1000 * 60);
        this.perMinute.meanSpeedKmh.push(this.minuteSamples ? this.minuteSpeed / this.minuteSamples * 3.6 : 0);
        this.minuteFuel = 0; this.minuteSpeed = 0; this.minuteSamples = 0;
      }
    }
    this.t += dt;
  }

  private retire(c: Car, lane: Car[], j: number, atEnd: boolean): void {
    lane.splice(j, 1);
    if (this.t < this.warmupS) return;
    this.stopsCounted += c.stops; this.carsCounted++;
    if (atEnd) this.exits[c.dir]++;
    if (atEnd && c.fromEnd && c.enteredAt >= this.warmupS) this.travel[c.dir].push(this.t - c.enteredAt);
  }

  get done(): boolean { return this.t >= this.endS; }

  /** Cars that have arrived at an end so far (on the corridor, gone, or still waiting to get on). */
  arrivals(dir: 0 | 1): number { return this.entryArrivals[dir].count; }

  run(): Metrics { while (!this.done) this.step(); return this.metrics(); }

  snapshot(): Snapshot {
    const cars: Car[] = [];
    for (const d of this.lanes) for (const l of d) for (const c of l) cars.push(c);
    return { t: this.t, cars, main: this.main, cross: this.cross, crossQueue: this.crossQueue,
      entryQueue: [this.entryWaiting[0].length, this.entryWaiting[1].length] };
  }

  metrics(): Metrics {
    const hours = Math.max(1e-6, (Math.min(this.t, this.endS) - this.warmupS) / 3600);
    const mean = (xs: number[]): number => xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : 0;
    const main = co2GramsFromFuelMl(this.fuelMl) / 1000 / hours, cross = co2GramsFromFuelMl(this.crossFuelMl) / 1000 / hours;
    return {
      plan: this.plan.label, demand: this.demand.label,
      travelTimeS: [mean(this.travel[0]), mean(this.travel[1])],
      through: [this.travel[0].length, this.travel[1].length],
      stopsPerCar: this.carsCounted ? this.stopsCounted / this.carsCounted : 0,
      delayHoursPerHour: { main: this.delayMain / 3600 / hours, cross: this.delayCross / 3600 / hours },
      co2KgPerHour: { main, cross, total: main + cross },
      fuelLitresPerHour: (this.fuelMl + this.crossFuelMl) / 1000 / hours,
      exitsPerHour: [this.exits[0] / hours, this.exits[1] / hours],
      maxEntryQueue: this.maxEntry,
      perMinute: this.perMinute,
      meanSpeedKmh: this.speedSamples ? this.speedSum / this.speedSamples * 3.6 : 0,
    };
  }
}

/** IDM acceleration for speed v, gap to the obstacle ahead, and closing speed dv. */
export function idmAccel(v: number, gap: number, dv: number, v0: number = IDM.v0): number {
  const r = v / v0, r2 = r * r;
  if (!Number.isFinite(gap)) return IDM.a * (1 - r2 * r2);
  const sStar = IDM.s0 + Math.max(0, v * IDM.T + v * dv / (2 * Math.sqrt(IDM.a * IDM.b)));
  const g = Math.max(0.1, gap);
  return Math.max(-9, IDM.a * (1 - r2 * r2 - (sStar / g) * (sStar / g)));
}

/** Run one plan under one demand and return its figures. */
export function runScenario(corridor: Corridor, demand: Demand, plan: ControlPlan, opts: RunOptions = {}): Metrics {
  return new CorridorSim(corridor, demand, plan, opts).run();
}
