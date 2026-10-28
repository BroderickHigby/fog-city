// Closed-loop driver for Plain Words on Columbus Ave: walk the corridor, wash each rebranded board
// with real water, and rust the sign-spinners, re-planning from observed state every step.
import { Action, AGENT_SPEC, FOOT, circleBlocked, circleInBoxes, clamp, datan2, DT, groundHeight, segmentBlocked, segmentCrossesWall, wrapAngle,
  type Box, type SimSystem, type SimState, type World } from "../../../src/sim/index.ts";
import { agentsRuntimeOf, runtimeCombatActors } from "../../../src/sim/agents/runtime.ts";
import { PLAIN_WORDS_BOARDS, PLAIN_WORDS_ID } from "../../../src/sim/activities/plain-words.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { observedVehicleBoxes, walkingRoute, type Point } from "../../e2e/gameplay-driver.ts";
import { Wave3Driver } from "./wave3-campaign.ts";

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
const ACTIVITY = DEFAULT_CATALOG.activities.find(value => value.id === PLAIN_WORDS_ID);

export class PlainWordsDriver extends Wave3Driver {
  constructor(world: World, state: SimState, playerId: string, systems: readonly SimSystem[], options: { sequence?: number; budget?: number } = {}) {
    super(world, state, playerId, systems, { budget: 120_000, ...options });
  }
  get own() { return this.state.ext.activities!.players[this.playerId]!; }
  override input(input: Parameters<Wave3Driver["input"]>[0]): void {
    const wasActive = this.own?.activeActivityId === PLAIN_WORDS_ID;
    super.input(input);
    const own = this.own;
    if (wasActive && own.activeActivityId !== PLAIN_WORDS_ID && !own.completedIds.includes(PLAIN_WORDS_ID)) {
      throw new Error(`Plain Words ended without completion at tick ${this.state.tick}; ${this.trace.slice(-6).join("; ")}`);
    }
    if (own.activeActivityId === PLAIN_WORDS_ID && (this.state.tick - own.activityStartedTick) % 1800 === 0) {
      this.trace.push(`t+${(this.state.tick - own.activityStartedTick) / 60}s washed ${own.objectiveCount} rusted ${this.run?.rusted.length} cp ${own.checkpointIndex} rung ${this.run?.rung} rebrands ${this.run?.rebrands} water ${this.water().toFixed(1)} at ${this.body.x.toFixed(0)},${this.body.z.toFixed(0)}`);
    }
  }
  get run() { return this.own.plainWords; }
  /** Follow the ordinary A* path with bounded, physically checked lookahead. */
  override walkTo(target: Point, stopDistance = 3, maxTicks = 15000): void {
    this.onFoot();
    const bodies = (): Box[] => [
      ...observedVehicleBoxes(this.state),
      ...(this.state.ext.agents?.list ?? []).filter(actor => actor.kind !== "robotaxi").map(actor => ({ x: actor.x, z: actor.z, heading: 0,
        hl: actor.radius ?? AGENT_SPEC[actor.kind].radius, hw: actor.radius ?? AGENT_SPEC[actor.kind].radius })),
    ];
    const plan = () => walkingRoute(this.world, this.body, target, stopDistance, bodies());
    let route = plan(), waypoint = 0, replans = 0;
    let checkpoint = { x: this.body.x, z: this.body.z };
    const clear = (to: Point, boxes: Box[]): boolean => {
      const from = this.body, length = distance(from, to);
      if (segmentBlocked(this.world, from.x, from.z, to.x, to.z) || segmentCrossesWall(this.world.walls, from.x, from.z, to.x, to.z)) return false;
      const steps = Math.max(1, Math.ceil(length / .5));
      let previousHeight = groundHeight(this.world, from.x, from.z);
      for (let index = 1; index <= steps; index++) {
        const fraction = index / steps, x = from.x + (to.x - from.x) * fraction, z = from.z + (to.z - from.z) * fraction;
        const height = groundHeight(this.world, x, z);
        if (circleBlocked(this.world, x, z, .6) || circleInBoxes(x, z, .6, boxes) || Math.abs(height - previousHeight) > length / steps) return false;
        previousHeight = height;
      }
      return true;
    };
    for (let tick = 0; tick < maxTicks; tick++) {
      const body = this.body, remaining = distance(body, target);
      if (remaining <= stopDistance) { this.hold(12); return; }
      while (waypoint < route.length - 1 && distance(body, route[waypoint]!) < .5) waypoint++;
      // The path uses 2 m grid steps. Steering at every diagonal/corner while sprinting
      // wastes turns; advance only across a segment checked against the same obstacles.
      const boxes = bodies().filter(box => distance(body, box) < 24);
      for (let candidate = waypoint + 1; candidate < route.length && distance(body, route[candidate]!) <= 10; candidate++) {
        if (clear(route[candidate]!, boxes)) waypoint = candidate;
      }
      const goal = route[waypoint]!, goalGap = distance(body, goal);
      const error = wrapAngle(datan2(goal.x - body.x, -(goal.z - body.z)) - body.heading);
      // Four metres allow the actual 14 m/s² deceleration to settle before the stop
      // radius; jogging the last eight metres of every board leg wastes the clock.
      const sprint = remaining > stopDistance + 4 && goalGap > 2 && Math.abs(error) < .25;
      const turnRate = sprint ? FOOT.sprintTurnRate : FOOT.turnRate;
      this.input({ throttle: Math.abs(error) < .55 ? 1 : 0, steer: clamp(error / (turnRate * DT), -1, 1), brake: sprint ? 1 : 0, actions: 0 });
      if ((tick + 1) % 120 === 0) {
        if (distance(this.body, checkpoint) < .5) {
          if (replans >= 4) throw new Error(`Plain Words walking made no progress after four consecutive replans at ${JSON.stringify(this.body)} toward ${JSON.stringify(target)}`);
          route = plan(); waypoint = 0; replans++;
        } else replans = 0;
        checkpoint = { x: this.body.x, z: this.body.z };
      }
    }
    throw new Error(`Plain Words walking timed out at ${JSON.stringify(this.body)} toward ${JSON.stringify(target)}`);
  }
  /** Walk to the Broadway end of the corridor, inside the start marker. */
  toStart(): void {
    if (!ACTIVITY) throw new Error("Plain Words is not offered");
    this.walkRoute(ACTIVITY, ACTIVITY.radius - 3);
  }
  /** The run from start to payout; `start` sends the recorded activity-start command. */
  play(start: () => void): void {
    start();
    if (this.own.activeActivityId !== PLAIN_WORDS_ID) throw new Error("Plain Words did not start at its marker");
    // Let the ordinary scene request stage its actual robots on the next simulation tick.
    this.hold(1);
    for (let move = 0; move < 200 && this.own.activeActivityId === PLAIN_WORDS_ID; move++) {
      if (this.late() && this.standingSpinners().length) { this.rustNearbySpinners(2000); continue; }
      // Qualification is distinct. Rewashing a rebranded qualified board cannot advance it.
      const board = PLAIN_WORDS_BOARDS.filter(value => this.run?.boards.some(shown => shown.id === value.id && !shown.qualified))
        .sort((a, b) => distance(a, this.body) - distance(b, this.body))[0];
      if (board) this.wash(board);
      else if (this.standingSpinners().length) this.rustNearbySpinners(2000);
      else this.hold(1); // Real seizure/collapse may still be advancing to its measured heap.
    }
    if (this.own.activeActivityId === PLAIN_WORDS_ID || !this.own.completedIds.includes(PLAIN_WORDS_ID)) {
      throw new Error(`Plain Words did not finish: ${JSON.stringify({ count: this.own.objectiveCount, rusted: this.run?.rusted.length })}; ${this.trace.slice(-6).join("; ")}`);
    }
  }
  standingSpinners(): string[] {
    // Posted mission actors remain real while abstract. Their last recorded position lets the
    // walker return to them; approaching reactivates fidelity through normal simulation.
    const runtime = agentsRuntimeOf(this.state);
    return (this.run?.spinnerIds ?? []).filter(id => !this.run!.rusted.includes(id) && runtime?.actors[id] && !runtime.actors[id]!.retired &&
      (this.state.ext.combat?.targets[id]?.phase ?? "active") === "active");
  }
  /** Twenty washes in, or the clock past three and a half minutes: time to rust the spinners. */
  late(): boolean {
    return (this.own.objectiveCount ?? 0) >= 20 || this.state.tick - this.own.activityStartedTick > 200 * 60;
  }
  /** Stand off a board on the street side and spray it at board height until it reads plain words. */
  wash(board: { id: string; x: number; z: number }): void {
    if (distance(this.body, board) > 4.5) this.walkTo(board, 3.5, 4000);
    // Rust each nearby spinner on the northbound trip rather than leaving all four behind
    // until the clock is nearly over. This uses its real body and the ordinary water input.
    this.rustNearbySpinners(24);
    if (this.run?.boards.find(value => value.id === board.id)?.qualified) return;
    // The fight may have moved the player away from this board and across traffic. Plan
    // the return from the accepted pose rather than blindly walking a straight firing line.
    if (distance(this.body, board) > 4.5) this.walkTo(board, 3.5, 4000);
    for (let tick = 0; tick < 900; tick++) {
      const shown = this.run?.boards.find(value => value.id === board.id);
      if (!shown || shown.word < 0 || this.own.activeActivityId !== PLAIN_WORDS_ID) return;
      if (this.water() < .1) { this.refill(); this.walkTo(board, 3.5, 4000); }
      const body = this.body, gap = distance(body, board);
      const aimYaw = datan2(board.x - body.x, -(board.z - body.z)), error = wrapAngle(aimYaw - body.heading);
      const reposition = gap > 3.8 || gap < 2;
      // Recorded pointer aim is independent of foot heading. Preserve the walking direction
      // while stationary spraying, rather than turning across the street then back again.
      this.input({ throttle: gap > 3.8 && Math.abs(error) < .4 ? 1 : gap < 2 ? -1 : 0,
        steer: reposition ? clamp(error / (FOOT.turnRate * DT), -1, 1) : 0, brake: 0,
        actions: gap <= 10 ? Action.fire : 0, aimYaw, aimPitch: -.12 });
    }
    throw new Error(`Actual board ${board.id} was not washed in 15 s from ${JSON.stringify(this.body)}`);
  }
  rustNearbySpinners(range: number): void {
    const position = (id: string) => agentsRuntimeOf(this.state)!.actors[id]!;
    for (const id of [...this.standingSpinners()].sort((a, b) => distance(position(a), this.body) - distance(position(b), this.body))) {
      if (this.run!.rusted.includes(id) || this.own.activeActivityId !== PLAIN_WORDS_ID) continue;
      const spinner = position(id);
      if (!spinner || distance(spinner, this.body) > range) continue;
      if (this.water() < 2) this.refill();
      this.approachActor(id);
      // A player can leave a seized robot and wash the next board while its real collapse
      // advances. Completion still requires each subsequent player-owned robot.heap fact.
      this.meltActor(id, () => (this.run?.rusted.includes(id) ?? true) ||
        (this.state.ext.combat?.targets[id]?.phase ?? "active") !== "active");
    }
  }

  override approachActor(id: string): void {
    const target = agentsRuntimeOf(this.state)?.actors[id];
    if (!target || target.retired) throw new Error(`Actual Plain Words spinner ${id} is absent`);
    const gap = distance(this.body, target);
    if (gap > 7) {
      // The old fixed 1800 ticks allowed only 30 s for a 167 m A* walk with turns.
      // First acceptance advanced safely for that entire leg and timed out 21.7 m short.
      const ticks = Math.min(6000, Math.max(1800, Math.ceil((gap / 3 + 15) * 60)));
      this.trace.push(`approach ${id} gap ${gap.toFixed(1)} budget ${ticks} at t${this.state.tick}`);
      this.walkTo(target, 5, ticks);
    }
    const live = runtimeCombatActors(this.state).find(actor => actor.id === id);
    if (!live || distance(this.body, live) > 10) throw new Error(`Could not approach actual Plain Words spinner ${id}`);
  }
}
