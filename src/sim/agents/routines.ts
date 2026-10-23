// Later-wave behavior reducers. They issue intents; the shared followers and final clearance
// pass retain movement authority. Observations and acknowledgements come from the live world.
import { TICK_HZ } from "../contract.ts";
import { clamp, datan2, dcos, dsin } from "../dmath.ts";
import { hash32 } from "../rng.ts";

export interface RoutinePoint { readonly x: number; readonly y: number; readonly z: number }
export interface RoutineActor extends RoutinePoint {
  readonly id: string;
  readonly kind: "player" | "robot" | "person" | "animal" | "vehicle";
  readonly heading: number;
  readonly speed: number;
  readonly operational: boolean;
  readonly firmware: "good" | "bad" | "none";
}
export interface RoutineMotion {
  readonly kind: "hold" | "follow" | "route";
  readonly target: RoutinePoint;
  readonly speedMps: number;
  readonly reason: string;
}

const byId = <T extends { readonly id: string }>(a: T, b: T): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const distance2 = (a: RoutinePoint, b: RoutinePoint): number => (((a.x - b.x)) * ((a.x - b.x))) + (((a.z - b.z)) * ((a.z - b.z)));
const copyPoint = (p: RoutinePoint): RoutinePoint => ({ x: p.x, y: p.y, z: p.z });
function uniqueIds(values: readonly { readonly id: string }[]): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (!value.id || value.id.length > 160 || ids.has(value.id)) throw new RangeError("Invalid or duplicate routine identity");
    ids.add(value.id);
  }
}
function tick(value: number, previous = -1): void {
  if (!Number.isSafeInteger(value) || value < 0 || value < previous) throw new RangeError("Invalid routine tick");
}
function point(value: RoutinePoint): void {
  if (![value.x, value.y, value.z].every(n => Number.isFinite(n) && Math.abs(n) <= 1e7)) throw new RangeError("Invalid routine position");
}
function actor(value: RoutineActor): void {
  point(value);
  if (!value.id || !Number.isFinite(value.heading) || Math.abs(value.heading) > 1e7 || !Number.isFinite(value.speed) || Math.abs(value.speed) > 1000) throw new RangeError("Invalid routine actor");
}
function hold(self: RoutinePoint, reason: string): RoutineMotion {
  return { kind: "hold", target: copyPoint(self), speedMps: 0, reason };
}

// ---- Clock-driven public routines ---------------------------------------------------------

export interface CalendarRoutineState {
  readonly lastTick: number;
  readonly lastGameSecond: number;
  readonly freezeDay: number;
  readonly freezeUntilTick: number;
  readonly sirenWeek: number;
  readonly sirenUntilTick: number;
}
export function createCalendarRoutines(): CalendarRoutineState {
  return { lastTick: -1, lastGameSecond: -1, freezeDay: -1, freezeUntilTick: -1, sirenWeek: -1, sirenUntilTick: -1 };
}
export interface CalendarRoutineInput {
  readonly tick: number;
  /** Monotonic seconds since a game Monday at midnight; never wall-clock time. */
  readonly gameSecond: number;
  readonly actors: readonly (RoutineActor & { readonly model: string; readonly district: string })[];
  readonly citywideFreeze?: boolean;
}
export interface CalendarRoutineResult {
  readonly state: CalendarRoutineState;
  readonly holds: readonly { readonly actorId: string; readonly untilTick: number; readonly reason: "firmware-update" | "siren" }[];
  readonly events: readonly { readonly id: string; readonly kind: "firmware-freeze" | "tuesday-siren" }[];
}
export function stepCalendarRoutines(previous: CalendarRoutineState, input: CalendarRoutineInput): CalendarRoutineResult {
  tick(input.tick, previous.lastTick);
  if (!Number.isFinite(input.gameSecond) || input.gameSecond < 0 || input.gameSecond < previous.lastGameSecond || input.actors.length > 2800) throw new RangeError("Invalid game calendar");
  uniqueIds(input.actors);
  const day = Math.floor(input.gameSecond / 86400);
  const week = Math.floor(day / 7);
  const freezeSecond = day * 86400 + 3 * 3600;
  const sirenSecond = week * 7 * 86400 + 86400 + 12 * 3600;
  const crossed = (second: number, duration: number): boolean => previous.lastGameSecond < second && input.gameSecond >= second && input.gameSecond - second < duration;
  let freezeDay = previous.freezeDay, freezeUntilTick = previous.freezeUntilTick;
  let sirenWeek = previous.sirenWeek, sirenUntilTick = previous.sirenUntilTick;
  const events: CalendarRoutineResult["events"][number][] = [];
  if (freezeDay !== day && crossed(freezeSecond, 20)) {
    freezeDay = day;
    // Calendar time triggers the event; installation lasts twenty simulation seconds,
    // regardless of how quickly the game calendar advances.
    freezeUntilTick = input.tick + 20 * TICK_HZ;
    events.push({ id: `firmware:${day}`, kind: "firmware-freeze" });
  }
  if (sirenWeek !== week && crossed(sirenSecond, 60)) {
    sirenWeek = week;
    sirenUntilTick = input.tick + 60 * TICK_HZ;
    events.push({ id: `siren:${week}`, kind: "tuesday-siren" });
  }
  const holds: CalendarRoutineResult["holds"][number][] = [];
  for (const a of [...input.actors].sort(byId)) {
    actor(a);
    if (!a.operational) continue;
    if (input.tick < freezeUntilTick && (a.kind === "robot" || a.kind === "vehicle") && a.firmware === "good" && (input.citywideFreeze || a.district === "north-beach")) {
      holds.push({ actorId: a.id, untilTick: freezeUntilTick, reason: "firmware-update" });
    } else if (input.tick < sirenUntilTick && a.kind === "vehicle" && a.model === "robotaxi") {
      holds.push({ actorId: a.id, untilTick: sirenUntilTick, reason: "siren" });
    }
  }
  return { state: { lastTick: input.tick, lastGameSecond: input.gameSecond, freezeDay, freezeUntilTick, sirenWeek, sirenUntilTick }, holds, events };
}

