// Mission JSON (content/missions/*.json): types, a pure validator and a dry-run interpreter.
//
// No sim dependency: this module never touches SimState. The dry run walks the step graph
// with an explicit chooser for every decision the player makes (arrive or time out at a goto,
// which answer to give each question), so tests can enumerate EVERY answer path and prove it
// terminates, and that every declared outcome is reachable.

import { toLocal } from "../geo/project.ts";
import { BOT_TELLS, type BotTellsFile } from "./botTells.ts";

export interface Line {
  speaker: string;
  text: string;
}

export interface Place {
  label: string;
  lat: number;
  lon: number;
  radiusM?: number;
  headingDeg?: number;
  source?: string;
}

export type TriggerEvent =
  | { kind: "phoneCall"; caller: string; place: Place; clock?: string }
  | { kind: "enterArea"; place: Place; clock?: string };

export interface TriggerStep { id: string; type: "trigger"; note?: string; event: TriggerEvent; lines?: Line[]; next: string }
export interface GotoStep {
  id: string; type: "goto"; note?: string; target: Place & { radiusM: number };
  timer: { limitS: number; warnAtS?: number; label?: string; deadline?: string };
  travel?: "any" | "vehicle" | "foot"; lines?: Line[]; next: string; onTimeout: string;
}
export interface TimerStep { id: string; type: "timer"; note?: string; durationS: number; lines?: Line[]; next: string }
export interface Answer { id: string; text: string; delta: number; reply: string }
export interface Question { id: string; prompt: string; answers: Answer[] }
export interface DialogueStep {
  id: string; type: "dialogue"; note?: string; speaker: string; meter: string; intro?: Line[]; questions: Question[]; next: string;
}
export interface BranchCase { min?: number; max?: number; next: string }
export interface BranchStep { id: string; type: "branch"; note?: string; meter: string; cases: BranchCase[]; default: string }
export type Grant =
  | { kind: "billboard"; corridor: string; place: Place & { headingDeg: number }; copy: { generator: "billboard" | "busWrap"; product: "playerStartup" } }
  | { kind: "stat"; stat: string; delta: number }
  | { kind: "unlock"; unlock: string };
export interface RewardStep { id: string; type: "reward"; note?: string; outcome: string; lines?: Line[]; grants: Grant[]; next?: string }
export interface RetryStep {
  id: string; type: "retry"; note?: string; outcome: string; lines?: Line[]; hint?: string; cooldownS?: number; retryFrom: string;
}
export interface EndStep { id: string; type: "end"; note?: string; outcome: string; lines?: Line[] }
/** Wave 2: place mission actors. */
export interface StageStep {
  id: string; type: "stage"; note?: string; actors: string[]; place: Place & { radiusM: number }; nearHydrantM?: number; lines?: Line[]; next: string;
}
export type ObjectiveKind = "melt" | "watch" | "scan" | "cone" | "interruptUpdate" | "threatAtLeast" | "threatAtMost" | "refill" | "enterVehicle";
/** Wave 2: a goal the sim checks, optionally against a time limit. */
export interface ObjectiveStep {
  id: string; type: "objective"; note?: string;
  objective: { kind: ObjectiveKind; actor?: string; count?: number; level?: number; seconds?: number };
  timeLimitS?: number; hint?: string; lines?: Line[]; next: string; onFail?: string;
}
/** Wave 2: a FreeTextBox form (the coworking sign-up). */
export interface FormStep {
  id: string; type: "form"; note?: string;
  form: { kind: "startupSignup"; prompt: string; maxLength: number; records: "StartupDefined"; multipleChoice?: string[] };
  lines?: Line[]; next: string;
}

export type Step = TriggerStep | GotoStep | TimerStep | DialogueStep | BranchStep | RewardStep | RetryStep | EndStep | StageStep | ObjectiveStep | FormStep;
export type StepType = Step["type"];
export const STEP_TYPES: readonly StepType[] = ["trigger", "goto", "timer", "dialogue", "branch", "reward", "retry", "end", "stage", "objective", "form"];
export const OBJECTIVE_KINDS: readonly ObjectiveKind[] = ["melt", "watch", "scan", "cone", "interruptUpdate", "threatAtLeast", "threatAtMost", "refill", "enterVehicle"];

