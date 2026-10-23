import { Action, TICK_HZ, sortedIds, type InputFrame, type SimState } from "../contract.ts";
import { rejoinAt, type AgentState, type AgentsExt } from "../agents.ts";
import { datan2 } from "../dmath.ts";
import { hash32 } from "../rng.ts";
import { initialTarget } from "../combat/shared.ts";
import type { CombatActor, CombatState } from "../combat-contract.ts";
import { movementLimit } from "../combat/system.ts";
import { circleBlocked, meshGroundHeight, segmentBlocked, type World } from "../world.ts";
import { pathPoint, projectOnPath, walkPath } from "../roads.ts";
import { finaleFootfallClear, type FinaleEffect, type FinaleLandingAck } from "../robots/finale.ts";
import { robotAgentId } from "../robots/runtime.ts";
import { agentRuntimeSession, type RuntimePhysicalBody } from "./runtime-state.ts";
import { createRuntimeVisualSensor } from "./runtime-sight.ts";
import type { AgentRuntimeData } from "./runtime-system.ts";
import { routineFinaleBodyClear, type RoutineRuntimeEffect, type RoutineRuntimeState } from "./routine-runtime.ts";

interface RoutineOutput { effects: readonly RoutineRuntimeEffect[]; actorMetadata: Readonly<Record<string, Partial<CombatActor>>> }
interface HeapBinding { heapId: string; tidyId: string }
interface TermsWindup { id: string; actorId: string; playerId: string; startedTick: number; activeUntil: number }
export interface RoutineEffectState {
  version: 1; acks: string[]; applied: string[]; bindings: HeapBinding[]; terms: TermsWindup[];
  carClaims: { actorId: string; carId: string; sequence: number; tick: number }[];
  landingReceipts: FinaleLandingAck[];
  diagnostics: string[];
  events: { id: string; tick: number; kind: string; actorId: string; targetId: string }[];
}
export interface RoutineRestorationArrival {
  actorId: string; effectId: string; playerId: string; sequence: number; safehouseId: string;
  position: { x: number; y: number; z: number };
}
type Runtime = AgentRuntimeData & {
  routines?: RoutineRuntimeState; routineOutput?: RoutineOutput; effectState?: RoutineEffectState;
  restorationArrivals?: readonly RoutineRestorationArrival[];
  restoreSafehouses?: readonly { id: string; x: number; z: number; radiusM?: number }[];
};
type ExtendedAgents = AgentsExt & { runtime: Runtime };
const MAX_EFFECTS = 128;
const d2 = (a: { x: number; z: number }, b: { x: number; z: number }): number => (((a.x - b.x)) * ((a.x - b.x))) + (((a.z - b.z)) * ((a.z - b.z)));
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function poseFinite<T extends { x?: number; y?: number; z?: number }>(value: T): value is T & { x: number; y: number; z: number } {
  return [value.x, value.y, value.z].every(n => typeof n === "number" && Number.isFinite(n));
}