/** Conference Week is every fourth game week, offset two from Fleet Week. */
export function conferenceDensity(week: number, inSoma: boolean, conventionDistanceM: number, protectedArea: boolean): { badRateMultiplier: number; lanyardCrowd: boolean } {
  if (!Number.isSafeInteger(week) || week < 0 || !Number.isFinite(conventionDistanceM) || conventionDistanceM < 0) throw new RangeError("Invalid conference location/calendar");
  const active = week % 4 === 2 && inSoma && conventionDistanceM <= 600 && !protectedArea;
  return { badRateMultiplier: active ? 1.5 : 1, lanyardCrowd: active };
}

// ---- Flying followers, perimeter roles and street approaches ------------------------------

export interface DroneState {
  readonly lastTick: number;
  readonly targetId: string | null;
  readonly lastSeenTick: number;
  readonly lastSeen: RoutinePoint | null;
  readonly nextBlastTick: number;
}
export function createDroneState(): DroneState { return { lastTick: -1, targetId: null, lastSeenTick: -1, lastSeen: null, nextBlastTick: 0 }; }
export function stepDrone(previous: DroneState, input: {
  readonly tick: number; readonly self: RoutineActor; readonly groundY: number;
  readonly observedTarget: (RoutineActor & { readonly lineOfSight: boolean }) | null;
}): { state: DroneState; motion: RoutineMotion; blast: { readonly targetId: string; readonly sequence: number } | null } {
  tick(input.tick, previous.lastTick); actor(input.self);
  if (!Number.isFinite(input.groundY) || Math.abs(input.groundY) > 1e7) throw new RangeError("Invalid drone ground height");
  let targetId = previous.targetId, lastSeenTick = previous.lastSeenTick, lastSeen = previous.lastSeen;
  const target = input.observedTarget;
  if (target) actor(target);
  const visible = target !== null && target.lineOfSight && target.operational && (target.kind === "player" || target.kind === "robot") && distance2(input.self, target) <= ((30) * (30));
  if (visible) { targetId = target.id; lastSeenTick = input.tick; lastSeen = copyPoint(target); }
  if (input.tick - lastSeenTick > 10 * TICK_HZ) { targetId = null; lastSeen = null; }
  const at = lastSeen ?? input.self;
  const goal = { x: at.x, y: input.groundY + 6, z: at.z };
  const active = input.self.operational;
  const motion: RoutineMotion = active ? { kind: lastSeen ? "follow" : "hold", target: goal, speedMps: lastSeen ? 5 : 0, reason: "drone-hover" } : hold(input.self, "disabled");
  let nextBlastTick = previous.nextBlastTick;
  let blast: { targetId: string; sequence: number } | null = null;
  if (active && visible && distance2(input.self, target) <= ((8) * (8)) && input.tick >= nextBlastTick && input.tick > previous.lastTick) {
    blast = { targetId: target.id, sequence: input.tick };
    nextBlastTick = input.tick + 4 * TICK_HZ;
  }
  return { state: { lastTick: input.tick, targetId, lastSeenTick, lastSeen: lastSeen ? copyPoint(lastSeen) : null, nextBlastTick }, motion, blast };
}

