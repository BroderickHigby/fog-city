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

The previous hosted favicon failure was fixed independently by the rendering lane; the lane does not weaken those assertions. Core's new movement and dodge integration still needs runtime acceptance/clearance tests before a zero-contact claim. No golden files were changed.

## Remaining

1. Merge core's prepared-motion, stable identity, observed-body and final dodge checkpoint; run actual registered runtime acceptance tests.
2. Connect the static world loader to `navigationFromPipeline` and use the loaded tile set.
3. Connect shared threat requests and the existing van/bus policies to actual steering follower bodies, measured route progress, disembarkation and safe retirement. A policy timer alone is not delivery proof.
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
