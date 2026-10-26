import {
  Action,
  DT,
  NEUTRAL_INPUT,
  SIM_VERSION,
  sortedIds,
  type CarState,
  type DodgeState,
  type FootState,
  type InputFrame,
  type PlayerId,
  type PlayerRide,
  type PlayerState,
  type SimEvent,
  type SimInput,
  type SimState,
  type Spawn,
} from "./contract.ts";
import { clamp, HALF_PI, TAU, wrapAngle } from "./dmath.ts";
import { CAR, CLEAR_SPOT_RADIUS_M, carBox, carCircles, clearCarSpot, makeCar, stepCar, type CarContact } from "./car.ts";
import { agentImpactBody, carImpactBody, impactsOf, knockedIds, limpThrottle, stepImpacts } from "./impacts.ts";
import { propsNear } from "./props.ts";
import { FOOT, canEnterCar, exitSpot, stepFoot, wantsSprint } from "./foot.ts";
import { AGENTS_EXT_KEY, AGENT_SPEC, ROBOTAXI_BODY, agentCircles, initialAgents, stepAgents, type AgentsExt, type AgentState } from "./agents.ts";
import {
  DODGE_PROFILE,
  STOPPED_CLEAR_M,
  agentDodgeClass,
  horizonS,
  robotaxiBerth,
  routeReach,
  stepDodge,
  sweepHit,
  vehicleOfAgent,
  vehicleOfCar,
  zoneDistance,
  type DodgeClass,
  type Vehicle,
} from "./dodge.ts";
import type { Box, Circle } from "./collide.ts";
import { seedRng } from "./rng.ts";
import { meshGroundHeight, type World } from "./world.ts";
import { prepareSystems, runSystems, SYSTEMS } from "./systems.ts";
import type { SimSystem } from "./system-contract.ts";
import { prepareMotionBodies, applyMotionBodies, observedMotionBodies } from "./motion.ts";
import { tractionAt } from "./fog/index.ts";
import { releaseActorIds } from "./identity.ts";
import { movementLimit } from "./combat/system.ts";
import { stepManualTaxis, syncManualTaxiImpacts, commandeerTaxi } from "./manual-taxi.ts";
import { RIDE, RIDE_DESTINATION_EVENT, arrived, boardableTaxi, canTakeOverTaxi, destinationOf, hailableTaxi, takeoverTaxi } from "./ride.ts";

