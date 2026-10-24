// Demo Day through real controls (plans in Node against observed state; every change goes
// through the production step). Mirrors campaign-driver.ts.
import { MISSIONS } from "../../src/content/catalog.ts";
import { Action, DT, clamp, datan2, wrapAngle, type SimInput } from "../../src/sim/index.ts";
import { dirIndex, pathPoint, type Dir } from "../../src/sim/roads.ts";
import { nearestSidewalkNode, shortestSidewalkRoute } from "../../src/sim/agents/navigation.ts";
import { runtimeCombatActors } from "../../src/sim/agents/runtime.ts";
import { missionPlace } from "../../src/sim/missions/system.ts";
import { TURNTABLES } from "../../src/sim/missions/mechanics/bell.ts";
import { GameplayDriver, type Point } from "./gameplay-driver.ts";

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
export class DemoDayDriver extends GameplayDriver {
  override input(input: SimInput): void {
    if (this.frames.length >= 70_000) throw new Error("Demo Day input budget exhausted");
    super.input(input);
  }
  /** Test hook: called once with the state when the mission is staged. */
  onStaged?: (state: import("../../src/sim/index.ts").SimState) => void;
  get progress() { return this.state.ext.missions!.players[this.playerId]!; }
  phase(): string { return this.progress.stepId; }
  alias(alias: string): string {
    const bindings = this.state.ext.robots?.missionBindings ?? {};
    return bindings[`${this.playerId}:demo-day:${alias}`] ?? bindings[`demo-day:${alias}`] ?? `mission:demo-day:${alias}`;
  }
  actor(alias: string) {
    const id = this.alias(alias), actor = runtimeCombatActors(this.state).find(candidate => candidate.id === id);
    if (!actor) throw new Error(`Demo Day actor ${alias} (${id}) is missing at ${this.phase()}`);
    return actor;
  }
  /** Lane waypoints from the car to `target` along the shortest drivable road route (planning only). */
  roadRoute(target: Point): Point[] {
    const roads = this.world.roads;
    if (!roads) return [target];
    const nearest = (p: Point) => roads.nodes.reduce((best, n) => distance(n, p) < distance(roads.nodes[best]!, p) ? n.index : best, 0);
    // Start from the nearest node ahead: the follower drives forward, it does not U-turn.
    const fx = Math.sin(this.body.heading), fz = -Math.cos(this.body.heading);
    const ahead = roads.nodes.filter(n => (n.x - this.body.x) * fx + (n.z - this.body.z) * fz > 8);
    const start = (ahead.length ? ahead : roads.nodes).reduce((best, n) => distance(n, this.body) < distance(best, this.body) ? n : best).index, goal = nearest(target);
    const out = new Map<number, { edge: number; dir: Dir; to: number; cost: number }[]>();
    for (const e of roads.edges) {
      if (!e.drivable) continue;
      for (const dir of [1, -1] as const) {
        if (e.laneCount[dirIndex(dir)] < 1) continue;
        const from = dir === 1 ? e.a : e.b, to = dir === 1 ? e.b : e.a;
        const list = out.get(from) ?? []; list.push({ edge: e.index, dir, to, cost: e.center.len }); out.set(from, list);
      }
    }
    const best = new Map<number, number>([[start, 0]]), via = new Map<number, { edge: number; dir: Dir; from: number }>();
    const open = [start];
    while (open.length) {
      open.sort((a, b) => best.get(b)! - best.get(a)! || b - a);
      const node = open.pop()!;
      if (node === goal) break;
      for (const step of out.get(node) ?? []) {
        const cost = best.get(node)! + step.cost;
        if (cost < (best.get(step.to) ?? Infinity)) { best.set(step.to, cost); via.set(step.to, { edge: step.edge, dir: step.dir, from: node }); open.push(step.to); }
      }
    }
    if (!best.has(goal)) throw new Error("No drivable road route");
    const edges: { edge: number; dir: Dir }[] = [];
    for (let node = goal; node !== start;) { const v = via.get(node)!; edges.unshift(v); node = v.from; }
    const points: Point[] = [];
    for (const { edge, dir } of edges) {
      const lanes = roads.edges[edge]!.lanePaths[dirIndex(dir)]!, lane = lanes[lanes.length - 1]!;
      for (let at = 0; at < lane.len; at += 12) { const p = pathPoint(lane, at); points.push({ x: p.x, z: p.z }); }
      const end = pathPoint(lane, lane.len); points.push({ x: end.x, z: end.z });
    }
    points.push(target);
    return points;
  }
  /** Walk to `target` along the sidewalk graph, hop by hop (crosswalks included). */
  walkRoute(target: Point, stopDistance: number): void {
    this.onFoot();
    const graph = this.world.sidewalks;
    if (graph) {
      const route = shortestSidewalkRoute(graph, nearestSidewalkNode(graph, this.body), nearestSidewalkNode(graph, target));
      // Sprint through the sidewalk nodes without stopping at each; fall back to the planner when blocked.
      for (const id of route?.nodeIds ?? []) {
        const node = graph.nodeById.get(id)!;
        if (distance(this.body, target) <= stopDistance + 10) break;
        let last = distance(this.body, node), stuck = 0;
        for (let tick = 0; tick < 1200 && distance(this.body, node) > 3; tick++) {
          const body = this.body, error = wrapAngle(datan2(node.x - body.x, -(node.z - body.z)) - body.heading);
          this.input({ throttle: Math.abs(error) < .65 ? 1 : 0, steer: clamp(error / (2.2 * DT), -1, 1), brake: 1, actions: 0 });
          const now = distance(this.body, node);
          stuck = now > last - .02 ? stuck + 1 : 0; last = now;
          if (stuck > 45) { this.walkTo(node, 2.5, 3000); break; }
        }
      }
    }
    this.walkTo(target, stopDistance, 6000);
  }
  /** Steer at a waypoint like a careful driver: slow for turns, never above 9 m/s. */
  steerTo(target: Point, stopDistance: number, maxTicks: number): void {
    let stalled = 0, backoffs = 0;
    for (let i = 0; i < maxTicks; i++) {
      const body = this.body, d = distance(body, target);
      if (d <= stopDistance) return;
      const error = wrapAngle(datan2(target.x - body.x, -(target.z - body.z)) - body.heading);
      // Inside the turning circle and beside it: the waypoint is passed.
      if (d <= stopDistance + 6 && Math.abs(error) > 1.1) return;
      stalled = Math.abs(body.speed) < .4 ? stalled + 1 : 0;
      if (stalled > 90 && backoffs >= 2) return; // Blocked twice: go round it via the next waypoint.
      if (stalled > 90) {
        backoffs++;
        // Nose against something (a queue, a kerb post): back off and try again.
        for (let k = 0; k < 50; k++) this.input({ throttle: -1, steer: clamp(-error * 2, -1, 1), brake: 0, actions: 0 });
        this.hold(10);
        stalled = 0;
        continue;
      }
      const want = Math.abs(error) > 0.9 ? 3 : Math.min(9, 2 + d);
      const speed = body.speed;
      this.input({ throttle: speed < want ? 1 : 0, steer: clamp(error * 2, -1, 1), brake: speed > want + 1.5 ? 1 : 0, actions: 0 });
    }
    throw new Error(`Steering timed out at ${JSON.stringify({ x: this.body.x, z: this.body.z })} toward ${JSON.stringify(target)}`);
  }
  driveRoute(target: Point, stopDistance: number): void {
    this.inCar();
    for (const point of this.roadRoute(target)) {
      if (distance(this.body, target) <= stopDistance) break;
      if (distance(this.body, point) < 6) continue;
      this.driveTo(point, 5, 1200);
    }
    this.steerTo(target, stopDistance, 1800);
    for (let i = 0; i < 180 && Math.abs(this.body.speed) > .2; i++) this.hold(1);
  }
  water(): number { return this.state.ext.combat?.players[this.playerId]?.water ?? 0; }
  refill(): void {
    const source = [...this.world.gameplay?.refills ?? []].filter(value => value.kind === "hydrant" || value.kind === "fountain")
      .sort((a, b) => distance(a, this.body) - distance(b, this.body))[0];
    if (!source) throw new Error("No fresh-water refill source");
    this.walkTo(source, source.radius * .6, 2400);
    this.hold(200, Action.interact);
    this.hold(1);
  }
  /** Spray `alias` until `done`, approaching and refilling as a player would. */
  sprayUntil(alias: string, done: () => boolean, budget = 3600): void {
    for (let tick = 0; tick < budget && !done(); tick++) {
      if (this.water() < .1) this.refill();
      const target = this.actor(alias);
      if (distance(this.body, target) > 7) { this.walkTo(target, 5, 1200); continue; }
      this.aim(target, Action.fire);
    }
    if (!done()) throw new Error(`Spraying ${alias} did not finish ${this.phase()}`);
  }
  play(): void {
    const mission = MISSIONS.find(value => value.id === "demo-day")!;
    const start = mission.steps[0]!;
    if (start.type !== "trigger" || start.event.kind !== "enterArea") throw new Error("Demo Day entry missing");
    if (this.phase() === "start") {
      this.walkRoute(missionPlace(start.event.place), 15);
      this.hold(6);
    }
    if (this.phase() !== "interrupt") throw new Error(`Plaza arrival did not stage Demo Day (${this.phase()})`);
    this.onStaged?.(this.state);
    this.onFoot();
    // Bad firmware sabotages only unobserved: wait 10 m off, looking away, then turn and spray.
    const pushing = () => (this.state.ext.combat?.attacks ?? []).some(a => a.kind === "forced-update" && a.attackerId === this.alias("pusher"));
    if (distance(this.body, this.actor("pusher")) > 16) this.walkTo(this.actor("pusher"), 14, 2400);
    for (let tick = 0; tick < 3000 && !pushing() && this.phase() === "interrupt"; tick++) {
      const pusher = this.actor("pusher");
      this.aim({ x: 2 * this.body.x - pusher.x, z: 2 * this.body.z - pusher.z }, 0);
    }
    if (!pushing()) throw new Error("The update pusher never began its channel");
    this.sprayUntil("pusher", () => this.phase() !== "interrupt", 900);
    if (this.phase() !== "melt") throw new Error(`Interrupt did not advance (${this.phase()})`);
    this.sprayUntil("sticker", () => this.phase() !== "melt");
    this.sprayUntil("pusher", () => this.phase() !== "melt-pusher");
    this.hold(4);
    if (this.phase() !== "corner") throw new Error(`Melts did not reach the duel (${this.phase()})`);
    // Five stars: go to the turntable the HUD marks and ring in.
    const table = TURNTABLES.reduce((best, t) => distance(t, this.body) < distance(best, this.body) ? t : best);
    this.walkRoute(table, 3);
    this.hold(10);
    this.input({ throttle: 0, steer: 0, brake: 1, actions: Action.interact });
    this.hold(2);
    if (this.phase() !== "bell") throw new Error(`Interact at the turntable did not start the duel (${this.phase()})`);
    // The HUD says "Listen" then "Your turn": ring on each beat of the pattern.
    for (let tick = 0; tick < 6000 && this.phase() === "bell" && this.progress.status === "active"; tick++) {
      const duel = this.state.ext.missions!.bell?.duels[this.playerId];
      const due = duel?.phase === "response" ? duel.responseTicks[duel.ringIndex] : undefined;
      this.input({ throttle: 0, steer: 0, brake: 1, actions: due === this.state.tick + 1 ? Action.interact : 0 });
    }
    this.hold(6);
    if (!this.progress.completedIds.includes("demo-day")) throw new Error(`Demo Day did not complete (${this.phase()}, ${this.progress.status})`);
  }
}
