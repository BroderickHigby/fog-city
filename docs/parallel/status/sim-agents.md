# Lane 3 — Sim-Agents

## Now

Worktree: `/workspace/fog-city-agents`, branch `lane/sim-agents/wave2`. The original prototype in `/workspace/fog-city` remains untouched. Existing policy commit `083f685` is preserved, with shared core `9a6a107` and combat `ef74fe5` merged.

Published runtime checkpoints: `975ab09` adds the runtime and mission placement; `950f47c` supplies portable arithmetic and retirements; `8b896c4` uses the shared foot factory in the fixture. Core has taken these into its wave-2 candidate. This remains integration work, not a completed wave-2 game.

## Implemented

- Existing sidewalk routing, fidelity, reactions, robot brain, van dispatch and bus timetable policies remain intact.
- `createAgentsSystem(provider, allocateActorIds)` prepares bounded movement proposals before physics, observes the actual accepted bodies afterward, and reports retired body IDs. Core owns physical acceptance and final person clearance.
- `runtimeCombatActors` and `agentsCombatOptions` provide stable firmware/protection metadata and actual positions. Legacy bodies are described through metadata rather than duplicated. Extra bodies have centrally allocated numeric IDs.
- Sensing uses line of sight and actual combat events. An empty-tank fire button creates no hostility. A scan alert reaches its actual target. Shared combat owns all attack durations and effects; the runtime emits one monotonic request per windup and consumes authoritative conversion events.
- Default population density and protected-area conversion checks reuse `src/content/places.ts`. Unknown legacy people remain protected until the core's child metadata is adopted. Animals are always protected; detached dogs hold safely.
- `decodeMissionStage` and `planMissionActors` produce stable `mission:<missionId>:<alias>` identities, clear placements, crew expansion and bindings. Taxis require valid road candidates. The optional allocator lets the registered system admit stage actors automatically.
- `planModeRoster` produces 120 base robots plus the armoured Update Relay for Bot Sweep, with 10 + 4/player bad base units; Clean Streets has 30 bad units among 120. All placements must lie in the approved instance predicate. Relay rust resistance is 0.2.
- `navigationFromPipeline` consumes the existing sidewalk dataset, preserves source IDs, retains height/signal metadata, joins authored interior curve vertices to their endpoint nodes, and can restrict routing to loaded tile nodes.

## Verification

- Earlier policy-only work: 2,573 unit tests passed; Node/Chromium policy replay matched at 30 checkpoints over 1,800 ticks. This is historical evidence for the policies, not proof of integrated runtime behavior.
- Current owned agents plus wave-2 combat subset: **13 files, 230 tests passed**.
- Latest runtime, mission placement, mode rosters, pipeline navigation and forbidden-API check: **5 files, 68 tests passed**; typecheck passed.
- The real `public/tiles/sf/sidewalks.json` loads through the new adapter: **33,081 nodes, 58,007 edges, 28,134 crossings**.
- Automatic mission-stage admission, portable APIs and runtime retention passed a follow-up: **3 files, 63 tests**, plus typecheck.
- Heavy checks use `/tmp/fog.lock`, `NODE_OPTIONS=--max-old-space-size=8192` and at most two Vitest workers. No new full browser run was started in this lane.

The previous hosted favicon failure was fixed independently by the rendering lane; the lane does not weaken those assertions. The registered runtime acceptance fixtures now pass: accepted extra bodies move once, an unopposed forced update completes once at tick 361, the van delivers within 20 seconds and a wrapped bus stops at the Ferry. These fixtures check zero contacts each step; a full multi-player clearance soak remains owned by the integration lane. No golden files were changed.

## Remaining

1. Complete the scene/controller regression checks and publish this checkpoint; core physical kernel and observed-body integration are merged.
2. Connect the static world loader to `navigationFromPipeline` and use the loaded tile set.
3. Broaden service route coverage and lifecycle soak; the physical van/bus acceptance fixtures pass with real follower controls and measured stopped arrivals.
4. Continue wave-3 through wave-8 behaviors: drones, rogue taxi/swarm/patrol/associates, Tidy/restore, calendar behaviors, recruits/parrots, robot-body control and finale evacuation/boss actors.
5. Run integrated performance, deterministic replay and browser checks with the coordinating lane.

## Requests for other lanes