/** Finalize only observed physical effects. Core must still run its final mixed-body dodge. */
export function finalizeRoutineEffects(world: World, before: Readonly<SimState>, after: SimState, inputs: InputFrame = {}): SimState {
  const current = after.ext.agents as ExtendedAgents | undefined;
  const source = current?.runtime;
  if (!current || !source?.routines || !source.routineOutput) return after;
  if (after.tick !== before.tick + 1 || source.routineOutput.effects.length > MAX_EFFECTS) throw new Error("Invalid routine effect frame");
  const old = source.effectState;
  if (old && (old.applied.length > 512 || old.bindings.length > 128 || old.terms.length > 128 || (old.carClaims?.length ?? 0) > 128 || (old.landingReceipts?.length ?? 0) > 2)) throw new Error("Invalid routine effect state budget");
  const effects = [...source.routineOutput.effects].sort((a, b) => compare(a.id, b.id));
  const canSee = createRuntimeVisualSensor({ world, previous: after, state: after });
  const pendingIds = new Set(effects.map(e => e.id));
  const effectState: RoutineEffectState = {
    version: 1, acks: (old?.acks ?? []).filter(id => pendingIds.has(id)), applied: [...(old?.applied ?? [])],
    bindings: (old?.bindings ?? []).map(b => ({ ...b })), terms: (old?.terms ?? []).map(t => ({ ...t })),
    carClaims: (old?.carClaims ?? []).map(c => ({ ...c })), landingReceipts: [], diagnostics: [], events: [],
  };
  const list = current.list.map(a => ({ ...a, dodge: a.dodge ? { ...a.dodge } : null }));
  const bodies = source.bodies.map(b => ({ ...b, dodge: b.dodge ? { ...b.dodge } : null }));
  const runtime: Runtime = { ...source, bodies, effectState, significantAgentIds: [...source.significantAgentIds], deliveredAgentIds: [...source.deliveredAgentIds] };
  let nextId = current.nextId;
  let shedThisTick = 0;
  const squareAmbientReserve = agentRuntimeSession(after)?.ambientMode === "squares-v1" ? (runtime.population?.ambient ?? 0) : 0;
  const significantOccupancy = (): number => {
    const physical = new Set(runtime.significantAgentIds);
    for (const body of bodies) if (body.kind !== "animal" && body.model !== "van" && body.model !== "bus") physical.add(body.numericId);
    return Math.max((runtime.population?.significant ?? 0) + shedThisTick, physical.size)
      + (runtime.population?.reservedVanUnits ?? 0) + squareAmbientReserve;
  };
  const combat: CombatState | undefined = after.ext.combat ? { ...after.ext.combat,
    targets: Object.fromEntries(sortedIds(after.ext.combat.targets).map(id => { const value = after.ext.combat!.targets[id]!; return [id, { ...value, wetHits: [...value.wetHits] }]; })),
    players: Object.fromEntries(sortedIds(after.ext.combat.players).map(id => { const value = after.ext.combat!.players[id]!; return [id, { ...value, marks: value.marks.map(mark => ({ ...mark })) }]; })),
    events: [...after.ext.combat.events],
  } : undefined;
  const restored = new Set<number>();
  const retired = new Set<number>();
  const players = { ...after.players };
  const legacy = (id: string): AgentState | undefined => list.find(a => a.id === robotAgentId(id));
  const physical = (id: string): AgentState | RuntimePhysicalBody | undefined => legacy(id) ?? bodies.find(b => b.id === id);
  const robotActors = Array.isArray(after.ext.robots?.actors) ? after.ext.robots.actors as unknown as readonly CombatActor[] : [];
  const robotById = new Map(robotActors.map(actor => [actor.id, actor]));
  const restoredIds = Array.isArray(after.ext.robots?.restoredAgentIds) ? after.ext.robots.restoredAgentIds : [];
  const termsAllowed = (actorId: string, playerId: string): boolean => {
    const body = physical(actorId), player = players[playerId];
    if (!combat || !body || !("model" in body) || body.kind !== "robot" || body.model !== "patrol" || body.operational === false || !player) return false;
    const robot = robotById.get(actorId), routine = source.routineOutput!.actorMetadata[actorId];
    const id = robotAgentId(actorId);
    // Match the combat wrapper's metadata precedence, using the current physical pose.
    // Explicit restoration also applies when this frame still has a stale bad descriptor.
    const firmware = id !== null && (restored.has(id) || restoredIds.includes(id)) ? "good" :
      robot?.firmware ?? routine?.firmware ?? body.firmware ?? "none";
    const actor: CombatActor = { ...robot, ...routine, id: actorId, kind: "robot", model: "patrol", firmware,
      x: body.x, y: body.y, z: body.z, heading: body.heading, speed: body.speed, radius: body.radius, height: body.height };
    const target = player.mode === "foot" && player.foot ? player.foot : player.car;
    return actor.firmware === "bad" && actor.protected !== true && actor.inFidelity !== false &&
      movementLimit(combat, actor).canAttack && d2(body, target) <= 36 && canSee(body, target);
  };
  const atKiosk = (p: { x: number; z: number }): boolean => (world.gameplay?.anchors ?? []).some(a => a.kind === "repair-kiosk" && d2(a, p) <= 4);
  const protectors = (): { id: string; kind: "person" | "animal"; x: number; z: number; radius: number }[] => [
    ...list.filter(a => a.kind === "person").map(a => ({ id: `agent:${a.id}`, kind: "person" as const, x: a.x, z: a.z, radius: 0.35 })),
    ...bodies.filter(b => b.kind === "person" || b.kind === "animal" || ["bus", "recruit-taxi", "associate-car", "associate-scooter"].includes(b.model)).map(b => ({ id: b.id, kind: b.kind === "animal" ? "animal" as const : "person" as const, x: b.x, z: b.z, radius: ["bus", "recruit-taxi", "associate-car", "associate-scooter"].includes(b.model) ? Math.sqrt(b.halfLength * b.halfLength + b.halfWidth * b.halfWidth) : b.radius })),
    ...sortedIds(after.players).map(id => after.players[id]!).map(p => { const at = p.mode === "foot" && p.foot ? p.foot : p.car; return { id: `player:${p.id}`, kind: "person" as const, x: at.x, z: at.z, radius: p.mode === "foot" ? 0.35 : 2.4 }; }),
  ];
  const safePoint = (id: string, p: { x: number; y: number; z: number }, radius = 0.4): boolean => {
    if (!poseFinite(p) || circleBlocked(world, p.x, p.z, radius)) return false;
    if (protectors().some(a => a.id !== id && d2(a, p) <= (((a.radius + radius + 0.2)) * ((a.radius + radius + 0.2))))) return false;
    if (sortedIds(after.players).some(id => { const player = after.players[id]!; return d2(player.car, p) < (2.6 + radius) * (2.6 + radius) && Math.abs(player.car.y - p.y) < 2; })) return false;
    return !bodies.some(b => {
      const clearance = Math.sqrt(b.halfLength * b.halfLength + b.halfWidth * b.halfWidth) + radius;
      return b.id !== id && b.kind === "vehicle" && d2(b, p) <= clearance * clearance && Math.abs(b.y - p.y) < b.height;
    });
  };
  const ack = (effect: RoutineRuntimeEffect, kind = effect.kind): void => {
    if (!effectState.acks.includes(effect.id)) effectState.acks.push(effect.id);
    if (!effectState.applied.includes(effect.id)) effectState.applied.push(effect.id);
    effectState.events.push({ id: effect.id, tick: after.tick, kind, actorId: effect.actorId, targetId: effect.targetId });
  };
  const cancelTerms = (id: string, actorId: string, playerId: string): void => {
    const terms = effectState.terms.find(term => term.id === id);
    const target = combat?.targets[playerId];
    if (terms && terms.activeUntil > after.tick && target?.stoppedUntil === terms.activeUntil) {
      // This reducer can release its own stop, but never shorten a stronger unrelated stop.
      target.stoppedUntil = Math.max(after.tick, ...effectState.terms.filter(term => term.id !== id && term.playerId === playerId).map(term => term.activeUntil));
    }
    effectState.terms = effectState.terms.filter(term => term.id !== id);
    const pending = effects.find(effect => effect.id === id);
    if (pending && !effectState.applied.includes(id)) ack(pending, "patrol.terms-cancelled");
    else effectState.events.push({ id: `${id}/cancelled`, tick: after.tick, kind: "patrol.terms-cancelled", actorId, targetId: playerId });
  };
  const applyPose = (id: string, p: { x: number; y: number; z: number }, speed = 0): boolean => {
    const body = physical(id);
    if (!body) return false;
    const moved = d2(body, p);
    body.x = p.x; body.y = p.y; body.z = p.z; body.speed = speed;
    const routed = legacy(id);
    if (routed) {
      if (moved === 0) return true;
      // Normal local steps and holds keep their current route; only an attachment,
      // restoration or other relocation needs a city-wide nearest-road search.
      const local = moved <= 0.09 ? rejoinAt(world, routed, p.x, p.z) : null;
      if (local) { Object.assign(routed, local); return true; }
      const candidates = (world.roads?.edges ?? []).filter(edge => edge.walkable).map(edge => {
        const path = walkPath(edge, 1, 1), projection = projectOnPath(path, p.x, p.z), at = pathPoint(path, projection.s);
        return { edge, projection, at };
      }).filter(candidate => candidate.projection.dist <= 20 && !segmentBlocked(world, p.x, p.z, candidate.at.x, candidate.at.z))
        .sort((a, b) => a.projection.dist - b.projection.dist || compare(a.edge.id, b.edge.id));
      const candidate = candidates[0];
      const rejoined = candidate ? rejoinAt(world, { ...routed, edge: candidate.edge.id, dir: 1, lane: 1, conn: null }, p.x, p.z) : null;
      if (rejoined && candidate) Object.assign(routed, { edge: candidate.edge.id, dir: 1, lane: 1, dwell: 0, mode: "go", ...rejoined });
      else { routed.speed = 0; routed.dwell = Number.MAX_SAFE_INTEGER; routed.mode = "dwell"; }
    }
    return true;
  };
  // Safe locomotion/hold proposals are applied to their real legacy bodies too, not only
  // to combat descriptors. Large relocations require a separately verified binding below.
  for (const id of sortedIds(source.routineOutput.actorMetadata)) {
    const metadata = source.routineOutput.actorMetadata[id]!;
    const body = physical(id);
    if (!body || !poseFinite(metadata) || (metadata.speed !== undefined && !Number.isFinite(metadata.speed)) || d2(body, metadata) > 0.09 || !safePoint(id, metadata)) continue;
    applyPose(id, metadata, metadata.speed ?? body.speed);
    if (metadata.heading !== undefined && Number.isFinite(metadata.heading)) body.heading = metadata.heading;
  }
  effectState.bindings = effectState.bindings.filter(binding => {
    const tidy = physical(binding.tidyId), heap = physical(binding.heapId);
    return !!tidy && !!heap && combat?.targets[binding.heapId]?.phase === "heap" && (!combat.targets[binding.tidyId] || combat.targets[binding.tidyId]!.phase === "active");
  });
  for (const binding of effectState.bindings) {
    const tidy = physical(binding.tidyId), heap = physical(binding.heapId);
    if (!tidy || !heap || combat?.targets[binding.heapId]?.phase !== "heap") continue;
    applyPose(binding.heapId, { x: tidy.x, y: tidy.y + 0.4, z: tidy.z }, tidy.speed);
  }
  // Ownership is revoked by recovery or loss of the actual thief, not by a timer.
  effectState.carClaims = effectState.carClaims.filter(claim => {
    const playerId = claim.carId.startsWith("car:") ? claim.carId.slice(4) : "";
    const player = players[playerId], thief = physical(claim.actorId);
    const target = combat?.targets[claim.actorId];
    const active = !!player && player.mode === "foot" && !!thief && (!target || target.phase === "active") && !("firmware" in thief && thief.firmware !== "bad");
    if (!active && player?.mode === "foot") players[playerId] = { ...player, car: { ...player.car, speed: 0, lateral: 0, yawRate: 0 } };
    return active;
  });
  for (const terms of [...effectState.terms]) {
    if (terms.activeUntil > 0 && terms.activeUntil <= after.tick) continue;
    if (!termsAllowed(terms.actorId, terms.playerId)) { cancelTerms(terms.id, terms.actorId, terms.playerId); continue; }
    if (terms.activeUntil > after.tick && ((inputs[terms.playerId]?.actions ?? 0) & Action.interact) !== 0 && combat?.targets[terms.playerId]) {
      combat.targets[terms.playerId]!.stoppedUntil = after.tick;
      terms.activeUntil = after.tick;
    }
  }
  effectState.terms = effectState.terms.filter(t => t.activeUntil === 0 || t.activeUntil > after.tick);
  for (const e of effects) {
    if (!e.id || e.id.length > 180 || !e.kind) { effectState.diagnostics.push("invalid-effect-id"); continue; }
    if (effectState.applied.includes(e.id)) { if (!effectState.acks.includes(e.id)) effectState.acks.push(e.id); continue; }
    const sourceBody = physical(e.actorId), targetBody = physical(e.targetId);
    if (e.kind === "theft.claim") {
      const player = players[e.playerId], existing = effectState.carClaims.find(c => c.carId === e.targetId);
      const thief = source.routines.specials.find(s => s.body.id === e.actorId && s.role === "thief")?.theft;
      if (!player?.foot || player.mode !== "foot" || !sourceBody || thief?.phase !== "claim" || thief.carId !== e.targetId || thief.sequence !== e.amount || after.tick - thief.startedTick < 3 * TICK_HZ ||
          e.targetId !== `car:${e.playerId}` || Math.abs(player.car.speed) >= 0.1 || d2(player.foot, player.car) <= 900 || d2(sourceBody, player.car) > 4 ||
          (combat?.targets[e.actorId] && combat.targets[e.actorId]!.phase !== "active") || ("firmware" in sourceBody && sourceBody.firmware !== "bad") ||
          !Number.isSafeInteger(e.amount) || e.amount < 1 || (!existing && effectState.carClaims.length >= 128) || (existing && (existing.actorId !== e.actorId || existing.sequence !== e.amount))) continue;
      if (!existing) effectState.carClaims.push({ actorId: e.actorId, carId: e.targetId, sequence: e.amount, tick: after.tick });
      ack(e);
    } else if (e.kind === "theft.release") {
      const claim = effectState.carClaims.find(c => c.carId === e.targetId && c.actorId === e.actorId);
      if (!claim) {
        const player = players[e.playerId];
        if (e.targetId === `car:${e.playerId}` && player && !effectState.carClaims.some(c => c.carId === e.targetId) && (player.mode === "vehicle" || Math.abs(player.car.speed) < 0.1)) ack(e);
        continue;
      }
      effectState.carClaims = effectState.carClaims.filter(c => c !== claim);
      const player = players[e.playerId];
      if (player?.mode === "foot") players[e.playerId] = { ...player, car: { ...player.car, speed: 0, lateral: 0, yawRate: 0 } };
      ack(e);
    } else if (e.kind === "heap.attach") {
      const existing = effectState.bindings.find(b => b.heapId === e.targetId);
      if (!sourceBody || !targetBody || source.routines.specials.find(s => s.body.id === e.actorId)?.role !== "tidy" || combat?.targets[e.targetId]?.phase !== "heap" || d2(sourceBody, targetBody) > 4 || (existing && existing.tidyId !== e.actorId) || effectState.bindings.length >= 128) continue;
      if (!effectState.bindings.some(b => b.heapId === e.targetId)) effectState.bindings.push({ heapId: e.targetId, tidyId: e.actorId });
      applyPose(e.targetId, { x: sourceBody.x, y: sourceBody.y + 0.4, z: sourceBody.z }, sourceBody.speed);
      ack(e);
    } else if (e.kind === "heap.remove" || e.kind === "heap.restore") {
      if (!sourceBody || !targetBody || !atKiosk(sourceBody) || combat?.targets[e.targetId]?.phase !== "heap" || !effectState.bindings.some(b => b.heapId === e.targetId && b.tidyId === e.actorId)) continue;
      const id = robotAgentId(e.targetId);
      if (e.kind === "heap.restore") {
        const at = { x: sourceBody.x + 1, y: meshGroundHeight(world, sourceBody.x + 1, sourceBody.z), z: sourceBody.z };
        if (!safePoint(e.targetId, at)) continue;
        applyPose(e.targetId, at); combat.targets[e.targetId] = initialTarget();
        const extra = bodies.find(b => b.id === e.targetId); if (extra) { extra.firmware = "good"; extra.operational = true; }
        if (id !== null) restored.add(id);
      } else {
        const li = list.findIndex(a => a.id === id); if (li >= 0) list.splice(li, 1);
        const bi = bodies.findIndex(b => b.id === e.targetId); if (bi >= 0) bodies.splice(bi, 1);
        combat.targets[e.targetId] = { ...combat.targets[e.targetId]!, phase: "cleared" };
        if (id !== null) retired.add(id);
      }
      effectState.bindings = effectState.bindings.filter(b => b.heapId !== e.targetId);
      ack(e);
    } else if (e.kind === "recruit.restore-at-safehouse") {
      const arrival = source.restorationArrivals?.find(a => a.effectId === e.id && a.actorId === e.actorId && a.playerId === e.playerId && a.sequence === e.amount);
      const house = arrival && source.restoreSafehouses?.find(h => h.id === arrival.safehouseId);
      const radius = house?.radiusM ?? 3;
      if (!arrival || !house || !sourceBody || !combat || !poseFinite(arrival.position) || d2(sourceBody, arrival.position) > 0.01 || Math.abs(sourceBody.y - arrival.position.y) > 0.1 || d2(sourceBody, house) > radius * radius || !safePoint(e.actorId, { x: sourceBody.x, y: sourceBody.y, z: sourceBody.z })) continue;
      combat.targets[e.actorId] = initialTarget();
      const restoredBody = bodies.find(b => b.id === e.actorId);
      if (restoredBody) { restoredBody.firmware = "good"; restoredBody.operational = true; }
      const restoredId = robotAgentId(e.actorId); if (restoredId !== null) restored.add(restoredId);
      applyPose(e.actorId, { x: sourceBody.x, y: sourceBody.y, z: sourceBody.z });
      ack(e);
    } else if (e.kind === "recruit.spot") {
      const player = combat?.players[e.playerId];
      const targetFirmware = targetBody && "firmware" in targetBody ? targetBody.firmware : undefined;
      if (!player || !sourceBody || !targetBody || targetFirmware === "good" || targetFirmware === "none" || d2(sourceBody, targetBody) > 400 || !canSee(sourceBody, targetBody) || !Number.isSafeInteger(e.amount) || e.amount <= after.tick || e.amount > after.tick + 30 * TICK_HZ) continue;
      player.marks = [...player.marks.filter(m => m.targetId !== e.targetId && m.untilTick > after.tick), { targetId: e.targetId, untilTick: e.amount, confidence: 1, hallucination: false }].slice(-64);
      ack(e);
    } else if (e.kind === "body.rebind") {
      const player = after.players[e.playerId];
      if (!player?.foot || player.mode !== "foot" || !e.position || d2(player.foot, e.position) > 0.01 || Math.abs(player.foot.y - e.position.y) > 0.1 || !safePoint(`player:${e.playerId}`, e.position, 0.35)) continue;
      if (sortedIds(after.players).some(id => { const p = after.players[id]!; return p.id !== e.playerId && d2(p.mode === "foot" && p.foot ? p.foot : p.car, e.position!) < 150 * 150; })) continue;
      if (!combat) continue;
      if (combat.targets[e.playerId]) combat.targets[e.playerId] = initialTarget();
      if (combat.targets[`player:${e.playerId}`]) combat.targets[`player:${e.playerId}`] = initialTarget();
      ack(e);
    } else if (e.kind === "patrol.terms") {
      if (!termsAllowed(e.actorId, e.playerId)) { cancelTerms(e.id, e.actorId, e.playerId); continue; }
      if (!combat) continue;
      let windup = effectState.terms.find(t => t.id === e.id);
      if (!windup) { windup = { id: e.id, actorId: e.actorId, playerId: e.playerId, startedTick: after.tick, activeUntil: 0 }; effectState.terms.push(windup); }
      if (((inputs[e.playerId]?.actions ?? 0) & Action.interact) !== 0) { effectState.terms = effectState.terms.filter(t => t.id !== e.id); ack(e); continue; }
      if (after.tick - windup.startedTick < TICK_HZ) continue;
      const target = combat.targets[e.playerId] ?? initialTarget();
      combat.targets[e.playerId] = { ...target, stoppedUntil: Math.max(target.stoppedUntil, after.tick + 2 * TICK_HZ) };
      windup.activeUntil = after.tick + 2 * TICK_HZ; ack(e);
    } else if (e.kind === "firmware-freeze" || e.kind === "tuesday-siren") {
      const held = sortedIds(source.routineOutput.actorMetadata).filter(id => source.routineOutput!.actorMetadata[id]!.speed === 0).map(id => physical(id)).filter(b => b !== undefined);
      if (held.every(b => b.speed === 0)) ack(e);
    } else if (e.kind.startsWith("finale.")) {
      const finale = source.routines.finales.find(f => f.body.id === e.actorId);
      const pending = finale?.state.pendingEffects.find(p => p.id === e.id);
      if (!finale || !pending) continue;
      if (pending.kind === "impact" || pending.kind === "shed-robots") {
        const waypoint = pending.kind === "impact" ? finale.route.waypoints.find(w => w.id === pending.waypointId) : finale.route.waypoints[Math.max(0, finale.state.waypointIndex - 1)];
        if (!waypoint || !routineFinaleBodyClear(finale.state.kind, waypoint, protectors()) || !finaleFootfallClear(finale.state.kind, waypoint, { tick: after.tick, complete: true, bodies: protectors() }, after.tick)) continue;
      }
      if (pending.kind === "shed-robots") {
        if (significantOccupancy() + pending.count > 2000) { effectState.diagnostics.push("finale-significant-capacity"); continue; }
        const placed = spawnShed(world, nextId, pending, list, bodies, protectors());
        if (!placed) { effectState.diagnostics.push("finale-shed-awaits-safe-space"); continue; }
        nextId += placed.length; list.push(...placed);
        shedThisTick += placed.length;
        runtime.significantAgentIds.push(...placed.map(a => a.id)); runtime.deliveredAgentIds.push(...placed.map(a => a.id));
      } else if (pending.kind === "restore-robots") {
        if (!combat || pending.robotIds.some(id => !physical(id))) { effectState.diagnostics.push("finale-restore-needs-physical-identities"); continue; }
        for (const id of pending.robotIds) {
          combat.targets[id] = initialTarget();
          const number = robotAgentId(id); if (number !== null) restored.add(number);
          const body = bodies.find(b => b.id === id); if (body) { body.firmware = "good"; body.operational = true; }
        }
      } else if (pending.kind === "finale-complete" && finale.state.status !== "complete") continue;
      ack(e);
    } else {
      // Transport owns real seat reservations, boarding and taxi journeys. The unfinished
      // requests stay pending instead of being acknowledged as completed trips.
      effectState.diagnostics.push(`unhandled:${e.kind}`);
    }
  }
  effectState.acks = [...new Set(effectState.acks)].slice(-MAX_EFFECTS);
  effectState.applied = [...new Set(effectState.applied)].slice(-512);
  effectState.events = effectState.events.slice(-MAX_EFFECTS);
  effectState.diagnostics = [...new Set(effectState.diagnostics)].sort(compare).slice(0, 64);
  runtime.significantAgentIds = [...new Set(runtime.significantAgentIds)].filter(id => !retired.has(id)).sort((a, b) => a - b);
  runtime.deliveredAgentIds = [...new Set(runtime.deliveredAgentIds)].filter(id => !retired.has(id)).sort((a, b) => a - b);
  const robots = { ...(after.ext.robots ?? {}), restoredAgentIds: [...new Set([...(Array.isArray(after.ext.robots?.restoredAgentIds) ? after.ext.robots.restoredAgentIds as number[] : []), ...restored])].sort((a, b) => a - b), retiredAgentIds: [...new Set([...(Array.isArray(after.ext.robots?.retiredAgentIds) ? after.ext.robots.retiredAgentIds as number[] : []), ...retired])].sort((a, b) => a - b) };
  const nextAgents: ExtendedAgents = { ...current, nextId, list: list.sort((a, b) => a.id - b.id), runtime };
  return { ...after, players, ext: { ...after.ext, agents: nextAgents, robots, ...(combat ? { combat } : {}) } };
}

