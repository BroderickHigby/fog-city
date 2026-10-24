// Closed-loop drivers for the wave-3 campaign (Launch Day, Demo'd Correctly) in the real SF world.
// Planning reads committed geometry and observed state; every body, mission and wallet change goes
// through the production step function with the same inputs and recorded commands the page uses.
import { MISSIONS } from "../../../src/content/catalog.ts";
import { STARTUP_KITS } from "../../../src/content/kits.ts";
import { Action, AGENT_SPEC, CAR, circleBlocked, clamp, createFollowerState, datan2, DT, segmentCrossesWall, wrapAngle, createInitialState, dcos, dsin, step, stepVehicleFollower, type SimEvent, type SimInput, type SimState, type SimSystem, type World } from "../../../src/sim/index.ts";
import { missionActorBindings } from "../../../src/sim/agents/systems.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { missionPlace } from "../../../src/sim/missions/system.ts";
import { buildMissionParkingWorld } from "../../../src/sim/missions/parking-world.ts";
import { checkParking, type ParkingBay } from "../../../src/sim/missions/mechanics/parking.ts";
import { captureProgression, restoreProgression, validateSavedProgression } from "../../../src/save/progression.ts";
import { restoreSpawn } from "../../../src/save/restore-spawn.ts";
import type { ProgressionDocument } from "../../../src/save/store.ts";
import type { GameplayCommandPayload } from "../../../src/sim/gameplay-contract.ts";
import { CampaignDriver } from "../../e2e/campaign-driver.ts";
import { followerRoute, nearestDrivableLane } from "../../../src/sim/vehicles/follower.ts";
import { pathPoint, projectOnPath } from "../../../src/sim/roads.ts";
import { observedVehicleBoxes, type Point } from "../../e2e/gameplay-driver.ts";