- **Core:** publish the prepared-motion checkpoint and stable allocator; include extra body width/length, accepted poses and retirements in the clearance path. The factory can accept `allocateActorIds` directly. Legacy child metadata comes from `personIsChild`; unknown subjects must remain protected. Publish the vehicle follower interface and measured progress/retirement observations.
- **Pipeline/world loader:** load the existing sidewalk graph with the actual tile node set; the adapter now matches its interior-point semantics. Supply physically valid transit route geometry and Ferry stop IDs.
- **Combat:** publish validated monotonic Tidy collect/restore requests; agents will not reset combat rust or phases directly. Parrot lure events will become agent movement toward a 15 m stand-off radius.
- **Player:** shared `ThreatSpawnRequest` string identities and mission stage events are the source of spawns. Mission bindings use the stable IDs above; crew objectives resolve member aliases. Service arrival is acknowledged only after actual measured body progress.
- **Rendering:** draw extra actors from `ext.robots.actors` where `legacyId === null`, not retired and in full/active fidelity. State has model, firmware, accepted pose, reaction, behavior and brain state. Models include animals, service vehicles, drones, Patrol, Tidy, associates, sign-spinners and Walker. Render proposals never move the sim.

## Draft pull request text

Title: `feat(agents): connect actor policies, mission spawns and combat runtime`

Body:

Connect the existing deterministic agent policies to a runtime that proposes bounded movement before physics, observes accepted body poses and supplies real classifications and sensory facts to combat. Add stable mission actor placement, approved mode roster blueprints and an adapter for the existing sidewalk dataset. The original prototype is excluded.

Validation: owned agents/combat subset 230 tests passed; runtime/placement/mode/navigation and forbidden-API pass 68 tests, plus typecheck. Real sidewalk data loads at 33,081 nodes and 58,007 edges. Core movement/service integration remains under validation, so this is a draft against `integrate/wave2`.

Git push works. GitHub API operations have been blocked in this environment, so the coordinating session can open the draft PR. No merge to `main` or `integrate/wave1` is authorized or performed by this lane.

## Service and authored-behavior checkpoint

- Shared allocation/follower API `fd9715e` is incorporated. The new service coordinator dispatches vans onto clear directed roads 100–140 m away, sends follower controls to core, and unloads exactly two actors only after an observed stopped arrival. It reports late arrivals instead of treating a deadline as delivery.
- The Muni coordinator accepts immutable `TransitLayer` data from the world loader. It schedules wrapped buses every ten game minutes near the Ferry Building, uses actual source stop IDs, emits Ferry passage only from a stopped physical body at that stop, and retires buses after they leave player fidelity. The actual data file is `public/tiles/sf/muni.json`; the world loader must supply it.
- Runtime actors now expose authored `bag`, `statusLight`, `tellIds`, `tellIntensity` and `hiddenTellId` fields. Mission archetypes choose the correct model and goal table from the existing content. The Hot Desk snatcher pursues a grocery snatch and carries its authored empty-bag tell; the shopper carries groceries. Inventory events update bag state.
- Good robots with a repair flag seek a real repair kiosk. `agentsCombatOptions` supplies the baseline twofold conversion cap required for forced updates.
- Latest validation: **typecheck passed; 14 owned-agent/forbidden-API files, 194 tests passed**. The van and bus tests require observed arrival, reject timer-only success and replayed dispatch, and check wrap/source-stop data.
- Core `b7c412c` now publishes the physical prepared-motion kernel. Merge and actual service-control acceptance tests are the next step; the passing controller tests do not establish physical 20-second delivery yet.

## Physical service, scene and rival-controller checkpoint

- Core physical kernel `a86ac61` and isolated follower fix `953a4d8` are merged. Actual van arrival and the wrapped Ferry bus both pass through the ordinary vehicle controller. Arrival requires an observed body within 2 m and speed below 0.3 m/s.
- A forced update completes exactly once at tick 361 through the combat reducer, with runtime firmware synchronized afterward. Accepted extra-body poses feed both runtime and combat; no direct movement shortcut is used.
- `e78b70c` isolates the rival-founder controller under the extra paths assigned by the coordinating lane. It produces ordinary player inputs and recorded gameplay commands from visible actors, its own accepted scans, refills and objectives. It preserves last-seen memory, avoids unseen updates and protected spray corridors, and recovers from blocked travel. All ten adversarial controller tests pass.
- Scene requests use validated stable IDs and safe placement for the teleoperation van, unit, pickup, recipient and server. Posted scene actors remain stationary. Accepted controlled actor IDs suspend the autonomous planner without removing runtime metadata. `fogAt` allows core to provide per-position weather. Scene admission, posted actors, control suppression and positional fog tests pass.