export interface SwarmAssignment { readonly id: string; readonly role: "melee" | "ranged" }
export function allocateSwarm(units: readonly RoutineActor[], player: RoutineActor, threat: number): readonly SwarmAssignment[] {
  actor(player);
  if (units.length > 2800 || !Number.isInteger(threat) || threat < 0 || threat > 5) throw new RangeError("Invalid swarm input");
  uniqueIds(units);
  if (threat < 4 || player.kind !== "player") return [];
  const unique = new Map<string, RoutineActor>();
  for (const unit of units) { actor(unit); if (!unique.has(unit.id)) unique.set(unit.id, unit); }
  return [...unique.values()].filter(a => a.kind === "robot" && a.firmware === "bad" && a.operational && distance2(a, player) <= ((120) * (120)))
    .sort((a, b) => distance2(a, player) - distance2(b, player) || byId(a, b)).slice(0, 8)
    .map((a, i) => ({ id: a.id, role: i < 2 ? "melee" : "ranged" }));
}

export interface BoxInState { readonly lastTick: number; readonly targetId: string | null; readonly startedTick: number; readonly phase: "idle" | "telegraph" | "approach" | "hold" }
export function createBoxInState(): BoxInState { return { lastTick: -1, targetId: null, startedTick: -1, phase: "idle" }; }
export function stepBoxIn(previous: BoxInState, input: {
  readonly tick: number; readonly self: RoutineActor; readonly target: (RoutineActor & { readonly occupiedByTarget: boolean; readonly lineOfSight: boolean }) | null;
  readonly reachedGoal: boolean;
}): { state: BoxInState; motion: RoutineMotion; honk: boolean; desiredHeading: number } {
  tick(input.tick, previous.lastTick); actor(input.self);
  const target = input.target;
  if (target) actor(target);
  if (!input.self.operational || !target || target.kind !== "vehicle" || !target.occupiedByTarget || !target.lineOfSight) return {
    state: { lastTick: input.tick, targetId: null, startedTick: -1, phase: "idle" }, motion: hold(input.self, "no-vehicle-target"), honk: false, desiredHeading: input.self.heading,
  };
  const startedTick = previous.targetId === target.id ? previous.startedTick : input.tick;
  const phase = input.tick - startedTick < 2 * TICK_HZ ? "telegraph" : input.reachedGoal ? "hold" : "approach";
  const goal = { x: target.x + dsin(target.heading) * 10, y: target.y, z: target.z - dcos(target.heading) * 10 };
  return { state: { lastTick: input.tick, targetId: target.id, startedTick, phase },
    motion: phase === "approach" ? { kind: "route", target: goal, speedMps: 8, reason: "box-in" } : hold(input.self, phase),
    honk: phase === "hold", desiredHeading: target.heading + 1.5707963267948966 };
}

export function patrolTerms(self: RoutineActor, observed: readonly (RoutineActor & { readonly lineOfSight: boolean })[]): { targetId: string; contentKey: "patrol.terms-of-service" } | null {
  actor(self);
  uniqueIds(observed);
  if (!self.operational) return null;
  const target = [...observed].filter(a => { actor(a); return a.lineOfSight && a.operational && (a.kind === "player" || a.kind === "robot") && distance2(self, a) <= 36; })
    .sort((a, b) => distance2(self, a) - distance2(self, b) || byId(a, b))[0];
  return target ? { targetId: target.id, contentKey: "patrol.terms-of-service" } : null;
}

export function associateApproach(self: RoutineActor, target: (RoutineActor & { readonly lineOfSight: boolean }) | null, inVehicle: boolean): RoutineMotion {
  actor(self); if (target) actor(target);
  if (!self.operational || !target || target.kind !== "player" || !target.lineOfSight || distance2(self, target) > ((40) * (40))) return hold(self, "no-observed-founder");
  if (distance2(self, target) < ((4) * (4))) return hold(self, "pitch-distance");
  return { kind: "route", target: copyPoint(target), speedMps: inVehicle ? 5 : 1.4, reason: inVehicle ? "pull-alongside" : "approach-founder" };
}

