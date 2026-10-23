// Input-only integration driver. Planning may inspect committed geometry and observed state;
// every change to a body, mission or wallet still goes through the production step function.
import {
  Action, DT, carBox, circleInBoxes, clamp, datan2, dodgeExtOf, segmentBlocked, segmentCrossesWall, circleBlocked, groundHeight,
  createGameSystems, createFollowerState, stepVehicleFollower, step, wrapAngle,
  type Box, type InputFrame, type SimInput, type SimState, type World,
} from "../../src/sim/index.ts";

export interface Point { x: number; z: number }
export class GameplayDriver {
  readonly frames: InputFrame[] = [];
  readonly systems = createGameSystems();
  readonly world: World;
  readonly playerId: string;
  state: SimState;
  /** Retain the immutable pre-step snapshot so a safety failure is a one-tick reproduction. */
  previousState: SimState;
  constructor(world: World, state: SimState, playerId = "p1") {
    this.world = world;
    this.state = state;
    this.previousState = state;
    this.playerId = playerId;
  }
  get body() {
    const player = this.state.players[this.playerId]!;
    return player.mode === "foot" ? player.foot! : player.car;
  }
  input(input: SimInput): void {
    const frame = { [this.playerId]: input };
    this.frames.push(frame);
    this.previousState = this.state;
    this.state = step(this.world, this.state, frame, [], this.systems);
    const clearance = dodgeExtOf(this.state);
    if (clearance.contacts !== 0 || clearance.failures !== 0) {
      throw new Error(`Unsafe physical step at tick ${this.state.tick}: ${JSON.stringify(clearance)}`);
    }
  }
  hold(ticks: number, actions = 0): void {
    for (let i = 0; i < ticks; i++) this.input({ throttle: 0, steer: 0, brake: 1, actions });
  }
  onFoot(): void {
    if (this.state.players[this.playerId]!.mode === "foot") return;
    for (let i = 0; i < 120 && Math.abs(this.body.speed) > .3; i++) this.hold(1);
    this.hold(1, Action.enterExit);
    if (this.state.players[this.playerId]!.mode !== "foot") throw new Error("No safe place to exit the car");
  }
  inCar(): void {
    const player = this.state.players[this.playerId]!;
    if (player.mode === "vehicle") return;
    this.walkTo(player.car, 2.8);
    this.hold(1, Action.enterExit);
    if (this.state.players[this.playerId]!.mode !== "vehicle") throw new Error("Could not enter the nearby car");
  }
  aim(target: Point, actions: number, ticks = 1): void {
    for (let i = 0; i < ticks; i++) {
      const body = this.body;
      const error = wrapAngle(datan2(target.x - body.x, -(target.z - body.z)) - body.heading);
      this.input({ throttle: 0, steer: clamp(error / (3 * DT), -1, 1), brake: 0, actions });
    }
  }
  driveTo(target: Point, stopDistance = 15, maxTicks = 7200): void {
    if (this.state.players[this.playerId]!.mode !== "vehicle") throw new Error("Driver needs the player's car");
    let follower = createFollowerState(this.body);
    for (let i = 0; i < maxTicks; i++) {
      const next = stepVehicleFollower(this.world, this.body, follower, { kind: "pursue", target, stopDistance, maxSpeed: 12 });
      follower = next.state;
      if (next.status === "arrived") return;
      this.input(next.input);
    }
    throw new Error(`Driving timed out at ${JSON.stringify(this.body)} toward ${JSON.stringify(target)}`);
  }
  walkTo(target: Point, stopDistance = 3, maxTicks = 15000): void {
    this.onFoot();
    const cars = Object.keys(this.state.players).sort().map(id => carBox(this.state.players[id]!.car));
    const route = walkingRoute(this.world, this.body, target, stopDistance, cars);
    let waypoint = 0;
    for (let i = 0; i < maxTicks; i++) {
      const body = this.body;
      if (Math.hypot(body.x - target.x, body.z - target.z) <= stopDistance) { this.hold(12); return; }
      while (waypoint < route.length - 1 && Math.hypot(body.x - route[waypoint]!.x, body.z - route[waypoint]!.z) < 1) waypoint++;
      const goal = route[waypoint]!;
      const error = wrapAngle(datan2(goal.x - body.x, -(goal.z - body.z)) - body.heading);
      this.input({ throttle: Math.abs(error) < .65 ? 1 : 0, steer: clamp(error / (2.2 * DT), -1, 1), brake: 1, actions: 0 });
    }
    throw new Error(`Walking timed out at ${JSON.stringify(this.body)} toward ${JSON.stringify(target)}`);
  }
}

/** Small bounded A* on committed ground geometry; this does not move any game body. */
function walkingRoute(world: World, start: Point, target: Point, stopDistance: number, cars: readonly Box[]): Point[] {
  const size = 2, padding = 80;
  const minX = Math.min(start.x, target.x) - padding, maxX = Math.max(start.x, target.x) + padding;
  const minZ = Math.min(start.z, target.z) - padding, maxZ = Math.max(start.z, target.z) + padding;
  interface Node { x: number; z: number; cost: number; score: number; parent?: Node }
  const key = (x: number, z: number) => `${x},${z}`;
  const root: Node = { x: 0, z: 0, cost: 0, score: Math.hypot(start.x - target.x, start.z - target.z) };
  const pending = [root], best = new Map<string, number>([[key(0, 0), 0]]), closed = new Set<string>();
  const point = (n: { x: number; z: number }): Point => ({ x: start.x + n.x * size, z: start.z + n.z * size });
  while (pending.length && closed.size < 100000) {
    pending.sort((a, b) => b.score - a.score || b.x - a.x || b.z - a.z);
    const current = pending.pop()!, currentKey = key(current.x, current.z);
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);
    const from = point(current);
    if (Math.hypot(from.x - target.x, from.z - target.z) <= stopDistance) {
      const route: Point[] = [];
      for (let n: Node | undefined = current; n; n = n.parent) route.push(point(n));
      return route.reverse();
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = current.x + dx!, z = current.z + dz!, id = key(x, z), to = point({ x, z });
      const cost = current.cost + Math.hypot(dx!, dz!) * size;
      if (closed.has(id) || cost >= (best.get(id) ?? Infinity) || to.x < minX || to.x > maxX || to.z < minZ || to.z > maxZ) continue;
      if (circleBlocked(world, to.x, to.z, .6) || segmentBlocked(world, from.x, from.z, to.x, to.z) ||
        circleInBoxes(to.x, to.z, .6, cars) || circleInBoxes((from.x + to.x) / 2, (from.z + to.z) / 2, .6, cars) ||
        segmentCrossesWall(world.walls, from.x, from.z, to.x, to.z) || Math.abs(groundHeight(world, from.x, from.z) - groundHeight(world, to.x, to.z)) > size) continue;
      best.set(id, cost);
      pending.push({ x, z, cost, score: cost + Math.hypot(to.x - target.x, to.z - target.z), parent: current });
    }
  }
  throw new Error(`No walkable route from ${JSON.stringify(start)} to ${JSON.stringify(target)}`);
}
