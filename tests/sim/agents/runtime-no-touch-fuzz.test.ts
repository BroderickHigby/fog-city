// The no-touch fuzz for runtime bodies (docs/design.md, "Vehicles never hurt people"): the
// composed game systems (createGameSystems) on a grid city, with what tests/sim/dodge-fuzz.test.ts
// leaves out. Service vans dispatched by heat's threat.spawn and timed Ferry buses (transit
// layer) drive through ambient people under car physics; on alternate seeds the agents runtime
// also places children, dogs on leads with their owners, seated people and people with mobility
// aids on the sidewalk, and a player's car chases them, straight, weaving or drifting. Every tick
// of every scene: no person, child, animal, seated person or player on foot inside any vehicle's
// body (player cars, robotaxis, vans, buses), and no contact counted by the dodge.
import { describe, expect, it } from "vitest";
import {
  AGENT_SPEC, CAR, FOOT, ROBOTAXI_BODY, agentDodgeClass, boxDistance, createGameSystems, createInitialState, dodgeExtOf,
  hashState, makeCar, makeFoot, step, type AgentState, type InputFrame, type SimState, type World,
} from "../../../src/sim/index.ts";
import type { SimSystem } from "../../../src/sim/system-contract.ts";
import { allocateActorIds } from "../../../src/sim/identity.ts";
import { fogDensity } from "../../../src/sim/fog/index.ts";
import { badRobotRateAt } from "../../../src/sim/agents/bad-rate.ts";
import { agentsRuntimeOf, type RuntimeSpawn } from "../../../src/sim/agents/runtime.ts";
import { createAgentsSystem } from "../../../src/sim/agents/systems.ts";
import type { TransitLayer } from "../../../src/sim/agents/transit-runtime.ts";
import { gridCity } from "../fixtures.ts";

const SEEDS = 24;
const TICKS = 720;

