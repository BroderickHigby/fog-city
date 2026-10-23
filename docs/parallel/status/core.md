# Lane 2: Core sim and harness

## Now
- Remaining wave-2 core/harness work is active: shared gameplay commands/world metadata, clock/calendar, fog API, vehicle follower and runtime movement integration.
- `integrate/wave2` is pushed at `ee21b4d`: reviewed core + combat `ef74fe5` + favicon fix. Scoped intake verification passed (157 tests and typecheck).
- Publishing `gameplay-contract.ts` with the single `gameplay.command` channel agreed by Player/UI, and `gameplay-world.ts` plus the tile-gameplay schema for Pipeline.

## Done
- Inspected the actual base: `SIM_VERSION` is 2. `qa/sim` and `feature/dodge` use 4, with 5 reserved for their integration. Wave 2 will use 6.
- Isolated this lane from the uncommitted prototype and combat checkouts.
- Pushed `integrate/wave2` at `2deafc912ea0971440b541e800158b258c548275`.
- Added schema 6, optional aim fields and seven action bits. Old bits are unchanged.
- Added core-owned `combat-contract.ts`, typed extension slots, event-name constants and fixed-order pure system hooks. Every area's registration list starts empty.
- Captured a 300-tick schema-2 replay from the unmodified base (12 ambient agents, driving, braking and walking) with five pinned state hashes in `tests/golden/wave1-v2.json`.
- Frozen-lockfile offline dependency installation and typecheck passed.
- Interface commit: `39abfda` (`Core: publish wave-2 interfaces with schema 6 replay migration`).
- Focused verification passed: 3 files, 50 tests (wave-2 interface, sim determinism, forbidden APIs). An independent read-only adversarial review found no blocking regressions.

## Next
- Integrating session: run full unit/browser verification on the combined core and combat commit, then integrate the interface into `integrate/wave2`.
- The remaining wave-2 clock, fog, vehicle follower, drivers, benchmarks and browser harness work is separate from this day-one interface.

## Blocked on
- GitHub API access is unavailable; the owner will open the draft PR from the pushed branch.
- QA/dodge migrations must land before saves from their intermediate schemas can be accepted safely.
- Automatic approval review rejected merging the docs-only `origin/integrate/wave1` source into `integrate/wave2` twice, interpreting the protected-branch rule as banning that merge direction too. No protected branch was changed; no workaround was attempted. Read-only handoffs remain available.

## Requests for other lanes
- All lanes: build against the shared interface once published. Do not edit `contract.ts`.
- Lane 4: import/re-export shared combat types from `src/sim/combat-contract.ts` after this interface lands.
- Lane R: coordinate QA/dodge migrations and the reserved schema 5 before merging them into wave 2.

## For the owner
- No changes to `main` or `integrate/wave1`. This is the shared foundation, not a completed wave or a visual-quality sign-off.
- Draft PR title and body are recorded below. Full unit/browser and CI results remain pending; focused success does not claim full-wave completion.

## Interface hand-off
- `Action`: old bits 0–3 remain; `gadget`, `cone`, `interact`, `streak`, `emote`, `watch`, `altFire` are bits 4–10.
- `SimInput.aimYaw` and `aimPitch` are optional radians. Sanitization wraps finite yaw, clamps pitch to ±π/2, and omits absent or non-finite aim so old logs retain weapon defaults.
- `SimSystem` is `{ key, step(context): SimState }`. Context contains `world`, `previous`, post-movement `state`, sanitized `inputs`, and recorded `events`. Return a new state and never mutate the context.
- `src/sim/<area>/systems.ts` exports `systems: readonly SimSystem[]`. The core composes lists in fixed order and rejects duplicate keys or changed tick/version.
- `step(world, previous, inputs, events, systems)` also accepts an explicit registry; this allows complete world/actor context providers without mutable global registration. Empty defaults produce no extension state.
- `src/sim/combat-contract.ts` is the shared combat authority. Lane 4 can replace its local type definitions with `export type * from "../combat-contract.ts"`.
- Extension schemas for unopened areas are JSON object placeholders. Event constants type names; payload validation is not implemented by this interface.
- v1 and v2 saves load through `upgradeState`. Versions 3–5 are intentionally rejected until their QA/dodge migrations land. Schema 6 only changes the schema stamp for v2 saves.

