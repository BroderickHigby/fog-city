import { clamp } from "../dmath.ts";
import { sortedIds } from "../contract.ts";
import type { CombatEvent } from "../combat-contract.ts";
import type { MatchEvent, MatchPosition } from "./types.ts";

export const ROYALE_RULES = { phases: 5, holdTicks: 90 * 60, closeTicks: 60 * 60, fleeceTicks: 60 * 60, pairTicks: 20 * 60, duelTimeoutTicks: 120 * 60, maxPlayers: 8 } as const;
export interface RoyaleCircle { x: number; z: number; radius: number }
export interface RoyaleLandmark extends RoyaleCircle { id: string }
export interface RoyaleCrate extends MatchPosition { id: string; kind: "fleece" | "cloud-credit"; claimedBy: string }
export interface RoyalePlayer { id: string; bot: boolean; runway: number; score: number; status: "active" | "duel-wait" | "duel" | "redeploy" | "spectating"; bridgeUsed: boolean; duelUsed: boolean; fogCharge: number; fleeceUntil: number; queuedAt: number }
export interface RoyaleDuel { id: string; players: string[]; associateId: string; startedAt: number; complete: boolean }
export interface RoyaleRedeploy { id: string; playerId: string; x: number; z: number }
export interface RoyaleState {
  version: 1; id: string; seed: number; tick: number; elapsedTicks: number; phase: "active" | "finished";
  circles: RoyaleCircle[]; finalLandmarkId: string; players: Record<string, RoyalePlayer>; crates: RoyaleCrate[];
  duels: RoyaleDuel[]; pendingRedeploys: RoyaleRedeploy[]; creditedBad: string[];
  lastCombatTick: number; lastCombatId: number; lastDuelSequence: number; nextEventId: number;
  events: MatchEvent[]; result: { winners: string[]; reason: string } | null;
}
export interface RoyaleConfig {
  id: string; seed: number; playerIds: readonly string[]; solo?: boolean; tick?: number;
  initialCircle: RoyaleCircle; finalLandmarks: readonly RoyaleLandmark[];
  crates?: readonly Omit<RoyaleCrate, "claimedBy">[];
}
export interface RoyaleInput { crateId?: string }
export interface RoyaleDuelResult { sequence: number; duelId: string; winnerId: string }
/** Core supplies only accepted physical taxi placements. The ID echoes a pending request. */
export interface RoyaleAcceptedRedeploy extends MatchPosition { id: string; playerId: string }
export interface RoyaleContext {
  tick?: number; paused?: boolean; positions: Readonly<Record<string, MatchPosition>>;
  inputs?: Readonly<Record<string, RoyaleInput>>; combatEvents?: readonly CombatEvent[];
  badRobotIds?: readonly string[];
  duelResults?: readonly RoyaleDuelResult[]; acceptedRedeploys?: readonly RoyaleAcceptedRedeploy[];
}
export interface RoyaleBotIntent { playerId: string; target: { x: number; z: number }; flowerTargetId?: string; crateId?: string }
export interface RoyaleDuelRequest { id: string; playerIds: string[]; opponentId: string }
export interface RoyaleOutput { state: RoyaleState; circle: RoyaleCircle; anchors: string[]; botIntents: RoyaleBotIntent[]; duelRequests: RoyaleDuelRequest[]; redeployRequests: RoyaleRedeploy[] }

const validId = (id: string): boolean => /^[A-Za-z0-9:_-]{1,96}$/.test(id) && !Object.hasOwn(Object.prototype, id) && id !== "prototype";
const finitePosition = (p: MatchPosition | undefined): p is MatchPosition => !!p && [p.x, p.y, p.z].every(Number.isFinite);
const distanceSq = (a: { x: number; z: number }, b: { x: number; z: number }): number => { const x = a.x - b.x, z = a.z - b.z; return x * x + z * z; };
const hash = (value: string): number => { let out = 2166136261; for (let i = 0; i < value.length; i++) out = Math.imul(out ^ value.charCodeAt(i), 16777619); return out >>> 0; };
const validCircle = (circle: RoyaleCircle): boolean => [circle.x, circle.z, circle.radius].every(Number.isFinite) && circle.radius > 0;
function emit(s: RoyaleState, kind: string, playerId = "", targetId = "", amount = 0, detail = ""): void { s.events.push({ id: s.nextEventId++, tick: s.tick, kind, playerId, targetId, amount, detail }); }

