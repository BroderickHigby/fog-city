# Lane 4: Sim-Combat

## Now
Wave-2 combat foundation on `lane/sim-combat/wave2`, based on `integrate/wave1` at `2deafc912ea0971440b541e800158b258c548275`, with Lane 2's published interface `39abfda` merged in `0b7fc70`. The isolated intake worktree is `/workspace/fog-city-combat-base`; future-wave work remains separate. The handoff rules are on `docs/parallel-handoff` at `38065dd3c48970ab42c97d2bb0d104eee403ed7c`.

## Done
- Inspected the handoff, current shared simulation, and combat design.
- Created a separate checkout to preserve existing uncommitted prototype work.
- Pushed initial status in `ab785bd`. The original prototype remains untouched in `/workspace/fog-city`; this lane uses `/workspace/fog-city-combat`.
- Implemented a pure combat reducer, swept water/cone collision with terrain and walls, deterministic scans, fresh/salt refills, wrong-target penalties, rust/drying, and seized/slumping/heap lifecycle. A heap reaches 30% height by tick 120 after seizure.
- Added shove, snatch, ad blast, handshake, and interrupted/capped forced updates with monotonic request sequences. Phone hacks remain wave-3 gated.
- Exposed an explicit compatibility adapter and movement constraints without modifying shared simulation files or registering an incomplete system.
- Consumed the published shared contract through a type-only re-export. Added `createCombatSystem(provider)` for the core's registered post-movement hook; recorded fire, scan, cone, alt-fire, aim, equipped gadget and nearest valid refill inputs map into the reducer. Explicit provider inputs replace those defaults. The default system list stays empty until real actor/world providers are supplied.
- Hardened compatibility metadata: actor classification may be supplied, but body IDs, ownership and current poses remain authoritative at runtime and in the metadata type.
- Adversarial fixes: protected subjects intercept projectiles; vertical interaction limits; huge finite aim values; canonical player-body constraints; non-resurrecting heaps; bounded attack history; unknown attackers cannot exhaust it; no zero-speed cap on unaffected actors.
- Typecheck passed. Scoped combat suite passed 166 tests across seven files, including later-wave modules still being reviewed. This checkpoint includes wave-2 files only. Scan accuracy has 10,000 seeded samples per tier; protected-crowd regression covers 50 scenes.
- Intake validation: typecheck and all 110 wave-2 combat tests passed across five files. `git diff --check` and a direct Node registered-step smoke also passed. Seven new owned tests cover registration, unrelated extension preservation, sanitized controls, explicit input overrides, refill selection and metadata identity.

## Next
Run full combined verification and carry this shared-type intake into the separate wave-3 through wave-5 branches.

## Blocked on
- Production registration still needs current actor/world/loadout providers. `createCombatSystem` is ready, but no default provider invents classifications or water sources. Controls without a recorded shared action/value (gear, selected streak, close-ad, break-free, placement and boost) still require provider inputs from the owning lanes.
- GitHub API CONNECT returns HTTP 403. Git push works; owner can open the draft PR using the title/body below.
- Browser melt rendering and live play remain pending the renderer and actor integration. Unit simulation results do not establish visual quality or frame rate.

