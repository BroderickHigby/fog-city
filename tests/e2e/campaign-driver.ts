// Plans against observed state; every change still uses the production input path.
import { MISSIONS } from "../../src/content/catalog.ts";
import { Action, datan2, clamp, DT, wrapAngle, type SimInput } from "../../src/sim/index.ts";
import { runtimeCombatActors } from "../../src/sim/agents/runtime.ts";
import { missionPlace } from "../../src/sim/missions/system.ts";
import { GameplayDriver, type Point } from "./gameplay-driver.ts";

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
export class CampaignDriver extends GameplayDriver {
  override input(input: SimInput): void {
    if (this.frames.length >= 16_000) throw new Error("Campaign input budget exhausted");
    super.input(input);
  }
  get progress() { return this.state.ext.missions!.players[this.playerId]!; }
  phase(): string { return this.progress.stepId; }
  complete(): boolean { return this.progress.completedIds.includes("hot-desk"); }
  actor(id: string) {
    const actor = runtimeCombatActors(this.state).find(candidate => candidate.id === id);
    if (!actor) throw new Error(`Canonical actor ${id} is missing`);
    return actor;
  }
  approachActor(id: string): void {
    for (let attempt = 0; attempt < 6 && distance(this.body, this.actor(id)) > 7; attempt++) {
      this.walkTo(this.actor(id), 5, 1800);
    }
    if (distance(this.body, this.actor(id)) > 10) throw new Error(`Could not approach ${id}`);
  }
  refill(): void {
    const source = [...this.world.gameplay?.refills ?? []]
      .filter(value => value.kind === "hydrant" || value.kind === "fountain")
      .sort((a, b) => distance(a, this.body) - distance(b, this.body))[0];
    if (!source) throw new Error("No authored fresh-water refill source");
    this.walkTo(source, source.radius * .6, 1800);
    this.hold(200, Action.interact);
    if (Math.abs((this.state.ext.combat?.players[this.playerId]?.water ?? 0) - 8) > .001) {
      throw new Error("Held hydrant interaction did not fill the base 8 L tank");
    }
  }
  hotDeskToSignup(): void {
    const mission = MISSIONS.find(value => value.id === "hot-desk")!;
    const opening = mission.steps.find(value => value.id === "arrive")!;
    if (opening.type !== "trigger") throw new Error("Missing Hot Desk arrival");
    if (this.phase() === "arrive") {
      this.driveTo(missionPlace(opening.event.place), 30, 1800);
      this.hold(4);
    }
    if (this.phase() !== "watch") throw new Error("Real plaza entry did not stage Hot Desk");
    const thief = "mission:hot-desk:thief";
    this.onFoot();
    this.approachActor(thief);
    for (let tick = 0; tick < 480 && this.phase() === "watch"; tick++) this.aim(this.actor(thief), Action.watch);
    if (this.phase() !== "melt") throw new Error("Held Watch did not identify the actual thief");
    for (let tick = 0; tick < 2400 && this.phase() === "melt"; tick++) {
      const phase = this.state.ext.combat?.targets[thief]?.phase;
      if (phase && phase !== "active") { this.hold(1); continue; }
      if ((this.state.ext.combat?.players[this.playerId]?.water ?? 0) < .08) this.refill();
      if (distance(this.body, this.actor(thief)) > 8) this.approachActor(thief);
      this.aim(this.actor(thief), Action.fire);
    }
    if (this.phase() !== "melted") throw new Error("Actual water did not melt the thief");
    this.refill();
    for (let tick = 0; tick < 600 && this.phase() === "melted"; tick++) this.hold(1);
    if (this.phase() !== "to-desk") throw new Error("Melt outro did not open the desk route");
    const desk = mission.steps.find(value => value.id === "to-desk")!;
    if (desk.type !== "goto") throw new Error("Missing desk destination");
    // The authored objective permits any travel mode; walk clear of the traffic queue.
    this.walkTo(missionPlace(desk.target), 18, 15_000);
    this.hold(2);
    if (this.phase() !== "signup") throw new Error("Physical desk arrival did not open signup");
  }
  coneHotDeskSpot(): void {
    if (this.phase() !== "cone") throw new Error("Signup did not stage the parked taxi");
    const id = "mission:hot-desk:squatter";
    this.onFoot();
    for (let attempt = 0; attempt < 3 && !this.complete(); attempt++) {
      const actor = this.actor(id);
      const front = { x: actor.x + Math.sin(actor.heading) * 6, z: actor.z - Math.cos(actor.heading) * 6 };
      this.walkTo(front, 1.5, 2400);
      // Finish the short, clear approach continuously, avoiding a grid-cell distance error.
      for (let tick = 0; tick < 120 && distance(this.body, front) > .25; tick++) {
        const error = wrapAngle(datan2(front.x - this.body.x, -(front.z - this.body.z)) - this.body.heading);
        this.input({ throttle: Math.abs(error) < .65 ? 1 : 0, steer: clamp(error / (2.2 * DT), -1, 1), brake: 1, actions: 0 });
      }
      this.hold(12);
      for (let tick = 0; tick < 45; tick++) this.aim(this.actor(id), 0);
      this.aim(this.actor(id), Action.cone);
      for (let tick = 0; tick < 100 && !this.complete(); tick++) this.hold(1);
    }
    if (!this.complete() || !this.progress.completedIds.includes("hot-desk")) {
      throw new Error("Physical hood cone did not complete Hot Desk");
    }
  }
}
