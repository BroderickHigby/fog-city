# Lane 3 — Sim-Agents

## Now

The existing policy implementation at `083f685` is preserved in `/workspace/fog-city-agents`. Shared core `9a6a107` and combat `ef74fe5` are merged. The wave-2 runtime now exposes `createAgentsSystem(provider)` with pre-movement proposals, accepted-pose observation, stable firmware/protection metadata, sensory brain inputs and monotonic shared combat requests. Core is implementing the final movement/clearance hook; production registration and actual service-body acceptance remain in progress.

The existing prototype in `/workspace/fog-city` remains untouched. Only owned agent/robot directories and this status file are edited.

## Done

- Read the published lane handoff at `38065dd3c48970ab42c97d2bb0d104eee403ed7c`.
- Final remote check found the newly published `integrate/wave2` at the same base commit, `2deafc912ea0971440b541e800158b258c548275`; fetched it and confirmed this branch is up to date. No `lane/core/*` interface branch is published.
- Installed pinned dependencies with a frozen lockfile.
- `9d9025f`: recorded ownership and prerequisites.
- `512beaf`: explicit and road-derived sidewalk graphs, deterministic route proposals, bounded fidelity scheduling, stable ambient identity and promotion, perceived reactions, pigeons and leashed dogs.
- `9766bf6`: graph-backed van dispatch planning, deduplicated requests, observed arrivals, exactly-once disembarkation, bus timetables and stop/dwell policies. Both services retain physical capacity until retirement is acknowledged.
- `f1bb14a`: sensory robot knowledge and state transitions, bounded memory, attack wind-ups, interrupted six-second forced updates, generation-safe completion acknowledgements, public policy exports and replay checks.
- Independent review covered invalid inputs, capacity leaks, repeated requests, observation authority, ordering and state bounds. Review findings were fixed before final unit validation.

## Verification

- Typecheck: passed on the implementation commits.
- Full unit suite: **74 files passed; 2,573 tests passed, 1 skipped**. Includes the new policy suites and forbidden-API check. No golden files changed.
- Policy replay: **Node 24.19.0 and Chromium 154.0.8037.57 match at all 30 checkpoints across 1,800 ticks**. Covers brain, reactions, navigation and fidelity; report at `test-results/lane3/browser-parity.json`.
- Existing Chromium browser suite: **30 passed, 2 failed, 2 did not run** in five minutes. The failures are the normal and split-pack hosted-build checks: Chromium requests `/favicon.ico`, outside `/fog/city/`, and receives 404. Their dependent serial tests consequently did not run. `index.html`, `scripts/build-web.ts` and `tests/e2e/web-build.spec.ts` are unchanged from the integration base. The full verification gate is **not green**.
- Passed browser coverage includes Node/game determinism, multiplayer replay, controls, collision/exit behavior, SF mesh decoding, landmarks, traffic rendering, skyline, city-edge continuity, packed-build host limits and collider-pack splitting. The report-only software-rendering probe completed for all three worlds with no probe errors; this does not establish real-device FPS or the cost of unregistered policies.
- The initial `pnpm verify` completed typecheck and units, then stopped before browser tests because the external browser-config helper used a `.ts` extension incompatible with its ESM context. The corrected `.mts` helper was used for the completed browser-stage rerun, with one worker and system Chromium.
- Firefox and WebKit: not installed or run. The pinned browser installation failed with HTTP 403 `Domain forbidden` from the browser download hosts. Integrated wave-2 clearance, van delivery and Ferry bus passage: not validated because these policies are not yet wired into the runtime.

Heavy checks use `/tmp/fog.lock` and `NODE_OPTIONS=--max-old-space-size=8192`. The browser override is outside the repository; no shared test configuration was edited.

Local evidence: `/tmp/fog-city-lane3-verify.log`, `/tmp/fog-city-lane3-e2e.log`, `test-results/perf.json`, and both hosted-build failure directories under `test-results/playwright/` (screenshots, traces and error context). These generated files are not committed. CI results could not be queried through the blocked GitHub API.

## Next

After the rendering lane fixes the hosted-page icon, rerun the hosted-build checks and their dependent serial tests. When lane 2 publishes its interface, reconcile the policy types with its typed extensions, register the adapters, and run the integrated acceptance tests and clearance soak. Open a draft PR into `integrate/wave2` once GitHub API access is available. Move to wave 3 after the wave-2 runtime is accepted.

## Blocked on

Lane 2's wave-2 interface PR, typed extension slots, migration, event definitions, movement hooks and vehicle/body classifications. Runtime registration is pending that interface. Lane R's hosted-page icon defect currently fails the browser gate. Draft PR creation against the newly published target was attempted with `gh pr create`, but `POST https://api.github.com/graphql` returned `Forbidden`; no PR was created. Git pushes succeed. The environment draft now permits the GitHub API and pinned browser-download hosts, but those changes require environment publication before they apply.

## Requests for other lanes