function finiteOr0(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export function sanitizeInput(i: Readonly<SimInput>): SimInput {
  const input: SimInput = {
    throttle: clamp(finiteOr0(i.throttle), -1, 1),
    steer: clamp(finiteOr0(i.steer), -1, 1),
    brake: clamp(finiteOr0(i.brake), 0, 1),
    actions: (i.actions | 0) >>> 0,
  };
  // Missing/non-finite aim stays absent so pre-wave-2 input logs keep body-heading aim.
  if (Number.isFinite(i.aimYaw)) input.aimYaw = wrapAngle(i.aimYaw! % TAU);
  if (Number.isFinite(i.aimPitch)) input.aimPitch = clamp(i.aimPitch!, -HALF_PI, HALF_PI);
  return input;
}

/**
 * A new player in a car at the spawn, or at the nearest clear spot to it (clearCarSpot): never
 * overlapping a building, a wall or another car (`others`), and keeping `keepOff` (people,
 * animals and players on foot, grown by the dodge's clearance: joinKeepOff) clear of its body.
 */
function spawnPlayer(world: World, id: PlayerId, s: Spawn, others: ReadonlyArray<Readonly<Box>>, keepOff: readonly Circle[] = []): PlayerState {
  const p = clearCarSpot(world, s.x, s.z, s.heading, others, keepOff);
  return {
    id,
    mode: "vehicle",
    car: makeCar(p.x, p.z, s.heading, meshGroundHeight(world, p.x, p.z)),
    foot: null,
    exitPending: false,
  };
}

/**
 * What a car that appears (a player joining) keeps clear of besides buildings, walls and cars:
 * every person and animal and every player on foot, grown by the dodge's widest override
 * clearance (DODGE_PROFILE.care, 0.6 m) and a little more, so it never appears on top of anyone
 * (a contact) or close enough to set off the override; robots and robotaxis as the bodies they
 * are.
 */
function joinKeepOff(s: Readonly<SimState>, x: number, z: number): Circle[] {
  const grow = DODGE_PROFILE.care.override! + 0.1;
  // (Only what the spots clearCarSpot tries can meet.)
  const lim = CLEAR_SPOT_RADIUS_M + CAR.halfLength + CAR.halfWidth + 4;
  const out: Circle[] = [];
  const add = (c: Circle): void => {
    if ((c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) <= lim * lim) out.push(c);
  };
  for (const a of (s.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? []) {
    const cls = agentDodgeClass(a);
    const person = cls !== null && cls !== "errandRobot" && cls !== "sidewalkBot";
    for (const c of agentCircles(a)) add({ x: c.x, z: c.z, r: c.r + (person ? grow : 0), person: false });
  }
  for (const id of sortedIds(s.players)) {
    const f = s.players[id]!.foot;
    if (s.players[id]!.mode === "foot" && f) add({ x: f.x, z: f.z, r: FOOT.radius + grow, person: false });
  }
  return out;
}

/**
 * A new world state. When the world has roads, ext.agents starts with the ambient population
 * around the players (src/sim/agents.ts), drawn from the seeded RNG.
 */
export function createInitialState(world: World, seed: number, playerIds: readonly PlayerId[], spawn: Spawn): SimState {
  const players: Record<PlayerId, PlayerState> = {};
  [...playerIds].sort().forEach((id, n) => {
    // Side by side so multiplayer spawns do not overlap.
    const others = sortedIds(players).map((pid) => carBox(players[pid]!.car));
    players[id] = spawnPlayer(world, id, { x: spawn.x + n * 4, z: spawn.z, heading: spawn.heading }, others);
  });
  // (ext.dodge appears with the first dive; absent means every counter is 0, dodge.ts dodgeExtOf.)
  const state: SimState = { version: SIM_VERSION, tick: 0, seed, rng: seedRng(seed), players, ext: {} };
  if (!world.roads) return state;
  const pop = initialAgents(world, state);
  return { ...state, rng: pop.rng, ext: { ...state.ext, [AGENTS_EXT_KEY]: pop.ext } };
}

/**
 * Lift a saved state from an older SIM_VERSION to this one, one version at a time. Pure.
 *  - v1 -> v2: cars gain the handling fields (at rest), players gain foot (none) and exitPending.
 *  - v2 -> v3, ..., v6 -> v7: each step fills only the body fields a save still lacks and keeps
 *    every field it has: a walker's vy (0), grounded (true) and dodge (null), a car's nearMisses
 *    (0) and each ambient agent's dodge (null). Stamps 3 to 6 were written with overlapping
 *    meanings (qa/sim's v3 and v4 gravity and surfaces, feature/dodge's own v4 dodge, their v5
 *    combination, the wave-2 v6 interface on v2 bodies), so no step may assume which fields a
 *    stamp implies. Unknown ext keys are kept; ext.dodge stays absent (every counter 0) until
 *    the first dive. tests/sim/legacy-saves.test.ts loads real saves from those branches.
 *  - v7 -> v8: gameplay behavior changes without a required field rewrite. Preserve the
 *    complete saved state, including active missions, combat effects and future extensions.
 *  - v8 -> v10 (v9 is the structural world's reserved stamp): weather changes behaviour only.
 *    Every saved field is kept; ext.fog, when absent, is created by the fog reducer.
 *  - v10 -> v11: faster on-foot pace and Action.sprint change behaviour only; every field is kept.
 *  - v11 -> v12: robotaxi rides. PlayerState.ride is optional (absent = not riding); every field is kept.
 *  - v12 -> v13: unlimited water and optional traffic pass/walker detour state; every saved field is kept.
 *  - v13 -> v14 (impacts.ts): cars shove, spin and dent other cars and robotaxis instead of
 *    stopping against them as at a wall. Every new field is optional (ext.impacts absent until
 *    the first hit, AgentState.knock and .dents absent on an untouched agent), so a v13 save
 *    loads unchanged.
 *    Combined v14: cars bowl robots over and robots stop dodging a player's car. A
 *    knocked robot's state is AgentState.knock (optional, absent in an older save): no rewrite.
 *    Combined v14 (props.ts, impacts.ts): street trees, lamp posts and hydrants are bodies a car
 *    hits and breaks; broken ones are in ext.impacts.props (optional, absent: none broken).
 *  - v13 -> v14: people dodge on their feet (dodge.ts). Every dodge under way gains a velocity
 *    (0: it sets off again from a standstill) and a top speed (its profile's); a person's or a
 *    player's hop is taken off their height and set to 0, and a leap's drawn hop with it (peak
 *    0). Robots keep their hop. Nothing else changes.
 *  - v14 -> v15: civilian traffic and a faster on-foot pace change behavior only. Preserve
 *    every existing field and optional extension; do not rebuild traffic or progression.
 *  - v15 -> v16: optional manual taxi controls; preserve all existing state unchanged.
 */
export function upgradeState(s: Readonly<SimState>): SimState {
  if (s.version === SIM_VERSION) return s as SimState;
  if (s.version === 1) return upgradeState(upgradeV1(s));
  if ([2, 3, 4, 5, 6].includes(s.version)) {
    return upgradeState(upgradeLegacyFields(s, s.version + 1));
  }
  if (s.version === 7) return upgradeState({ ...s, version: 8 });
  if (s.version === 8) return upgradeState({ ...s, version: 10 });
  if (s.version === 10) return upgradeState({ ...s, version: 11 });
  if (s.version === 11) return upgradeState({ ...s, version: 12 });
  if (s.version === 12) return upgradeState({ ...s, version: 13 });
  if (s.version === 13) return upgradeState(upgradeDodgeOnFoot(s, 14));
  if (s.version === 14) return upgradeState({ ...s, version: 15 });
  if (s.version === 15) return upgradeState({ ...s, version: 16 });
  throw new Error(`cannot upgrade sim state version ${s.version}`);
}

/** A dodge from before people dodged on their feet, as `upgradeDodgeOnFoot` leaves it, for a body of this class. */
function dodgeOnFoot(d: Readonly<DodgeState>, cls: DodgeClass): DodgeState {
  const prof = DODGE_PROFILE[cls];
  const person = prof.override !== null;
  return { ...d, hop: person ? 0 : d.hop, peak: person ? 0 : d.peak, vx: d.vx ?? 0, vz: d.vz ?? 0, vmax: d.vmax ?? prof.speed };
}

/** The step to the version (`version`) in which people dodge on their feet: see upgradeState. */
function upgradeDodgeOnFoot(s: Readonly<SimState>, version: number): SimState {
  const players: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(s.players)) {
    const p = s.players[id]!;
    const f = p.foot;
    players[id] = f && f.dodge ? { ...p, foot: { ...f, y: f.y - f.dodge.hop, dodge: dodgeOnFoot(f.dodge, "player") } } : p;
  }
  const ext = { ...s.ext };
  const agents = ext[AGENTS_EXT_KEY];
  if (agents) {
    ext[AGENTS_EXT_KEY] = {
      ...agents,
      list: agents.list.map((a) => {
        const cls = agentDodgeClass(a);
        if (!a.dodge || !cls) return a;
        const d = dodgeOnFoot(a.dodge, cls);
        return { ...a, y: a.y - a.dodge.hop + d.hop, dodge: d };
      }),
    };
  }
  return { ...s, version, players, ext };
}

function upgradeV1(s: Readonly<SimState>): SimState {
  const players: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(s.players)) {
    const p = s.players[id]!;
    const c = p.car;
    players[id] = {
      id: p.id,
      mode: "vehicle",
      car: { ...makeCar(c.x, c.z, c.heading, c.y), speed: c.speed, steer: c.steer, hits: c.hits },
      foot: null,
      exitPending: false,
    };
  }
  return { ...s, version: 2, players };
}

