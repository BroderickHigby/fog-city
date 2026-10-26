import type { SimState } from "./contract.ts";
import { isGameplayId } from "./gameplay-contract.ts";

export interface ActorIdentities { version: 1; nextId: number; ids: Record<string, number> }

/**
 * Live bindings kept at most. Retired actors release theirs (releaseActorIds), so this bounds a
 * leak, not normal play; at the bound the lowest-numbered bindings without a body are dropped.
 */
export const MAX_ACTOR_IDENTITIES = 32768;

/** Reserve stable IDs from the same monotonic allocator used by ambient agents. */
export function allocateActorIds(state: Readonly<SimState>, stableIds: readonly string[]): { state: SimState; ids: Record<string, number> } {
  // Malformed names or a corrupt counter are caller bugs, not gameplay conditions.
  if (stableIds.length > 4096 || stableIds.some(id => !isGameplayId(id))) throw new Error("Invalid actor identity request");
  const previous = state.ext.identities as ActorIdentities | undefined;
  const ids: Record<string, number> = {};
  if (stableIds.length === 0) return { state: state as SimState, ids };
  const bindings = { ...(previous?.ids ?? {}) };
  const agents = state.ext.agents ?? { nextId: 1, list: [] };
  let nextId = Math.max(agents.nextId, previous?.nextId ?? 1);
  const requested = [...new Set(stableIds)].sort();
  // Count live bindings once per call instead of sorting every binding for each new ID.
  const count = Object.keys(bindings).length;
  const fresh = requested.filter(id => bindings[id] === undefined).length;
  if (count + fresh > MAX_ACTOR_IDENTITIES) evict(state, bindings, new Set(requested), count + fresh - MAX_ACTOR_IDENTITIES);
  for (const id of requested) {
    if (bindings[id] === undefined) {
      if (!Number.isSafeInteger(nextId) || nextId >= Number.MAX_SAFE_INTEGER) throw new Error("Actor identity counter is corrupt");
      bindings[id] = nextId++;
    }
    ids[id] = bindings[id]!;
  }
  return { state: { ...state, ext: { ...state.ext,
    agents: { ...agents, nextId }, identities: { version: 1, nextId, ids: bindings },
  } }, ids };
}

/**
 * Drop the oldest (lowest-numbered) bindings that no physical body holds and that this request
 * does not name. Numeric IDs are never reused: a dropped name that comes back gets a new one.
 */
function evict(state: Readonly<SimState>, bindings: Record<string, number>, keep: ReadonlySet<string>, excess: number): void {
  const embodied = new Set((state.ext.agents?.list ?? []).map(body => body.runtimeId));
  const candidates = Object.keys(bindings).filter(id => !keep.has(id) && !embodied.has(id))
    .sort((a, b) => bindings[a]! - bindings[b]! || (a < b ? -1 : a > b ? 1 : 0));
  for (const id of candidates.slice(0, excess)) delete bindings[id];
}

/**
 * Release the bindings of retired actors so the table holds live actors only. Pure; returns the
 * same state when nothing is bound to those names. The shared counter never goes back.
 */
export function releaseActorIds(state: SimState, retired: readonly string[]): SimState {
  const previous = state.ext.identities as ActorIdentities | undefined;
  if (!previous || !retired.length || !retired.some(id => Object.hasOwn(previous.ids, id))) return state;
  const ids = { ...previous.ids };
  for (const id of retired) delete ids[id];
  return { ...state, ext: { ...state.ext, identities: { ...previous, ids } } };
}

const legacyIds: string[] = [];
/**
 * `agent:<id>`, the runtime id of an ambient agent. The same string object comes back for the
 * same id, so the hot paths that key records and sets by it hash it once instead of building a
 * new string every tick.
 */
export function agentActorId(id: number): string {
  if (!Number.isSafeInteger(id) || id < 0 || id > 1 << 20) return `agent:${id}`;
  return legacyIds[id] ??= `agent:${id}`;
}