function lcg(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A bus line along the arterial (z = 200) with the Ferry stop id the transit runtime runs from. */
const TRANSIT: TransitLayer = {
  version: 1,
  routes: [{ id: "fuzz-bus", line: "F", mode: "bus", direction: "east", night: false, paths: [[[0, 200], [300, 200]]] }],
  stops: [
    { id: "s4513", x: 150, y: 0, z: 207, routes: ["fuzz-bus"] },
    { id: "fuzz-east", x: 250, y: 0, z: 207, routes: ["fuzz-bus"] },
    { id: "fuzz-west", x: 50, y: 0, z: 207, routes: ["fuzz-bus"] },
  ],
};

type Care = "child" | "dog" | "seated" | "mobility" | "adult";
interface Scene {
  name: string;
  world: World;
  state: SimState;
  systems: readonly SimSystem[];
  /** The car chases this physical body (a runtime id), or the foot player when none. */
  target: string | null;
  driver: "straight" | "chase" | "weave" | "drift";
  vanTick: number;
}

/** createGameSystems(), its agents provider given extra runtime bodies (as a mission or scene would). */
function composed(spawns: readonly RuntimeSpawn[]): readonly SimSystem[] {
  const game = createGameSystems({ wave: 2, protectedArea: () => false });
  if (!spawns.length) return game;
  const agents = createAgentsSystem((context) => ({
    wave: 2, graph: context.world.sidewalks, transit: context.world.transit, protectedArea: () => false,
    badRateAt: badRobotRateAt, fog: fogDensity(context.world, context.state, 0, 0), spawns: [...spawns],
  }), allocateActorIds);
  return game.map((system) => system.key === agents.key ? agents : system);
}

function clearOf(state: SimState, world: World, x: number, z: number, r: number, placed: readonly { x: number; z: number; radius: number }[]): boolean {
  if (x > 94.5 && x < 112 && z > 112 && z < 184.5) {
    for (const a of state.ext.agents?.list ?? []) {
      const ar = a.kind === "robotaxi" ? ROBOTAXI_BODY.halfLength : (a.radius ?? AGENT_SPEC[a.kind].radius);
      if ((a.x - x) * (a.x - x) + (a.z - z) * (a.z - z) < (ar + r + 1) * (ar + r + 1)) return false;
    }
    return placed.every((p) => (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) > (p.radius + r + 0.6) * (p.radius + r + 0.6));
  }
  void world;
  return false;
}

function makeScene(seed: number): Scene {
  const rnd = lcg(seed);
  const world = gridCity();
  world.transit = TRANSIT;
  let state = createInitialState(world, seed, ["car", "w"], { x: 100, z: 195, heading: 0 });
  // The foot player stands on the west sidewalk of x = 100 or in the road itself (where the van
  // heat sends drives to), its parked car out of the way.
  const wz = 120 + rnd() * 60, wx = rnd() < 0.5 ? 91 : 97 + rnd() * 6;
  state = { ...state, players: {
    car: { ...state.players.car!, car: makeCar(100, rnd() < 0.5 ? 195 : 105, 0, 0) },
    w: { ...state.players.w!, mode: "foot", foot: makeFoot(wx, 0, wz, 0), car: makeCar(-40, -40, 0, 0) },
  } };
  if (state.players.car!.car.z < 150) state.players.car!.car = makeCar(100, 105, Math.PI, 0);
  const spawns: RuntimeSpawn[] = [];
  const kinds: Care[] = [];
  if (seed % 2 === 0) {
    // In the road x = 100 and on its east sidewalk (x 94.5..112, z 112..184.5): 6 to 10 cared-for bodies.
    const placed: Array<{ x: number; z: number; radius: number }> = [];
    const n = 6 + Math.floor(rnd() * 5);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const kind = (["child", "dog", "seated", "mobility", "adult"] as const)[Math.floor(rnd() * 5)]!;
      for (let attempt = 0; attempt < 20; attempt++) {
        const x = 95.5 + rnd() * 15.5, z = 114 + rnd() * 68;
        const r = kind === "child" ? 0.25 : 0.32;
        if (kind === "dog") {
          const ox = x, oz = z + 1.2;
          if (!clearOf(state, world, x, z, 0.3, placed) || !clearOf(state, world, ox, oz, 0.32, [...placed, { x, z, radius: 0.3 }])) continue;
          ids.push(`fuzz:owner${i}`, `fuzz:dog${i}`);
          placed.push({ x: ox, z: oz, radius: 0.32 }, { x, z, radius: 0.3 });
          spawns.push({ id: `fuzz:owner${i}`, numericId: 0, model: "person", firmware: "none", x: ox, y: 0, z: oz, heading: 0, radius: 0.32, height: 1.75 });
          spawns.push({ id: `fuzz:dog${i}`, numericId: 0, model: "dog", firmware: "none", x, y: 0, z, heading: 0, radius: 0.3, height: 0.6, ownerId: `fuzz:owner${i}` });
        } else {
          if (!clearOf(state, world, x, z, r, placed)) continue;
          ids.push(`fuzz:${kind}${i}`);
          placed.push({ x, z, radius: r });
          spawns.push({ id: `fuzz:${kind}${i}`, numericId: 0, model: "person", firmware: "none", x, y: 0, z, heading: rnd() * 6.28, radius: r, height: kind === "child" ? 1.1 : 1.7,
            ...(kind === "child" ? { child: true, protected: true } : {}), ...(kind === "seated" ? { posture: "seated" as const } : {}), ...(kind === "mobility" ? { mobilityAid: true } : {}) });
        }
        kinds.push(kind);
        break;
      }
    }
    const reserved = allocateActorIds(state, ids);
    state = reserved.state;
    for (const s of spawns) s.numericId = reserved.ids[s.id]!;
  }
  const drivers = ["straight", "chase", "weave", "drift"] as const;
  const driver = drivers[Math.floor(rnd() * drivers.length)]!;
  const target = spawns.length ? spawns[Math.floor(rnd() * spawns.length)]!.id : null;
  return {
    name: `seed ${seed}: ${driver} at ${target ?? "the foot player"}${kinds.length ? ` among ${kinds.join(",")}` : ""}`,
    world, state, systems: composed(spawns), target, driver, vanTick: 2 + Math.floor(rnd() * 240),
  };
}