export function signSpinnerPose(id: number, tickValue: number): { readonly angle: number; readonly contentKey: string } {
  tick(tickValue);
  if (!Number.isSafeInteger(id) || id < 0) throw new RangeError("Invalid spinner id");
  return { angle: (tickValue % (4 * TICK_HZ)) / (4 * TICK_HZ) * 6.283185307179586,
    contentKey: ["spinner.pivot", "spinner.synergy", "spinner.runway"][hash32(id, Math.floor(tickValue / (30 * TICK_HZ))) % 3]! };
}

// ---- Empty parked-car theft ---------------------------------------------------------------

export interface TheftCar extends RoutinePoint { readonly id: string; readonly ownerId: string; readonly occupied: boolean; readonly driverId?: string | null; readonly parked: boolean; readonly speed: number }
export interface TheftState {
  readonly lastTick: number; readonly phase: "idle" | "windup" | "claim" | "driving" | "recoverable" | "delivered" | "recovered" | "aborted";
  readonly carId: string | null; readonly ownerId: string | null; readonly startedTick: number; readonly sequence: number;
}
export type TheftIntent =
  | { readonly kind: "claim-empty-car"; readonly carId: string; readonly sequence: number }
  | { readonly kind: "drive-stolen-car"; readonly carId: string; readonly destination: RoutinePoint }
  | { readonly kind: "release-car"; readonly carId: string; readonly sequence: number }
  | { readonly kind: "mark-stolen-car"; readonly carId: string; readonly ownerId: string };
export function createTheftState(): TheftState { return { lastTick: -1, phase: "idle", carId: null, ownerId: null, startedTick: -1, sequence: 0 }; }
export function stepTheft(previous: TheftState, input: {
  readonly tick: number; readonly self: RoutineActor; readonly car: TheftCar | null; readonly owner: RoutinePoint;
  readonly depot: RoutinePoint; readonly claimAck: { readonly sequence: number; readonly carId: string; readonly tick: number } | null;
  readonly atDepot: boolean; readonly stoppedByCone: boolean; readonly thiefDisabled: boolean; readonly recoveredByOwner: boolean;
}): { state: TheftState; intents: readonly TheftIntent[] } {
  tick(input.tick, previous.lastTick); actor(input.self); point(input.owner); point(input.depot);
  const car = input.car;
  if (car) { point(car); if (!car.id || !car.ownerId || !Number.isFinite(car.speed)) throw new RangeError("Invalid theft car"); }
  let state: TheftState = { ...previous, lastTick: input.tick };
  const intents: TheftIntent[] = [];
  const safeCar = car !== null && !car.occupied && car.parked && Math.abs(car.speed) < 0.1 && distance2(car, input.owner) > ((30) * (30));
  if (previous.phase === "idle") {
    if (safeCar && input.self.operational && input.self.firmware === "bad" && distance2(input.self, car) <= 4) state = {
      lastTick: input.tick, phase: "windup", carId: car.id, ownerId: car.ownerId, startedTick: input.tick, sequence: previous.sequence + 1,
    };
  } else if (previous.phase === "windup") {
    if (!safeCar || car.id !== previous.carId || !input.self.operational || input.self.firmware !== "bad" || input.thiefDisabled || distance2(input.self, car) > 4) state = { ...state, phase: "aborted" };
    else if (input.tick - previous.startedTick >= 3 * TICK_HZ) {
      state = { ...state, phase: "claim" };
      intents.push({ kind: "claim-empty-car", carId: car.id, sequence: previous.sequence });
    }
  } else if (previous.phase === "claim") {
    const alreadyClaimed = car?.occupied === true && car.driverId === input.self.id;
    const eligibleNow = safeCar && car.id === previous.carId && distance2(input.self, car) <= 4;
    if (!car || car.id !== previous.carId || (!alreadyClaimed && !eligibleNow) || !input.self.operational || input.self.firmware !== "bad" || input.thiefDisabled) state = { ...state, phase: "aborted" };
    else if (input.claimAck?.carId === previous.carId && input.claimAck.sequence === previous.sequence && Number.isSafeInteger(input.claimAck.tick) && input.claimAck.tick >= previous.startedTick + 3 * TICK_HZ && input.claimAck.tick <= input.tick) state = { ...state, phase: "driving" };
  }
  if (state.phase === "driving" && state.carId !== null && state.ownerId !== null) {
    const carId = state.carId;
    if (input.recoveredByOwner) state = { ...state, phase: "recovered" };
    else if (!car || car.id !== carId || (car.occupied && car.driverId !== input.self.id)) state = { ...state, phase: "aborted" };
    else if (input.thiefDisabled || !input.self.operational || input.self.firmware !== "bad" || input.stoppedByCone) {
      state = { ...state, phase: "recoverable" };
      intents.push({ kind: "release-car", carId, sequence: state.sequence });
    } else if (input.atDepot && Math.abs(car.speed) < 0.1 && distance2(car, input.depot) <= 9) state = { ...state, phase: "delivered" };
    else intents.push({ kind: "drive-stolen-car", carId, destination: copyPoint(input.depot) });
  }
  if ((state.phase === "recoverable" || state.phase === "delivered") && input.recoveredByOwner) state = { ...state, phase: "recovered" };
  if ((state.phase === "driving" || state.phase === "recoverable" || state.phase === "delivered") && state.carId && state.ownerId) intents.push({ kind: "mark-stolen-car", carId: state.carId, ownerId: state.ownerId });
  return { state, intents };
}

