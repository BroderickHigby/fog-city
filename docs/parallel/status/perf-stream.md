# Performance stream (`perf`)

Session `session_01JWycw9G1GysBgaa8ZFThFS`. Owner report: the live game "freezes and gets slower over time".
Cause: the sim's cost per tick grows with the agent population and exceeds the 16.7 ms budget, and the
old main loop then spiralled (up to 15 catch-up ticks per frame).

## PRs

| PR | Branch | What | State |
|---|---|---|---|
| [#72](https://github.com/BroderickHigby/fog-city/pull/72) | `work/perf/frame-pacer` | Main loop: ≤4 catch-up ticks and a 24 ms sim budget per frame; dropped time slows the game; "running slow" badge (`?debug=1`/`?perf=1`); `ticksThisFrame` for the GPU governor; debug pause authoritative (the extra-tick determinism flake) | merged via release #67 |
| [#87](https://github.com/BroderickHigby/fog-city/pull/87) | `work/perf/sim-hotspots` | Hash-preserving sim hotspot fixes + the `tests/sim/perf-budget.test.ts` regression guard | draft (CI blocked by Actions billing; local evidence) |
| next | `work/perf/agent-lod` | SIM_VERSION 14: distant quiet walkers plan every 4th tick, id-staggered; order-preserving grids for the planner's vehicle and sight scans | draft PR after e2e |

## How it is measured

All numbers are from this container (Intel Xeon 2.8 GHz x4, 16 GB, Node 22), run alone under `flock /tmp/fog.lock`.
Scenario (the coordinator's probe, recreated): `loadWorldFiles("sf")`, `buildWorldWithRoads`, `createInitialState(world, 1, ids, spawn)`,
`createGameSystems({wave:3})`, p1 drives a slow weave (throttle 0.45, steer ±0.25 every 240 ticks). The 4-player
case adds three idle cars at Union Square, Chinatown and the Mission (the 1,024-agent cap).
Scripts: `scratch-probe/longrun.ts` (ms/tick and state hash every N ticks), `phases.ts` (per system),
`alloc.sh` (bytes/tick from `--trace-gc-nvp`), `allocsites.ts` (sampling heap profiler, collected objects included).

## Before (live game, integrate/wave2 `86dfb90`, SIM_VERSION 10)

ms per tick (1 player): 14.5 @900 → 15.6 @1,800 → 17.4 @3,600 → 22 @7,200 → 25.7 @9,000; agents 198 → 337, state 377 → 675 KB.
4 players: 108 ms/tick at 1,024 agents. GC: 14 % of CPU (1p), 20 % (4p).

Per system at ~310 agents (1p, ticks 6,001-8,000, 22.5 ms/tick): core movement/traffic/dodge 9.0 · robots.prepare (agent planning) 5.6 ·
player.step (observed gameplay, shared by the six gameplay reducers) 3.6 · combat 2.7 · robots.step (observe) 1.4.

### Top 15 by self time (1p, 6,000 ticks, `--cpu-prof`)

| self ms | % | function |
|---:|---:|---|
| 19,045 | 14.2 | (garbage collector) |
| 7,460 | 5.6 | `synchronize` agents/runtime.ts (copies every runtime actor, twice a tick) |
| 6,433 | 4.8 | `step` step.ts |
| 5,860 | 4.4 | `prepareMotionBodies` motion.ts (list.find/findIndex per motion: O(n²)) |
| 5,149 | 3.8 | `contextFromState` agent map, combat/adapter.ts (built twice a tick) |
| 4,923 | 3.7 | `propose` agents/runtime.ts |
| 4,721 | 3.5 | parking-world.ts:75 (filters every parking and street-cleaning rule, every tick) |
| 3,580 | 2.7 | `actorMetadata` combat/adapter.ts |
| 3,317 | 2.5 | `serviceBlockersOf` map, service-runtime.ts (built every tick, read only on spawns) |
| 3,226 | 2.4 | `applyMotionBodies` body map, motion.ts (every walker × every vehicle) |
| 3,096 | 2.3 | `buildMissionParkingWorld` |
| 3,084 | 2.3 | `keys` agents/runtime.ts (re-sorting the same actor ids ~10× a tick) |
| 2,861 | 2.1 | `stepAgents` agents.ts |
| 2,602 | 1.9 | `runtimeCombatActors` map (spread-heavy) |
| 2,482 | 1.9 | `planAgentRuntime` |

### Top allocation sites (1p, ticks 6,001-6,600; 8.66 MB/tick sampled, 8.88 MB/tick from GC counters)

| KB/tick | site |
|---:|---|
| 639 | `contextFromState` (combat actors, twice a tick) |
| 575 | `applyMotionBodies` body copies |
| 521 | `segmentBlocked` (a closure per segment test) |
| 513 | `synchronize` actor copies |
| 510 | `runtimeCombatActors` |
| 466 | `propose` (proposal spreads) |
| 436 | `serviceBlockersOf` |
| 326 | `prepareMotionBodies` |
| 318 | `probe` agents.ts |
| 287 | `combatContext` |
| 286 | `boxPolygonPush` (13 arrays per call) |
| 272 | `pointInPolygon` (array destructuring) |

## Hash-preserving fixes (`work/perf/sim-hotspots`)

Every change keeps the state hash identical at every 1,000-tick checkpoint (1p, 6,000 ticks) and every 500 (4p, 1,500 ticks),
re-checked after each batch and again on the merged base `59e5a7b` (SIM_VERSION 13): no restamp, no golden changes.

- Combat context built once per tick, not twice (the gameplay provider reuses it; keyed on every ext slot but combat; not cached for match instances with their own `options.combat`).
- Parking/street-cleaning rules filtered once per rule list and edge set.
- `prepareMotionBodies`: index maps instead of O(n²) `find`/`findIndex`; an unchanged body is kept as is.
- `applyMotionBodies`: walkers test only vehicles from a 16 m grid; a body that stays put is kept; robotaxi intent conflicts through a grid (only pairs with an intent, within reach) instead of all pairs.
- Runtime `synchronize`: sorted ids cached per actor record; the post-movement observation copies only the actors it changes (structural sharing).
- Service/transit blocker lists built only when a tick spawns something.
- Building wall boxes measured once; sorted combat actors once per context; cached `agent:<id>` strings.
- Spread-free builders for motion proposals, runtime combat actors and legacy combat actors.
- Allocation-free `pointInPolygon`, `segmentsMeet` (no closure), `boxPolygonPush` (sample table).

### After (same scenarios)

| | base | after | |
|---|---:|---:|---|
| 1p ms/tick @6,000 (v10 base `86dfb90`) | 24.5 | 10.4 | −58 % |
| 4p ms/tick @1,500 (v10 base) | 107.8 | 48.9 | −55 % |
| 1p ms/tick @6,000 (v13 base `59e5a7b`) | 29.1 | 18.4 | −37 % |
| 4p ms/tick @1,500 (v13 base) | 129.2 | 68.9 | −47 % |
| 1p bytes/tick (v10, ticks 6,001-7,500) | 8.88 MB | 6.68 MB | −25 % |
| 4p bytes/tick (v10, ticks 901-1,500) | 35.1 MB | 27.9 MB | −20 % |
| 1p GC pause ms/tick (v10) | 3.33 | 2.07 | −38 % |
| 4p GC pause ms/tick (v10) | 14.9 | 10.2 | −32 % |

Not yet at the targets (≤5 ms/tick 1p, ≤15 ms 4p; allocation halved). What remains is per-actor work done every tick for
every runtime actor within 300 m: the planner copies each actor (≈1.4 µs for a 37-field record, measured: an explicit
clone is no faster than the spread), proposes a move, builds its combat record; ~75 % of runtime walkers are in the
150-300 m "active" fidelity tier. The next PR plans those at a lower, id-staggered rate (deterministic, a behaviour change).

## SIM_VERSION 14 (`work/perf/agent-lod`, stacked on #87)

Behaviour change, so a new stamp: a walker in the **active** fidelity tier (beyond 150 m of every anchor) with nothing
going on (no reaction, detour, combat effect or attack, not bad firmware, not a dog on a lead, not authored/significant,
not posted, not pending admission) plans only on ticks where `(tick + numericId) % 4 === 0` and moves four ticks' worth
(`AgentMotionProposal.strideTicks`, body speed reported per tick). In between it is untouched: the planner now shares
unchanged actors with the previous tick and copies only what it changes (`own()`), so a skipped walker costs neither a copy
nor a proposal. Near walkers (≤150 m, where the player sees them) still plan every tick. The ambient-traffic layer
already used the same id-staggered stride beyond 200 m.

Hash-preserving additions on the same branch: order-preserving grids for the stopped-vehicle and vehicle box scans
(detours, refused steps) and for bad-robot sight lists.

Upgrade 13 → 14 keeps every field (`upgradeState`). `composed-v14.json` re-recorded (coverage identical in every scenario;
`composed-v13.json` kept); four version pins moved to 14. Full vitest: only those pins and the golden failed before the
re-record; the dodge and clearance soaks stay at zero contacts.

| ticks 6,001-7,500 (1p) / 901-1,500 (4p) | v13 base `59e5a7b` | v14 branch | |
|---|---:|---:|---|
| 1p ms/tick | 34.4 | 13.9 | −60 % |
| 4p ms/tick | 136.2 | 59.0 | −57 % |
| 1p bytes/tick | 11.6 MB | 6.4 MB | −45 % |
| 4p bytes/tick | 47.9 MB | 25.2 MB | −47 % |
| 1p GC pause ms/tick | 6.39 | 2.34 | −63 % |
| 4p GC pause ms/tick | 20.5 | 12.9 | −37 % |

Long run (1p, ms/tick at 1k…6k): v13 base 16.4 · 18.3 · 21.1 · 28.5 · 25.6 · 29.1; v14 8.3 · 8.6 · 9.4 · 11.7 · 13.3 · 12.5.

### Still short of the targets (≤5 ms/tick 1p, ≤15 ms 4p)

Remaining per-tick cost at 4 players (v14, ms): agent planning 19 (route following and detour checks for ~1,000 near walkers),
ambient traffic `stepAgents` 14 (probe 3.5, per-agent step 4.1, obstacle hashes 2.4 — robotaxis within 200 m of a player),
combat 6, post-movement observe 4.5, motion apply 3.4, dodge 3.5, gameplay 3. The next lever is again behavioural: a wider
LOD for ambient traffic (NEAR_RANGE_M 200 → ~120 m), which changes vehicle behaviour near people and needs the dodge/clearance
soaks re-proven. Proposed, not done; it needs the coordinator's call.

## Regression guard

`tests/sim/perf-budget.test.ts` + `tests/sim/perf-budget.json`: SF, seed 1, wave 3, 1 player, ticks 901-1,200 in six
50-tick blocks, each paired with a fixed synthetic calibration workload in the same process. It fails when
best-sim-block ÷ best-calibration-block exceeds 1.6× the baseline ratio, or bytes allocated per tick (v8.GCProfiler)
exceed 1.3× the baseline. Checked both ways: passes on this branch (twice); fails on the unoptimised sim
(ratio 6.0 vs limit 4.9). `FOG_PERF_UPDATE=1` re-records it.

## Coordination

- City-life (#38) raises robot density: each extra runtime walker within 300 m currently costs ≈30-40 µs/tick (1p); please keep density changes behind the LOD PR or share the numbers.
- The pacer's `ticksThisFrame > 1` is the busy signal for Lane R's GPU governor (wired in release #67).
- GitHub Actions is blocked by billing (coordinator, 04:03Z): evidence above is local.