function upgradeLegacyFields(s: Readonly<SimState>, version: number): SimState {
  const players: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(s.players)) {
    const p = s.players[id]!;
    const f = p.foot;
    players[id] = { ...p, car: { ...p.car, nearMisses: p.car.nearMisses ?? 0 },
      foot: f ? { ...f, vy: f.vy ?? 0, grounded: f.grounded ?? true, dodge: f.dodge ?? null } : null };
  }
  const ext = { ...s.ext };
  const agents = ext[AGENTS_EXT_KEY];
  if (agents) ext[AGENTS_EXT_KEY] = { ...agents, list: agents.list.map(a => ({ ...a, dodge: a.dodge ?? null })) };
  return { ...s, version, players, ext };
}

/** What every body collides with this tick, built from the previous state. */
interface Obstacles {
  /** Every player's car body, by player id. */
  carBoxes: Map<PlayerId, Box>;
  /**
   * Round bodies a player's car must not pass through: robots and other cars. Never people,
   * animals or walkers (v4): they dive out of its way (dodge.ts), so a car is never stopped,
   * slowed or deflected by one. Other cars and robotaxis carry their `body` (v11): a car shoves
   * them (car.ts, impacts.ts).
   */
  forCar: Map<PlayerId, Circle[]>;
  /** Round bodies a player's walker must not pass through: agents and other walkers. */
  forWalker: Map<PlayerId, Circle[]>;
  /**
   * Vehicle bodies a player's walker must not pass through: every other player's car and every
   * robotaxi near (its drawn body, ROBOTAXI_BODY), each grown by WALKER_SKIN_M, leaving out any
   * whose height band cannot meet the walker's (a car in the street below a roof the walker is on:
   * bandsMeet). The player's own car is `ownBox`.
   */
  walkerBoxes: Map<PlayerId, Box[]>;
  /** A player's own car, grown by WALKER_SKIN_M, when its band meets the walker's (else null). */
  ownBox: Map<PlayerId, Box | null>;
  /** The state the tick started from (for the exit's vehicle reach). */
  prev: Readonly<SimState>;
}

/**
 * A player's walker keeps this far off a vehicle's body (more than the dodge's clearance from a
 * stopped vehicle's reach, dodge.ts STOPPED_CLEAR_M plus its creep), so leaning on a parked car
 * or a waiting robotaxi never sets off the dodge's override.
 */
export const WALKER_SKIN_M = 0.04;

/** Street props farther than this from a player's car cannot touch it this tick (a car's half diagonal plus a tick at 50 m/s). */
const PROP_REACH_M = 4;

/** Agents farther than this from a player's body cannot touch it this tick. */
const NEAR_AGENT_M = 40;

/**
 * Can a body whose feet are at `feet` (`height` tall) meet a vehicle standing at `vy` (`top`
 * tall) this tick? Each band is widened by `slack` for what a tick can change (a step up onto a
 * deck, a drop): a walker on a 4 m roof never collides with a car in the street below it.
 */
export function bandsMeet(feet: number, height: number, vy: number, top: number, slack: number): boolean {
  return feet < vy + top + slack && vy < feet + height + slack;
}

/** A tick can raise or drop a walker or a vehicle by about this much against the other, metres (a step onto a deck, a hill). */
const BAND_SLACK_M = 0.75;