// ---- Tidy's physical haul and acknowledged restoration ------------------------------------

export interface HeapObservation extends RoutinePoint { readonly id: string; readonly converted: boolean; readonly present: boolean }
export interface KioskObservation extends RoutinePoint { readonly id: string }
export interface TidyState {
  readonly lastTick: number; readonly phase: "seek" | "collect" | "attach" | "haul" | "reboot" | "restore" | "complete";
  readonly heapId: string | null; readonly kioskId: string | null; readonly rebootStartTick: number; readonly sequence: number;
  readonly completedHeapIds: readonly string[];
}
export type TidyIntent =
  | { readonly kind: "attach-heap" | "restore-good" | "remove-heap"; readonly heapId: string; readonly sequence: number }
  | { readonly kind: "motion"; readonly motion: RoutineMotion };
export function createTidyState(): TidyState { return { lastTick: -1, phase: "seek", heapId: null, kioskId: null, rebootStartTick: -1, sequence: 0, completedHeapIds: [] }; }
export function stepTidy(previous: TidyState, input: {
  readonly tick: number; readonly self: RoutineActor; readonly heaps: readonly HeapObservation[]; readonly kiosks: readonly KioskObservation[];
  readonly carryingHeapId: string | null; readonly restoredAck: { readonly heapId: string; readonly sequence: number } | null;
}): { state: TidyState; intents: readonly TidyIntent[] } {
  tick(input.tick, previous.lastTick); actor(input.self);
  if (input.heaps.length > 2000 || input.kiosks.length > 512 || previous.completedHeapIds.length > 2000) throw new RangeError("Tidy observation budget exceeded");
  uniqueIds(input.heaps); uniqueIds(input.kiosks);
  for (const h of input.heaps) point(h);
  for (const k of input.kiosks) point(k);
  let state: TidyState = { ...previous, lastTick: input.tick };
  const intents: TidyIntent[] = [];
  if (!input.self.operational) return { state, intents: [{ kind: "motion", motion: hold(input.self, "disabled") }] };
  // An applied restoration can remove the heap from this very observation. Consume the
  // acknowledgement before requiring that heap to remain in the physical actor list.
  if (state.phase === "restore" && state.heapId !== null && input.restoredAck?.heapId === state.heapId && input.restoredAck.sequence === state.sequence) {
    state = { ...state, phase: "complete", completedHeapIds: [...state.completedHeapIds, state.heapId] };
  }
  if (state.phase === "seek" || state.phase === "complete") {
    if (state.completedHeapIds.length >= 2000) return { state, intents: [{ kind: "motion", motion: hold(input.self, "haul-history-full") }] };
    const heap = [...input.heaps].filter(h => h.present && !state.completedHeapIds.includes(h.id)).sort((a, b) => distance2(input.self, a) - distance2(input.self, b) || byId(a, b))[0];
    const kiosk = heap && [...input.kiosks].sort((a, b) => distance2(heap, a) - distance2(heap, b) || byId(a, b))[0];
    if (!heap || !kiosk) return { state, intents: [{ kind: "motion", motion: hold(input.self, "no-haul-route") }] };
    state = { ...state, phase: "collect", heapId: heap.id, kioskId: kiosk.id, rebootStartTick: -1, sequence: state.sequence + 1 };
  }
  const heap = input.heaps.find(h => h.id === state.heapId && h.present);
  const kiosk = input.kiosks.find(k => k.id === state.kioskId);
  if (!heap || !kiosk) return { state: { ...state, phase: "seek", heapId: null, kioskId: null }, intents: [{ kind: "motion", motion: hold(input.self, "lost-haul-target") }] };
  if (state.phase === "collect" || state.phase === "attach") {
    if (input.carryingHeapId === heap.id) state = { ...state, phase: "haul" };
    else if (state.phase === "attach") return { state, intents: [{ kind: "motion", motion: hold(input.self, "await-heap-attachment") }] };
    else if (distance2(input.self, heap) <= 4 && Math.abs(input.self.speed) < 0.1) {
      state = { ...state, phase: "attach" };
      intents.push({ kind: "attach-heap", heapId: heap.id, sequence: state.sequence });
      return { state, intents: [...intents, { kind: "motion", motion: hold(input.self, "collect-heap") }] };
    } else return { state, intents: [{ kind: "motion", motion: { kind: "route", target: copyPoint(heap), speedMps: 1.2, reason: "seek-heap" } }] };
  }
  if (state.phase === "haul") {
    if (input.carryingHeapId !== heap.id) return { state: { ...state, phase: "collect" }, intents: [{ kind: "motion", motion: hold(input.self, "heap-detached") }] };
    if (distance2(input.self, kiosk) > 4 || Math.abs(input.self.speed) >= 0.1) return { state, intents: [{ kind: "motion", motion: { kind: "route", target: copyPoint(kiosk), speedMps: 1, reason: "haul-to-kiosk" } }] };
    state = { ...state, phase: "reboot", rebootStartTick: input.tick };
  }
  if (state.phase === "reboot") {
    if (distance2(input.self, kiosk) > 4 || input.carryingHeapId !== heap.id) return { state: { ...state, phase: "haul", rebootStartTick: -1 }, intents: [] };
    if (input.tick - state.rebootStartTick >= 60 * TICK_HZ) {
      state = { ...state, phase: "restore" };
      intents.push({ kind: heap.converted ? "restore-good" : "remove-heap", heapId: heap.id, sequence: state.sequence });
    }
  }
  return { state, intents: [...intents, { kind: "motion", motion: hold(input.self, "kiosk-reboot") }] };
}