### Requests for other lanes

- **Core:** supply only accepted `controlledActorIds` and keep their accepted poses in `observedBodies`; add bounded flying-body acceptance for wave 3. World navigation/transit data should continue to flow through the configured provider.
- **Player:** `mission.scene-request` can supply the agreed small-body scene schema; giant Walker and fireboat require their dedicated physical/model contract.
- **Combat:** maintenance dependency is published at `043396c`; the Tidy bridge will retain hidden carried targets in combat until restore, then wait for physical readmission before emitting accepted restoration.
- **Integration:** full clearance fuzz/soak and browser performance remain necessary beyond the small physical fixtures.

### Updated draft PR

Title: `feat(agents): connect physical services, mission actors and observed robot behavior`

Body:

Connect sidewalk policies and robot knowledge to the shared physical kernel and combat reducer. Vans dispatch on valid directed road routes and deliver two units after an actual stopped arrival; wrapped buses follow timetables and acknowledge source Ferry stops only after physical arrival. Stable mission/scene actors retain accepted poses and authored visual tells. Add an isolated rival-founder input controller using perceived actors and accepted scan results.

Validation: registered runtime/forced-update integration passes; real van and Ferry-bus service fixtures pass with zero contacts on every checked tick. Typecheck and 101 focused runtime, scene, rival-controller, physical-service and portable-API checks pass. No full browser or multi-player soak is claimed.

Latest verification: TypeScript passes; **5 files, 101 tests pass**, covering runtime behavior, scene admission/control, all ten rival-controller checks, physical van/bus acceptance, and forbidden APIs.

## Routing performance checkpoint

The CPU profile of the real SF scene identified repeated nearest-node scans as a major agent cost. The sidewalk graph now owns an immutable spatial tree, and exact nearest-node queries preserve the existing distance and ID tie rules. It also stores weak components, so disconnected destinations return immediately instead of searching a component that cannot reach them. There is no global mutable route cache or changed AI cadence.

Typecheck and **4 focused files / 90 tests pass**, including exact nearest-node comparisons for local/remote points and ties, disconnected-search rejection, physical runtime integration and forbidden APIs. A real-SF per-system timing probe is queued before claiming a measured speed improvement.

## Wave-2 admission repair from the canonical Hot Desk probe

Branch: `lane/sim-agents/wave2-admission-fix`, based directly on frozen `9c65082`. This repair does not include the later threat/flight/Tidy stack.

The saved canonical SF Hot Desk run failed at tick 1201 when `transit:FBUS-in:20` (numeric ID 334) overlapped `transit:FBUS-in:10` (333). Their long bus hulls intersected although the old center/radius entry check passed. Static world clearance was not the cause.

Service and transit entry planners now check complete oriented vehicle hulls against static geometry, physical bodies, runtime extras, parked cars and walking players. Pending service spawns also block transit entries in the same prepare batch. Missing-body retries recheck their stored origin each tick and remain pending while blocked, without inserting a runtime/combat actor.

Validation: TypeScript passes; 16 focused service/transit/admission tests and 75 forbidden-API checks pass. The exact saved state and last input now advance from tick 1200 to 1201 through canonical `createGameSystems()`: the second bus is admitted at `(79.902636, 172.812664)`, and all 333 runtime actors match physical bodies. The narrow tests cover the exact rejected hull pair, foot-player entry blocking, parked car hulls, blocked retries and simultaneous van/bus admission. Full Hot Desk completion remains with the coordinating harness.

Draft PR title: `fix(agents): validate full service hulls before admission`

Draft PR body:

The canonical Hot Desk approach could crash when a second timed Ferry bus spawned through the first bus's long hull. Check complete vehicle footprints and all accepted bodies before service admission, include walking players and pending service/transit spawns, and defer blocked retries before a runtime actor is created.

Validation: typecheck, 16 targeted tests and 75 portable-API checks pass. Replaying the exact saved SF tick-1200 state through the game systems now reaches tick 1201 with a clear second-bus entry and matching runtime/physical actor counts.

Follow-up: service admission now takes missing legacy taxi dimensions from shared `ROBOTAXI_BODY` (half-length 2.5 m, half-width 1.0 m), matching the drawn body and core clearance. Explicit bus/van dimensions remain unchanged. Typecheck and 17 service/transit/admission regressions pass, including the taxi's outer length and width.