/** Call only after the final mixed-body clearance pass. No motion occurs here. */
export function recordRoutineLandingReceipts(world: World, state: SimState): SimState {
  const agents = state.ext.agents as ExtendedAgents | undefined, runtime = agents?.runtime;
  if (!agents || !runtime?.routines || !runtime.effectState) return state;
  const protectedBodies = [
    ...agents.list.filter(a => a.kind === "person").map(a => ({ id: `agent:${a.id}`, kind: "person" as const, x: a.x, z: a.z, radius: 0.35 })),
    ...runtime.bodies.filter(b => b.kind === "person" || b.kind === "animal" || ["bus", "recruit-taxi", "associate-car", "associate-scooter"].includes(b.model)).map(b => ({ id: b.id, kind: b.kind === "animal" ? "animal" as const : "person" as const, x: b.x, z: b.z, radius: ["bus", "recruit-taxi", "associate-car", "associate-scooter"].includes(b.model) ? Math.sqrt(b.halfLength * b.halfLength + b.halfWidth * b.halfWidth) : b.radius })),
    ...sortedIds(state.players).map(id => state.players[id]!).map(p => { const at = p.mode === "foot" && p.foot ? p.foot : p.car; return { id: `player:${p.id}`, kind: "person" as const, x: at.x, z: at.z, radius: p.mode === "foot" ? 0.35 : 2.4 }; }),
  ];
  const landingReceipts: FinaleLandingAck[] = [];
  for (const finale of runtime.routines.finales) {
    const landing = finale.state.landing, body = runtime.bodies.find(b => b.id === finale.body.id);
    const waypoint = finale.route.waypoints[finale.state.waypointIndex];
    if (!landing || !body || !waypoint || d2(body, waypoint) > 0.0001 || circleBlocked(world, body.x, body.z, finale.state.kind === "walker" ? 4.5 : body.radius) || Math.abs(body.y - meshGroundHeight(world, body.x, body.z)) > 0.05 ||
        !routineFinaleBodyClear(finale.state.kind, waypoint, protectedBodies) || !finaleFootfallClear(finale.state.kind, waypoint, { tick: state.tick, complete: true, bodies: protectedBodies }, state.tick)) continue;
    landingReceipts.push({ requestId: landing.id, tick: state.tick, x: body.x, z: body.z, clear: true });
  }
  const nextAgents: ExtendedAgents = { ...agents, runtime: { ...runtime, effectState: { ...runtime.effectState, landingReceipts } } };
  return { ...state, ext: { ...state.ext, agents: nextAgents } };
}

