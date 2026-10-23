# Agent runtime

Lane 3 supplies the deterministic population, service vehicles, robot decisions and later-wave routines. The public game enables this runtime; old recordings remain opt-in so their motion stays compatible.

```ts
import { enableAgentRuntime } from "./runtime-state.ts";

const live = enableAgentRuntime(saved, {
  wave: 8,
  startGameMinute: 720,
  startWeekday: 0,
  // Supply only real authored/purchased restoration sites.
  restoreSafehouses: [],
});
const next = step(world, live, inputs, recordedEvents);
```

The shared schema is `SIM_VERSION = 7`. `upgradeState` completes legacy ground/dodge fields and preserves unknown extensions. Runtime state is serialized below `ext.agents.runtime`; robot observations/results and the activation marker are below `ext.robots`. Never copy the earlier prototype's incompatible `ext.game` into these slots.

## Modules

| Module | Responsibility |
| --- | --- |
| `navigation.ts`, `fidelity.ts`, `reactions.ts` | Sidewalk graph/routing, bounded population scheduling, sensory reactions |
| `runtime-spatial.ts` | Physical sidewalk handoff, protected pigeons and leashed dogs |
| `services.ts`, `runtime-services.ts` | Timetabled buses and dispatched vans, physical routes, safe unloading and retirement |
| `runtime-system.ts` | Registered population/fleet stage and shared numeric ID allocation |
| `../robots/brain.ts`, `../robots/runtime*.ts` | Robot knowledge, decisions, retained firmware and combat requests |
| `routines.ts`, `routine-runtime.ts` | Drones, box-in, Patrol, swarm, theft, Tidy, calendar routines, recruits, robot-body control and finales |
| `recruit-transport.ts`, `associate-transport.ts` | Actual seats, journeys, arrivals and separate rider/vehicle identities |
| `runtime-combat.ts` | Authoritative water/attack integration, cancellation and shared swarm limits |
| `runtime-clearance.ts`, `routine-effects.ts` | Final mixed-body clearance, physical effects and post-clearance receipts |
| `runtime-registration.ts` | Composes the complete agent stage |
| `walker-route.ts`, `../robots/finale.ts` | Checked Walker patrols and body/joint/footfall progression |

## Tick ownership

1. Move players and legacy road agents, with runtime obstacles included in spawn/join/exit checks.
2. Compose population, physical fleet/transport and routines. Use prior authoritative observations; one owner moves each body.
3. Run robot decisions, then combat. Combat owns wind-up clocks, rust and conversion completion.
4. Apply validated physical effects and restoration. Arrival is separate from a completed firmware reset.
5. Run one final mixed-body clearance pass. Record landing receipts afterward without moving anything.

Camera position never acts as a simulation anchor. Hidden riders retain their identity but have no independent collision/draw body. A timetable, elapsed deadline or requested waypoint is never an arrival acknowledgement. Failed routes and missing safehouses remain explicit pending/rejected results. Significant actors and reserved van unload slots share the 2,000-actor cap; ambient limits remain 60 per anchor and 800 total.

`threat.spawn` uses the shared gameplay contract. `agents.recruit`, `agents.robot-body.start` and `agents.finale.start` are recorded, sequenced commands; their payloads are validated. A boss route must have all required phases and real clearance. Without an authored Walker route, threat 5 can derive a checked patrol from known world geometry. Unknown ground produces no invented route.

## Validation

Source `/workspace/.fog-city/activate.sh` in this environment. Serialize heavy work:

```bash
NODE_OPTIONS=--max-old-space-size=8192 flock /tmp/fog.lock pnpm typecheck
NODE_OPTIONS=--max-old-space-size=8192 flock /tmp/fog.lock pnpm exec vitest run --maxWorkers=2
NODE_OPTIONS=--max-old-space-size=8192 E2E_PORT=5483 flock /tmp/fog.lock pnpm e2e --config /workspace/.fog-city/lane3.playwright.config.mts --workers=1 --project=chromium
NODE_OPTIONS=--max-old-space-size=8192 flock /tmp/fog.lock node scripts/bench/agent-runtime.ts --world sf --anchors 1,4,24 --ticks 180 --warmup 10 --max-p95-ms 0.7 --max-state-bytes 1500000
```

`tests/e2e/agent-runtime.spec.ts` compares Node/browser hashes and complete state over 1,800 integrated ticks. The benchmark supports `--drive --check-clearance --replay` and `--require-services`; a failed gate returns nonzero. Software rendering does not establish real-device FPS or final art quality. See `docs/parallel/status/sim-agents.md` for actual results, dependencies and known failures.