export interface MissionActor {
  kind: "badRobot" | "goodRobot" | "rogueTaxi" | "goodTaxi" | "crew";
  archetype?: string;
  level?: number;
  members?: string[];
  posted?: boolean;
  note?: string;
}

export interface Meter { label: string; start: number; min: number; max: number }
export type OutcomeKind = "success" | "retry" | "fail";

export interface Mission {
  id: string;
  version: 1;
  title: string;
  summary?: string;
  area?: string;
  start?: string;
  wave?: number;
  campaign?: number;
  cast: Record<string, { name: string; role: string; description?: string }>;
  actors?: Record<string, MissionActor>;
  meters: Record<string, Meter>;
  outcomes: Record<string, { label: string; kind: OutcomeKind }>;
  steps: Step[];
}

/** Every mission takes place in San Francisco (generous box around the city). */
export const SF_BOUNDS = { minLat: 37.7, maxLat: 37.84, minLon: -122.53, maxLon: -122.35 } as const;
/** Fastest sustained average a goto timer may assume, door to door, m/s (~72 km/h). */
export const MAX_AVG_SPEED_MPS = 20;

// ---------------------------------------------------------------------------------------------
// Dry-run interpreter

export type Decision =
  | { kind: "goto"; stepId: string; options: readonly ["arrive", "timeout"] }
  | { kind: "answer"; stepId: string; questionId: string; options: readonly string[] }
  | { kind: "objective"; stepId: string; options: readonly ["done", "timeout"] }
  | { kind: "form"; stepId: string; options: readonly ["matched", "fallback"] };

/** Returns one of decision.options. */
export type Chooser = (d: Decision) => string;

export interface RunResult {
  status: "ended" | "loop" | "dangling" | "badChoice" | "maxSteps";
  outcome?: string;
  outcomeKind?: OutcomeKind;
  retryFrom?: string;
  /** Every choice made, "<step or question>:<option>", in order. */
  choices: string[];
  /** Step ids in visit order. */
  trace: string[];
  meters: Record<string, number>;
  grants: Grant[];
  error?: string;
}

export interface DryRunOptions {
  /** Step to start from (default mission.start, else the first step). */
  from?: string;
  maxSteps?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Run the mission once, asking `choose` at every decision. Never throws on bad data. */
export function dryRun(m: Mission, choose: Chooser, opts: DryRunOptions = {}): RunResult {
  const byId = new Map(m.steps.map((s) => [s.id, s] as const));
  const meters: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.meters ?? {})) meters[k] = v.start;
  const res: RunResult = { status: "ended", choices: [], trace: [], meters, grants: [] };
  const seen = new Set<string>();
  const maxSteps = opts.maxSteps ?? 10_000;
  let cur: string | undefined = opts.from ?? m.start ?? m.steps[0]?.id;

  const pick = (d: Decision, label: string): string | null => {
    const c = choose(d);
    if (!(d.options as readonly string[]).includes(c)) {
      res.status = "badChoice";
      res.error = `chooser returned "${c}" at ${label}; options: ${d.options.join(", ")}`;
      return null;
    }
    res.choices.push(`${label}:${c}`);
    return c;
  };
  const end = (s: RewardStep | RetryStep | EndStep): RunResult => {
    res.status = "ended";
    res.outcome = s.outcome;
    res.outcomeKind = m.outcomes?.[s.outcome]?.kind;
    if (s.type === "retry") res.retryFrom = s.retryFrom;
    return res;
  };

  for (let n = 0; ; n++) {
    if (n >= maxSteps) {
      res.status = "maxSteps";
      res.error = `no outcome after ${maxSteps} steps`;
      return res;
    }
    const step = cur === undefined ? undefined : byId.get(cur);
    if (!step) {
      res.status = "dangling";
      res.error = `step "${cur}" does not exist (after ${res.trace.join(" -> ") || "start"})`;
      return res;
    }
    // Same step with the same meters = the same future: a cycle the player cannot leave.
    const key = `${step.id}|${JSON.stringify(meters)}`;
    if (seen.has(key)) {
      res.status = "loop";
      res.error = `revisits "${step.id}" with identical state: ${[...res.trace, step.id].join(" -> ")}`;
      return res;
    }
    seen.add(key);
    res.trace.push(step.id);

    switch (step.type) {
      case "trigger":
      case "timer":
      case "stage":
        cur = step.next;
        break;
      case "objective": {
        if (step.timeLimitS === undefined) {
          res.choices.push(`${step.id}:done`);
          cur = step.next;
          break;
        }
        const c = pick({ kind: "objective", stepId: step.id, options: ["done", "timeout"] }, step.id);
        if (c === null) return res;
        cur = c === "done" ? step.next : step.onFail;
        break;
      }
      case "form": {
        // The keyword matcher or the fallback both record a kit; the mission goes on either way.
        const c = pick({ kind: "form", stepId: step.id, options: ["matched", "fallback"] }, step.id);
        if (c === null) return res;
        cur = step.next;
        break;
      }
      case "goto": {
        const c = pick({ kind: "goto", stepId: step.id, options: ["arrive", "timeout"] }, step.id);
        if (c === null) return res;
        cur = c === "arrive" ? step.next : step.onTimeout;
        break;
      }
      case "dialogue": {
        const meter = m.meters?.[step.meter];
        for (const q of step.questions) {
          const c = pick({ kind: "answer", stepId: step.id, questionId: q.id, options: q.answers.map((a) => a.id) }, q.id);
          if (c === null) return res;
          const a = q.answers.find((x) => x.id === c) as Answer;
          if (meter) meters[step.meter] = clamp((meters[step.meter] ?? meter.start) + a.delta, meter.min, meter.max);
        }
        cur = step.next;
        break;
      }
      case "branch": {
        const v = meters[step.meter] ?? NaN;
        const hit = step.cases.find((c) => (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max));
        cur = hit ? hit.next : step.default;
        break;
      }
      case "reward":
        res.grants.push(...step.grants);
        if (step.next === undefined) return end(step);
        cur = step.next;
        break;
      case "retry":
      case "end":
        return end(step);
      default:
        res.status = "dangling";
        res.error = `step "${(step as { id: string }).id}" has unknown type "${(step as { type: string }).type}"`;
        return res;
    }
  }
}