## Draft pull request

Title: `Core: publish the wave-2 simulation interface and replay migration`

Base: `integrate/wave2` · Head: `lane/core/wave2`

Open: <https://github.com/BroderickHigby/fog-city/compare/integrate/wave2...lane/core/wave2?expand=1>

Body:

### Summary
Publish a common interface so the simulation lanes can build against one contract. Add optional aiming, seven action bits, typed extension slots, shared combat state/context types, and deterministic system hooks after movement. Empty registrations preserve existing play.

### Roadmap deliverables
- [x] Wave-2 interface and next `SIM_VERSION` with migration coverage.
- [x] Shared extension names and event kinds; per-area registration stubs.
- [ ] Remaining Sim-World and Harness wave-2 deliverables (clock, fog, vehicle followers, drivers, soaks, goldens, browser harness and benchmarks).

### Acceptance tests
- Passing: typecheck.
- Passing: 50 tests across the recorded schema-2 replay, migration, action/aim, registration order, sim determinism and sim purity suites.
- Reviewed: independent adversarial read-only review found no blocking regression.
- Pending: full unit and browser verification on the integrating session's combined core/combat branch. No CI claim before the PR runs.

### Contract changes
**SIM_VERSION 2 → 6**; versions 3–5 are reserved for pending QA/dodge code and are not blindly migrated. v1/v2 saves preserve existing data and old input frames need no new fields. Existing action bits retain their values. All shared combat types live in the core-owned `combat-contract.ts`.

### Requests for other lanes
Lane 4: consume the shared combat types and provide a pure system factory with complete actor context. All lanes: replace only your own empty registration list as implementations land; coordinate shared schema changes with Core. Lane R: bring QA/dodge migrations with their code and preserve schema 6 on integration.

### For the owner to judge
This PR supplies interfaces and replay compatibility. It does not claim the full wave, visual quality or gameplay feel is complete. The branch contains no prototype changes and does not alter `main` or `integrate/wave1`.

## Physical runtime candidate (2026-10-23)

Branch: `lane/core/clearance-candidate` (disposable integration candidate; not merged into `integrate/wave2` yet).

- Shared allocator/follower checkpoint `fd9715e` is pushed. Stable actor names reserve monotonic numeric IDs; vehicle following produces normal inputs and measures actual travel.
- Intake is limited to the reviewed `feature/dodge` core physics, its regression harness, and compatible lane-owned gameplay commits. No QA pipeline/render tree was imported.
- **SIM_VERSION 7** adds missing vertical/dodge fields for historical schemas while preserving existing fields and old input logs. The old v2 golden remains unchanged; the v7 replay has its own golden.
- Prepare/observe hooks admit actors before movement, apply desired movement once, perform final clearance, and expose accepted poses to the agent reducer. Retirement removes the physical proxy without recycling its ID.
- Added deterministic calendar (24-minute game days) and explicit wave-2 fog provider, plus static sidewalk metadata adapter.
- Validation before the final adversarial fixes: typecheck and 85 focused tests passed; reviewed physics harness had 131 tests passed, and 10 real-city/fuzz/calendar/identity tests passed. Final acceptance run passed 110 tests across motion, follower, dodge and purity. Typecheck passed before the final regression-only rerun; subsequent shared additions are type-only. Full combined browser verification remains with the integrating session.
- Read-only adversarial review identified legacy population retention, vehicle hull collision, and identity/dimension validation gaps; fixes and regression coverage are included in the candidate.

### Candidate draft PR