function spawnShed(world: World, nextId: number, effect: Extract<FinaleEffect, { kind: "shed-robots" }>, existing: readonly AgentState[], bodies: readonly RuntimePhysicalBody[], protectedBodies: readonly { x: number; z: number; radius: number }[]): AgentState[] | null {
  if (!Number.isSafeInteger(nextId) || nextId < 0 || nextId + effect.count > Number.MAX_SAFE_INTEGER || effect.count > 8) return null;
  const candidates: { edge: string; s: number; x: number; z: number; heading: number }[] = [];
  for (const edge of world.roads?.edges ?? []) {
    if (!edge.walkable || !edge.walkClear[0][0]) continue;
    const path = walkPath(edge, 1, 1);
    for (let s = 0; s <= path.len; s += 4) {
      const p = pathPoint(path, s);
      if (d2(p, effect) > ((50) * (50)) || circleBlocked(world, p.x, p.z, 0.45) || protectedBodies.some(b => d2(b, p) < (((b.radius + 1.2)) * ((b.radius + 1.2)))) || bodies.some(b => d2(b, p) < (((b.radius + 1.2)) * ((b.radius + 1.2)))) || existing.some(a => d2(a, p) < 2.25)) continue;
      candidates.push({ edge: edge.id, s, x: p.x, z: p.z, heading: datan2(p.tx, -p.tz) });
    }
  }
  candidates.sort((a, b) => d2(a, effect) - d2(b, effect) || compare(a.edge, b.edge) || a.s - b.s);
  const selected: typeof candidates = [];
  for (const p of candidates) { if (selected.every(other => d2(other, p) >= 2.25)) selected.push(p); if (selected.length === effect.count) break; }
  if (selected.length !== effect.count) return null;
  return selected.map((p, index): AgentState => ({ id: nextId + index, kind: "errandRobot", x: p.x, y: meshGroundHeight(world, p.x, p.z), z: p.z, heading: p.heading, pitch: 0, speed: 0, vmax: 1.6, edge: p.edge, dir: 1, lane: 1, s: p.s, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: hash32(nextId + index, 8), dodge: null }));
}
