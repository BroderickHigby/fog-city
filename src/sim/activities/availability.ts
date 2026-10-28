import type { ActivityDefinition } from "../player/types.ts";

/** Only expose activities whose objective can be produced by this runtime: every kind below has
 * a measured producer in src/sim/activities/ (or, for interviews, the mission it runs).
 */
export function activityAvailable(activity: Pick<ActivityDefinition, "wave" | "kind" | "objective" | "checkpoints">): boolean {
  if (activity.wave < 3) return true;
  if (!activity.checkpoints?.length) return false;
  return activity.kind === "timeTrial" && activity.objective?.event === "race.finished"
    || activity.kind === "delivery" && activity.objective?.event === "delivery.completed"
    || activity.kind === "photo" && activity.objective?.event === "photo.landmarkFramed"
    || activity.kind === "relic" && activity.objective?.event === "relic.viewerFound"
    || activity.kind === "washBoards" && activity.objective?.event === "board.washed"
    || activity.kind === "interview" && activity.objective?.event === "demo.robotPresented"
    || activity.kind === "parking" && activity.objective?.event === "parking.legalStop"
    || activity.kind === "faction" && (activity.objective?.event === "faction.pauser-completed" || activity.objective?.event === "faction.accelerator-completed")
    || activity.kind === "recon" && (activity.objective?.event === "recon.signalFound" || activity.objective?.event === "recon.viewerCompleted");
}