Title: `Core: integrate physical actor preparation, clearance and schema-7 migration`

Base: `integrate/wave2`
Head: `lane/core/clearance-candidate`
Open: <https://github.com/BroderickHigby/fog-city/compare/integrate/wave2...lane/core/clearance-candidate?expand=1>

Body:

Provide one physical movement path for runtime agents and the player: prepare actor intent before movement, admit deterministic identities, apply bounded desired motion, finish collision/clearance, and return accepted body poses. Retired runtime bodies are removed and IDs are never reused. Vehicle proposals are checked using their full swept footprint, and claimed legacy actors retain population ownership.

Bring the reviewed gravity/roof/dodge core and its replay/fuzz harness into the current interface without importing unrelated QA assets or render work. Bump the state schema to 7; historical input logs remain unchanged and missing physical fields are migrated additively. Add a deterministic calendar, wave-2 fog interface, static navigation adapter, and a measured vehicle follower.

Validation: focused migration/interface/physics/purity, calendar/identity/follower and motion regression checks; exact final results are recorded above as runs finish. Full combined browser and CI verification remain pending. No changes to `main` or `integrate/wave1`; this candidate is not a completed visual-quality or full-wave sign-off.

## Composed gameplay checkpoint

- `createGameSystems({ wave: 2 })` is the shared browser/headless/relay composition. Pass the returned registry as the fifth argument to `step`.
- It registers the calendar, configured agent preparation/observation, combat with actual body metadata/loadouts/refills, player/economy/mission/progression reducers, and the modes registration list. Empty wave-2 mode registration becomes the real reducer when the modes lane is integrated.
- `World.gameplay`, `World.sidewalks` and `World.transit` supply immutable loaded data. `World.transit` uses the agents lane's `TransitLayer`; `buildWorldNavigation` adapts the existing sidewalk layer.
- Service vehicle `controls` now run through `stepCar` once, retain physical controller state, then pass through full-size hull and final clearance acceptance.
- Typed extension placeholders for robots/player/heat/missions/economy/progression/activities now reference each owning lane's exported state. Narrow owned fixture migrations were authorized by the respective lane owners.
- Real composed tests exposed and fixed reticle targeting: Watch now uses a 15-degree cone and angular error before distance, preventing an off-reticle nearer robot from stealing an aimed target.
- Integrated agent services/transit `31b4079` and player real-event normalization `e857ab4` + `4d32239` (local equivalents `e41f1f5` + `6f459ab`).
- Validation: **typecheck passed; 102 tests across 7 files passed**, including authored Hot Desk stage→accepted actor→held Watch objective, held interact→actual refill, physical service controls, agent runtime/service/transit regressions, event attribution and forbidden APIs.
- Still pending: visible renderer composition, real-SF service/mission driving and full browser/parity checks. The existing world pack remains FCWC v1; no QA v4 deck/tunnel geometry has been imported.

## Performance candidate

Branch `lane/core/perf` starts at the immutable wave-2 candidate `aa1eb6a`. `9873dd8` reuses identical per-tick observations across the six gameplay reducers; interleaved simulation branches remain identical to fresh registries (three composition tests passed). The first timed comparison did not demonstrate a speed improvement, so this is not a performance sign-off.

A core population defect was found during profiling: claimed legacy actors were omitted from ambient population counts, allowing replacement actors to be added every population tick. Population now counts all present bodies while preserving runtime ownership. The exact regression compares the same population calculation with claimed bodies and passes, alongside the composition tests (four tests total).

Real-SF baseline remains too slow for the intended game: the 100-tick sample measured about 17 ms median, 27 ms p95 at 255 actors; a separate 600-tick driving probe took 51 seconds. CPU sampling points primarily at agent preparation/nearest-node work. Agent and combat hot paths are being reviewed separately; full renderer and replay timing remain pending.

