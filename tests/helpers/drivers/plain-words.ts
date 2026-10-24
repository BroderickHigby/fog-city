// Closed-loop driver for Plain Words on Columbus Ave: walk the corridor, wash each rebranded board
// with real water, and rust the sign-spinners, re-planning from observed state every step.
import { Action, clamp, datan2, DT, wrapAngle, type SimSystem, type SimState, type World } from "../../../src/sim/index.ts";
import { runtimeCombatActors } from "../../../src/sim/agents/runtime.ts";
import { PLAIN_WORDS_BOARDS, PLAIN_WORDS_ID } from "../../../src/sim/activities/plain-words.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { Point } from "../../e2e/gameplay-driver.ts";
import { Wave3Driver } from "./wave3-campaign.ts";

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
const ACTIVITY = DEFAULT_CATALOG.activities.find(value => value.id === PLAIN_WORDS_ID);

export class PlainWordsDriver extends Wave3Driver {
  constructor(world: World, state: SimState, playerId: string, systems: readonly SimSystem[], options: { sequence?: number; budget?: number } = {}) {
    super(world, state, playerId, systems, { budget: 120_000, ...options });
  }
  get own() { return this.state.ext.activities!.players[this.playerId]!; }
  override input(input: Parameters<Wave3Driver["input"]>[0]): void {
    super.input(input);
    const own = this.own;
    if (own.activeActivityId === PLAIN_WORDS_ID && (this.state.tick - own.activityStartedTick) % 1800 === 0) {
      this.trace.push(`t+${(this.state.tick - own.activityStartedTick) / 60}s washed ${own.objectiveCount} rusted ${this.run?.rusted.length} cp ${own.checkpointIndex} rung ${this.run?.rung} rebrands ${this.run?.rebrands} water ${this.water().toFixed(1)} at ${this.body.x.toFixed(0)},${this.body.z.toFixed(0)}`);
    }
  }
  get run() { return this.own.plainWords; }
  /** Walk to the Broadway end of the corridor, inside the start marker. */
  toStart(): void {
    if (!ACTIVITY) throw new Error("Plain Words is not offered");
    this.walkRoute(ACTIVITY, ACTIVITY.radius - 3);
  }
  /** The run from start to payout; `start` sends the recorded activity-start command. */
  play(start: () => void): void {
    start();
    if (this.own.activeActivityId !== PLAIN_WORDS_ID) throw new Error("Plain Words did not start at its marker");
    for (let move = 0; move < 200 && this.own.activeActivityId === PLAIN_WORDS_ID; move++) {
      if (this.late() && this.standingSpinners().length) { this.rustNearbySpinners(2000); continue; }
      // Greedy: the nearest board still showing a hype word.
      const board = PLAIN_WORDS_BOARDS.filter(value => (this.run?.boards.find(shown => shown.id === value.id)?.word ?? -1) >= 0)
        .sort((a, b) => distance(a, this.body) - distance(b, this.body))[0];
      if (board) this.wash(board);
      else this.rustNearbySpinners(2000);
    }
    if (this.own.activeActivityId === PLAIN_WORDS_ID || !this.own.completedIds.includes(PLAIN_WORDS_ID)) {
      throw new Error(`Plain Words did not finish: ${JSON.stringify({ count: this.own.objectiveCount, rusted: this.run?.rusted.length })}; ${this.trace.slice(-6).join("; ")}`);
    }
  }
  standingSpinners(): string[] {
    return (this.run?.spinnerIds ?? []).filter(id => !this.run!.rusted.includes(id) && runtimeCombatActors(this.state).some(actor => actor.id === id));
  }
  /** Twenty washes in, or the clock past three and a half minutes: time to rust the spinners. */
  late(): boolean {
    return (this.own.objectiveCount ?? 0) >= 20 || this.state.tick - this.own.activityStartedTick > 200 * 60;
  }
  /** Stand off a board on the street side and spray it at board height until it reads plain words. */
  wash(board: { id: string; x: number; z: number }): void {
    if (distance(this.body, board) > 4.5) this.walkTo(board, 3.5, 4000);
    for (let tick = 0; tick < 900; tick++) {
      const shown = this.run?.boards.find(value => value.id === board.id);
      if (!shown || shown.word < 0 || this.own.activeActivityId !== PLAIN_WORDS_ID) return;
      if (this.water() < .1) { this.refill(); this.walkTo(board, 3.5, 4000); }
      const body = this.body, gap = distance(body, board);
      const error = wrapAngle(datan2(board.x - body.x, -(board.z - body.z)) - body.heading);
      this.input({ throttle: gap > 5 && Math.abs(error) < .4 ? 1 : gap < 2 ? -1 : 0, steer: clamp(error / (3 * DT), -1, 1), brake: 0,
        actions: Math.abs(error) < .2 ? Action.fire : 0, aimPitch: -.12 });
    }
    this.trace.push(`board ${board.id} was not washed in 15 s`);
  }
  rustNearbySpinners(range: number): void {
    for (const id of [...this.standingSpinners()].sort((a, b) => distance(this.actor(a), this.body) - distance(this.actor(b), this.body))) {
      if (this.run!.rusted.includes(id) || this.own.activeActivityId !== PLAIN_WORDS_ID) continue;
      const spinner = runtimeCombatActors(this.state).find(actor => actor.id === id);
      if (!spinner || distance(spinner, this.body) > range) continue;
      if (this.water() < 2) this.refill();
      this.approachActor(id);
      try { this.meltActor(id, () => this.run?.rusted.includes(id) ?? true); }
      catch (error) { this.trace.push(`spinner ${id}: ${(error as Error).message.slice(0, 80)}`); }
    }
  }
}
