import type { SimState } from "../contract.ts";
import type { JsonObject } from "../extensions.ts";
import type { SimSystem, SimSystemContext } from "../system-contract.ts";
import type { CombatActorMetadata, CombatAdapterOptions } from "../combat/adapter.ts";
import {
  agentsRuntimeOf, observeAgentRuntime, planAgentRuntime, runtimeCombatActors,
  runtimeAttackRequests, type AgentRuntimeOptions, type AgentMotionProposal,
} from "./runtime.ts";

export type AgentRuntimeProvider = (context: SimSystemContext) => AgentRuntimeOptions;
export interface AgentsSystem extends SimSystem {
  prepare(context: SimSystemContext): { state: SimState; motions: readonly AgentMotionProposal[]; retirements: readonly string[] };
}
function withRuntime(state: SimState, runtime: ReturnType<typeof planAgentRuntime>): SimState {
  return { ...state, ext: { ...state.ext, robots: runtime as unknown as JsonObject } };
}

/** The core calls prepare before movement, accepts proposals through clearance, then step. */
export function createAgentsSystem(provider: AgentRuntimeProvider = () => ({})): AgentsSystem {
  return {
    key: "robots",
    prepare(context) {
      const runtime = planAgentRuntime(context.world, context.state, context.inputs, provider(context));
      return { state: withRuntime(context.state, runtime), motions: runtime.proposals, retirements: Object.keys(runtime.actors).sort().filter(id=>runtime.actors[id]!.retired) };
    },
    step(context) {
      // Keep compatibility with an older system host; only a prepare-capable host moves bodies.
      const options=provider(context);
      const observed=(context as SimSystemContext & {observedBodies?: AgentRuntimeOptions["observedBodies"]}).observedBodies;
      const runtime = agentsRuntimeOf(context.state)?.tick === context.state.tick
        ? observeAgentRuntime(context.state, {...options,...(observed?{observedBodies:observed}:{})})
        : planAgentRuntime(context.world, context.state, context.inputs, options);
      return withRuntime(context.state, runtime);
    },
  };
}

/** Legacy bodies already exist in contextFromState. Supply metadata, never duplicate them. */
export function agentsCombatOptions(state: Readonly<SimState>): CombatAdapterOptions {
  const runtime = agentsRuntimeOf(state);
  const actorMetadata: Record<string, CombatActorMetadata> = {};
  const extraActors: NonNullable<CombatAdapterOptions["extraActors"]>[number][] = [];
  for (const actor of runtimeCombatActors(state)) {
    if (runtime?.actors[actor.id]?.legacyId !== null) actorMetadata[actor.id] = actor;
    else extraActors.push(actor);
  }
  return { actorMetadata, extraActors, attacks: runtimeAttackRequests(state) };
}

/** Core composes the configured provider once world navigation and service data are loaded. */
export const systems: readonly SimSystem[] = Object.freeze([]);