Draft PR title: `Core: retain claimed actors in population budgets and reuse observations`
Base: `integrate/wave2` · Head: `lane/core/perf`
Open: <https://github.com/BroderickHigby/fog-city/compare/integrate/wave2...lane/core/perf?expand=1>
Body: Count runtime-owned legacy actors when replenishing ambient population, preventing duplicate replacements without surrendering movement ownership. Reuse the unchanged observation snapshot across gameplay reducers and verify interleaved replay branches. Includes population and replay regression tests. Actual-SF profiling is still in progress; this branch does not claim the final simulation budget or visual quality target.

Performance candidate follow-up: merged the agents lane's tested `fc64776` exact spatial nearest-node index and current runtime reuse, retained population fix `f6f8357`, and applied an authorized combat adapter allowlist copy (avoids cloning then deleting body fields). The adapter still ignores metadata identity/position overrides. Updated a leftover test assertion from the earlier typed-extension fixture migration. Combined **typecheck and 100 tests across 7 files passed**, including exact navigation queries, actual service movement, population ownership, metadata protection, replay branches and purity. A new consistent-world timed probe is still required before claiming the frame budget.

## Real-route pedestrian contact fix

- Isolated branch `lane/core/contact-fix`, based on corrected harness `7269504`.
- At Hot Desk tick 3078, runtime person 224 stepped from 0.325502 m clearance to 0.298938 m from stopped legacy taxi 198, penetrating its 0.3 m radius by about 1.062 mm. Runtime walker acceptance checked player cars but omitted ambient/service vehicle hulls; final dodge correctly counted the resulting contact.
- Runtime walkers now sweep their bounded step against all actual vehicle hulls. Legacy taxis use the drawn `ROBOTAXI_BODY` defaults; explicit van/bus dimensions and parked player cars are preserved. Height bands avoid unrelated stacked surfaces, and an already overlapping body can move away. Strict contact counters and the final dodge phase are unchanged.
- Validation: **typecheck and 120 tests across four files passed**. The new side/front regressions both reproduced a contact before the change. Tests also cover long service hulls, parked player cars and escape from an existing overlap.
- The exact saved 3077 state plus its next input now reaches tick 3078 with **zero contacts and zero failures**, then remains at zero for 120 additional ticks through 3198. Full route/browser re-verification belongs to the updated immutable integration candidate.
- Dependency alignment: Agents owns the corresponding planner fallback to `ROBOTAXI_BODY` so spawn planning and core admission use the same legacy taxi bounds.

Draft PR title: `Core: keep runtime walkers outside every vehicle hull`
Base: `integrate/wave2` · Head: `lane/core/contact-fix`
Open: <https://github.com/BroderickHigby/fog-city/compare/integrate/wave2...lane/core/contact-fix?expand=1>
Body: Prevent runtime-controlled pedestrians from stepping into parked NPC taxis or service vehicles before final clearance runs. Sweep against the full physical hull, use the drawn legacy taxi defaults, and preserve height separation and escape from old overlaps. Typecheck and 120 focused tests passed. The actual Hot Desk contact snapshot now replays with zero contacts/failures through 120 further ticks. Keep the strict zero-contact gate; full route and browser checks run on the combined candidate.

## Exact building walls for combat

- Isolated branch `lane/core/combat-wall-fix` starts from current harness `21a1f3c` (including the recorded cone failure).
- The real cone muzzle at `(-683.74698, 8.77519, 541.36113)` stood outside building `201006.0000770` but inside its bounding rectangle. Combat incorrectly ended every cone on its birth tick as a wall hit in that open concave notch.
- `Wall.footprint` optionally carries the immutable world polygon. Bounds still provide the broad phase; the narrow phase intersects the exact closed polygon extruded through the clipped height interval. Rectangle-only fixtures retain their old behavior, and invalid optional polygons fall back to the enclosing wall. Projectile, sight and attack rays share the same test.
- `SIM_VERSION` remains unchanged: `Wall` lives only in ephemeral `CombatContext`; this adds no serialized state or recorded-input field. Old box-only contexts remain supported.
- Validation: **typecheck and 135 tests across four files passed**, plus a final **five-test geometry rerun** covering the requested diagonal height-clipping cases. Tests cover rotated footprints, concave notches, actual facades, tangencies, collinear edges, vertical/zero-length paths, above/below clearance, invalid polygons and adapter propagation.
- The exact saved cone-stage state now completes Hot Desk at tick **14313** after **574 normal input frames**, with **zero contacts and zero failures**. Full browser and aggregate QA remain on the combined final candidate.

