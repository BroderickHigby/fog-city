import { sortedIds, type SimState } from "./contract.ts";
import { isGameplayId } from "./gameplay-contract.ts";

export interface ActorIdentities { version: 1; nextId: number; ids: Record<string, number> }

/** Reserve stable IDs from the same monotonic allocator used by ambient agents. */
export function allocateActorIds(state: Readonly<SimState>, stableIds: readonly string[]): { state: SimState; ids: Record<string, number> } {
  if (stableIds.length > 4096 || stableIds.some(id => !isGameplayId(id))) throw new Error("Invalid actor identity request");
  const previous = state.ext.identities as ActorIdentities | undefined;
  const bindings = { ...(previous?.ids ?? {}) };
  const ids: Record<string, number> = {};
  const agents = state.ext.agents ?? { nextId: 1, list: [] };
  let nextId = Math.max(agents.nextId, previous?.nextId ?? 1);
  for (const id of [...new Set(stableIds)].sort()) {
    if (bindings[id] === undefined) {
      if (sortedIds(bindings).length >= 32768 || !Number.isSafeInteger(nextId) || nextId >= Number.MAX_SAFE_INTEGER) throw new Error("Actor identity capacity exceeded");
      bindings[id] = nextId++;
    }
    ids[id] = bindings[id]!;
  }
  if (stableIds.length === 0) return { state: state as SimState, ids };
  return { state: { ...state, ext: { ...state.ext,
    agents: { ...agents, nextId }, identities: { version: 1, nextId, ids: bindings },
  } }, ids };
}