- **Lane 2 — `src/sim/contract.ts`, `src/sim/systems.ts`, serialization/migration and vehicle adapters:** publish typed policy state, authoritative observations/events and monotonic day/clock inputs; reserve numeric actor/vehicle IDs centrally; map stable ambient spawn identities to runtime IDs; reserve shared attack/conversion capacity in stable actor order; register movement before final `stepDodge`; include vans, buses, people and animals in swept clearance, spawn, join and exit checks. Feed actual vehicle progress and safe-retirement acknowledgements back to services. Keep abstract actors out of combat and sensing. Register the parity fixture with the shared cross-engine harness.
- **Lane 1 — sidewalk and Muni world data:** publish connected sidewalk/crossing graphs, route geometry, Ferry stop IDs and physically feasible departure headways. Lane 3 supplies deterministic road-offset routing and a validated authored bus-route fallback.
- **Lane 4 — combat event adapter:** supply observed rust/wet/melt, operational state and interruptions; apply requested effects only after global capacity arbitration; acknowledge completed forced updates with `{targetId, completedTick}`. Protected people and animals must remain outside water effects.
- **Lane 5 — threat event adapter:** publish validated, monotonically identified `threat.spawn` requests with stable creation ticks. Core/service observations, not the request producer, confirm arrival. Route candidates must support the approximately 120 m entry and 20 s response deadline.
- **Lane R / Assets — `src/render/` agent adapters and `src/debug.ts`:** draw original agent and service-vehicle models with walking, idle, wary/alert, flee, wind-up, forced update, animal startle, van delivery and bus stop/dwell states; expose bounded debug views via `window.__fogcity`. Buses expose an ad-wrap slot. Draw policy intent without advancing sim state or moving bodies after clearance.
- **Lane R — `index.html`:** declare a valid inline or subpath-relative icon in a host-permitted format so Chromium does not probe `/favicon.ico` at the origin root. Keep both hosted-build path/HTTP-status assertions intact; rerun `tests/e2e/web-build.spec.ts` after the fix. This is outside lane 3's ownership.
- **Lane 8 — content:** supply bark keys, behavior tells and bus-wrap content without changing policy decisions.

## For the owner

**Contract changes: none.** No top-level sim file, schema, sim version, renderer, world data or golden file changed. The checked-in integration contract reports version 2, despite the handoff's anticipated version 4/5; lane 2 must allocate the actual next version.

The six-second unopposed update passes as a policy test. A real threat-2 van bringing two units within 20 seconds, a wrapped bus physically passing the Ferry Building every ten game minutes, zero vehicle-person contacts, cross-engine parity on all four engines, performance at full population and final visual quality remain integration acceptance gates. These are not implied by passing pure-policy tests. No wave work was merged into `main` or `integrate/wave1`, and the world-QA gate is unchanged.

## Runtime integration checkpoint

- Added `runtime.ts` and `createAgentsSystem` in the owned registration file. Each proposal contains source and desired poses; the planner never changes a physical body itself. Rejected movement preserves the old route cursor.
- `agentsCombatOptions` supplies classifications for existing bodies and distinct extra actors, avoiding duplicate combat identities. Empty-tank fire does not become hostility; observations use emitted combat events and actual line of sight. Scan alerts are delivered only to their target.
- Attack requests start once per windup with a monotonic per-actor sequence. The combat reducer owns all damage, durations and conversion effects. Actual conversion events update firmware and acknowledge channels.
- Targeted runtime tests: 9 passed. They cover immutable/serializable state, ID collisions, accepted positions, sensory authority, attack idempotency, abstract exclusions, protected animals, detached dog handling, bounded drone ascent and actor-order replay. The larger owned-agent/combat subset passed: 13 files, 230 tests. Typecheck and 12 runtime/mission placement tests also passed before the final content-default wiring; a targeted recheck of that wiring is queued under the shared lock.
- Remaining acceptance: core pre-movement and final dodge integration; real graph/Muni adapters and steering service bodies; mission actor bindings; wave-3 onward behaviors; integrated acceptance/performance/browser checks. No claim of a finished game or zero-contact integration is made yet.

## Draft pull request text

Title: `feat(agents): connect deterministic actor policies to core and combat`

Body:

Connect the existing sidewalk, reaction, fidelity and bad-robot policies to a stateful runtime adapter. The runtime supplies stable classifications and sensory facts, proposes bounded movement for core clearance, observes accepted body positions and emits monotonic combat requests without scheduling attack effects itself. Shared core/combat branches are merged; the original prototype is excluded.

Validation: targeted runtime tests (9 passed); existing policy replay evidence above. Core movement/service integration and broader validation are still in progress, so open this as a draft against `integrate/wave2`.

- Handoff checkpoint: default density/protected-area queries now reuse `src/content/places.ts`; final targeted typecheck/test rerun is pending the shared lock. Mission placement exposes stable blueprints and crew bindings, with road-only taxi candidates.