Draft PR title: `Core: use exact building footprints for combat wall contacts`
Base: `integrate/wave2` · Head: `lane/core/combat-wall-fix`
Open: <https://github.com/BroderickHigby/fog-city/compare/integrate/wave2...lane/core/combat-wall-fix?expand=1>
Body: Fix cones and other combat rays being blocked in open corners of rotated or concave buildings. Preserve bounding-box broad phase and legacy box-only walls, then use the original footprint for exact height-clipped contact. Sight and attack rays share the same geometry. This context-only addition needs no saved-state version change. Typecheck and135 targeted tests passed; the saved Hot Desk cone endpoint completes through normal inputs with zero physical contacts/failures.

## Reviewed PR #7 resync — 23 October 2026

- Canonical `lane/core/wave2` fast-forwarded to reviewed integration `c36a550`; no frozen showcase branch imported.
- M1: save upgrades now recurse through each supported version through v7, retaining the existing missing-field repair for old-shaped v6 saves. Added frozen legacy-save coverage for v2–v6, JSON round trips, and preservation of live velocity, grounded state, counters and unknown extensions. Existing v2-input/v7 replay golden is unchanged.
- M4: copy extension slots before prepare hooks and on the roadless movement path. A frozen-input test exercises both a prepare hook and a reducer assigning new slots without modifying the prior tick.
- M2/M3: canonical integration already supplies the motion proposal phase and `createGameSystems` runtime composition. Focused coverage includes actual mission actors, accepted movement, held Watch, refill interaction and independent replay branches.
- Still open: Bay-edge polygon schema/provider contract; typed `gameplay.command`/`threat.spawn` constants and replacing positional threat payloads with body identity. PR #19 remains a later-wave review, not included in this patch. No rendering ownership changes or duplicate PR closures.
- Validation pending below; this entry is not a full-game quality or deployment sign-off.
- Validation checkpoint: TypeScript passed; all 128 unit files passed (3,003 tests, one opt-in skip). Two focused Chromium composition/UI replay checks passed. Full Chromium run in progress.
- Full real-control campaign passed in 11.9 minutes: Hot Desk complete, first purchase verified, Spill acknowledged at tick 14335, zero protected contacts/failures. Replayed 14,330 input frames and five UI commands; expected/actual hash both `31034910`. Proof: `test-results/campaign-replay-proof.json`; screenshots: `test-results/hot-desk-complete-{third,first}-person.png`.
- Render request: the new third-person campaign screenshot still shows a low-detail avatar and flat environment materials. These images are functional evidence, not the requested modern high-definition visual acceptance. Lane R retains the asset, material and presentation work.
- Final gate: **3,003 unit tests passed, one opt-in skip; all 37 Chromium browser tests passed (19.7 minutes)**, including production sub-path builds, split collider packs and the expected missing-part failure. Firefox/WebKit's 10 cases explicitly skipped because those engines are not installed. No claim of cross-engine coverage beyond Chromium/Node.
- Verification used the normal typecheck/unit/e2e stages, two unit workers and one browser worker, serialized under `/tmp/fog.lock`; the external Playwright config points to this checkout and system Chromium on port 4199. Source and golden files were unchanged throughout the browser runs. The only implementation delta over `c36a550` is the reviewed migration and extension-isolation repair above.
