// Full registered agent/runtime benchmark against committed world data.
// Run alone: NODE_OPTIONS=--max-old-space-size=8192 flock /tmp/fog.lock \
//   node scripts/bench/agent-runtime.ts --world sf --anchors 1,4,24 --ticks 1200
// --replay repeats each scenario and requires identical final canonical state.
// Timing covers step() only; JSON measurement and invariant checks run outside it.
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { loadWorldFiles } from "../../tests/helpers.ts";
import { createInitialState, step } from "../../src/sim/step.ts";
import { buildWorld, meshGroundHeight, type World } from "../../src/sim/world.ts";
import { CAR, makeCar } from "../../src/sim/car.ts";
import { boxBlocked } from "../../src/sim/collide.ts";
import { datan2 } from "../../src/sim/dmath.ts";
import { lanePath, pathPoint, type RoadsFile } from "../../src/sim/roads.ts";
import { agentsOf } from "../../src/sim/agents.ts";
import { agentsRuntimeOf, runtimePhysicalBodies } from "../../src/sim/agents/runtime-system.ts";
import { enableAgentRuntime, type AgentRuntimeWave } from "../../src/sim/agents/runtime-state.ts";
import { hashState } from "../../src/sim/serialize.ts";
import type { InputFrame, SimEvent, SimState } from "../../src/sim/contract.ts";

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name} value`);
  return value;
}
function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid --${name}`);
  return value;
}

const worldName = option("world", "sf");
const ticks = integer("ticks", 1200, 1, 36000);
const warmup = integer("warmup", 120, 0, 3600);
const wave = integer("wave", 8, 2, 8) as AgentRuntimeWave;
const seed = integer("seed", 7, 0, 2147483647);
const requestEvery = integer("request-every", 600, 1, 36000);
const anchorCounts = option("anchors", "1,4,24").split(",").map(Number);
if (anchorCounts.length === 0 || anchorCounts.some((value) => !Number.isInteger(value) || value < 1 || value > 24) || new Set(anchorCounts).size !== anchorCounts.length) throw new Error("Invalid --anchors");
const maxP95 = Number(option("max-p95-ms", "0"));
const maxStateBytes = integer("max-state-bytes", 0, 0, 100000000);
const requireServices = args.includes("--require-services");
if (!Number.isFinite(maxP95) || maxP95 < 0) throw new Error("Invalid --max-p95-ms");

const files = loadWorldFiles(worldName);
const world = buildWorld(files.tiles, files.roads as RoadsFile | null, files.boundary, files.gameplay ?? undefined);