/** The caller's landmark list is already filtered to built, playable world geometry. */
export function createRoyale(config: RoyaleConfig): RoyaleState {
  if (!validId(config.id) || !Number.isSafeInteger(config.seed) || !validCircle(config.initialCircle) || !config.finalLandmarks.length) throw new Error("Invalid Royale arena");
  const landmarks = [...config.finalLandmarks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (landmarks.some((l) => !validId(l.id) || !validCircle(l) || Math.sqrt(distanceSq(l, config.initialCircle)) + l.radius > config.initialCircle.radius + 1e-6) || new Set(landmarks.map((l) => l.id)).size !== landmarks.length) throw new Error("Royale final circles must be nested inside the built arena");
  const ids = [...config.playerIds].sort();
  if (!ids.length || ids.length > ROYALE_RULES.maxPlayers || new Set(ids).size !== ids.length || ids.some((id) => !validId(id)) || config.solo && ids.length !== 1) throw new Error("Invalid Royale founders");
  const humanIds = new Set(ids);
  if (config.solo) for (let i = 0; i < 7; i++) { const id = `royale-bot:${i}`; if (humanIds.has(id)) throw new Error("Reserved Royale bot ID"); ids.push(id); }
  const last = landmarks[hash(`${config.id}:${config.seed}`) % landmarks.length]!;
  const circles = [{ ...config.initialCircle }];
  for (let i = 1; i <= ROYALE_RULES.phases; i++) { const t = i / ROYALE_RULES.phases; circles.push({ x: config.initialCircle.x + (last.x - config.initialCircle.x) * t, z: config.initialCircle.z + (last.z - config.initialCircle.z) * t, radius: config.initialCircle.radius + (last.radius - config.initialCircle.radius) * t }); }
  const crates = [...(config.crates ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((crate) => ({ ...crate, claimedBy: "" }));
  if (crates.length > 256 || new Set(crates.map((c) => c.id)).size !== crates.length || crates.some((c) => !validId(c.id) || !finitePosition(c) || (c.kind !== "fleece" && c.kind !== "cloud-credit"))) throw new Error("Invalid Royale crates");
  const tick = config.tick ?? 0; if (!Number.isSafeInteger(tick) || tick < 0) throw new Error("Invalid Royale tick");
  return { version: 1, id: config.id, seed: config.seed, tick, elapsedTicks: 0, phase: "active", circles, finalLandmarkId: last.id,
    players: Object.fromEntries(ids.sort().map((id) => [id, { id, bot: !humanIds.has(id), runway: 18, score: 0, status: "active", bridgeUsed: false, duelUsed: false, fogCharge: 0, fleeceUntil: 0, queuedAt: 0 }])), crates,
    duels: [], pendingRedeploys: [], creditedBad: [], lastCombatTick: -1, lastCombatId: 0, lastDuelSequence: 0, nextEventId: 1, events: [], result: null };
}

export function royaleCircle(state: Pick<RoyaleState, "circles" | "elapsedTicks">): RoyaleCircle {
  const phaseTicks = ROYALE_RULES.holdTicks + ROYALE_RULES.closeTicks;
  const phase = Math.min(ROYALE_RULES.phases - 1, Math.floor(state.elapsedTicks / phaseTicks));
  const progress = clamp((state.elapsedTicks - phase * phaseTicks - ROYALE_RULES.holdTicks) / ROYALE_RULES.closeTicks, 0, 1);
  const start = state.circles[phase]!, end = state.circles[phase + 1]!;
  return { x: start.x + (end.x - start.x) * progress, z: start.z + (end.z - start.z) * progress, radius: start.radius + (end.radius - start.radius) * progress };
}

function copy(previous: RoyaleState, tick: number): RoyaleState {
  return { ...previous, tick, players: Object.fromEntries(sortedIds(previous.players).map((id) => [id, { ...previous.players[id]! }])), circles: previous.circles.map((c) => ({ ...c })), crates: previous.crates.map((c) => ({ ...c })), duels: previous.duels.map((d) => ({ ...d, players: [...d.players] })), pendingRedeploys: previous.pendingRedeploys.map((r) => ({ ...r })), creditedBad: [...previous.creditedBad], events: [], result: previous.result ? { ...previous.result, winners: [...previous.result.winners] } : null };
}

function combat(state: RoyaleState, context: RoyaleContext): void {
  const batch = [...(context.combatEvents ?? [])].filter((e) => Number.isSafeInteger(e.id) && e.id > 0 && Number.isSafeInteger(e.tick) && e.tick <= state.tick && (e.tick > state.lastCombatTick || e.tick === state.lastCombatTick && e.id > state.lastCombatId)).sort((a, b) => a.tick - b.tick || a.id - b.id);
  for (const event of batch) {
    if (event.tick < state.lastCombatTick || event.tick === state.lastCombatTick && event.id <= state.lastCombatId) continue;
    state.lastCombatTick = event.tick; state.lastCombatId = event.id;
    const source = state.players[event.sourceId], target = state.players[event.targetId];
    if (event.kind === "player.runway" && target?.status === "active" && Number.isFinite(event.amount)) target.runway = clamp(target.runway + event.amount, 0, 18);
    if (event.kind === "pvp.score" && event.detail === "flower" && source?.status === "active") { source.score += 150; emit(state, "royale.score", source.id, "", 150, "flower"); }
    if (event.kind === "robot.heap" && source?.status === "active" && context.badRobotIds?.includes(event.targetId) && validId(event.targetId) && !state.players[event.targetId] && !state.creditedBad.includes(event.targetId)) { state.creditedBad.push(event.targetId); source.runway = Math.min(18, source.runway + 1); source.score += 100; emit(state, "royale.score", source.id, event.targetId, 100, "melt"); }
  }
}

function requestRedeploy(state: RoyaleState, playerId: string, circle: RoyaleCircle, context: RoyaleContext): void {
  const player = state.players[playerId]!, point = context.positions[playerId];
  const dx = point ? point.x - circle.x : 1, dz = point ? point.z - circle.z : 0, length = Math.sqrt(dx * dx + dz * dz);
  const radius = Math.max(0, circle.radius - 2), scale = length > 1e-9 ? radius / length : 0;
  const request = { id: `redeploy:${hash(state.id)}:${hash(playerId)}:${state.elapsedTicks}`, playerId, x: circle.x + (length > 1e-9 ? dx * scale : radius), z: circle.z + dz * scale };
  state.pendingRedeploys.push(request); player.status = "redeploy";
  emit(state, "royale.redeploy-request", playerId, request.id, 6);
}

function recoveries(state: RoyaleState, context: RoyaleContext, circle: RoyaleCircle): void {
  for (const result of [...(context.duelResults ?? [])].sort((a, b) => a.sequence - b.sequence)) {
    if (!Number.isSafeInteger(result.sequence) || result.sequence <= state.lastDuelSequence) continue;
    const duel = state.duels.find((d) => d.id === result.duelId && !d.complete);
    if (!duel || !duel.players.includes(result.winnerId)) continue;
    state.lastDuelSequence = result.sequence; duel.complete = true;
    for (const id of duel.players) {
      if (id === result.winnerId) requestRedeploy(state, id, circle, context);
      else { state.players[id]!.status = "spectating"; emit(state, "royale.eliminated", id, "", 0, "duel"); }
    }
  }
  for (const accepted of [...(context.acceptedRedeploys ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const request = state.pendingRedeploys.find((r) => r.id === accepted.id && r.playerId === accepted.playerId);
    const player = state.players[accepted.playerId], body = context.positions[accepted.playerId];
    if (!request || player?.status !== "redeploy" || !finitePosition(accepted) || !finitePosition(body)) continue;
    const edgeDistance = Math.sqrt(distanceSq(accepted, circle));
    const dy = accepted.y - body.y;
    if (Math.abs(edgeDistance - circle.radius) > Math.min(8, circle.radius / 2) || distanceSq(accepted, body) + dy * dy > 1) continue;
    state.pendingRedeploys = state.pendingRedeploys.filter((r) => r !== request);
    player.status = "active"; player.runway = 6; player.fogCharge = 0;
    emit(state, "royale.redeployed", player.id, request.id, 6);
  }
  for (const duel of state.duels) if (!duel.complete && state.elapsedTicks - duel.startedAt > ROYALE_RULES.duelTimeoutTicks) {
    duel.complete = true;
    for (const id of duel.players) { state.players[id]!.status = "spectating"; emit(state, "royale.eliminated", id, "", 0, "duel-timeout"); }
  }
}

function startDuel(state: RoyaleState, ids: string[]): void {
  const duel = { id: `duel:${hash(state.id)}:${state.elapsedTicks}:${hash(ids.join(":"))}`, players: [...ids].sort(), associateId: ids.length === 1 ? `associate:${hash(ids[0]!)}` : "", startedAt: state.elapsedTicks, complete: false };
  state.duels.push(duel);
  for (const id of ids) { state.players[id]!.status = "duel"; emit(state, "royale.duel-request", id, duel.id); }
}

function zeroRunway(state: RoyaleState): void {
  for (const id of sortedIds(state.players)) {
    const player = state.players[id]!;
    if (player.status !== "active" || player.runway > 0) continue;
    emit(state, "royale.streak-reset", id);
    if (!player.bridgeUsed) { player.bridgeUsed = true; player.runway = 6; player.fogCharge = 0; emit(state, "royale.bridge-round", id, "", 6); }
    else if (!player.duelUsed) { player.duelUsed = true; player.status = "duel-wait"; player.queuedAt = state.elapsedTicks; emit(state, "royale.duel-wait", id); }
    else { player.status = "spectating"; emit(state, "royale.eliminated", id, "", 0, "runway"); }
  }
  const waiting = sortedIds(state.players).filter((id) => state.players[id]!.status === "duel-wait").sort((a, b) => state.players[a]!.queuedAt - state.players[b]!.queuedAt || (a < b ? -1 : 1));
  while (waiting.length >= 2) { const first = waiting[0]!, second = waiting[1]!; if (state.players[second]!.queuedAt - state.players[first]!.queuedAt > ROYALE_RULES.pairTicks) break; waiting.splice(0, 2); startDuel(state, [first, second]); }
  for (const id of waiting) if (state.elapsedTicks - state.players[id]!.queuedAt >= ROYALE_RULES.pairTicks) startDuel(state, [id]);
}

function botIntents(state: RoyaleState, context: RoyaleContext, circle: RoyaleCircle): RoyaleBotIntent[] {
  return sortedIds(state.players).filter((id) => state.players[id]!.bot && state.players[id]!.status === "active").map((id) => {
    const point = context.positions[id]!;
    const crates = state.crates.filter((c) => !c.claimedBy && distanceSq(c, circle) <= circle.radius * circle.radius).sort((a, b) => distanceSq(a, point) - distanceSq(b, point) || (a.id < b.id ? -1 : 1));
    const crate = crates[0], target = crate && distanceSq(point, circle) < circle.radius * circle.radius ? { x: crate.x, z: crate.z } : { x: circle.x, z: circle.z };
    const rivals = sortedIds(state.players).filter((other) => other !== id && state.players[other]!.status === "active" && distanceSq(point, context.positions[other]!) <= 20 * 20).sort((a, b) => distanceSq(point, context.positions[a]!) - distanceSq(point, context.positions[b]!) || (a < b ? -1 : 1));
    return { playerId: id, target, ...(rivals[0] ? { flowerTargetId: rivals[0] } : {}), ...(crate && distanceSq(point, crate) <= 9 ? { crateId: crate.id } : {}) };
  });
}

/** No free-roam state is accepted. Bot intents and redeploy requests need core's physical adapter. */
export function stepRoyale(previous: RoyaleState, context: RoyaleContext): RoyaleOutput {
  const tick = context.tick ?? previous.tick + 1;
  if (previous.version !== 1 || !Number.isSafeInteger(tick) || tick <= previous.tick) throw new Error("Invalid Royale tick");
  const state = copy(previous, tick);
  const output = (): RoyaleOutput => {
    const running = state.phase === "active" && !context.paused;
    return { state, circle: royaleCircle(state), anchors: sortedIds(state.players).filter((id) => state.players[id]!.status !== "spectating"), botIntents: running ? botIntents(state, context, royaleCircle(state)) : [], duelRequests: running ? state.duels.filter((d) => !d.complete).map((d) => ({ id: d.id, playerIds: [...d.players], opponentId: d.associateId })) : [], redeployRequests: running ? state.pendingRedeploys.map((r) => ({ ...r })) : [] };
  };
  if (state.phase === "finished" || context.paused) return output();
  for (const id of sortedIds(state.players)) if (state.players[id]!.status === "active" && !finitePosition(context.positions[id])) throw new Error(`Missing accepted Royale pose: ${id}`);
  state.elapsedTicks++;
  const circle = royaleCircle(state);
  combat(state, context); recoveries(state, context, circle);
  for (const id of sortedIds(state.players)) {
    const player = state.players[id]!, point = context.positions[id]; if (player.status !== "active") continue;
    if (!finitePosition(point)) throw new Error(`Missing redeployed Royale pose: ${id}`);
    if (distanceSq(point, circle) > circle.radius * circle.radius) {
      player.fogCharge += state.elapsedTicks < player.fleeceUntil ? 1 : 2;
      if (player.fogCharge >= 360) { player.fogCharge -= 360; player.runway = Math.max(0, player.runway - 1); emit(state, "royale.fog-drain", id, "", 1); }
    }
    const crateId = context.inputs?.[id]?.crateId;
    const crate = crateId && state.crates.find((c) => c.id === crateId && !c.claimedBy);
    if (crate && distanceSq(point, crate) + (point.y - crate.y) * (point.y - crate.y) <= 9) {
      crate.claimedBy = id; player.score += 50;
      if (crate.kind === "fleece") player.fleeceUntil = state.elapsedTicks + ROYALE_RULES.fleeceTicks;
      else player.runway = Math.min(18, player.runway + 3);
      emit(state, "royale.crate", id, crate.id, 50, crate.kind);
    }
  }
  zeroRunway(state);
  const remaining = sortedIds(state.players).filter((id) => state.players[id]!.status !== "spectating");
  if (remaining.length === 0 || remaining.length === 1 && state.players[remaining[0]!]!.status === "active") {
    state.phase = "finished"; state.result = { winners: remaining, reason: remaining.length ? "last-founder" : "no-founders" }; emit(state, "royale.finished", remaining[0] ?? "");
  }
  return output();
}
