// The mission validator and dry-run interpreter, and the missions they check.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blockedProseReason } from "../../src/content/blocklist.ts";
import { toLocal } from "../../src/geo/project.ts";
import { dryRun, enumeratePaths, validateMission, type Decision, type DialogueStep, type GotoStep, type Mission, type TriggerStep } from "../../src/content/missions.ts";
import { ROOT, readJson } from "../helpers.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const yc = readJson<Mission>("content/missions/ramen-pitch.json");
const step = <T>(m: Mission, id: string) => m.steps.find((s) => s.id === id) as T;

/** Chooser that always arrives and picks the answer with the given rank by delta (0 = best). */
const byRank = (rank: number, m: Mission = yc) => (d: Decision): string => {
  if (d.kind === "goto") return "arrive";
  const q = (m.steps.find((s) => s.id === d.stepId) as DialogueStep).questions.find((x) => x.id === d.questionId)!;
  const sorted = [...q.answers].sort((a, b) => b.delta - a.delta);
  return sorted[Math.min(rank, sorted.length - 1)]!.id;
};

describe("every mission file", () => {
  for (const f of readdirSync(join(ROOT, "content/missions")).filter((x) => x.endsWith(".json"))) {
    it(`content/missions/${f} passes validateMission`, () => {
      const r = validateMission(readJson(`content/missions/${f}`));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }
});

describe("ramen-pitch: the brief, as data", () => {
  it("starts with a phone call at the player's Marina apartment: the meeting moved up to 10:00", () => {
    const call = step<TriggerStep>(yc, yc.start ?? yc.steps[0]!.id);
    expect(call.type).toBe("trigger");
    expect(call.event.kind).toBe("phoneCall");
    expect(call.event.place.label).toMatch(/Marina/);
    const text = (call.lines ?? []).map((l) => l.text).join(" ");
    expect(text).toMatch(/moved up/);
    expect(text).toMatch(/\bten\b/i);
  });

  it("drives to the Ramen house at Pier 70, Dogpatch, against a timer, by lat/lon", () => {
    const drive = step<GotoStep>(yc, "drive");
    expect(drive.type).toBe("goto");
    expect(drive.target.label).toMatch(/Ramen house, Pier 70, Dogpatch/);
    // Pier 70 lies east of Illinois St between 18th and 22nd St.
    expect(drive.target.lat).toBeGreaterThan(37.758);
    expect(drive.target.lat).toBeLessThan(37.7635);
    expect(drive.target.lon).toBeGreaterThan(-122.3875);
    expect(drive.target.lon).toBeLessThan(-122.381);
    expect(drive.timer.limitS).toBeGreaterThan(0);
    expect(drive.timer.deadline).toBe("10:00");
    // Marina -> Dogpatch is ~6.5 km in a straight line; 540 s needs ~12 m/s door to door.
    const call = step<TriggerStep>(yc, "call");
    const a = toLocal(call.event.place.lat, call.event.place.lon);
    const b = toLocal(drive.target.lat, drive.target.lon);
    const km = Math.hypot(a.x - b.x, a.z - b.z) / 1000;
    expect(km).toBeGreaterThan(5);
    expect(km).toBeLessThan(7);
  });

  it("asks four questions across the three Ramen partners: moat, company or feature, why now, traction", () => {
    const dialogues = yc.steps.filter((x): x is DialogueStep => x.type === "dialogue");
    expect(dialogues.map((d) => d.speaker)).toEqual(["philosopher", "vibes", "metrics"]);
    const qs = dialogues.flatMap((d) => d.questions);
    expect(qs.length).toBe(4);
    const prompts = qs.map((q) => q.prompt).join(" ");
    expect(prompts).toMatch(/moat/i);
    expect(prompts).toMatch(/why now/i);
    expect(prompts).toMatch(/company, or is it a feature/i);
    expect(prompts).toMatch(/traction/i);
    for (const d of dialogues) expect(d.meter).toBe("conviction");
    for (const q of qs) for (const a of q.answers) expect(a.delta, `${q.id}/${a.id}`).not.toBe(0);
  });

  it("the partners are Ramen archetypes, never a real partner or the real accelerator", () => {
    for (const id of ["philosopher", "metrics", "vibes"]) {
      const p = yc.cast[id]!;
      expect(p.role).toBe("Partner at Ramen");
      expect(p.description).toMatch(/archetype, not a person/);
      expect(blockedProseReason(p.name)).toBeNull();
    }
    expect(blockedProseReason(JSON.stringify(yc))).toBeNull();
    expect(JSON.stringify(yc)).not.toMatch(/\bYC\b|Combinator|Batchery|Paxton/i);
  });

  it("funded grants the startup's billboard on the Embarcadero and +1 VC attention", () => {
    const r = dryRun(yc, byRank(0));
    expect(r.status).toBe("ended");
    expect(r.outcome).toBe("funded");
    expect(r.outcomeKind).toBe("success");
    expect(r.grants).toContainEqual({ kind: "stat", stat: "vcAttention", delta: 1 });
    const board = r.grants.find((g) => g.kind === "billboard");
    expect(board).toMatchObject({ kind: "billboard", corridor: "embarcadero", copy: { product: "playerStartup" } });
  });

  it("weak answers get 'come back with traction', which retries from the phone call", () => {
    const r = dryRun(yc, byRank(2));
    expect(r.outcome).toBe("traction");
    expect(r.outcomeKind).toBe("retry");
    expect(r.retryFrom).toBe("call");
    expect(r.grants).toEqual([]);
  });

  it("running out the clock is a missed meeting (also a retry)", () => {
    const r = dryRun(yc, (d) => (d.kind === "goto" ? "timeout" : d.options[0]!));
    expect(r.outcome).toBe("missed");
    expect(r.trace).toEqual(["call", "drive", "missed"]);
  });
});

describe("ramen-pitch: every answer path", () => {
  const { paths, truncated } = enumeratePaths(yc);

  it("enumerates all 3^4 answer combinations plus the timeout", () => {
    expect(truncated).toBe(false);
    expect(paths.length).toBe(3 ** 4 + 1);
    expect(new Set(paths.map((p) => p.choices.join(","))).size).toBe(paths.length);
  });

  it("every path terminates in a declared outcome, and both funded and traction are reached", () => {
    for (const p of paths) {
      expect(p.status, p.choices.join(",")).toBe("ended");
      expect(Object.keys(yc.outcomes)).toContain(p.outcome);
    }
    const outcomes = new Set(paths.map((p) => p.outcome));
    expect(outcomes).toEqual(new Set(["funded", "traction", "missed"]));
  });

  it("conviction stays within its bounds on every path", () => {
    const m = yc.meters.conviction!;
    for (const p of paths) {
      expect(p.meters.conviction!).toBeGreaterThanOrEqual(m.min);
      expect(p.meters.conviction!).toBeLessThanOrEqual(m.max);
    }
  });

  it("is balanced: funding takes good answers but not perfect ones (20-40% of answer paths)", () => {
    const answered = paths.filter((p) => p.outcome !== "missed");
    const funded = answered.filter((p) => p.outcome === "funded").length / answered.length;
    expect(funded).toBeGreaterThan(0.2);
    expect(funded).toBeLessThan(0.4);
  });

  it("is deterministic", () => {
    expect(enumeratePaths(yc).paths).toEqual(paths);
  });
});

describe("validateMission catches broken missions", () => {
  const broken = (mutate: (m: Mission) => void): string[] => {
    const m = clone(yc);
    mutate(m);
    const r = validateMission(m);
    expect(r.ok).toBe(false);
    return r.errors;
  };
  const has = (errs: string[], re: RegExp) => expect(errs.join("\n")).toMatch(re);

  it("a dangling next / onTimeout / branch target / retryFrom", () => {
    has(broken((m) => (step<GotoStep>(m, "drive").next = "lobbyy")), /next -> "lobbyy" does not exist/);
    has(broken((m) => (step<GotoStep>(m, "drive").onTimeout = "nowhere")), /onTimeout -> "nowhere"/);
    has(broken((m) => (step<{ cases: Array<{ next: string }> }>(m, "decide").cases[0]!.next = "rich")), /case next -> "rich"/);
    has(broken((m) => (step<{ retryFrom: string }>(m, "traction").retryFrom = "yesterday")), /retryFrom -> "yesterday"/);
  });

  it("non-positive or inverted timers", () => {
    has(broken((m) => (step<GotoStep>(m, "drive").timer.limitS = 0)), /limitS must be a positive/);
    has(broken((m) => (step<{ durationS: number }>(m, "lobby").durationS = -5)), /durationS must be a positive/);
    has(broken((m) => (step<GotoStep>(m, "drive").timer.warnAtS = 600)), /warnAtS must be below limitS/);
  });

  it("a timer nobody could beat", () => {
    has(
      broken((m) => {
        step<GotoStep>(m, "drive").timer = { limitS: 60 };
      }),
      /needs \d+ m\/s; the limit is 20/,
    );
  });

  it("an unbounded or inconsistent meter", () => {
    has(broken((m) => (m.meters.conviction!.start = 140)), /start 140 outside/);
    has(broken((m) => (m.meters.conviction!.max = Infinity)), /finite numbers/);
    has(broken((m) => (m.meters.conviction!.min = 100)), /min 100 must be below max 100/);
    has(broken((m) => (step<{ cases: Array<{ min: number }> }>(m, "decide").cases[0]!.min = 170)), /outside meter range/);
    has(broken((m) => (step<DialogueStep>(m, "pitch-philosopher").questions[0]!.answers[0]!.delta = 400)), /exceeds the meter's range/);
    has(broken((m) => (step<DialogueStep>(m, "pitch-philosopher").meter = "mood")), /meter "mood" is not declared/);
  });

  it("a path that never terminates", () => {
    has(broken((m) => (step<GotoStep>(m, "drive").onTimeout = "drive")), /does not terminate: loop/);
    has(
      broken((m) => {
        step<{ next: string }>(m, "lobby").next = "drive"; // arrive -> lobby -> drive -> ... forever
      }),
      /does not terminate|unreachable/,
    );
  });

  it("an outcome nobody can reach, or no success at all", () => {
    has(broken((m) => (step<{ cases: Array<{ min: number }> }>(m, "decide").cases[0]!.min = 100.5)), /outside meter range/);
    has(broken((m) => (step<{ cases: Array<{ min: number }> }>(m, "decide").cases[0]!.min = 0)), /outcome traction is never reached/);
    has(
      broken((m) => {
        step<{ cases: Array<{ min: number }> }>(m, "decide").cases[0]!.min = 0;
        step<GotoStep>(m, "drive").onTimeout = "lobby";
      }),
      /no path fails or asks for a retry|never reached/,
    );
  });

  it("unreachable steps, unknown speakers, undeclared outcomes, places outside SF", () => {
    has(broken((m) => m.steps.push({ id: "epilogue", type: "end", outcome: "funded" })), /step epilogue is unreachable/);
    has(broken((m) => (step<TriggerStep>(m, "call").lines![0]!.speaker = "realPerson")), /speaker "realPerson" is not in cast/);
    has(broken((m) => (step<{ outcome: string }>(m, "funded").outcome = "ipo")), /outcome "ipo" is not declared/);
    has(broken((m) => (step<GotoStep>(m, "drive").target.lat = 40.7)), /outside San Francisco/);
  });

  it("garbage input returns errors instead of throwing", () => {
    for (const junk of [null, 42, "mission", [], {}, { steps: [] }, { steps: [null, 7] }, { id: "x", steps: [{ id: "a", type: "goto" }] }]) {
      const r = validateMission(junk);
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("dryRun", () => {
  it("rejects a chooser that returns an option that does not exist", () => {
    const r = dryRun(yc, () => "whatever");
    expect(r.status).toBe("badChoice");
  });

  it("reports a dangling step instead of throwing", () => {
    const m = clone(yc);
    step<TriggerStep>(m, "call").next = "ghost";
    const r = dryRun(m, byRank(0, m));
    expect(r.status).toBe("dangling");
    expect(r.error).toMatch(/ghost/);
  });

  it("clamps the meter at its bounds", () => {
    const m = clone(yc);
    for (const d of m.steps) if (d.type === "dialogue") for (const q of d.questions) for (const a of q.answers) a.delta = a.delta > 0 ? 90 : -90;
    expect(dryRun(m, byRank(0, m)).meters.conviction).toBe(100);
    expect(dryRun(m, byRank(2, m)).meters.conviction).toBe(0);
  });
});
