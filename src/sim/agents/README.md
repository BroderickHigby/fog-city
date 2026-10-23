# Wave-2 agent policies

These modules prepare the lane-3 behavior systems. They are independently executable policies, not a registration of new actors in the running game. The shared wave-2 interface and its `systems.ts` stubs were not available when this branch was prepared. No top-level sim file, schema, version, renderer, or world data is changed here.

Import the APIs from `src/sim/agents/index.ts`, or import a module directly:

| Module | Responsibility |
| --- | --- |
| `navigation.ts` | Explicit sidewalk graphs, the road-offset fallback, deterministic shortest routes and route proposals |
| `fidelity.ts` | Sim-anchor scheduling, reproducible ambient identity, promotion, and abstract offscreen progress |
| `reactions.ts` | Helpful robot, person, pigeon and leashed-dog reaction intents |
| `../robots/brain.ts` | Sensory knowledge, behavior states, bounded attack wind-ups and interrupted forced updates |
| `services.ts` | Idempotent van requests and observed arrivals; bus timetable and stop policies |

## Integration order

The core lane must supply the final adapter and state migration. Its per-tick order should be:

1. Read prior-state actors and validated events. Allocate numeric runtime IDs centrally. An ambient identity is a stable spawn key, not permission to replace a live actor's numeric ID.
2. Construct sensory observations using actual line-of-sight and authoritative prior-state positions. Do not mark an occluded actor as visible, update remembered positions from hidden state, or turn a camera location into a fidelity anchor.
3. Run the lane-owned policies in stable actor order. Reserve conversion and melee capacity as intents are accepted, so simultaneous policies cannot independently oversubscribe a shared cap.
4. Apply accepted locomotion through the shared sidewalk/vehicle follower and collision system. Service arrival/stop observations must describe its resulting progress; a deadline or a timetable is never a substitute for physical arrival.
5. Apply authorized combat effects through the combat lane. A policy only requests an effect; it does not change another robot's alignment, rust, health or rewards itself.
6. Run the existing final `stepDodge(world, before, moved)` pass. Do not move any physical actor afterward.

An agent already controlled by a dive/clearance override must keep that motion authority. New vans and buses must be represented in the same swept footprint, vertical-band, spawn, join and exit-clearance checks as existing vehicles. People and animals need the appropriate protected-body classifications before they appear in the live world. A policy-only test cannot prove those integration guarantees.

## Existing runtime adapter

The current integration branch's `src/sim/agents.ts` uses numeric IDs and the `ext.agents` list. Its `errandRobot` maps to the brain's `footman` archetype and `sidewalkBot` maps to `trundle`; do not rename the existing serialized kinds to adopt the policy API. The road graph is static world data. Policy state belongs in a typed, migrated extension chosen by core; it must not silently replace `ext.agents` or the separately developed prototype's `ext.game`.

Keep significant actors when they leave active regions. Promote wet, rusted, scanned, recruited, converted or mission actors before population handoff/despawn, and handle a refused promotion explicitly so an interacted actor cannot silently disappear at the population cap. Keep their route, identity, random state and phase when promoting or handing them back to full detail. Abstract actors must not attack, convert, receive new sensory knowledge or award rewards. Van request IDs and their creation ticks must be stable across retries. Timetable minute values must be monotonic across midnight; convert the shared day/clock before calling the scheduler.

Service vehicle IDs are reservations from the core allocator, not a separate global ID space. Confirm retirement only after the shared vehicle system has safely removed the physical body; a completed or timed-out job retains its vehicle slot until that acknowledgement. Confirm forced-update completion with both `targetId` and `completedTick`, after the combat lane has applied it, so delayed acknowledgements cannot consume a newer completion.

## Validation

From this checkout, with its dependencies installed:

```bash
NODE_OPTIONS=--max-old-space-size=8192 flock /tmp/fog.lock pnpm typecheck
NODE_OPTIONS=--max-old-space-size=8192 flock /tmp/fog.lock pnpm exec vitest run tests/sim/agents --maxWorkers=2
NODE_OPTIONS=--max-old-space-size=8192 flock /tmp/fog.lock node tests/sim/agents/browser-parity.ts
```

The parity runner uses installed Chromium (or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`), compares 30 checkpoints over 1,800 policy ticks against Node, and writes `test-results/lane3/browser-parity.json`. It does not register the policies in the live simulation or validate physical clearance.

Core owns the final registration, migrations, cross-engine suite, golden updates and combined vehicle/person clearance soak. Lane R owns visible assets and animation; lane 4 owns rust and effect application. Requests and current verification results are recorded in `docs/parallel/status/sim-agents.md`.
