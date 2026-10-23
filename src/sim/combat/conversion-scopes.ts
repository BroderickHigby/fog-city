import type { CombatActor, ConversionScope } from "./types.ts";

export const MAX_CONVERSION_SCOPES = 1024;
export const MAX_CONVERSION_SCOPE_MEMBERS = 4096;
export const MAX_CONVERSION_RESERVATIONS = 4096;
const MAX_ID_LENGTH = 256;

export interface ConversionScopeLedger {
  /** True for real population members represented by at least one current scope. */
  contains(targetId: string): boolean;
  allows(targetId: string): boolean;
  /** Record an existing or newly admitted conversion, even if a scope is already full. */
  reserve(targetId: string): void;
  /** Remove only this tick's reservation; baseline bad firmware remains counted. */
  release(targetId: string): void;
}
interface CompiledScope { readonly cap: number; used: number }
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function validId(id: unknown): id is string { return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH; }
function requireId(id: string): void { if (!validId(id)) throw new RangeError("Invalid conversion reservation ID"); }

/** Ephemeral per-tick capacity accounting. No actor or caller-owned scope is changed. */
export function createConversionScopeLedger(actors: readonly CombatActor[], scopes?: readonly ConversionScope[]): ConversionScopeLedger | null {
  if (scopes === undefined) return null;
  if (!Array.isArray(scopes) || scopes.length > MAX_CONVERSION_SCOPES || !Array.isArray(actors) || actors.length > MAX_CONVERSION_SCOPE_MEMBERS) throw new RangeError("Conversion scope capacity exceeded");
  const actorIds = new Set<string>(), badIds = new Set<string>();
  for (const actor of actors) {
    if (!actor || !validId(actor.id) || actorIds.has(actor.id)) throw new RangeError("Invalid conversion actor IDs");
    actorIds.add(actor.id);
    if (actor.kind === "robot" && actor.firmware === "bad") badIds.add(actor.id);
  }
  const scopeIds = new Set<string>();
  for (const scope of scopes) {
    if (!scope || !validId(scope.id) || scopeIds.has(scope.id) || !Number.isSafeInteger(scope.cap) || scope.cap < 0 ||
        !Array.isArray(scope.actorIds) || scope.actorIds.length > MAX_CONVERSION_SCOPE_MEMBERS) throw new RangeError("Invalid conversion scope");
    scopeIds.add(scope.id);
    const members = new Set<string>();
    for (const id of scope.actorIds) {
      if (!validId(id) || members.has(id)) throw new RangeError("Invalid conversion scope member IDs");
      members.add(id);
    }
  }
  const memberships = new Map<string, CompiledScope[]>();
  for (const scope of [...scopes].sort((a, b) => compare(a.id, b.id))) {
    const ids = [...scope.actorIds].sort(compare);
    const compiled: CompiledScope = { cap: scope.cap, used: ids.filter(id => badIds.has(id)).length };
    for (const id of ids) {
      let containing = memberships.get(id);
      if (!containing) { containing = []; memberships.set(id, containing); }
      containing.push(compiled);
    }
  }
  const reservations = new Set<string>();
  return {
    contains(targetId) { return memberships.has(targetId); },
    allows(targetId) {
      if (!validId(targetId) || reservations.has(targetId) || badIds.has(targetId)) return false;
      const containing = memberships.get(targetId);
      return !!containing?.length && containing.every(scope => scope.used < scope.cap);
    },
    reserve(targetId) {
      requireId(targetId);
      if (reservations.has(targetId)) return;
      if (reservations.size >= MAX_CONVERSION_RESERVATIONS) throw new RangeError("Conversion reservation capacity exceeded");
      reservations.add(targetId);
      if (!badIds.has(targetId)) for (const scope of memberships.get(targetId) ?? []) scope.used++;
    },
    release(targetId) {
      requireId(targetId);
      if (!reservations.delete(targetId)) return;
      if (!badIds.has(targetId)) for (const scope of memberships.get(targetId) ?? []) scope.used--;
    },
  };
}