// ---- Recruits, flock and a controlled robot body -------------------------------------------

export interface Recruit extends RoutinePoint {
  readonly id: string; readonly ownerId: string; readonly phase: "follow" | "boarding" | "ride" | "taxi" | "converted" | "backup";
  readonly nextSpotTick: number; readonly requestSequence: number;
}
export interface RecruitState { readonly lastTick: number; readonly roster: readonly Recruit[] }
export type RecruitIntent =
  | { readonly kind: "follow"; readonly actorId: string; readonly target: RoutinePoint }
  | { readonly kind: "board" | "hail-taxi" | "restore-at-safehouse"; readonly actorId: string; readonly sequence: number }
  | { readonly kind: "spot"; readonly actorId: string; readonly targetId: string; readonly untilTick: number };
export function createRecruitState(): RecruitState { return { lastTick: -1, roster: [] }; }
export function stepRecruits(previous: RecruitState, input: {
  readonly tick: number; readonly owner: RoutineActor; readonly reputation: number;
  readonly candidates: readonly (RoutineActor & { readonly interruptedUpdate: boolean; readonly accepted: boolean })[];
  readonly observations: readonly (RoutineActor & { readonly boarded: boolean; readonly boardedSequence?: number; readonly melted: boolean; readonly restored: boolean })[];
  readonly visibleBadRobots: readonly (RoutineActor & { readonly lineOfSight: boolean })[];
  readonly seatCapacity: number; readonly ownerInVehicle: boolean;
}): { state: RecruitState; intents: readonly RecruitIntent[] } {
  tick(input.tick, previous.lastTick); actor(input.owner);
  if (!Number.isFinite(input.reputation) || !Number.isInteger(input.seatCapacity) || input.seatCapacity < 0 || input.seatCapacity > 3 || previous.roster.length > 3 || input.candidates.length > 2000 || input.observations.length > 2000 || input.visibleBadRobots.length > 2800) throw new RangeError("Invalid recruit budget");
  uniqueIds(previous.roster); uniqueIds(input.candidates); uniqueIds(input.observations); uniqueIds(input.visibleBadRobots);
  const roster: Recruit[] = previous.roster.map(r => ({ ...r }));
  if (input.reputation >= 60) for (const candidate of [...input.candidates].sort(byId)) {
    actor(candidate);
    if (roster.length >= 3) break;
    if (candidate.kind !== "robot" || candidate.firmware !== "good" || !candidate.operational || !candidate.interruptedUpdate || !candidate.accepted || roster.some(r => r.id === candidate.id)) continue;
    roster.push({ id: candidate.id, ownerId: input.owner.id, x: candidate.x, y: candidate.y, z: candidate.z, phase: "follow", nextSpotTick: input.tick, requestSequence: 0 });
  }
  roster.sort(byId);
  const intents: RecruitIntent[] = [];
  let seats = input.seatCapacity;
  for (let index = 0; index < roster.length; index++) {
    const old = roster[index]!;
    if (old.ownerId !== input.owner.id) continue;
    const observed = input.observations.find(a => a.id === old.id);
    if (!observed) continue;
    actor(observed);
    let r: Recruit = { ...old, x: observed.x, y: observed.y, z: observed.z };
    if (observed.melted) {
      if (r.phase !== "backup") { r = { ...r, phase: "backup", requestSequence: r.requestSequence + 1 }; intents.push({ kind: "restore-at-safehouse", actorId: r.id, sequence: r.requestSequence }); }
    } else if (observed.firmware === "bad") {
      r = { ...r, phase: "converted" };
    } else if (r.phase === "backup") {
      if (observed.restored && observed.firmware === "good") r = { ...r, phase: "follow" };
    } else if (input.ownerInVehicle && observed.boarded && observed.boardedSequence === r.requestSequence && (r.phase === "boarding" || r.phase === "ride")) {
      if (seats > 0) { seats--; r = { ...r, phase: "ride" }; }
    } else if (!input.ownerInVehicle && distance2(observed, input.owner) > ((300) * (300))) {
      if (r.phase !== "taxi") { r = { ...r, phase: "taxi", requestSequence: r.requestSequence + 1 }; intents.push({ kind: "hail-taxi", actorId: r.id, sequence: r.requestSequence }); }
    } else if (observed.operational) {
      const canBoard = input.ownerInVehicle && input.owner.speed === 0 && seats > 0 && distance2(observed, input.owner) <= 9;
      if (canBoard) {
        seats--;
        if (r.phase !== "boarding") {
          r = { ...r, phase: "boarding", requestSequence: r.requestSequence + 1 };
          intents.push({ kind: "board", actorId: r.id, sequence: r.requestSequence });
        }
      } else {
        r = { ...r, phase: "follow" };
        intents.push({ kind: "follow", actorId: r.id, target: copyPoint(input.owner) });
      }
      if (input.tick >= r.nextSpotTick && input.tick > previous.lastTick) {
        const target = [...input.visibleBadRobots].filter(a => { actor(a); return a.lineOfSight && a.kind === "robot" && a.firmware === "bad" && a.operational && distance2(observed, a) <= 400; })
          .sort((a, b) => distance2(observed, a) - distance2(observed, b) || byId(a, b))[0];
        if (target) { intents.push({ kind: "spot", actorId: r.id, targetId: target.id, untilTick: input.tick + 30 * TICK_HZ }); r = { ...r, nextSpotTick: input.tick + 30 * TICK_HZ }; }
      }
    }
    roster[index] = r;
  }
  return { state: { lastTick: input.tick, roster }, intents };
}