## Requests for other lanes
- Lane 2 (`systems.ts`): configure `createCombatSystem(provider)` with the real actor/world/loadout providers. The factory maps published recorded actions/aim and calls the pure reducer after movement. `ext.combat` has its own version 1 and tracks the simulation tick. Preserve it in saves/replays. Own the browser melt acceptance test. Shared contract intake is complete; later shared changes remain Lane 2-owned.
- Lane 3 (`src/sim/agents/`, `robots/`): provide stable actor IDs, firmware, model, posture/age/protection flags, occupancy and fidelity. Apply `movementLimit` before movement: null maxSpeed is unrestricted. Consume conversion/repair/pull-over/inventory events exactly once by tick+event ID. Supply a stable encounter `conversionCap`; absent cap intentionally forbids forced conversions. Never reinsert an already cleared heap as a fresh active actor.
- Lane 1: provide typed hydrant/fountain/Bay/puddle sources, accurate collider/ground geometry and weather exposure. Compatibility adapter building AABBs are conservative; extra walls are accepted explicitly.
- Lane 5: provide upgrade/loadout and trunk inventory inputs, consume `economy.penalty`/`player.runway` once, and publish earned streak grants. Attack requests need monotonically increasing per-attacker sequence numbers, even when display IDs repeat.
- Lane 6: supply explicit rival IDs and match mode for flowers/streak targeting; reset combat state at match boundaries.
- Lane 7: consume water/salt/reserve/scan fields and canonical player-target events; add recorded controls for refill/cone/gadget/gear/close-ad/break-free.
- Lane 8: supply content keys for wet/scan/melt dialogue rather than deriving text in simulation.

## Requests for Render-World / Assets
- Render `projectiles`, `targets[id].rust`, `phase`, `phaseTick`, `heightScale` and `puddle`. Seized starts at age 0, slumping at 30 ticks, heap/30% height at 120; `cleared` is invisible. Robotaxis disable/pull over and never melt.
- Draw water/splashes/wet decals and heap props. Use source/target IDs to attach readable attack windups, popups, cone blindness and scan results.
- Prove Footman and Trundle drawn heights <=40% within two seconds of seizure in Lane 2's browser gate. Simulation coverage alone is insufficient.

## For the owner
No design changes or paid services are proposed. Integration and visible-effect claims remain pending the owning lanes' hooks.

## Draft pull request
Base: `integrate/wave2`  
Head: `lane/sim-combat/wave2`  
Title: `Sim-Combat: deterministic water, rust, melt, scans and robot attacks`

### Summary
Adds the wave-2 combat reducer and provider-driven registered adapter under the combat-owned directories. Water follows swept, wall/terrain-clipped trajectories; bad robots rust, seize and collapse to 30% height; protected subjects never receive wet effects. The published Lane 2 interface is merged, and combat now consumes its shared types. No prior prototype edits are included.

### Roadmap deliverables
- [x] Water particles; hydrant/fountain/Bay/salt refills; drying and partial rust.
- [x] Seize/slump/heap simulation and cleared-heap lifecycle.
- [x] Shove, snatch, ad blast, handshake and interruptible forced updates.
- [x] Base cone, good-robot repair, wet-adult penalties and protected-subject interception.
- [x] Bot Check scan and ping.
- [x] Shared contract intake and an explicit provider-driven registered system factory.
- [ ] Production actor/world provider registration and rendered browser acceptance.

### Acceptance tests
Passing scoped tests from the reducer checkpoint: conservation, dry thresholds, good-robot non-seizure, 120-tick collapse, three-second cone stop, forced-update interruption/cap, 10,000 seeded scans per tier, 50 protected crowd scenes, frozen-state replay equivalence, bounded history and vertical-range regressions. Intake adds seven integration/adapter tests; their heavy run and full repository/browser verification are pending. Direct Node registered-step smoke and whitespace checks passed.

### Contract changes
**Shared contract changed through the merge of Lane 2's published `39abfda`: `SIM_VERSION` is now 6.** That upstream interface adds optional recorded aim, action bits, typed `ext.combat`, deterministic system ordering and the published replay migration. The combat lane did not edit shared core files by hand; `combat/types.ts` now re-exports the authoritative `combat-contract.ts` types. Owned adapter changes preserve unrelated extension slots and leave default registration empty. Lane 2 owns all shared migration and baseline changes.

### Requests for other lanes
See the detailed handoffs above. Core owns shared definitions/registration; actors own firmware/movement; world owns sources/colliders; player owns economy; renderer owns visible effects.

### For the owner to judge
Open as draft. Gameplay feel and visible collapse require the integrated renderer; this reducer does not establish a high-definition playable build by itself.
