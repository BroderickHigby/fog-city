import { initialTarget, emit, protectedActor } from "./shared.ts";
import { lineOfSight } from "./physics.ts";
import type { CombatActor, CombatContext, CombatState, MaintenanceChannel, MaintenanceRequest } from "./types.ts";

export const MAINTENANCE = { range: 3, floorTolerance: 1.25, maxWorkerSpeed: 0.1, collectTicks: 180, restoreTicks: 3600 } as const;
const validId = (id: string): boolean => !!id && id.length <= 128 && !Object.hasOwn(Object.prototype, id) && id !== "prototype";
function near(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return [dx, dy, dz].every(Number.isFinite) && Math.abs(dy) <= MAINTENANCE.floorTolerance && dx * dx + dy * dy + dz * dz <= MAINTENANCE.range * MAINTENANCE.range;
}
function sameRequest(a: MaintenanceRequest, b: MaintenanceRequest): boolean {
  return a.id === b.id && a.sequence === b.sequence && a.kind === b.kind && a.actorId === b.actorId && a.workerId === b.workerId && a.kioskId === b.kioskId;
}
function eligible(state: CombatState, ctx: CombatContext, request: MaintenanceRequest, actors: ReadonlyMap<string, CombatActor>): boolean {
  const worker = actors.get(request.workerId), actor = actors.get(request.actorId), target = state.targets[request.actorId];
  if (!worker || !actor || !target || actor.id === worker.id || worker.kind !== "robot" || worker.model !== "tidy" || worker.firmware !== "good" || worker.inFidelity !== true || protectedActor(worker) || !Number.isFinite(worker.speed) || Math.abs(worker.speed) > MAINTENANCE.maxWorkerSpeed) return false;
  const workerState = state.targets[worker.id];
  if ((workerState?.phase ?? "active") !== "active" || (workerState?.stoppedUntil ?? 0) > state.tick || (workerState?.blindUntil ?? 0) > state.tick || actor.kind !== "robot" || actor.inFidelity !== true || protectedActor(actor) || actor.model === "robotaxi" && actor.occupied || !near(worker, actor)) return false;
  if (!lineOfSight({ x: worker.x, y: worker.y + 0.3, z: worker.z }, { x: actor.x, y: actor.y + 0.3, z: actor.z }, ctx.walls)) return false;
  if (request.kind === "collect-heap") return target.phase === "heap";
  const kiosk = ctx.maintenanceKiosks?.find((k) => k.id === request.kioskId);
  const converted = target.converted === true;
  return !!kiosk && Number.isFinite(actor.speed) && Math.abs(actor.speed) <= MAINTENANCE.maxWorkerSpeed && near(worker, kiosk) && near(actor, kiosk) &&
    lineOfSight({ x: worker.x, y: worker.y + 0.3, z: worker.z }, { x: kiosk.x, y: kiosk.y + 0.3, z: kiosk.z }, ctx.walls) &&
    lineOfSight({ x: actor.x, y: actor.y + 0.3, z: actor.z }, { x: kiosk.x, y: kiosk.y + 0.3, z: kiosk.z }, ctx.walls) &&
    (converted && target.phase === "cleared" || target.repair && (target.phase === "active" || target.phase === "cleared" || target.phase === "disabled"));
}

/** Repeated intent is a continuous work channel, never trusted elapsed time from a caller. */
export function stepMaintenance(state: CombatState, ctx: CombatContext): void {
  if ((ctx.wave ?? 2) < 3) { if (state.maintenanceChannels) state.maintenanceChannels = {}; return; }
  if (!ctx.maintenance?.length && !state.maintenanceChannels) return;
  if ((ctx.maintenance?.length ?? 0) > 4096) throw new Error("Maintenance request budget exceeded");
  const actors = new Map(ctx.actors.map((a) => [a.id, a]));
  const old = state.maintenanceChannels ?? {};
  const channels: Record<string, MaintenanceChannel> = {};
  const cursors = state.maintenanceSequence ?? {};
  const requests = [...(ctx.maintenance ?? [])].sort((a, b) => a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : a.sequence - b.sequence || (a.id < b.id ? -1 : 1));
  const byWorker = new Map<string, MaintenanceRequest>();
  const conflicting = new Set<string>();
  for (const request of requests) {
    if (!validId(request.id) || !validId(request.workerId) || !validId(request.actorId) || !Number.isSafeInteger(request.sequence) || request.sequence < 1 || request.kind !== "collect-heap" && request.kind !== "restore") continue;
    const other = byWorker.get(request.workerId);
    if (other && !sameRequest(other, request)) conflicting.add(request.workerId);
    byWorker.set(request.workerId, request);
  }
  for (const [workerId, request] of byWorker) {
    const active = old[workerId];
    if (conflicting.has(workerId) || request.sequence <= (cursors[workerId] ?? 0) || active && request.sequence < active.sequence || !eligible(state, ctx, request, actors)) continue;
    if (active && active.sequence === request.sequence && !sameRequest(active, request)) continue;
    const continuous = active && sameRequest(active, request) && active.lastTick === state.tick - 1;
    const channel: MaintenanceChannel = { ...request, startedTick: continuous ? active.startedTick : state.tick, lastTick: state.tick };
    channels[workerId] = channel;
    const duration = request.kind === "collect-heap" ? MAINTENANCE.collectTicks : MAINTENANCE.restoreTicks;
    if (state.tick - channel.startedTick + 1 < duration) continue;
    const target = state.targets[request.actorId]!;
    if (request.kind === "collect-heap") {
      target.phase = "cleared"; target.heightScale = 0; target.puddle = false; target.movementScale = 0;
      emit(state, "robot.heap-cleared", workerId, request.actorId, duration, request.id);
    } else {
      state.targets[request.actorId] = { ...initialTarget(), phaseTick: state.tick };
      emit(state, "robot.restored", workerId, request.actorId, duration, request.id);
    }
    cursors[workerId] = request.sequence;
    delete channels[workerId];
  }
  state.maintenanceChannels = channels;
  state.maintenanceSequence = cursors;
}