export function parrotFlock(seed: number, tickValue: number, centre: RoutinePoint, count = 12): readonly { readonly id: string; readonly goal: RoutinePoint }[] {
  tick(tickValue); point(centre);
  if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isInteger(count) || count < 0 || count > 32) throw new RangeError("Invalid flock budget");
  return Array.from({ length: count }, (_, i) => {
    const phase = hash32(seed, i) / 4294967296 * 6.283185307179586 + (tickValue % (10 * TICK_HZ)) / (10 * TICK_HZ) * 6.283185307179586;
    const radius = 3 + hash32(seed, i, 1) % 50 / 10;
    return { id: `parrot:${seed}:${i}`, goal: { x: centre.x + dcos(phase) * radius, y: centre.y + 5 + i % 3, z: centre.z + dsin(phase) * radius } };
  });
}

export type RobotEmote = "none" | "crosswalk" | "carry-bag" | "recharge" | "wave" | "apologise";
export interface RobotBodyState {
  readonly lastTick: number; readonly burstUntilTick: number; readonly burstHeld: boolean;
  readonly disconnectedTick: number; readonly generation: number; readonly pendingSpawn: RoutinePoint | null;
}
export function createRobotBodyState(): RobotBodyState { return { lastTick: -1, burstUntilTick: -1, burstHeld: false, disconnectedTick: -1, generation: 0, pendingSpawn: null }; }
export function stepRobotBody(previous: RobotBodyState, input: {
  readonly tick: number; readonly self: RoutinePoint; readonly moveX: number; readonly moveZ: number; readonly burst: boolean; readonly emote: RobotEmote;
  readonly melted: boolean; readonly respawnCoverageComplete: boolean;
  readonly respawnCandidates: readonly (RoutinePoint & { readonly id: string; readonly peopleFree: boolean })[];
  readonly spotters: readonly RoutinePoint[];
  readonly rebindAck: { readonly generation: number; readonly tick: number; readonly at: RoutinePoint } | null;
}): { state: RobotBodyState; readonly vx: number; readonly vz: number; readonly heading: number; readonly emote: RobotEmote; readonly tells: readonly string[]; readonly rebind: { readonly generation: number; readonly at: RoutinePoint } | null } {
  tick(input.tick, previous.lastTick); point(input.self);
  if (![input.moveX, input.moveZ].every(Number.isFinite) || input.respawnCandidates.length > 512 || input.spotters.length > 24) throw new RangeError("Invalid robot controls");
  if (!["none", "crosswalk", "carry-bag", "recharge", "wave", "apologise"].includes(input.emote)) throw new RangeError("Invalid robot emote");
  for (const p of input.respawnCandidates) point(p);
  let state: RobotBodyState = { ...previous, lastTick: input.tick, burstHeld: input.burst };
  if (input.melted && state.disconnectedTick < 0) state = { ...state, disconnectedTick: input.tick, pendingSpawn: null, burstUntilTick: -1 };
  if (state.disconnectedTick >= 0) {
    for (const s of input.spotters) point(s);
    const pendingSafe = state.pendingSpawn !== null && input.respawnCoverageComplete && input.spotters.every(s => distance2(state.pendingSpawn!, s) >= ((150) * (150))) && input.respawnCandidates.some(p => p.peopleFree && distance2(p, state.pendingSpawn!) < 0.0001);
    const ack = input.rebindAck;
    if (ack) point(ack.at);
    if (pendingSafe && !input.melted && ack?.generation === state.generation + 1 && ack.tick === input.tick &&
        distance2(ack.at, state.pendingSpawn!) <= 0.01 && distance2(input.self, ack.at) <= 0.01 && Math.abs(input.self.y - ack.at.y) <= 0.1) {
      state = { ...state, disconnectedTick: -1, generation: state.generation + 1, pendingSpawn: null };
    }
    else {
      let pending = state.pendingSpawn;
      if (!pending && input.tick - state.disconnectedTick >= 10 * TICK_HZ && input.respawnCoverageComplete) {
        const found = [...input.respawnCandidates].filter(p => { point(p); return p.peopleFree && input.spotters.every(s => distance2(p, s) >= ((150) * (150))); }).sort(byId)[0];
        if (found) pending = copyPoint(found);
      }
      // Safety is rechecked while waiting for the actual core rebind acknowledgement.
      if (pending && (!input.respawnCoverageComplete || input.spotters.some(s => distance2(pending!, s) < ((150) * (150))) || !input.respawnCandidates.some(p => p.peopleFree && distance2(p, pending!) < 0.0001))) pending = null;
      state = { ...state, pendingSpawn: pending };
      return { state, vx: 0, vz: 0, heading: 0, emote: "none", tells: [], rebind: pending ? { generation: state.generation + 1, at: copyPoint(pending) } : null };
    }
  }
  if (input.burst && !previous.burstHeld && input.tick > previous.lastTick) state = { ...state, burstUntilTick: input.tick + 2 * TICK_HZ };
  const x = clamp(input.moveX, -1, 1), z = clamp(input.moveZ, -1, 1), length = Math.sqrt(x * x + z * z);
  const speed = input.tick < state.burstUntilTick ? 3 : 1.6;
  const scale = length > 0 ? speed / Math.max(1, length) : 0;
  const tells: string[] = [];
  if (input.tick < state.burstUntilTick) tells.push("battery-overdraw");
  if (input.tick % (30 * TICK_HZ) < 30) tells.push("battery-calibrating");
  return { state, vx: x * scale, vz: z * scale, heading: length > 0 ? datan2(x, -z) : 0, emote: input.emote, tells, rebind: null };
}