/**
 * Every distinct path through the mission: one run per combination of choices. Re-runs the
 * mission with a growing script of choices (depth-first), so it needs no copy of interpreter
 * state. Stops after maxPaths runs.
 */
export function enumeratePaths(m: Mission, opts: DryRunOptions & { maxPaths?: number } = {}): { paths: RunResult[]; truncated: boolean } {
  const maxPaths = opts.maxPaths ?? 100_000;
  const paths: RunResult[] = [];
  const stack: string[][] = [[]];
  while (stack.length > 0) {
    if (paths.length >= maxPaths) return { paths, truncated: true };
    const script = stack.pop() as string[];
    const taken: string[] = [];
    const res = dryRun(
      m,
      (d) => {
        const i = taken.length;
        let c: string;
        if (i < script.length) c = script[i] as string;
        else {
          for (let k = d.options.length - 1; k >= 1; k--) stack.push([...taken, d.options[k] as string]);
          c = d.options[0] as string;
        }
        taken.push(c);
        return c;
      },
      opts,
    );
    paths.push(res);
  }
  return { paths, truncated: false };
}

// ---------------------------------------------------------------------------------------------
// Validator

export interface MissionReport {
  ok: boolean;
  errors: string[];
  /** Present when the structure was sound enough to dry-run. */
  paths?: RunResult[];
  /** Runs per outcome id. */
  outcomeCounts?: Record<string, number>;
  /** Observed [min, max] of each meter over all paths, after clamping. */
  meterRanges?: Record<string, [number, number]>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function distanceM(a: Place, b: Place): number {
  const pa = toLocal(a.lat, a.lon);
  const pb = toLocal(b.lat, b.lon);
  return Math.hypot(pa.x - pb.x, pa.z - pb.z);
}

/**
 * Check a parsed mission file. Structural rules first (so a broken file never crashes the
 * checker), then a dry run of every path: each must reach an outcome, every declared outcome
 * must be reachable, at least one path must succeed and at least one must not, and every step
 * must lie on some path.
 */
export function validateMission(input: unknown): MissionReport {
  const errors: string[] = [];
  const err = (msg: string): void => {
    errors.push(msg);
  };
  if (!isObj(input)) return { ok: false, errors: ["mission is not an object"] };
  const m = input as unknown as Mission;
  if (!isStr(m.id) || !/^[a-z0-9-]+$/.test(m.id)) err(`id "${String(m.id)}" must match ^[a-z0-9-]+$`);
  if (!isStr(m.title)) err("title is missing");
  if (!Array.isArray(m.steps) || m.steps.length === 0) return { ok: false, errors: [...errors, "steps must be a non-empty array"] };
  const cast = isObj(m.cast) ? m.cast : {};
  const meters = isObj(m.meters) ? (m.meters as Record<string, Meter>) : {};
  const outcomes = isObj(m.outcomes) ? m.outcomes : {};
  const actors = isObj(m.actors) ? (m.actors as Record<string, unknown>) : {};
  if (!isObj(m.cast)) err("cast must be an object");
  if (!isObj(m.meters)) err("meters must be an object");
  if (!isObj(m.outcomes)) err("outcomes must be an object");

  // Meters: finite, ordered, start inside.
  for (const [id, mt] of Object.entries(meters)) {
    if (!isObj(mt) || !isNum(mt.min) || !isNum(mt.max) || !isNum(mt.start)) {
      err(`meter ${id}: start, min and max must be finite numbers`);
      continue;
    }
    if (!(mt.min < mt.max)) err(`meter ${id}: min ${mt.min} must be below max ${mt.max}`);
    if (mt.start < mt.min || mt.start > mt.max) err(`meter ${id}: start ${mt.start} outside [${mt.min}, ${mt.max}]`);
  }
  const outcomeKinds = Object.values(outcomes).map((o) => (isObj(o) ? o.kind : undefined));
  for (const [id, o] of Object.entries(outcomes)) {
    if (!isObj(o) || !["success", "retry", "fail"].includes(o.kind as string)) err(`outcome ${id}: kind must be success, retry or fail`);
  }
  if (!outcomeKinds.includes("success")) err("no success outcome declared");
  if (!outcomeKinds.some((k) => k === "retry" || k === "fail")) err("no retry or fail outcome declared");

  // Steps: ids, types, references.
  const ids = new Set<string>();
  for (const s of m.steps) {
    if (!isObj(s) || !isStr(s.id)) {
      err("a step has no id");
      continue;
    }
    if (ids.has(s.id)) err(`step ${s.id}: duplicate id`);
    ids.add(s.id);
  }
  const ref = (from: string, field: string, target: unknown): void => {
    if (!isStr(target)) err(`step ${from}: ${field} is missing`);
    else if (!ids.has(target)) err(`step ${from}: ${field} -> "${target}" does not exist`);
  };
  const speaker = (from: string, who: unknown): void => {
    if (!isStr(who) || !(who in cast)) err(`step ${from}: speaker "${String(who)}" is not in cast`);
  };
  const lines = (from: string, ls: unknown): void => {
    if (ls === undefined) return;
    if (!Array.isArray(ls)) return err(`step ${from}: lines must be an array`);
    for (const l of ls) {
      if (!isObj(l) || !isStr(l.text)) err(`step ${from}: a line has no text`);
      else speaker(from, l.speaker);
    }
  };
  const place = (from: string, p: unknown, needRadius: boolean): void => {
    if (!isObj(p) || !isNum(p.lat) || !isNum(p.lon)) return err(`step ${from}: place needs numeric lat and lon`);
    if (p.lat < SF_BOUNDS.minLat || p.lat > SF_BOUNDS.maxLat || p.lon < SF_BOUNDS.minLon || p.lon > SF_BOUNDS.maxLon) {
      err(`step ${from}: place ${String(p.label)} (${p.lat}, ${p.lon}) is outside San Francisco`);
    }
    if (needRadius && !(isNum(p.radiusM) && p.radiusM > 0)) err(`step ${from}: target radiusM must be positive`);
  };
  const meterOf = (from: string, id: unknown): Meter | undefined => {
    if (!isStr(id) || !(id in meters)) {
      err(`step ${from}: meter "${String(id)}" is not declared`);
      return undefined;
    }
    return meters[id];
  };
  const outcomeOf = (from: string, id: unknown): void => {
    if (!isStr(id) || !(id in outcomes)) err(`step ${from}: outcome "${String(id)}" is not declared`);
  };
  const positive = (from: string, field: string, v: unknown, optional = false): void => {
    if (optional && v === undefined) return;
    if (!isNum(v) || v <= 0) err(`step ${from}: ${field} must be a positive number of seconds, got ${String(v)}`);
  };

  for (const s of m.steps as unknown as Array<Record<string, unknown>>) {
    if (!isObj(s) || !isStr(s.id)) continue;
    const id = s.id;
    if (!STEP_TYPES.includes(s.type as StepType)) {
      err(`step ${id}: unknown type "${String(s.type)}"`);
      continue;
    }
    lines(id, s.lines);
    switch (s.type as StepType) {
      case "trigger": {
        const ev = s.event;
        if (!isObj(ev) || (ev.kind !== "phoneCall" && ev.kind !== "enterArea")) err(`step ${id}: event must be phoneCall or enterArea`);
        else {
          place(id, ev.place, false);
          if (ev.kind === "phoneCall") speaker(id, ev.caller);
        }
        ref(id, "next", s.next);
        break;
      }
      case "goto": {
        place(id, s.target, true);
        const t = s.timer;
        if (!isObj(t)) err(`step ${id}: timer is missing`);
        else {
          positive(id, "timer.limitS", t.limitS);
          positive(id, "timer.warnAtS", t.warnAtS, true);
          if (isNum(t.warnAtS) && isNum(t.limitS) && t.warnAtS >= t.limitS) err(`step ${id}: timer.warnAtS must be below limitS`);
        }
        ref(id, "next", s.next);
        ref(id, "onTimeout", s.onTimeout);
        break;
      }
      case "timer":
        positive(id, "durationS", s.durationS);
        ref(id, "next", s.next);
        break;
      case "dialogue": {
        speaker(id, s.speaker);
        lines(id, s.intro);
        const mt = meterOf(id, s.meter);
        if (!Array.isArray(s.questions) || s.questions.length === 0) err(`step ${id}: needs at least one question`);
        else {
          const qids = new Set<string>();
          for (const q of s.questions as unknown[]) {
            if (!isObj(q) || !isStr(q.id) || !isStr(q.prompt)) {
              err(`step ${id}: a question needs id and prompt`);
              continue;
            }
            if (qids.has(q.id)) err(`step ${id}: duplicate question ${q.id}`);
            qids.add(q.id);
            if (!Array.isArray(q.answers) || q.answers.length < 2) {
              err(`step ${id}: question ${q.id} needs at least two answers`);
              continue;
            }
            const aids = new Set<string>();
            for (const a of q.answers as unknown[]) {
              if (!isObj(a) || !isStr(a.id) || !isStr(a.text) || !isStr(a.reply)) {
                err(`step ${id}: question ${q.id} has an answer without id, text or reply`);
                continue;
              }
              if (aids.has(a.id)) err(`step ${id}: question ${q.id} repeats answer ${a.id}`);
              aids.add(a.id);
              if (!isNum(a.delta) || !Number.isInteger(a.delta)) err(`step ${id}: answer ${q.id}/${a.id} delta must be an integer`);
              else if (mt && Math.abs(a.delta) > mt.max - mt.min) err(`step ${id}: answer ${q.id}/${a.id} delta ${a.delta} exceeds the meter's range`);
            }
          }
        }
        ref(id, "next", s.next);
        break;
      }
      case "branch": {
        const mt = meterOf(id, s.meter);
        if (!Array.isArray(s.cases) || s.cases.length === 0) err(`step ${id}: needs at least one case`);
        else {
          for (const c of s.cases as unknown[]) {
            if (!isObj(c)) {
              err(`step ${id}: bad case`);
              continue;
            }
            if (c.min === undefined && c.max === undefined) err(`step ${id}: a case needs min or max`);
            for (const k of ["min", "max"] as const) {
              const v = c[k];
              if (v === undefined) continue;
              if (!isNum(v)) err(`step ${id}: case ${k} must be a number`);
              else if (mt && (v < mt.min || v > mt.max)) err(`step ${id}: case ${k} ${v} outside meter range [${mt.min}, ${mt.max}]`);
            }
            if (isNum(c.min) && isNum(c.max) && c.min > c.max) err(`step ${id}: case min ${c.min} > max ${c.max}`);
            ref(id, "case next", c.next);
          }
        }
        ref(id, "default", s.default);
        break;
      }
      case "reward": {
        outcomeOf(id, s.outcome);
        if (!Array.isArray(s.grants) || s.grants.length === 0) err(`step ${id}: a reward needs grants`);
        else
          for (const g of s.grants as unknown[]) {
            if (!isObj(g)) err(`step ${id}: bad grant`);
            else if (g.kind === "billboard") {
              place(id, g.place, false);
              if (!isObj(g.place) || !isNum(g.place.headingDeg)) err(`step ${id}: billboard place needs headingDeg`);
            } else if (g.kind === "stat") {
              if (!isStr(g.stat) || !isNum(g.delta) || !Number.isInteger(g.delta)) err(`step ${id}: stat grant needs stat and integer delta`);
            } else if (g.kind === "unlock") {
              if (!isStr(g.unlock) || !/^(safehouse|vendor|activity|app):[a-z0-9-]+$/.test(g.unlock)) err(`step ${id}: unlock must be kind:id`);
            } else err(`step ${id}: unknown grant kind "${String(g.kind)}"`);
          }
        if (s.next !== undefined) ref(id, "next", s.next);
        break;
      }
      case "retry":
        outcomeOf(id, s.outcome);
        ref(id, "retryFrom", s.retryFrom);
        positive(id, "cooldownS", s.cooldownS, true);
        break;
      case "end":
        outcomeOf(id, s.outcome);
        break;
      case "stage": {
        place(id, s.place, true);
        if (!Array.isArray(s.actors) || s.actors.length === 0) err(`step ${id}: stage needs actors`);
        else for (const a of s.actors as unknown[]) if (!isStr(a) || !(a in actors)) err(`step ${id}: actor "${String(a)}" is not declared`);
        positive(id, "nearHydrantM", s.nearHydrantM, true);
        ref(id, "next", s.next);
        break;
      }
      case "objective": {
        const o = s.objective;
        if (!isObj(o) || !OBJECTIVE_KINDS.includes(o.kind as ObjectiveKind)) err(`step ${id}: unknown objective`);
        else {
          const needsActor = ["melt", "watch", "scan", "cone"].includes(o.kind as string);
          if (needsActor && (!isStr(o.actor) || !(o.actor in actors))) err(`step ${id}: objective ${String(o.kind)} needs a declared actor`);
          if (isStr(o.actor) && !(o.actor in actors)) err(`step ${id}: actor "${o.actor}" is not declared`);
          if ((o.kind === "threatAtLeast" || o.kind === "threatAtMost") && !(isNum(o.level) && Number.isInteger(o.level) && o.level >= 0 && o.level <= 5)) err(`step ${id}: ${o.kind} needs a level 0-5`);
          if (o.kind === "watch") positive(id, "objective.seconds", o.seconds);
        }
        if ((s.timeLimitS === undefined) !== (s.onFail === undefined)) err(`step ${id}: timeLimitS and onFail come together`);
        positive(id, "timeLimitS", s.timeLimitS, true);
        ref(id, "next", s.next);
        if (s.onFail !== undefined) ref(id, "onFail", s.onFail);
        break;
      }
      case "form": {
        const f = s.form;
        if (!isObj(f) || f.kind !== "startupSignup" || !isStr(f.prompt) || f.records !== "StartupDefined") err(`step ${id}: form must be a startupSignup that records StartupDefined`);
        else if (!isNum(f.maxLength) || f.maxLength < 1 || f.maxLength > 280) err(`step ${id}: form maxLength must be 1-280`);
        ref(id, "next", s.next);
        break;
      }
    }
  }
  if (m.start !== undefined) {
    if (!isStr(m.start) || !ids.has(m.start)) err(`start "${String(m.start)}" does not exist`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // Dynamic: every path through the mission.
  const { paths, truncated } = enumeratePaths(m);
  if (truncated) err(`more than ${paths.length} paths: the mission is too branchy to verify`);
  const outcomeCounts: Record<string, number> = {};
  const meterRanges: Record<string, [number, number]> = {};
  const visited = new Set<string>();
  const feasibility = new Set<string>();
  const byId = new Map(m.steps.map((s) => [s.id, s] as const));
  for (const p of paths) {
    for (const s of p.trace) visited.add(s);
    if (p.status !== "ended") {
      err(`path [${p.choices.join(", ")}] does not terminate: ${p.status}: ${p.error ?? ""}`);
      continue;
    }
    outcomeCounts[p.outcome as string] = (outcomeCounts[p.outcome as string] ?? 0) + 1;
    for (const [k, v] of Object.entries(p.meters)) {
      const r = meterRanges[k];
      meterRanges[k] = r ? [Math.min(r[0], v), Math.max(r[1], v)] : [v, v];
    }
    // Goto timers must be beatable from wherever the path last put the player.
    let last: Place | undefined;
    for (const sid of p.trace) {
      const s = byId.get(sid);
      if (s?.type === "trigger") last = s.event.place;
      else if (s?.type === "stage") last = s.place;
      else if (s?.type === "goto") {
        if (last) {
          const key = `${last.lat},${last.lon}->${s.id}`;
          if (!feasibility.has(key)) {
            feasibility.add(key);
            const d = distanceM(last, s.target);
            const need = d / MAX_AVG_SPEED_MPS;
            if (s.timer.limitS < need) {
              err(`step ${s.id}: ${Math.round(d)} m in ${s.timer.limitS} s needs ${Math.round(d / s.timer.limitS)} m/s; the limit is ${MAX_AVG_SPEED_MPS} m/s`);
            }
          }
        }
        last = s.target;
      }
    }
  }
  for (const [k, [lo, hi]] of Object.entries(meterRanges)) {
    const mt = meters[k] as Meter;
    if (lo < mt.min || hi > mt.max) err(`meter ${k}: reached [${lo}, ${hi}] outside [${mt.min}, ${mt.max}]`);
  }
  for (const id of Object.keys(outcomes)) if (!outcomeCounts[id]) err(`outcome ${id} is never reached`);
  const reachedKinds = new Set(Object.keys(outcomeCounts).map((o) => outcomes[o]?.kind));
  if (!reachedKinds.has("success")) err("no path succeeds");
  if (!reachedKinds.has("retry") && !reachedKinds.has("fail")) err("no path fails or asks for a retry");
  for (const s of m.steps) if (!visited.has(s.id)) err(`step ${s.id} is unreachable`);
  return { ok: errors.length === 0, errors, paths, outcomeCounts, meterRanges };
}

/** Every place a mission names: trigger places, goto targets, stage places, billboard grants. */
export function missionPlaces(m: Mission): Array<{ step: string; place: Place }> {
  const out: Array<{ step: string; place: Place }> = [];
  for (const s of m.steps) {
    if (s.type === "trigger") out.push({ step: s.id, place: s.event.place });
    else if (s.type === "goto") out.push({ step: s.id, place: s.target });
    else if (s.type === "stage") out.push({ step: s.id, place: s.place });
    else if (s.type === "reward") for (const g of s.grants) if (g.kind === "billboard") out.push({ step: s.id, place: g.place });
  }
  return out;
}

/** Mission actors against the robots: archetypes exist and match their kind; crews are 2-4 bad robots. */
export function checkMissionActors(m: Mission, tells: BotTellsFile = BOT_TELLS): string[] {
  const errs: string[] = [];
  for (const [id, a] of Object.entries(m.actors ?? {})) {
    if (a.kind === "crew") {
      const members = a.members ?? [];
      if (members.length < 2 || members.length > 4) errs.push(`actor ${id}: a crew is 2-4 robots`);
      for (const x of members) if (tells.archetypes.find((t) => t.id === x)?.kind !== "bad") errs.push(`actor ${id}: crew member ${x} is not a bad archetype`);
      continue;
    }
    const arch = tells.archetypes.find((t) => t.id === a.archetype);
    if (!arch) {
      errs.push(`actor ${id}: unknown archetype ${String(a.archetype)}`);
      continue;
    }
    const wantBad = a.kind === "badRobot" || a.kind === "rogueTaxi";
    if ((arch.kind === "bad") !== wantBad) errs.push(`actor ${id}: ${a.kind} but ${arch.id} is ${arch.kind}`);
    if ((arch.model === "robotaxi") !== (a.kind === "rogueTaxi" || a.kind === "goodTaxi")) errs.push(`actor ${id}: kind ${a.kind} does not fit model ${arch.model}`);
  }
  for (const s of m.steps) {
    if (s.type === "objective" && (s.objective.kind === "melt" || s.objective.kind === "scan") && s.objective.actor) {
      const a = m.actors?.[s.objective.actor];
      if (a && a.kind !== "badRobot" && a.kind !== "rogueTaxi") errs.push(`step ${s.id}: ${s.objective.kind} targets ${s.objective.actor}, which is not a bad robot`);
    }
  }
  return errs;
}