interface Placement { x: number; z: number; heading: number }
function placements(count: number): Placement[] {
  const candidates: Placement[] = [];
  for (const edge of [...(world.roads?.edges ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (!edge.drivable || !edge.laneSafe[0][0]) continue;
    const path = lanePath(edge, 1, 0);
    const point = pathPoint(path, path.len / 2);
    const heading = datan2(point.tx, -point.tz);
    if (boxBlocked(world, { x: point.x, z: point.z, heading, hl: CAR.halfLength, hw: CAR.halfWidth }, meshGroundHeight(world, point.x, point.z))) continue;
    candidates.push({ x: point.x, z: point.z, heading });
  }
  candidates.sort((a, b) => {
    const distance = (point: Placement): number => (point.x - files.manifest.spawn.x) * (point.x - files.manifest.spawn.x) + (point.z - files.manifest.spawn.z) * (point.z - files.manifest.spawn.z);
    return distance(a) - distance(b) || a.x - b.x || a.z - b.z;
  });
  const result: Placement[] = [];
  for (const distanceM of [450, 150, 30]) {
    for (const candidate of candidates) {
      if (result.length === count) return result;
      if (result.some((point) => (point.x - candidate.x) * (point.x - candidate.x) + (point.z - candidate.z) * (point.z - candidate.z) < distanceM * distanceM)) continue;
      result.push(candidate);
    }
  }
  if (result.length < count) throw new Error(`World ${worldName} has only ${result.length} safe distinct anchor placements; requested ${count}`);
  return result;
}

function initial(count: number): { state: SimState; ids: string[] } {
  const points = placements(count);
  const ids = points.map((_, index) => `p${String(index).padStart(2, "0")}`);
  let state = createInitialState(world, seed, ids, points[0]!);
  const players = { ...state.players };
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!; const point = points[i]!;
    players[id] = { ...players[id]!, car: makeCar(point.x, point.z, point.heading, meshGroundHeight(world, point.x, point.z)) };
  }
  state = enableAgentRuntime({ ...state, players }, { wave, startGameMinute: 0 });
  return { state, ids };
}

interface FleetCounts {
  requestsSent: number; requestsMapped: number; maxQueued: number; spawnedVans: number; deliveredRequests: number;
  rejectedRequests: number; onTimeArrivals: number; lateArrivals: number; retiredVans: number;
  spawnedBuses: number; busStops: number; retiredBuses: number; progressedVehicles: number; maxPhysical: number;
  maxDistanceM: number; fifoStable: boolean;
}
interface Result {
  world: string; anchors: number; wave: number; seed: number; ticks: number; warmup: number;
  medianMs: number; p95Ms: number; maxMs: number; jsonBytes: number; peakJsonBytes: number;
  peakAmbient: number; peakSignificant: number; peakReservedVanUnits: number; peakBodies: number; finitePoses: boolean; boundedPopulation: boolean;
  fleet: FleetCounts; finalHash: string; replay: "not-run" | "matched"; violations: string[];
}

function run(count: number, timed: boolean): Result {
  const setup = initial(count);
  let state = setup.state;
  const inputs: InputFrame = Object.fromEntries(setup.ids.map((id) => [id, { throttle: 0, steer: 0, brake: 1, actions: 0 }]));
  for (let i = 0; i < warmup; i++) state = step(world, state, inputs);
  const times: number[] = [];
  const violations: string[] = [];
  const addViolation = (message: string): void => { if (violations.length < 8 && !violations.includes(message)) violations.push(message); };
  const countFleet: FleetCounts = { requestsSent: 0, requestsMapped: 0, maxQueued: 0, spawnedVans: 0, deliveredRequests: 0, rejectedRequests: 0,
    onTimeArrivals: 0, lateArrivals: 0, retiredVans: 0, spawnedBuses: 0, busStops: 0, retiredBuses: 0, progressedVehicles: 0, maxPhysical: 0, maxDistanceM: 0, fifoStable: true };
  const seenVans = new Set<number>(); const seenBuses = new Set<number>(); const seenArrivals = new Set<number>(); const seenRetired = new Set<number>();
  const seenDisembarks = new Set<number>(); const seenRejected = new Set<number>(); const progressed = new Set<number>();
  const busStops = new Map<number, number>(); const distanceByRoute = new Map<string, number>();
  let previousBuses = new Set<number>(); let lastDispatched = -1;
  let peakJsonBytes = 0; let peakAmbient = 0; let peakSignificant = 0; let peakReservedVanUnits = 0; let peakBodies = 0; let finitePoses = true; let boundedPopulation = true;
  for (let i = 0; i < ticks; i++) {
    const tick = state.tick + 1;
    const events: SimEvent[] = [];
    if (i % requestEvery === 0) {
      const playerId = setup.ids[0]!; const player = state.players[playerId]!;
      const active = player.mode === "foot" && player.foot ? player.foot : player.car;
      const payload = { id: `bench:${count}:${countFleet.requestsSent}`, requestTick: tick, playerId, player: { x: active.x, z: active.z }, kind: "van", threat: 2, unitCount: 2 };
      events.push({ kind: "threat.spawn", tick, payload }, { kind: "threat.spawn", tick, payload });
      countFleet.requestsSent++;
    }
    const start = timed ? performance.now() : 0;
    state = step(world, state, inputs, events);
    if (timed) times.push(performance.now() - start);
    const runtime = agentsRuntimeOf(state);
    if (!runtime) { addViolation("runtime-not-registered"); continue; }
    const bodies = runtimePhysicalBodies(state);
    peakAmbient = Math.max(peakAmbient, runtime.population.ambient); peakSignificant = Math.max(peakSignificant, runtime.population.significant);
    peakReservedVanUnits = Math.max(peakReservedVanUnits, runtime.population.reservedVanUnits); peakBodies = Math.max(peakBodies, bodies.length);
    if (runtime.population.ambient > 800 || runtime.population.significant + runtime.population.reservedVanUnits > 2000 || runtime.population.perAnchor.some((anchor) => anchor.count > 60)) {
      boundedPopulation = false; addViolation("population-cap-exceeded");
    }
    const poses = [...agentsOf(state), ...bodies, ...setup.ids.map((id) => state.players[id]!.mode === "foot" ? state.players[id]!.foot! : state.players[id]!.car)];
    if (poses.some((pose) => ![pose.x, pose.y, pose.z, pose.heading, pose.speed].every(Number.isFinite))) { finitePoses = false; addViolation("non-finite-pose"); }
    countFleet.requestsMapped = runtime.nextRequestId;
    countFleet.maxQueued = Math.max(countFleet.maxQueued, runtime.queuedVanRequests.length);
    countFleet.maxPhysical = Math.max(countFleet.maxPhysical, runtime.fleet.vehicles.filter((vehicle) => vehicle.spawned).length);
    for (const vehicle of runtime.fleet.vehicles) {
      if (vehicle.spawned) { if (vehicle.kind === "van") seenVans.add(vehicle.id); else seenBuses.add(vehicle.id); }
      const key = `${vehicle.id}:${vehicle.route.id}`;
      const previousDistance = distanceByRoute.get(key) ?? 0;
      if (vehicle.distanceM < previousDistance) addViolation("vehicle-route-progress-reversed");
      if (vehicle.spawned && vehicle.distanceM > 0.1) progressed.add(vehicle.id);
      countFleet.maxDistanceM = Math.max(countFleet.maxDistanceM, vehicle.distanceM);
      distanceByRoute.set(key, vehicle.distanceM);
    }
    for (const job of runtime.fleet.vans.jobs) {
      if (job.vehicleId !== null && job.requestId > lastDispatched) lastDispatched = job.requestId;
      else if (job.vehicleId !== null && job.requestId < lastDispatched && job.dispatchedTick === tick) countFleet.fifoStable = false;
      if (job.arrivalTick !== null && !seenArrivals.has(job.requestId)) {
        seenArrivals.add(job.requestId);
        if (job.onTime) countFleet.onTimeArrivals++; else countFleet.lateArrivals++;
      }
      if (job.retiredTick !== null) seenRetired.add(job.requestId);
    }
    for (const event of runtime.events) {
      if (event.kind === "van.disembark") seenDisembarks.add(event.requestId);
      if (event.kind === "van.rejected") seenRejected.add(event.requestId);
    }
    const currentBuses = new Set(runtime.fleet.buses.runs.map((bus) => bus.vehicleId));
    for (const id of previousBuses) if (!currentBuses.has(id) && seenBuses.has(id)) countFleet.retiredBuses++;
    previousBuses = currentBuses;
    for (const bus of runtime.fleet.buses.runs) {
      const previousStop = busStops.get(bus.vehicleId) ?? bus.nextStop;
      countFleet.busStops += Math.max(0, bus.nextStop - previousStop);
      busStops.set(bus.vehicleId, bus.nextStop);
    }
    if (i % 30 === 0 || i === ticks - 1) peakJsonBytes = Math.max(peakJsonBytes, Buffer.byteLength(JSON.stringify(state)));
  }
  countFleet.spawnedVans = seenVans.size; countFleet.spawnedBuses = seenBuses.size; countFleet.deliveredRequests = seenDisembarks.size;
  countFleet.rejectedRequests = seenRejected.size; countFleet.retiredVans = seenRetired.size; countFleet.progressedVehicles = progressed.size;
  if (!countFleet.fifoStable) addViolation("van-dispatch-order-changed");
  if (maxStateBytes > 0 && peakJsonBytes > maxStateBytes) addViolation("snapshot-budget-exceeded");
  if (requireServices) {
    if (countFleet.spawnedBuses === 0 || countFleet.progressedVehicles === 0) addViolation("no-observed-bus-service");
    if (countFleet.deliveredRequests === 0 || countFleet.onTimeArrivals === 0) addViolation("no-observed-on-time-van-delivery");
  }
  times.sort((a, b) => a - b);
  const quantile = (fraction: number): number => timed ? Number((times[Math.min(times.length - 1, Math.floor(times.length * fraction))] ?? 0).toFixed(3)) : 0;
  const p95Ms = quantile(0.95);
  if (timed && maxP95 > 0 && p95Ms > maxP95) addViolation("p95-budget-exceeded");
  return { world: worldName, anchors: count, wave, seed, ticks, warmup, medianMs: quantile(0.5), p95Ms, maxMs: quantile(1), jsonBytes: Buffer.byteLength(JSON.stringify(state)), peakJsonBytes,
    peakAmbient, peakSignificant, peakReservedVanUnits, peakBodies, finitePoses, boundedPopulation, fleet: countFleet, finalHash: hashState(state), replay: "not-run", violations };
}

const results: Result[] = [];
for (const count of anchorCounts) {
  const result = run(count, true);
  if (args.includes("--replay")) {
    const replay = run(count, false);
    if (result.finalHash !== replay.finalHash) result.violations.push("replay-hash-mismatch");
    else result.replay = "matched";
  }
  results.push(result);
  console.log(JSON.stringify(result));
}
const output = option("output", "");
if (output) writeFileSync(resolve(output), JSON.stringify({ results }, null, 2) + "\n");
if (results.some((result) => result.violations.length > 0)) process.exitCode = 1;