function obstaclesOf(world: World, prev: Readonly<SimState>): Obstacles {
  const agents = (prev.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
  const agentRound: Array<Circle & { road: boolean }> = [];
  // (A robotaxi is a body a car shoves: impacts.ts.)
  const taxiBoxes: Array<{ box: Box; y: number; height: number }> = [];
  for (const a of agents) {
    // People and animals: under the dodge's override (dodge.ts), never a car's obstacle.
    const cls = agentDodgeClass(a);
    const person = cls !== null && cls !== "errandRobot" && cls !== "sidewalkBot";
    const road = AGENT_SPEC[a.kind].road;
    const body = agentImpactBody(a, prev.ext.combat);
    for (const c of agentCircles(a)) agentRound.push(body ? { x: c.x, z: c.z, r: c.r, person, road, body } : { x: c.x, z: c.z, r: c.r, person, road });
    if (road) taxiBoxes.push({ box: { x: a.x, z: a.z, heading: a.heading, hl: (a.halfLength ?? ROBOTAXI_BODY.halfLength) + WALKER_SKIN_M, hw: (a.halfWidth ?? ROBOTAXI_BODY.halfWidth) + WALKER_SKIN_M }, y: a.y, height: a.height ?? ROBOTAXI_BODY.height });
  }
  const ids = sortedIds(prev.players);
  const carBoxes = new Map<PlayerId, Box>();
  const forCar = new Map<PlayerId, Circle[]>();
  const forWalker = new Map<PlayerId, Circle[]>();
  const walkerBoxes = new Map<PlayerId, Box[]>();
  const ownBox = new Map<PlayerId, Box | null>();
  for (const id of ids) carBoxes.set(id, carBox(prev.players[id]!.car));
  const skinned = new Map<PlayerId, Box>();
  for (const id of ids) {
    const b = carBoxes.get(id)!;
    skinned.set(id, { ...b, hl: b.hl + WALKER_SKIN_M, hw: b.hw + WALKER_SKIN_M });
  }
  for (const id of ids) {
    const p = prev.players[id]!;
    const onFoot = p.mode === "foot" && p.foot !== null;
    const bx = onFoot ? p.foot!.x : p.car.x;
    const bz = onFoot ? p.foot!.z : p.car.z;
    // (In the car: the walker it would get out as, at the car's height.)
    const feet = onFoot ? p.foot!.y : p.car.y;
    const near = agentRound.filter((c) => (c.x - bx) * (c.x - bx) + (c.z - bz) * (c.z - bz) < NEAR_AGENT_M * NEAR_AGENT_M);
    const car: Circle[] = near.filter((c) => !c.person).map((c) => (c.body ? { x: c.x, z: c.z, r: c.r, person: c.person, body: c.body } : { x: c.x, z: c.z, r: c.r, person: c.person }));
    // (A walker meets a robotaxi's drawn body, a box, not its circles.)
    const walker: Circle[] = near.filter((c) => !c.road).map((c) => ({ x: c.x, z: c.z, r: c.r, person: c.person }));
    const boxes: Box[] = [];
    for (const other of ids) {
      if (other === id) continue;
      const oc = prev.players[other]!.car;
      if (bandsMeet(feet, FOOT.height, oc.y, CAR.bodyHeight, BAND_SLACK_M)) boxes.push(skinned.get(other)!);
    }
    for (const t of taxiBoxes) {
      const dx = t.box.x - bx;
      const dz = t.box.z - bz;
      if (dx * dx + dz * dz < NEAR_AGENT_M * NEAR_AGENT_M && bandsMeet(feet, FOOT.height, t.y, t.height, BAND_SLACK_M)) boxes.push(t.box);
    }
    walkerBoxes.set(id, boxes);
    ownBox.set(id, bandsMeet(feet, FOOT.height, p.car.y, CAR.bodyHeight, BAND_SLACK_M) ? skinned.get(id)! : null);
    for (const other of ids) {
      if (other === id) continue;
      const o = prev.players[other]!;
      const body = carImpactBody(other, o.car);
      for (const c of carCircles(o.car)) car.push({ ...c, body });
      if (o.mode === "foot" && o.foot) {
        // Another player on foot: a body to walkers; to cars, someone who dives out of the way.
        walker.push({ x: o.foot.x, z: o.foot.z, r: FOOT.radius, person: true });
      }
    }
    // Street props near its car (impacts.ts, props.ts): bodies it breaks fast enough, walls slower.
    const pc = p.car;
    const broken = impactsOf(prev)?.props;
    for (const q of propsNear(world, pc.x, pc.z, PROP_REACH_M)) {
      if (broken?.[q.id]) continue;
      car.push({ x: q.x, z: q.z, r: q.r, person: false, body: { key: `prop:${q.id}`, mass: q.mass, x: q.x, z: q.z, vx: 0, vz: 0, breakSpeed: q.breakSpeed } });
    }
    forCar.set(id, car);
    forWalker.set(id, walker);
  }
  return { carBoxes, forCar, forWalker, walkerBoxes, ownBox, prev };
}

/**
 * The vehicles that can come near (x, z), from the state the tick started from, as the dodge
 * measures them: every other player's car (dodge.ts vehicleOfCar, what it collides with
 * included) and every robotaxi (vehicleOfAgent, along its route), with their reach by the end of
 * this tick and their predicted footprints.
 */
function vehiclesReaching(world: World, prev: Readonly<SimState>, self: PlayerId, x: number, z: number, within: number): Vehicle[] {
  const out: Vehicle[] = [];
  const agents = (prev.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
  const robots: Circle[] = [];
  for (const a of agents) {
    const cls = agentDodgeClass(a);
    if (cls === "errandRobot" || cls === "sidewalkBot" || cls === null) for (const c of agentCircles(a)) robots.push({ ...c, person: false });
  }
  for (const id of sortedIds(prev.players)) {
    if (id === self) continue;
    const c = prev.players[id]!.car;
    const v = Math.sqrt(c.speed * c.speed + c.lateral * c.lateral);
    const lim = within + CAR.halfLength + CAR.halfWidth + v * horizonS(v) + 3;
    if ((c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) > lim * lim) continue;
    const circles: Circle[] = robots.slice();
    for (const other of sortedIds(prev.players)) if (other !== id) circles.push(...carCircles(prev.players[other]!.car));
    out.push(vehicleOfCar(id, c, null, world, circles));
  }
  for (const a of agents) {
    if (!AGENT_SPEC[a.kind].road) continue;
    const lim = within + ROBOTAXI_BODY.halfLength + ROBOTAXI_BODY.halfWidth + a.speed * horizonS(a.speed) + 3;
    if ((a.x - x) * (a.x - x) + (a.z - z) * (a.z - z) > lim * lim) continue;
    const v = vehicleOfAgent(a, null, DT, world, true);
    routeReach(v, a, DT, world);
    out.push(v);
  }
  return out;
}

function stepPlayer(world: World, p: Readonly<PlayerState>, input: SimInput, obs: Obstacles, contacts: CarContact[] = []): PlayerState {
  const pressed = (input.actions & Action.enterExit) !== 0;
  if (p.mode === "foot" && p.foot) {
    // Diving out of a car's way, or getting up: the dodge moves the walker (dodge.ts).
    if (p.foot.dodge) return p;
    if (pressed && canEnterCar(world, p.car, p.foot.x, p.foot.z)) {
      return { ...p, mode: "vehicle", foot: null, exitPending: false };
    }
    const own = obs.ownBox.get(p.id) ?? null;
    const boxes = own ? [own, ...(obs.walkerBoxes.get(p.id) ?? [])] : (obs.walkerBoxes.get(p.id) ?? []);
    const foot = stepFoot(world, p.foot, input, boxes, obs.forWalker.get(p.id) ?? []);
    return { ...p, foot };
  }

  const exitPending = pressed ? !p.exitPending : p.exitPending;
  const canExit = (c: Readonly<CarState>): boolean =>
    c.grounded &&
    (c.speed < 0 ? -c.speed : c.speed) < FOOT.exitSpeed &&
    (c.lateral < 0 ? -c.lateral : c.lateral) < FOOT.exitSpeed;
  const getOut = (c: Readonly<CarState>): PlayerState => {
    // The car stays parked exactly where it stopped.
    const parked: CarState = { ...c, speed: 0, lateral: 0, yawRate: 0, vy: 0 };
    const own = carBox(parked);
    // Every vehicle body a walker collides with (robotaxis' drawn bodies included), and the
    // parked car itself.
    const boxes: Box[] = [{ ...own, hl: own.hl + WALKER_SKIN_M, hw: own.hw + WALKER_SKIN_M }, ...(obs.walkerBoxes.get(p.id) ?? [])];
    const circles = obs.forWalker.get(p.id) ?? [];
    // Never where a vehicle can be by the end of this tick, with the dodge's clearance from it
    // and what it can reach on the tick after (dodge.ts zoneDistance): getting out is never a
    // contact, and never sets off the override. Nor in a moving vehicle's way (its predicted
    // footprint, with the margin the dodge dives at): nobody steps out in front of a car.
    const near = vehiclesReaching(world, obs.prev, p.id, parked.x, parked.z, CAR.halfLength + FOOT.exitGap + 2 * FOOT.radius + 1);
    const prof = DODGE_PROFILE.player;
    const avoid = (x: number, z: number): boolean => {
      for (const v of near) {
        const clear = v.moving ? prof.override! : STOPPED_CLEAR_M;
        if (zoneDistance(v, x, z) < FOOT.radius + clear + 2 * v.inflate + v.speed * DT + 0.02) return true;
        const margin = v.player === null ? Math.min(prof.margin, robotaxiBerth("player")) : prof.margin;
        if (v.paths.length > 0 && sweepHit(v, x, z, FOOT.radius + margin + 0.05)) return true;
      }
      return false;
    };
    const foot = exitSpot(world, parked, boxes, circles, near.length > 0 ? avoid : null);
    if (!foot) {
      // Only a vehicle in the way (one passing, one pulling up): get out once it has gone.
      if (near.length > 0 && exitSpot(world, parked, boxes, circles)) return { ...p, car: parked, exitPending: true };
      // No room to get out (walls or bodies on every side): stay in, stopped, free to drive on.
      return { ...p, car: parked, exitPending: false };
    }
    return { ...p, mode: "foot", car: parked, foot, exitPending: false };
  };
  if (exitPending && canExit(p.car)) return getOut(p.car);
  // While an exit is pending the car brakes to a stop by itself, then the player gets out.
  const drive: SimInput = exitPending ? { throttle: 0, steer: 0, brake: 1, actions: input.actions } : input;
  const car = stepCar(world, p.car, drive, obs.forCar.get(p.id) ?? [], tractionAt(world, obs.prev, p.car.x, p.car.z), contacts);
  if (exitPending && canExit(car)) return getOut(car);
  return { ...p, car, exitPending };
}

/** Apply physical movement limits without swallowing combat or interaction inputs. */
function stepPlayerWithEffects(world: World, player: PlayerState, raw: SimInput, obs: ReturnType<typeof obstaclesOf>, state: Readonly<SimState>, contacts: CarContact[]): PlayerState {
  // A wrecked car limps (impacts.ts).
  const throttle = player.mode === "vehicle" ? limpThrottle(state, player.id, player.car, raw.throttle) : raw.throttle;
  const input = throttle === raw.throttle ? raw : { ...raw, throttle };
  const combat = state.ext.combat;
  if (!combat) return stepPlayer(world, player, input, obs, contacts);
  const limit = movementLimit(combat, { id: `player:${player.id}`, playerId: player.id });
  if (limit.maxSpeed === null && limit.scale === 1) return stepPlayer(world, player, input, obs, contacts);
  const foot = player.mode === "foot" && player.foot;
  const naturalCap = limit.scale < 1 ? (foot ? (wantsSprint(input) ? FOOT.sprint : FOOT.walk) : CAR.maxSpeed) * limit.scale : Infinity;
  const cap = Math.max(0, Math.min(limit.maxSpeed ?? Infinity, naturalCap));
  const body = foot || player.car;
  const limited = { ...body, speed: clamp(body.speed, -cap, cap) };
  const before = foot ? { ...player, foot: limited as FootState } : { ...player, car: { ...limited, lateral: cap === 0 ? 0 : player.car.lateral } as CarState };
  const controls = { ...input, throttle: cap === 0 ? 0 : input.throttle * limit.scale, steer: cap === 0 ? 0 : input.steer, brake: cap === 0 ? (foot ? 0 : 1) : input.brake };
  const next = stepPlayer(world, before, controls, obs, contacts);
  // Enter/exit placement still uses the normal clearance solver; constrain subsequent travel.
  if (next.mode !== player.mode) return next;
  const nextBody = next.mode === "foot" && next.foot ? next.foot : next.car;
  const dx = nextBody.x - body.x, dz = nextBody.z - body.z, distance = Math.sqrt(dx * dx + dz * dz);
  const ratio = distance > 0 ? Math.min(1, cap * DT / distance) : 1;
  const accepted = { ...nextBody, x: body.x + dx * ratio, z: body.z + dz * ratio, speed: clamp(nextBody.speed, -cap, cap) };
  return next.mode === "foot" ? { ...next, foot: accepted as FootState } : { ...next, car: { ...accepted, lateral: next.car.lateral * ratio } as CarState };
}

/**
 * Advance the world by one fixed tick (DT). Pure: returns a new state.
 * `events` must all carry tick === prev.tick + 1. `systems` defaults to the static SYSTEMS
 * (systems.ts), which leaves out every provider-backed gameplay system: pass
 * createGameSystems() to step the game as it is played.
 */
export function step(world: World, prev: Readonly<SimState>, inputs: InputFrame, events: readonly SimEvent[] = [], systems: readonly SimSystem[] = SYSTEMS): SimState {
  const tick = prev.tick + 1;
  const players: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(prev.players)) players[id] = prev.players[id]!;

  for (const e of events) {
    if (e.tick !== tick) throw new Error(`event ${e.kind} is for tick ${e.tick}, stepping to ${tick}`);
    if (e.kind === "player.join" && e.playerId && !players[e.playerId]) {
      const s = (e.payload ?? {}) as Partial<Spawn>;
      const others = sortedIds(players).map((id) => carBox(players[id]!.car));
      const at: Spawn = { x: s.x ?? 0, z: s.z ?? 0, heading: s.heading ?? 0 };
      players[e.playerId] = spawnPlayer(world, e.playerId, at, others, joinKeepOff({ ...prev, players }, at.x, at.z));
    } else if (e.kind === "player.leave" && e.playerId) {
      delete players[e.playerId];
    }
  }

  // Bodies collide with each other as of the previous tick (after joins and leaves), so the
  // order players and agents are processed in cannot change the outcome.
  const sanitized: Record<PlayerId, SimInput> = {};
  for (const id of sortedIds(players)) {
    const input = sanitizeInput(inputs[id] ?? NEUTRAL_INPUT);
    // A passenger can take control (H) or get out (F); a driver controls only the taxi.
    // Neither can spray or drive the parked car.
    sanitized[id] = players[id]!.ride
      ? players[id]!.ride!.manual ? { ...input, actions: input.actions & (Action.enterExit | Action.horn) }
        : { ...NEUTRAL_INPUT, actions: input.actions & (Action.enterExit | Action.horn) }
      : input;
  }
  const prior: SimState = { ...prev, players };
  const prepared = prepareSystems({ world,previous:prior,state:{...prior,tick,ext:{...prior.ext}},inputs:sanitized,events }, systems);
  const admitted = releaseActorIds(prepareMotionBodies(world, prepared.state, prepared.motions, prepared.retirements), prepared.retirements);
  const before: SimState = { ...admitted, tick:prev.tick };
  const obs = obstaclesOf(world, before);
  const next: Record<PlayerId, PlayerState> = {};
  const contacts = new Map<PlayerId, CarContact[]>();
  for (const id of sortedIds(players)) {
    const p = players[id]!;
    const hits: CarContact[] = [];
    // A rider's parked car has one physical owner: impacts.ts settles its impulses and slide.
    // settleRides handles the rider; never also integrate that car with stepCar here.
    next[id] = p.ride ? { ...p, exitPending: false } : stepPlayerWithEffects(world, p, sanitized[id]!, obs, before, hits);
    contacts.set(id, hits);
  }
  // (Knocked bodies are moved by impacts.ts, not by their routes.)
  const controlled = new Set([...prepared.motions.map(motion=>motion.numericId), ...knockedIds(before)]);
  const agents = stepAgents(world, before, tick, controlled);
  const moved: SimState = agents
    ? { ...admitted, tick, players: next, rng: agents.rng, ext: { ...admitted.ext, [AGENTS_EXT_KEY]: agents.ext } }
    : { ...admitted, tick, players: next, ext: { ...admitted.ext } };
  const physical = applyMotionBodies(world, moved, prepared.motions);
  const manual = stepManualTaxis(world, before, physical, sanitized);
  const impacted = syncManualTaxiImpacts(stepImpacts(world, manual.state, contacts, manual.contacts));
  const cleared = settleRides(world, before, stepDodge(world, before, impacted), sanitized, events);
  return runSystems({ world, previous: before, state: cleared, inputs: sanitized, events, observedBodies:observedMotionBodies(cleared,prepared.motions) }, systems);
}

/** The body a player controls right now: the walker on foot, else the car. For cameras, HUDs and AI. */
export interface ActiveBody {
  mode: "vehicle" | "foot";
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
}

export function activeBody(p: Readonly<PlayerState>): ActiveBody {
  if (p.ride) {
    const r = p.ride;
    return { mode: "vehicle", x: r.x, y: r.y, z: r.z, heading: r.heading, speed: r.speed };
  }
  if (p.mode === "foot" && p.foot) {
    const f = p.foot;
    return { mode: "foot", x: f.x, y: f.y, z: f.z, heading: f.heading, speed: f.speed };
  }
  const c = p.car;
  return { mode: "vehicle", x: c.x, y: c.y, z: c.z, heading: c.heading, speed: c.speed };
}

/**
 * Robotaxi rides, after every body has moved this tick (src/sim/ride.ts). In player-id order:
 *  - a destination event sets a rider's goal;
 *  - a walker who pressed F and did not get into their own car hops into the nearest boardable
 *    robotaxi (empty, stopped, fit, within reach, nothing in between);
 *  - a rider's ride mirrors the taxi's pose; F, arriving at the goal, or the taxi pulling over
 *    after water reaches it asks to get out; once the taxi has stopped the rider steps out at the
 *    first clear, reachable spot beside it that no vehicle can reach this tick (the same rules as
 *    getting out of the car), else stays aboard and tries again next tick.
 */
function settleRides(world: World, before: Readonly<SimState>, state: SimState, inputs: Readonly<Record<PlayerId, SimInput>>, events: readonly SimEvent[]): SimState {
  const ids = sortedIds(state.players);
  if (!ids.some((id) => state.players[id]!.ride || state.players[id]!.hail || (inputs[id]!.actions & (Action.enterExit | Action.horn)) !== 0)) return state;
  let agents = (state.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
  const players: Record<PlayerId, PlayerState> = { ...state.players };
  for (const id of ids) {
    const p = players[id]!;
    const pressed = (inputs[id]!.actions & Action.enterExit) !== 0;
    const takeover = (inputs[id]!.actions & Action.horn) !== 0;
    let goal: { x: number; z: number } | null | undefined;
    for (const e of events) if (e.kind === RIDE_DESTINATION_EVENT && e.playerId === id) goal = destinationOf(e.payload) ?? goal;
    if (!p.ride) {
      // A hail lapses after RIDE.hailTicks, or when the player is no longer on foot.
      const hail = p.hail && p.hail.untilTick > state.tick && p.mode === "foot" ? p.hail : null;
      if ((p.hail ?? null) !== hail) players[id] = { ...p, hail: null };
      const was = before.players[id];
      if ((!pressed && !takeover) || p.mode !== "foot" || !p.foot || p.foot.dodge || !was || was.mode !== "foot") continue;
      const taxi = takeover ? takeoverTaxi(world, { ...state, players, ext: { ...state.ext, agents: { ...state.ext.agents!, list: agents } } }, p.foot.x, p.foot.z, id)
        : boardableTaxi(world, { ...state, players }, p.foot.x, p.foot.z, id);
      if (taxi) {
        const manual = takeover || taxi.manualCar !== undefined;
        if (manual) agents = agents.map(a=>a.id===taxi.id ? commandeerTaxi(a) : a);
        players[id] = { ...p, mode: "vehicle", foot: null, exitPending: false, hail: null,
          ride: { agentId: taxi.id, ...(manual ? { manual: true as const } : {}), x: taxi.x, y: taxi.y, z: taxi.z, heading: taxi.heading, speed: taxi.speed, goal: goal ?? null, exitPending: false } };
        continue;
      }
      if (takeover) continue;
      // None in reach: hail the nearest one passing (it pulls up and waits for you).
      const passing = hailableTaxi(world, { ...state, players }, p.foot.x, p.foot.z, id);
      if (passing) players[id] = { ...p, hail: { agentId: passing.id, untilTick: state.tick + RIDE.hailTicks } };
      continue;
    }
    const taxi = agents.find((a) => a.id === p.ride!.agentId);
    const pulling = (state.ext.combat?.targets[`agent:${p.ride.agentId}`]?.pullOverTick ?? 0) > state.tick;
    const claim = takeover && !p.ride.manual && taxi && canTakeOverTaxi({ ...state, players }, taxi.id, id);
    if (claim) agents = agents.map(a=>a.id===taxi.id ? commandeerTaxi(a) : a);
    const ride = { ...p.ride, ...(claim ? { manual: true as const, goal: null, exitPending: false } : {}), ...(!p.ride.manual && !claim && goal !== undefined ? { goal } : {}),
      ...(taxi ? { x: taxi.x, y: taxi.y, z: taxi.z, heading: taxi.heading, speed: taxi.speed } : { speed: 0 }) };
    if (!taxi || pressed || pulling || (!ride.manual && arrived(ride, ride.x, ride.z))) ride.exitPending = true;
    if (ride.exitPending && Math.abs(ride.speed) < RIDE.exitSpeed && (!ride.manual || !taxi?.manualCar || taxi.manualCar.grounded && Math.abs(taxi.manualCar.lateral)<RIDE.exitSpeed)) {
      const foot = rideExitSpot(world, { ...state, players }, id, p.car, ride);
      if (foot) {
        players[id] = { ...p, mode: "foot", foot, exitPending: false, ride: null };
        continue;
      }
    }
    players[id] = { ...p, ride };
  }
  return { ...state, players, ...(state.ext.agents && agents !== state.ext.agents.list ? { ext: { ...state.ext, agents: { ...state.ext.agents, list: agents } } } : {}) };
}

/** Where a rider steps out of a stopped robotaxi, with getOut's rules (or null: not yet). */
function rideExitSpot(world: World, state: Readonly<SimState>, id: PlayerId, car: Readonly<CarState>, ride: Readonly<PlayerRide>): FootState | null {
  const agents = (state.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
  const near = (x: number, z: number, r: number): boolean => (x - ride.x) * (x - ride.x) + (z - ride.z) * (z - ride.z) < r * r;
  const boxes: Box[] = [];
  const circles: Circle[] = [];
  for (const a of agents) {
    if (!near(a.x, a.z, NEAR_AGENT_M)) continue;
    if (AGENT_SPEC[a.kind].road) {
      boxes.push({ x: a.x, z: a.z, heading: a.heading, hl: (a.halfLength ?? ROBOTAXI_BODY.halfLength) + WALKER_SKIN_M, hw: (a.halfWidth ?? ROBOTAXI_BODY.halfWidth) + WALKER_SKIN_M });
    } else {
      const cls = agentDodgeClass(a);
      const person = cls !== null && cls !== "errandRobot" && cls !== "sidewalkBot";
      for (const c of agentCircles(a)) circles.push({ x: c.x, z: c.z, r: c.r, person });
    }
  }
  for (const other of sortedIds(state.players)) {
    const o = state.players[other]!;
    const b = carBox(o.car);
    boxes.push({ ...b, hl: b.hl + WALKER_SKIN_M, hw: b.hw + WALKER_SKIN_M });
    if (other !== id && o.mode === "foot" && o.foot) circles.push({ x: o.foot.x, z: o.foot.z, r: FOOT.radius, person: true });
  }
  const reaching = vehiclesReaching(world, state, id, ride.x, ride.z, ROBOTAXI_BODY.halfLength + FOOT.exitGap + 2 * FOOT.radius + 1)
    .filter(v=>!ride.manual || v.key!==`a:${ride.agentId}`);
  const prof = DODGE_PROFILE.player;
  const avoid = (x: number, z: number): boolean => {
    for (const v of reaching) {
      const clear = v.moving ? prof.override! : STOPPED_CLEAR_M;
      if (zoneDistance(v, x, z) < FOOT.radius + clear + 2 * v.inflate + v.speed * DT + 0.02) return true;
      const margin = v.player === null ? Math.min(prof.margin, robotaxiBerth("player")) : prof.margin;
      if (v.paths.length > 0 && sweepHit(v, x, z, FOOT.radius + margin + 0.05)) return true;
    }
    return false;
  };
  // exitSpot steps out from a car's sides and ends; a robotaxi's body is in `boxes`, so a spot
  // inside or against it is refused like any other.
  return exitSpot(world, { ...car, x: ride.x, y: ride.y, z: ride.z, heading: ride.heading }, boxes, circles, reaching.length > 0 ? avoid : null);
}