function targetOf(sc: Scene, s: SimState): { x: number; z: number } {
  const id = sc.target === null ? undefined : agentsRuntimeOf(s)?.actors[sc.target]?.numericId;
  const body = id === undefined ? undefined : s.ext.agents?.list.find((a) => a.id === id);
  return body ?? s.players.w!.foot!;
}

function drive(sc: Scene, t: number, s: SimState): InputFrame {
  const c = s.players.car!.car;
  const tg = targetOf(sc, s);
  let err = Math.atan2(tg.x - c.x, -(tg.z - c.z)) - c.heading;
  while (err > Math.PI) err -= 2 * Math.PI;
  while (err < -Math.PI) err += 2 * Math.PI;
  const d = Math.hypot(tg.x - c.x, tg.z - c.z);
  const aim = Math.max(-1, Math.min(1, err * 3));
  const steer = sc.driver === "straight" ? 0 : sc.driver === "weave" ? Math.max(-1, Math.min(1, aim + Math.sin(t / 9) * 0.6)) : sc.driver === "drift" && d < 30 ? (err >= 0 ? 1 : -1) : aim;
  const brake = sc.driver === "drift" && d < 30 && d > 6 ? 1 : 0;
  // Round again after a pass: back off, then come at them from where the car ended up.
  const throttle = t % 240 < 200 ? 1 : -0.6;
  return { car: { throttle, steer, brake, actions: 0 }, w: { throttle: 0, steer: 0, brake: 0, actions: 0 } };
}

/** Heat's threat.spawn for the foot player, as the heat reducer writes it (read next tick). */
function requestVan(s: SimState, seed: number): SimState {
  const heat = (s.ext.heat ?? {}) as { events?: unknown[] };
  const p = s.players.w!.foot!;
  const payload = { id: `fuzz:${seed}:van`, requestTick: s.tick, playerId: "w", player: { x: Math.round(p.x), z: Math.round(p.z) }, kind: "van", unitCount: 2, threat: 2 };
  const event = { id: `${s.tick}:fuzz`, tick: s.tick, kind: "threat.spawn", playerId: "w", targetId: "", amount: 2, detail: "van", payload };
  return { ...s, ext: { ...s.ext, heat: { ...heat, events: [...(heat.events ?? []), event] } as SimState["ext"]["heat"] } };
}

interface Vehicle { key: string; x: number; z: number; heading: number; hl: number; hw: number; moving: boolean; runtime: boolean }
function vehicles(s: SimState): Vehicle[] {
  const out: Vehicle[] = [];
  for (const id of Object.keys(s.players).sort()) {
    const c = s.players[id]!.car;
    out.push({ key: `car:${id}`, x: c.x, z: c.z, heading: c.heading, hl: CAR.halfLength, hw: CAR.halfWidth, moving: Math.hypot(c.speed, c.lateral) > 1, runtime: false });
  }
  for (const a of s.ext.agents?.list ?? []) {
    if (a.kind !== "robotaxi") continue;
    out.push({ key: a.runtimeId ?? `taxi:${a.id}`, x: a.x, z: a.z, heading: a.heading, hl: a.halfLength ?? ROBOTAXI_BODY.halfLength, hw: a.halfWidth ?? ROBOTAXI_BODY.halfWidth, moving: Math.abs(a.speed) > 1, runtime: a.runtimeId !== undefined });
  }
  return out;
}
interface Guarded { key: string; x: number; z: number; r: number; care: boolean }
function guarded(s: SimState): Guarded[] {
  const out: Guarded[] = [];
  for (const id of Object.keys(s.players).sort()) {
    const p = s.players[id]!;
    if (p.mode === "foot" && p.foot) out.push({ key: `foot:${id}`, x: p.foot.x, z: p.foot.z, r: FOOT.radius, care: false });
  }
  for (const a of s.ext.agents?.list ?? []) {
    const cls = agentDodgeClass(a as AgentState);
    if (cls !== "person" && cls !== "care") continue;
    out.push({ key: a.runtimeId ?? `agent:${a.id}`, x: a.x, z: a.z, r: a.radius ?? AGENT_SPEC[a.kind].radius, care: cls === "care" });
  }
  return out;
}

