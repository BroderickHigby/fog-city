# Lane 2: Core sim and harness

## Now
- Validate and publish the day-one interface on `lane/core/wave2`.

## Done
- Inspected the actual base: `SIM_VERSION` is 2. `qa/sim` and `feature/dodge` use 4, with 5 reserved for their integration. Wave 2 will use 6.
- Isolated this lane from the uncommitted prototype and combat checkouts.
- Pushed `integrate/wave2` at `2deafc912ea0971440b541e800158b258c548275`.
- Added schema 6, optional aim fields and seven action bits. Old bits are unchanged.
- Added core-owned `combat-contract.ts`, typed extension slots, event-name constants and fixed-order pure system hooks. Every area's registration list starts empty.
- Captured a 300-tick schema-2 replay from the unmodified base (12 ambient agents, driving, braking and walking) with five pinned state hashes in `tests/golden/wave1-v2.json`.
- Frozen-lockfile offline dependency installation and typecheck passed.

## Next
- Run the replay, focused and full verification suites before integrating the interface.
- The remaining wave-2 clock, fog, vehicle follower, drivers, benchmarks and browser harness work is separate from this day-one interface.

## Blocked on
- GitHub API access is unavailable; the owner will open the draft PR from the pushed branch.
- QA/dodge migrations must land before saves from their intermediate schemas can be accepted safely.

## Requests for other lanes
- All lanes: build against the shared interface once published. Do not edit `contract.ts`.
- Lane 4: import/re-export shared combat types from `src/sim/combat-contract.ts` after this interface lands.
- Lane R: coordinate QA/dodge migrations and the reserved schema 5 before merging them into wave 2.

## For the owner
- No changes to `main` or `integrate/wave1`. This is the shared foundation, not a completed wave or a visual-quality sign-off.
- Draft PR title and body will be recorded here with validation results before the lane push.

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
- In progress: recorded schema-2 replay, migration, action/aim, registration order and sim purity tests.
- Pending: full unit and browser verification. No CI claim before the PR runs.

### Contract changes
**SIM_VERSION 2 → 6**; versions 3–5 are reserved for pending QA/dodge code and are not blindly migrated. v1/v2 saves preserve existing data and old input frames need no new fields. Existing action bits retain their values. All shared combat types live in the core-owned `combat-contract.ts`.

### Requests for other lanes
Lane 4: consume the shared combat types and provide a pure system factory with complete actor context. All lanes: replace only your own empty registration list as implementations land; coordinate shared schema changes with Core. Lane R: bring QA/dodge migrations with their code and preserve schema 6 on integration.

### For the owner to judge
This PR supplies interfaces and replay compatibility. It does not claim the full wave, visual quality or gameplay feel is complete. The branch contains no prototype changes and does not alter `main` or `integrate/wave1`.