export const NEUTRAL: SimInput = Object.freeze({ throttle: 0, steer: 0, brake: 0, actions: 0 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
const mission = (id: string) => {
  const value = MISSIONS.find(entry => entry.id === id);
  if (!value) throw new Error(`Missing mission ${id}`);
  return value;
};
export function stepOf<T extends string>(missionId: string, stepId: string, type: T) {
  const value = mission(missionId).steps.find(entry => entry.id === stepId);
  if (!value || value.type !== type) throw new Error(`Missing ${type} step ${missionId}:${stepId}`);
  return value as Extract<typeof value, { type: T }>;
}

/**
 * The durable progression a player has after finishing Hot Desk and Spill, as the save panel
 * stores it. Starting a wave-3 mission from it is the same path as loading a slot in the game.
 */
export function savedAfterSpill(world: World, systems: readonly SimSystem[], spawn: { x: number; z: number; heading: number }): ProgressionDocument {
  const fresh = step(world, createInitialState(world, 1, ["p1"], spawn), { p1: { ...NEUTRAL } }, [], systems);
  const base = captureProgression(fresh, "p1") as Record<string, Record<string, unknown>>;
  const wallet = base.wallet!, player = base.player!;
  return validateSavedProgression({
    ...base,
    wallet: { ...wallet, cashCents: (wallet.cashCents as number) + 50_000 + 75_000, ownedItemIds: ["vendor:fidi-desk", "app:bot-bounty", "activity:bounty-board"] },
    missions: { completedIds: ["hot-desk", "spill"], rewardedIds: ["hot-desk:moved-in", "spill:paid"] },
    player: { ...player, startupKitId: STARTUP_KITS[0]!.id, safehouseId: "fidi-desk" },
  } as ProgressionDocument);
}

/** The page's own restore (src/main.ts): fresh world at the safehouse, then the next campaign start. */
export function restoredState(world: World, systems: readonly SimSystem[], data: ProgressionDocument, fallback: { x: number; z: number; heading: number }): SimState {
  const clean = validateSavedProgression(data), player = clean.player as { safehouseId: string };
  const site = DEFAULT_CATALOG.sites.find(value => value.id === player.safehouseId);
  const spawn = site ? restoreSpawn(world, site) : fallback;
  const fresh = step(world, createInitialState(world, 1, ["p1"], spawn), { p1: { ...NEUTRAL } }, [], systems);
  return restoreProgression(fresh, clean, "p1");
}

export class Wave3Driver extends CampaignDriver {
  /** Commands this plan issued, exactly as the page's dispatcher records them. */
  readonly commands: SimEvent[] = [];
  /** Planner diagnostics, printed with a failure; never fed to the game. */
  readonly trace: string[] = [];
  private sequence: number;
  private budget: number;
  constructor(world: World, state: SimState, playerId: string, systems: readonly SimSystem[], options: { sequence?: number; budget?: number } = {}) {
    super(world, state, playerId, systems as SimSystem[]);
    this.sequence = options.sequence ?? 1;
    this.budget = options.budget ?? 40_000;
  }
  override input(input: SimInput): void {
    if (this.frames.length >= this.budget) throw new Error("Wave-3 input budget exhausted");
    this.stepWith(input, []);
  }
  /** One recorded UI command applied on the next tick, as createGameplayDispatcher emits it. */
  command(payload: Omit<GameplayCommandPayload, "sequence">, input: SimInput = { ...NEUTRAL, brake: 1 }): void {
    const event: SimEvent = { tick: this.state.tick + 1, kind: "gameplay.command", playerId: this.playerId, payload: { ...payload, sequence: this.sequence++ } };
    this.commands.push(event);
    this.stepWith(input, [event]);
  }
  private stepWith(input: SimInput, events: SimEvent[]): void {
    const frame = { [this.playerId]: input };
    this.frames.push(frame);
    this.previousState = this.state;
    this.state = step(this.world, this.state, frame, events, this.systems);
    const clearance = this.state.ext.dodge as { contacts?: number; failures?: number } | undefined;
    if ((clearance?.contacts ?? 0) !== 0 || (clearance?.failures ?? 0) !== 0) {
      throw new Error(`Unsafe physical step at tick ${this.state.tick}: ${JSON.stringify(clearance)}`);
    }
  }
  override complete(): boolean { return false; }
  missionId(): string { return this.progress.missionId; }
  status(): string { return this.progress.status; }
  bound(alias: string): string {
    return missionActorBindings(this.state, this.missionId(), this.playerId)[alias] ?? `mission:${this.missionId()}:${alias}`;
  }
  /** Fill the tank at the nearest fresh source that can actually be reached on foot. */
  override refill(): void {
    const sources = [...this.world.gameplay?.refills ?? []]
      .filter(value => value.kind === "hydrant" || value.kind === "fountain")
      .sort((a, b) => distance(a, this.body) - distance(b, this.body)).slice(0, 4);
    for (const source of sources) {
      for (const reach of [.6, .9]) {
        try { this.walkTo(source, source.radius * reach, 2400); }
        catch (error) { this.trace.push(`refill ${source.id} at ${reach}: ${(error as Error).message.slice(0, 80)}`); continue; }
        this.hold(200, Action.interact);
        if (this.water() >= 8 - .001) return;
      }
    }
    throw new Error(`No reachable fresh-water refill near ${JSON.stringify(this.body)}; ${this.trace.slice(-4).join("; ")}`);
  }
  water(): number { return this.state.ext.combat?.players[this.playerId]?.water ?? 0; }
  /** Drive the player's own car to an authored place, re-entering it first when on foot. */
  travelTo(target: Point, stop: number, options: { maxSpeed?: number; walkIfStuck?: boolean } = {}): void {
    if (this.state.players[this.playerId]!.mode === "foot") this.inCar();
    const speed = options.maxSpeed ?? 11, from = { x: this.body.x, z: this.body.z };
    const dx = target.x - from.x, dz = target.z - from.z, length = Math.hypot(dx, dz) || 1;
    const via = (side: number) => ({ x: (from.x + target.x) / 2 - dz / length * side, z: (from.z + target.z) / 2 + dx / length * side });
    // Traffic is deterministic, so a jam met on one plan is avoided by rewinding and trying another:
    // only the plan that arrives stays in the recorded inputs the page replays.
    const plans: (() => boolean)[] = [
      () => this.cruise(target, stop, speed, 1200),
      () => { this.hold(300); return this.cruise(target, stop, speed, 1200); },
      () => this.cruise(via(250), 40, speed, 1200) && this.cruise(target, stop, speed, 1200),
      () => this.cruise(via(-250), 40, speed, 1200) && this.cruise(target, stop, speed, 1200),
      () => { this.hold(900); return this.cruise(target, stop, speed, 1200); },
      // Leave the neighbourhood another way first when every direct line meets the same jam.
      ...[[0, -300], [300, 0], [0, 300], [-300, 0]].map(([ox, oz]) => () =>
        this.cruise({ x: from.x + ox!, z: from.z + oz! }, 40, speed, 1200) && this.cruise(target, stop, speed, 1200)),
    ];
    for (const [index, plan] of plans.entries()) {
      const mark = this.mark();
      let arrived = false;
      try { arrived = plan(); } catch (error) { this.trace.push(`plan ${index}: ${(error as Error).message.slice(0, 120)}`); }
      if (arrived) return;
      this.trace.push(`plan ${index} stalled at ${this.body.x.toFixed(0)},${this.body.z.toFixed(0)}`);
      if (index < plans.length - 1 || !options.walkIfStuck) this.rewind(mark);
    }
    if (!options.walkIfStuck) throw new Error(`Every driving plan stalled toward ${JSON.stringify(target)}; ${this.trace.slice(-10).join("; ")}`);
    // Gridlocked with no safe pass on any plan: leave the car at the queue and walk the road route.
    this.trace.push(`walking from ${this.body.x.toFixed(0)},${this.body.z.toFixed(0)}`);
    this.walkRoute(target, stop);
  }
  /** A planning checkpoint: everything needed to discard the inputs planned after it. */
  mark(): { state: SimState; previousState: SimState; frames: number; commands: number; sequence: number } {
    return { state: this.state, previousState: this.previousState, frames: this.frames.length, commands: this.commands.length, sequence: this.sequence };
  }
  rewind(mark: ReturnType<Wave3Driver["mark"]>): void {
    this.state = mark.state; this.previousState = mark.previousState;
    this.frames.length = mark.frames; this.commands.length = mark.commands; this.sequence = mark.sequence;
  }
  /** Walk to a far point in legs along the drivable route, each leg planned around observed traffic. */
  walkRoute(target: Point, stop: number): void {
    this.onFoot();
    // The street route from where the walker stands, not from the parked car.
    const route = followerRoute(this.world, this.body, target).map(([x, z]) => ({ x, z }));
    let last = { x: this.body.x, z: this.body.z };
    for (const point of route) {
      if (distance(point, last) < 40 || distance(point, target) < stop + 20) continue;
      this.walkTo(point, 4, 6000);
      last = point;
    }
    // The last leg ends anywhere inside the authored radius: a junction ringed by stopped
    // traffic has no route to its exact centre.
    for (const reach of [Math.max(3, stop - 5), stop - 2, stop]) {
      try { this.walkTo(target, reach, 6000); return; }
      catch (error) { this.trace.push(`final leg at ${reach} m: ${(error as Error).message.slice(0, 80)}`); }
    }
    throw new Error(`Could not walk the last leg to ${JSON.stringify(target)}; ${this.trace.slice(-4).join("; ")}`);
  }
  /**
   * The route follower plus what a driver sees through the windscreen: brake for any body in the
   * lane ahead within stopping distance, and hold the route state while waiting so a queue is
   * never mistaken for a wall.
   */
  cruise(target: Point, stopDistance: number, maxSpeed: number, stallTicks = 3600, maxTicks = 36_000): boolean {
    let follower = createFollowerState(this.body);
    let checkpoint = { x: this.body.x, z: this.body.z, tick: this.state.tick };
    let waited = 0;
    for (let i = 0; i < maxTicks; i++) {
      const next = stepVehicleFollower(this.world, this.body, follower, { kind: "pursue", target, stopDistance, maxSpeed });
      if (next.status === "arrived") { this.hold(30); return true; }
      if (next.status === "no-route") throw new Error(`No drivable route toward ${JSON.stringify(target)}`);
      const blocker = next.status === "reversing" ? undefined : this.blockerAhead();
      if (blocker?.startsWith("creep")) {
        // A person ahead but not close: roll at walking pace so they can step aside, as they do.
        const car = this.state.players[this.playerId]!.car;
        this.input({ throttle: car.speed < 1.2 ? .35 : 0, steer: next.input.steer, brake: car.speed > 1.8 ? 1 : 0, actions: 0 });
        waited++;
      } else if (blocker) {
        this.input({ throttle: 0, steer: next.input.steer, brake: 1, actions: 0 });
        waited++;
        // A queue that has not moved for five seconds is a jam: pass it where the road has room.
        if (waited % 300 === 0 && waited > 0 && this.overtake()) { follower = createFollowerState(this.body); waited = 0; }
      } else { waited = 0; follower = next.state; this.input(next.input); }
      if (Math.hypot(this.body.x - checkpoint.x, this.body.z - checkpoint.z) > 3) checkpoint = { x: this.body.x, z: this.body.z, tick: this.state.tick };
      else if (this.state.tick - checkpoint.tick > stallTicks) { this.trace.push(`stalled${blocker ? ` behind ${blocker}` : ""}`); this.hold(30); return false; }
    }
    throw new Error(`Driving timed out at ${JSON.stringify(this.body)} toward ${JSON.stringify(target)}`);
  }
  /** Bodies a car must keep clear of: other vehicles as boxes' outer circles, every agent as itself. */
  private obstacles(): { id: string; x: number; z: number; r: number; speed: number; vehicle: boolean }[] {
    const car = this.state.players[this.playerId]!.car;
    return [
      ...observedVehicleBoxes(this.state).filter(box => box.x !== car.x || box.z !== car.z)
        .map((box, index) => ({ id: `vehicle${index}`, x: box.x, z: box.z, r: Math.max(box.hl, box.hw), speed: 0, vehicle: true })),
      ...(this.state.ext.agents?.list ?? []).filter(actor => actor.kind !== "robotaxi")
        .map(actor => ({ id: actor.kind, x: actor.x, z: actor.z, r: actor.radius ?? AGENT_SPEC[actor.kind].radius, speed: Math.abs(actor.speed ?? 0), vehicle: false })),
    ];
  }
  /**
   * Pass a stopped queue: pick a side offset where a swept car-width corridor alongside the whole
   * queue is clear of buildings, walls and every body, then steer through it at walking pace,
   * braking for anyone who steps in. Returns false when no side has room (keep waiting).
   */
  overtake(): boolean {
    const car = this.state.players[this.playerId]!.car;
    const fx = dsin(car.heading), fz = -dcos(car.heading), rx = -fz, rz = fx;
    const vehicles = observedVehicleBoxes(this.state).filter(box => box.x !== car.x || box.z !== car.z);
    const robotaxiSpeed = new Map((this.state.ext.agents?.list ?? []).filter(actor => actor.kind === "robotaxi").map(actor => [`${actor.x},${actor.z}`, Math.abs(actor.speed ?? 0)]));
    const people = this.obstacles().filter(body => !body.vehicle);
    // A car body centred at p overlaps a vehicle box (both treated as aligned with that box).
    const hitsVehicle = (p: Point) => vehicles.some(box => {
      const bx = dsin(box.heading), bz = -dcos(box.heading), dx = p.x - box.x, dz = p.z - box.z;
      return Math.abs(dx * bx + dz * bz) < box.hl + CAR.halfLength + .1 && Math.abs(-dx * bz + dz * bx) < box.hw + CAR.halfWidth + .15;
    });
    // The queue: stopped vehicles in this lane up to 45 m ahead.
    let end = 0;
    for (const box of vehicles) {
      if ((robotaxiSpeed.get(`${box.x},${box.z}`) ?? 0) > .2) continue;
      const ahead = (box.x - car.x) * fx + (box.z - car.z) * fz, side = Math.abs((box.x - car.x) * rx + (box.z - car.z) * rz);
      if (ahead > 0 && ahead < 45 && side < 2.5) end = Math.max(end, ahead + box.hl);
    }
    if (end === 0) return false;
    const length = end + 7;
    // Stay on the carriageway: the pass uses the road's own width, never the sidewalk.
    const lane = this.world.roads ? nearestDrivableLane(this.world.roads, car, car.heading) : null;
    if (!lane) return false;
    const road = this.world.roads!.edges[lane.edge]!, kerb = road.widthM / 2 - CAR.halfWidth - .25;
    const fromCentre = (p: Point) => {
      // Lateral position from the road's centre line, positive to this car's right.
      const at = projectOnPath(road.center, p.x, p.z), c = pathPoint(road.center, at.s), sign = c.tx * fx + c.tz * fz < 0 ? -1 : 1;
      return sign * ((p.x - c.x) * -c.tz + (p.z - c.z) * c.tx);
    };
    const carSide = fromCentre(car);
    // On the carriageway first; past a gridlock, a kerb-side pass only where no one stands nearby.
    const candidates = [
      ...[-kerb - carSide, kerb - carSide].map(offset => ({ offset, road: true })),
      ...[-3, 3, -3.6, 3.6, -4.2, 4.2].map(offset => ({ offset, road: false })),
    ];
    for (const { offset, road: onRoad } of candidates) {
      if (Math.abs(offset) < 1.8) continue;
      const at = (along: number, lateral: number) => ({ x: car.x + fx * along + rx * lateral, z: car.z + fz * along + rz * lateral });
      let clear = true, reason = "";
      for (let along = 2; along <= length && clear; along += 1) {
        const lateral = offset * Math.min(1, along / 3.5);
        const p = at(along, lateral);
        if (onRoad && Math.abs(fromCentre(p)) > kerb + .05 && along >= 3.5) { clear = false; reason = "kerb"; }
        else if (circleBlocked(this.world, p.x, p.z, CAR.halfWidth + .3)) { clear = false; reason = "building"; }
        else if (hitsVehicle(p)) { clear = false; reason = "vehicle"; }
        for (const body of people) {
          const living = !body.id.toLowerCase().includes("robot") && !body.id.toLowerCase().includes("bot");
          if (clear && Math.hypot(body.x - p.x, body.z - p.z) < body.r + CAR.halfWidth + (living ? onRoad ? 1.2 : 2.5 : 1)) { clear = false; reason = body.id; }
        }
        if (!clear) this.trace.push(`overtake ${offset.toFixed(1)} ${onRoad ? "road" : "kerb"}: ${reason} at ${along} m`);
      }
      const goal = at(length, 0), side = at(length / 2, offset);
      if (!clear || segmentCrossesWall(this.world.walls, car.x, car.z, side.x, side.z) || segmentCrossesWall(this.world.walls, side.x, side.z, goal.x, goal.z)) continue;
      for (const waypoint of [at(3.5, offset), at(end, offset), goal]) {
        for (let tick = 0; tick < 900 && Math.hypot(this.body.x - waypoint.x, this.body.z - waypoint.z) > 1.5; tick++) {
          const body = this.state.players[this.playerId]!.car;
          const error = wrapAngle(datan2(waypoint.x - body.x, -(waypoint.z - body.z)) - body.heading);
          const person = this.obstacles().some(other => !other.vehicle && Math.hypot(other.x - body.x, other.z - body.z) < other.r + 4);
          this.input({ throttle: person ? 0 : body.speed < 3 ? .5 : 0, steer: clamp(error / (1.2 * DT * 10), -1, 1), brake: person ? 1 : 0, actions: 0 });
        }
      }
      return true;
    }
    return false;
  }
  /** The nearest body in this car's lane within stopping distance, described for diagnostics. */
  blockerAhead(): string | undefined {
    const car = this.state.players[this.playerId]!.car;
    const fx = dsin(car.heading), fz = -dcos(car.heading), rx = -fz, rz = fx;
    const reach = CAR.halfLength + 3 + car.speed * car.speed / 8 + Math.max(0, car.speed) * .6;
    const bodies: { id: string; x: number; z: number; r: number }[] = [
      ...observedVehicleBoxes(this.state).filter(box => box.x !== car.x || box.z !== car.z).map((box, index) => ({ id: `vehicle${index}`, x: box.x, z: box.z, r: Math.max(box.hl, box.hw) })),
      ...(this.state.ext.agents?.list ?? []).filter(actor => actor.kind !== "robotaxi").map(actor => ({ id: `${actor.kind}`, x: actor.x, z: actor.z, r: actor.radius ?? AGENT_SPEC[actor.kind].radius })),
    ];
    const vehicleIds = new Set(bodies.filter(body => body.id.startsWith("vehicle")).map(body => body.id));
    let creep: string | undefined;
    for (const body of bodies) {
      const dx = body.x - car.x, dz = body.z - car.z, ahead = dx * fx + dz * fz, side = Math.abs(dx * rx + dz * rz);
      if (ahead > 0 && ahead - body.r < reach && side < CAR.halfWidth + body.r + .5) {
        if (!vehicleIds.has(body.id) && ahead - body.r > CAR.halfLength + 2.5) creep = `creep behind ${body.id} ${ahead.toFixed(1)} m ahead`;
        else return `${body.id} ${ahead.toFixed(1)} m ahead`;
      }
    }
    return creep;
  }
  /** Hold Watch on one robot, turning and walking after it so it stays in view, until `done`. */
  watchActor(alias: string, done: () => boolean, limit = 1800): void {
    const id = this.bound(alias);
    if (distance(this.body, this.actor(id)) > 20) this.approachActor(id);
    for (let i = 0; i < limit && !done(); i++) {
      const body = this.body, actor = this.actor(id), gap = distance(body, actor);
      const error = wrapAngle(datan2(actor.x - body.x, -(actor.z - body.z)) - body.heading);
      this.input({ throttle: gap > 12 && Math.abs(error) < .3 ? 1 : 0, steer: clamp(error / (3 * DT), -1, 1), brake: 0, actions: Action.watch });
      if (gap > 26) this.approachActor(id);
    }
    if (!done()) throw new Error(`Watching ${alias} did not complete at ${this.phase()}`);
  }
  scanUntil(alias: string, done: () => boolean, limit = 2400): void {
    const id = this.bound(alias);
    this.approachActor(id);
    for (let i = 0; i < limit && !done(); i++) {
      if (distance(this.body, this.actor(id)) > 9) this.approachActor(id);
      // Bot Check reads while held on one robot, then starts a fresh reading.
      this.aim(this.actor(id), Action.scan);
    }
    if (!done()) throw new Error(`Scanning ${alias} did not produce the expected result at ${this.phase()}`);
  }
  meltUntil(alias: string, done: () => boolean, limit = 3600): void {
    this.meltActor(this.bound(alias), done, limit, alias);
  }
  /** Rust one robot with real water from a 3-5 m stand-off, refilling as needed, until `done`. */
  meltActor(id: string, done: () => boolean, limit = 3600, alias = id): void {
    for (let i = 0; i < limit && !done(); i++) {
      const phase = this.state.ext.combat?.targets[id]?.phase;
      if (phase && phase !== "active") { this.hold(1); continue; }
      if (this.water() < .08) this.refill();
      const gap = distance(this.body, this.actor(id));
      if (gap > 12) this.approachActor(id);
      // Stand 3-5 m off and aim the stream down at the body; point-blank sprays pass overhead.
      const body = this.body, actor = this.actor(id);
      const error = wrapAngle(datan2(actor.x - body.x, -(actor.z - body.z)) - body.heading);
      this.input({ throttle: gap > 5 && Math.abs(error) < .4 ? 1 : gap < 2.5 ? -1 : 0, steer: clamp(error / (3 * DT), -1, 1), brake: 0,
        actions: Math.abs(error) < .25 ? Action.fire : 0, aimPitch: gap < 4 ? -.25 : -.12 });
      if (i % 120 === 0) this.trace.push(`melt t${this.state.tick} d${distance(this.body, this.actor(id)).toFixed(1)} w${this.water().toFixed(2)} rust${(this.state.ext.combat?.targets[id]?.rust ?? 0).toFixed(2)} ${this.state.ext.combat?.targets[id]?.phase}`);
    }
    if (!done()) throw new Error(`Water did not melt ${alias} at ${this.phase()}`);
  }

  // ---- Launch Day -------------------------------------------------------------------------
  /** From the restored safehouse: drive to Washington Square and watch, scan and meet the false positive. */
  launchDayToFalsePositive(): void {
    if (this.missionId() !== "launch-day") throw new Error(`Expected Launch Day, found ${this.missionId()}`);
    if (this.phase() === "start") {
      const start = stepOf("launch-day", "start", "trigger");
      if (start.event.kind !== "enterArea") throw new Error("Launch Day entry is not an area");
      this.travelTo(missionPlace(start.event.place), 15, { walkIfStuck: true });
      this.hold(4);
    }
    if (!["watch", "scan", "false-positive"].includes(this.phase())) throw new Error(`Washington Square entry did not stage Launch Day: ${this.phase()}`);
    this.onFoot();
    if (this.water() < 8) this.refill();
    if (this.phase() === "watch") this.watchActor("suspect", () => this.phase() !== "watch");
    if (this.phase() === "scan") this.scanUntil("suspect", () => this.phase() !== "scan");
    if (this.phase() !== "false-positive") throw new Error(`Suspect scan did not reach the false positive: ${this.phase()}`);
    this.scanUntil("courier", () => this.progress.observed?.falsePositives.includes(this.bound("courier")) ?? false);
  }
  /** After the acknowledgement: compare the courier, then rust only the confirmed suspect. */
  launchDayToPivot(): void {
    if (this.phase() !== "compare") throw new Error(`False-positive acknowledgement did not open compare: ${this.phase()}`);
    this.watchActor("courier", () => this.phase() !== "compare");
    if (this.phase() !== "melt") throw new Error(`Comparing the courier did not open the melt: ${this.phase()}`);
    this.meltUntil("suspect", () => this.phase() !== "melt");
    if (this.phase() !== "pivot") throw new Error(`Melting the suspect did not reach the pivot: ${this.phase()}`);
    if ((this.state.ext.combat?.targets[this.bound("courier")]?.rust ?? 0) !== 0) throw new Error("The good courier was rusted");
  }
  // ---- Demo'd Correctly ------------------------------------------------------------------
  /** Drive to the Embarcadero billboard, then on to Pier 70 inside the authored 420 s. */
  demoedToParking(): void {
    if (this.missionId() !== "demoed-correctly") throw new Error(`Expected Demo'd Correctly, found ${this.missionId()}`);
    if (this.phase() === "start") {
      const start = stepOf("demoed-correctly", "start", "trigger");
      if (start.event.kind !== "enterArea") throw new Error("Demo'd Correctly entry is not an area");
      this.travelTo(missionPlace(start.event.place), 15);
      this.hold(4);
    }
    if (this.phase() !== "drive") throw new Error(`The billboard pass did not open the Pier 70 drive: ${this.phase()}`);
    this.travelTo(missionPlace(stepOf("demoed-correctly", "drive", "goto").target), 18);
    this.hold(4);
    if (this.phase() !== "park") throw new Error(`Arriving at Pier 70 did not open parking: ${this.phase()}`);
  }
  /** Find a signed legal bay, park inside it with the whole hull, settle, then press Interact. */
  parkLegally(): void {
    for (let attempt = 0; attempt < 4 && this.phase() === "park"; attempt++) {
      const bay = this.legalBay();
      if (!bay) throw new Error("No legal bay is free near Pier 70");
      this.trace.push(`parking in ${bay.id}`);
      this.parkIn(bay);
      for (let i = 0; i < 150 && this.state.players[this.playerId]!.car.speed !== 0; i++) this.hold(1);
      this.hold(125);
      this.hold(1, Action.interact);
      this.hold(2);
    }
    if (this.phase() !== "pitch-philosopher") throw new Error(`Physical parking did not open the pitch: ${this.phase()}; ${this.trace.slice(-6).join("; ")}`);
  }
  /** The legal bays the mission offers right now, nearest first, skipping any with a body in them. */
  legalBay(): ParkingBay | undefined {
    const parking = buildMissionParkingWorld({ world: this.world, state: this.state, previous: this.state, inputs: {}, events: [] }, this.world.parking?.rules ?? [], this.world.streetCleaning?.rules ?? []);
    const target = parking.targets.find(value => value.missionId === this.missionId() && value.stepId === this.phase());
    const vehicle = parking.vehicles.find(value => value.playerId === this.playerId);
    if (!target || !vehicle) return undefined;
    const car = this.state.players[this.playerId]!.car;
    const occupied = (bay: ParkingBay) => [...observedVehicleBoxes(this.state).filter(box => box.x !== car.x || box.z !== car.z), ...this.obstacles()]
      .some(body => Math.hypot(body.x - bay.x, body.z - bay.z) < bay.halfLength + 3);
    return parking.bays.filter(bay => target.bayIds.includes(bay.id) && !occupied(bay) && checkParking(
      { ...vehicle, x: bay.x, y: bay.y, z: bay.z, heading: bay.heading, speed: 0, lateral: 0 }, bay, { ...parking, requests: [] }, this.state.tick, target.expectedStayMinutes,
    ).legal).sort((a, b) => distance(a, car) - distance(b, car) || (a.id < b.id ? -1 : 1))[0];
  }
  /** Line up behind the bay, then pursue its centre line at walking pace and stop on its centre. */
  parkIn(bay: ParkingBay): void {
    const car = () => this.state.players[this.playerId]!.car;
    // Approach in the bay's own direction of travel when the car already faces that way.
    const flip = Math.abs(wrapAngle(car().heading - bay.heading)) > Math.PI / 2 ? Math.PI : 0;
    const heading = wrapAngle(bay.heading + flip), bx = dsin(heading), bz = -dcos(heading);
    const behind = { x: bay.x - bx * 16, z: bay.z - bz * 16 };
    if (distance(car(), behind) > 6 && this.along(bay, heading) < -10) this.cruise(behind, 4, 6);
    for (let tick = 0; tick < 1800; tick++) {
      const c = car(), along = (c.x - bay.x) * bx + (c.z - bay.z) * bz;
      if (along > -.15 && Math.abs(c.speed) < .05) return;
      const look = Math.max(3, Math.min(6, -along)), aimX = bay.x + bx * (along + look), aimZ = bay.z + bz * (along + look);
      const error = wrapAngle(datan2(aimX - c.x, -(aimZ - c.z)) - c.heading);
      const want = Math.max(0, Math.min(2.2, -along * .6));
      const blocked = this.blockerAhead() !== undefined && !this.blockerAhead()!.startsWith("creep");
      this.input({ throttle: !blocked && c.speed < want ? .4 : 0, steer: clamp(error / .35, -1, 1), brake: blocked || c.speed > want + .3 || along > -.15 ? 1 : 0, actions: 0 });
    }
  }
  private along(bay: ParkingBay, heading: number): number {
    const c = this.state.players[this.playerId]!.car;
    return (c.x - bay.x) * dsin(heading) + (c.z - bay.z) * -dcos(heading);
  }
  /** Watch each demo robot, then rust only the bad one, keeping both good robots and the partners dry. */
  demoedPresent(): void {
    if (this.phase() !== "present") throw new Error(`The demo floor did not open: ${this.phase()}`);
    this.onFoot();
    const observed = () => this.progress.observed?.watched ?? [];
    for (const alias of ["demoGoodA", "demoGoodB", "demoBad"]) {
      const id = this.bound(alias);
      this.watchActor(alias, () => observed().includes(id) || this.phase() !== "present", 1200);
    }
    this.meltUntil("demoBad", () => this.phase() !== "present");
  }
  /** Let an attempt run out its clock without acting, so the authored retry opens. */
  waitForRetry(limit = 9000): void {
    for (let i = 0; i < limit && this.status() !== "retry"; i++) this.hold(1);
    if (this.status() !== "retry") throw new Error(`Attempt did not fail into a retry: ${this.phase()}`);
    for (let i = 0; i < limit && this.state.tick < this.progress.deadlineTick; i++) this.hold(1);
  }
}