interface Result { contacts: string[]; simContacts: number; dives: number; overrides: number; vans: number; buses: number; cared: number; minRuntime: number; minCar: number; hash: string }
function run(sc: Scene): Result {
  let s = sc.state;
  const contacts: string[] = [];
  const vans = new Set<string>(), buses = new Set<string>();
  let cared = 0, minRuntime = Infinity, minCar = Infinity;
  for (let t = 0; t < TICKS; t++) {
    if (t === sc.vanTick) s = requestVan(s, t);
    s = step(sc.world, s, drive(sc, t, s), [], sc.systems);
    const vs = vehicles(s), gs = guarded(s);
    if (t === 2) cared = gs.filter((g) => g.care).length;
    for (const v of vs) {
      if (v.key.startsWith("service:")) vans.add(v.key);
      if (v.key.startsWith("transit:")) buses.add(v.key);
      const fx = Math.sin(v.heading), fz = -Math.cos(v.heading);
      for (const g of gs) {
        if (Math.abs(g.x - v.x) > v.hl + v.hw + 2 || Math.abs(g.z - v.z) > v.hl + v.hw + 2) continue;
        const clear = boxDistance(g.x, g.z, v.x, v.z, fx, fz, v.hl, v.hw) - g.r;
        if (clear < 0) contacts.push(`${sc.name}: ${g.key} inside ${v.key} at tick ${s.tick} by ${(-clear).toFixed(4)} m`);
        if (v.moving && v.runtime) minRuntime = Math.min(minRuntime, clear);
        if (v.moving && v.key === "car:car") minCar = Math.min(minCar, clear);
      }
    }
  }
  let bumps = 0;
  for (const id of Object.keys(s.players)) bumps += s.players[id]!.car.personBumps;
  return { contacts, simContacts: dodgeExtOf(s).contacts + bumps, dives: dodgeExtOf(s).dives, overrides: dodgeExtOf(s).overrides, vans: vans.size, buses: buses.size, cared, minRuntime, minCar, hash: hashState(s) };
}

describe("the no-touch fuzz for runtime bodies, through createGameSystems", () => {
  it(`${SEEDS} scenes: vans and buses under car physics among people, a car chasing children, dogs, seated people and mobility-aid users: zero contacts`, () => {
    const contacts: string[] = [];
    let simContacts = 0, dives = 0, overrides = 0, vans = 0, buses = 0, cared = 0, minRuntime = Infinity, minCar = Infinity;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = run(makeScene(seed));
      contacts.push(...r.contacts);
      simContacts += r.simContacts;
      dives += r.dives;
      overrides += r.overrides;
      vans += r.vans;
      buses += r.buses;
      cared += r.cared;
      minRuntime = Math.min(minRuntime, r.minRuntime);
      minCar = Math.min(minCar, r.minCar);
    }
    console.info(`[runtime no-touch fuzz] ${SEEDS} scenes: ${vans} vans, ${buses} buses, ${cared} cared-for runtime bodies, ${dives} dives, ${overrides} overrides; min clearance from a moving van or bus ${minRuntime.toFixed(3)} m, from the chasing car ${minCar.toFixed(3)} m`);
    expect(contacts.slice(0, 10)).toEqual([]);
    expect(simContacts).toBe(0);
    // The scenes did what they are for.
    expect(vans).toBeGreaterThanOrEqual(SEEDS);
    expect(buses).toBeGreaterThanOrEqual(SEEDS / 2);
    expect(cared).toBeGreaterThan(SEEDS * 2);
    expect(dives).toBeGreaterThan(SEEDS);
  }, 600_000);

  it("a scene replays to the same state", () => {
    for (const seed of [2, 7]) expect(run(makeScene(seed)).hash).toBe(run(makeScene(seed)).hash);
  }, 300_000);
});
