import { Action } from "../contract.ts";
import type { Mission, ObjectiveStep } from "../../content/missions.ts";
import type { GameplayContext, GameplayFact } from "../player/types.ts";

/** Durable evidence belongs to one attempt, never to a client completion request. */
export interface MissionObservedState {
  missionId: string;
  startedTick: number;
  watched: string[];
  falsePositives: string[];
  melted: string[];
  dirty: boolean;
  commandSequence: number;
  previousInteract: boolean;
}

export function observeMission(
  previous: MissionObservedState | undefined, mission: Mission, step: ObjectiveStep,
  ctx: GameplayContext, playerId: string, tick: number, startedTick: number,
  incoming: readonly GameplayFact[],
): { state: MissionObservedState; handled: boolean; complete: boolean } {
  const old = previous?.missionId === mission.id && previous.startedTick === startedTick ? previous : undefined;
  const state: MissionObservedState = old ? { ...old, watched: [...old.watched], falsePositives: [...old.falsePositives], melted: [...old.melted] }
    : { missionId: mission.id, startedTick, watched: [], falsePositives: [], melted: [], dirty: false, commandSequence: 0, previousInteract: false };
  const observation = ctx.observations.find(value => value.playerId === playerId);
  const actorId = (alias: string) => observation?.actorBindings?.[alias] ?? `mission:${mission.id}:${alias}`;
  const relevant = new Set(Object.keys(mission.actors ?? {}).sort().flatMap(alias => [actorId(alias), ...(mission.actors?.[alias]?.members ?? []).map(actorId)]));
  const append = (list: string[], id: string) => { if (!list.includes(id)) list.push(id); };
  for (const fact of incoming) {
    if (fact.playerId !== playerId) continue;
    if (fact.kind === "person.wet" || fact.kind === "economy.penalty") state.dirty = true;
    if (!fact.actorId || !relevant.has(fact.actorId)) continue;
    if (fact.kind === "scan.result" && fact.detail === "bad" && ctx.actors.find(actor => actor.id === fact.actorId)?.firmware === "good") append(state.falsePositives, fact.actorId);
    if (fact.kind === "robot.heap") append(state.melted, fact.actorId);
  }
  if (observation?.watchingActorId && relevant.has(observation.watchingActorId) && (observation.watchedTicks ?? 0) >= 180) append(state.watched, observation.watchingActorId);
  const interacting = Boolean((ctx.actions?.[playerId] ?? 0) & Action.interact);
  const acknowledgements = ctx.commands.filter(command => command.playerId === playerId && command.kind === "mission-ack" && command.sequence > state.commandSequence);
  const pressed = interacting && !state.previousInteract || acknowledgements.length > 0;
  state.previousInteract = interacting;
  for (const command of acknowledgements) state.commandSequence = Math.max(state.commandSequence, command.sequence);
  const expected = step.objective.kind === "event" ? step.objective.event : undefined;
  if (expected === "botCheck.falsePositiveSeen") return { state, handled: true, complete: state.falsePositives.includes(actorId("courier")) && pressed };
  if (expected === "demo.robotPresented") {
    const good = [actorId("demoGoodA"), actorId("demoGoodB")], bad = actorId("demoBad");
    for (const id of good) if ((ctx.rustByActor?.[id] ?? 0) > 0) state.dirty = true;
    const all = [bad, ...good];
    const complete = new Set(all).size === 3 && all.every(id => state.watched.includes(id)) && state.melted.includes(bad)
      && !state.dirty && good.every(id => ctx.actorBodies?.some(actor => actor.id === id && actor.firmware === "good"));
    return { state, handled: true, complete };
  }
  return { state, handled: false, complete: false };
}
