// Real recorded controls only. Reuse the accepted bounded pedestrian planner; no state edits.
import { datan2, type SimInput } from "../../../src/sim/index.ts";
import { agentsRuntimeOf } from "../../../src/sim/agents/runtime.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { COIT_VIEWER, COIT_VIEW, coitAngles, coitCameraPose, coitSessionActive } from "../../../src/sim/activities/coit-viewer.ts";
import { coitLandmarks, coitLineOfSight, coitPlayerContext } from "../../../src/sim/activities/coit-observation.ts";
import { PlainWordsDriver } from "./plain-words.ts";

const neutral: SimInput = { throttle: 0, steer: 0, brake: 1, actions: 0 };
const activity = DEFAULT_CATALOG.activities.find(value => value.id === "coit-recon");
export class CoitReconDriver extends PlainWordsDriver {
  aimYaw = Math.PI;
  aimPitch = -.2;
  get viewer() { return this.own.recon?.viewer; }
  viewerInput(): SimInput { return { ...neutral, aimYaw: this.aimYaw, aimPitch: this.aimPitch }; }
  private ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
  override rewind(_mark: ReturnType<PlainWordsDriver["mark"]>): void { throw new Error("Coit acceptance refuses planner rewind"); }
  reachStart(): void {
    this.ensure(activity, "The full Coit activity is absent from the runtime catalog");
    this.walkRoute(activity, activity.radius - 3);
  }
  startAndReachViewer(): void {
    this.ensure(activity, "Coit definition is absent");
    this.command({ kind: "activity-start", targetId: "coit-recon" });
    this.ensure(this.own.activeActivityId === "coit-recon", `Coit did not start: ${JSON.stringify(this.progress)}`);
    // An actual refused purchase at the distant path entrance must not spend a quarter.
    this.command({ kind: "coit-viewer", targetId: "coit-recon", choiceId: "open" }, this.viewerInput());
    this.ensure(!this.viewer, "A viewer opened away from its authored pod");
    this.walkRoute(COIT_VIEWER, 1.5);
    this.hold(20);
    this.ensure(Math.hypot(this.body.x - COIT_VIEWER.x, this.body.z - COIT_VIEWER.z) <= COIT_VIEWER.radius, "Physical walk did not reach the viewer pod");
  }
  private choice(choiceId: "open" | "close" | "tag" | "flag" | "skip"): void {
    this.command({ kind: "coit-viewer", targetId: "coit-recon", choiceId }, this.viewerInput());
  }
  private aimAt(point: { x: number; y: number; z: number }): boolean {
    const pose = coitCameraPose(this.world, { yaw: this.aimYaw, pitch: this.aimPitch });
    const rawYaw = datan2(point.x - pose.x, -(point.z - pose.z)), yaw = (rawYaw + Math.PI * 2) % (Math.PI * 2), pitch = datan2(point.y - pose.y, Math.hypot(point.x - pose.x, point.z - pose.z));
    const angles = coitAngles(yaw, pitch);
    if (Math.abs(angles.yaw - yaw) > .001 || Math.abs(angles.pitch - pitch) > .001) return false;
    this.aimYaw = angles.yaw; this.aimPitch = angles.pitch;
    return true;
  }
  private aimAtRealLandmark(): void {
    for (const landmark of coitLandmarks(this.world)) {
      if (!this.aimAt(landmark)) continue;
      const seen = coitPlayerContext(this.state, this.world, this.playerId, { aimYaw: this.aimYaw, aimPitch: this.aimPitch }).landmark;
      if (seen?.id === landmark.id) { this.trace.push(`real landmark preset ${landmark.id} at t${this.state.tick}`); return; }
    }
    throw new Error("No authored landmark preset has actual unobstructed Coit sight");
  }
  private awaitGuide(): void {
    this.aimAtRealLandmark();
    for (let frame = 0; frame < 240 && !this.viewer?.guide; frame++) this.input(this.viewerInput());
    this.ensure(this.viewer?.guide, "No guide claim arose from a real visible landmark within four seconds");
  }
  /** One deliberate paid failure: a real guide claim, a late refused flag, then close. */
  proveLateFlagAndRetry(): void {
    this.choice("open"); this.ensure(coitSessionActive(this.viewer, this.state.tick), "A quarter did not open the real viewer");
    const start = this.viewer.startedTick;
    this.choice("open"); this.ensure(this.viewer.startedTick === start, "Rapid duplicate open bought or replaced the live viewing");
    this.choice("tag"); this.ensure(!this.viewer.taggedIds.length, "An unobserved early tag was credited");
    this.awaitGuide();
    while (this.state.tick <= this.viewer!.guide!.flagUntilTick) this.input(this.viewerInput());
    this.choice("flag"); this.ensure(!this.viewer!.flaggedIds.length, "A guide flag after its real five-second deadline was credited");
    this.choice("close"); this.ensure(this.viewer?.closed, "The failed viewing did not close");
    this.ensure(!this.own.completedIds.includes("coit-recon"), "A failed viewing settled the activity");
  }
  /** The second quarter must yield a real correction and an observed remote NPC sabotage. */
  completePaidViewing(): void {
    this.choice("open"); this.ensure(coitSessionActive(this.viewer, this.state.tick), "The fresh paid retry did not open");
    this.awaitGuide(); this.choice("skip"); this.choice("flag");
    this.ensure(this.viewer!.flaggedIds.length === 1, "Skipping audio prevented the actual caption's timely flag");
    const visited = new Map<string, number>();
    let targetId = "", targetSince = this.state.tick;
    while (coitSessionActive(this.viewer, this.state.tick) && !this.viewer.taggedIds.length) {
      const viewer = this.viewer, runtime = agentsRuntimeOf(this.state);
      if (viewer.observedTicks >= COIT_VIEW.observeTicks && viewer.observedBehavior && this.state.tick - viewer.evidenceTick <= COIT_VIEW.flagTicks) {
        this.choice("tag");
        if (this.viewer?.taggedIds.length) break;
      }
      const current = targetId ? runtime?.actors[targetId] : undefined;
      if (!current || current.retired || this.state.tick - targetSince > 180 && !viewer.observedBehavior) {
        const pose = coitCameraPose(this.world, viewer);
        const candidates = Object.keys(runtime?.actors ?? {}).sort().map(id => runtime!.actors[id]!).filter(actor => {
          const distance = Math.hypot(actor.x - this.body.x, actor.z - this.body.z);
          return !actor.retired && actor.firmware === "bad" && !actor.protected && !actor.child && !actor.mobilityAid &&
            ["footman", "trundle", "patrol", "sign-spinner", "walker"].includes(actor.model) && distance >= 180 && distance <= COIT_VIEW.maxRangeM &&
            (this.state.ext.combat?.targets[actor.id]?.phase ?? "active") === "active" &&
            coitLineOfSight(this.world, pose, { ...actor, y: actor.y + actor.height * .6 });
        }).sort((a, b) => (a.intent?.sabotageActive ? 0 : 1) - (b.intent?.sabotageActive ? 0 : 1) ||
          (visited.get(a.id) ?? 0) - (visited.get(b.id) ?? 0) || Math.hypot(a.x - pose.aim.x, a.z - pose.aim.z) - Math.hypot(b.x - pose.aim.x, b.z - pose.aim.z) || (a.id < b.id ? -1 : 1));
        targetId = "";
        for (const actor of candidates) if (this.aimAt({ ...actor, y: actor.y + actor.height * .6 })) {
          targetId = actor.id; targetSince = this.state.tick; visited.set(actor.id, this.state.tick); this.trace.push(`view real remote ${actor.id} at ${Math.hypot(actor.x - this.body.x, actor.z - this.body.z).toFixed(1)}m t${this.state.tick}`); break;
        }
      }
      const target = targetId ? agentsRuntimeOf(this.state)?.actors[targetId] : undefined;
      if (target) this.aimAt({ ...target, y: target.y + target.height * .6 });
      else {
        // Recorded pan across built city sectors admits only ordinary, budgeted ambient actors.
        const phase = (this.state.tick - this.viewer!.startedTick) % 720;
        const yaw = COIT_VIEW.yawMin + (COIT_VIEW.yawMax - COIT_VIEW.yawMin) * phase / 720;
        const angles = coitAngles(yaw, -.1); this.aimYaw = angles.yaw; this.aimPitch = angles.pitch;
      }
      this.input(this.viewerInput());
    }
    this.ensure(this.viewer?.taggedIds.length, `No genuine remote behavior tag in the paid thirty seconds; ${this.trace.slice(-8).join("; ")}`);
    while (coitSessionActive(this.viewer, this.state.tick)) this.input(this.viewerInput());
    this.ensure(this.own.completedIds.includes("coit-recon") && !this.own.activeActivityId, "The real thirty-second tag/correction viewing did not settle");
  }
  verifyRestartCooldown(): void {
    this.ensure(activity, "Coit definition absent");
    this.walkRoute(activity, activity.radius - 3);
    this.ensure((this.own.cooldowns?.["coit-recon"] ?? 0) > this.state.tick, "Return walk outlasted the cooldown negative test");
    this.command({ kind: "activity-start", targetId: "coit-recon" });
    this.ensure(!this.own.activeActivityId, "Activity restarted inside its authored cooldown");
  }
}
