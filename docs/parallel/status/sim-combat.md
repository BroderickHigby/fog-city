# Lane 4: Sim-Combat

## Now
Working ahead on `lane/sim-combat/wave3`, based on the pushed wave-2 foundation `3a9da2d`. Lane 2 has created `integrate/wave2` and published interface `39abfda` on `lane/core/wave2`; an isolated wave-2 worktree is adopting it, then this branch will merge that intake. The handoff rules are on `docs/parallel-handoff` at `38065dd3c48970ab42c97d2bb0d104eee403ed7c`.

## Done
- Inspected the handoff, current shared simulation, and combat design.
- Created a separate checkout to preserve existing uncommitted prototype work.
- Pushed initial status in `ab785bd`. The original prototype remains untouched in `/workspace/fog-city`; this lane uses `/workspace/fog-city-combat`.
- Pushed wave-2 foundation `3a9da2d`; no prototype changes were included.
- Wave 3: driver window spray at <=7 m/s, sideways-only 8 m shots at 60% flow; full running-board spray; phone hacks; fog/rain exposure and drone resistance rates; typed puddle refills with fresh/salt inputs; sight range 30 m / 21 m / 12 m at fog density 0 / 0.5 / 1. Marine Layer halves sight, and blindness removes it. Distant heaps persist for Tidy from wave 3.
- Implemented a pure combat reducer, swept water/cone collision with terrain and walls, deterministic scans, fresh/salt refills, wrong-target penalties, rust/drying, and seized/slumping/heap lifecycle. A heap reaches 30% height by tick 120 after seizure.
- Added shove, snatch, ad blast, handshake, and interrupted/capped forced updates with monotonic request sequences. Phone hacks remain wave-3 gated.
- Exposed an explicit compatibility adapter and movement constraints without modifying shared simulation files or registering an incomplete system.
- Adversarial fixes: protected subjects intercept projectiles; vertical interaction limits; huge finite aim values; canonical player-body constraints; non-resurrecting heaps; bounded attack history; unknown attackers cannot exhaust it; no zero-speed cap on unaffected actors.
- Typecheck passed. Scoped combat suite passed 166 tests across seven files, including later-wave modules still being reviewed. This checkpoint includes wave-2 files only. Scan accuracy has 10,000 seeded samples per tier; protected-crowd regression covers 50 scenes.

## Next
Consume Lane 2's published shared types, wire its combat hook, run full verification, and push separate wave-3 through wave-5 extensions with independent adversarial checks.

## Blocked on
- Shared action bits, typed extension ownership and system registration await Lane 2's interface push. Temporary combat types are confined to `src/sim/combat/types.ts`; they will become shared-type re-exports immediately after publication.
- GitHub API CONNECT returns HTTP 403. Git push works; owner can open the draft PR using the title/body below.
- Browser melt rendering and live play remain pending the renderer and actor integration. Unit simulation results do not establish visual quality or frame rate.

## Requests for other lanes
- Lane 2 (`src/sim/combat-contract.ts`, `contract.ts`, `systems.ts`): publish the frozen interface; map input actions/aim into combat; call the pure reducer after movement. `ext.combat` has its own version 1 and must track the simulation tick. Preserve it in saves/replays. Register the adapter only with actor/world providers. Own the browser melt acceptance test.
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
Adds the wave-2 combat reducer and adapter under the combat-owned directories. Water follows swept, wall/terrain-clipped trajectories; bad robots rust, seize and collapse to 30% height; protected subjects never receive wet effects. No prior prototype edits are included.

### Roadmap deliverables
- [x] Water particles; hydrant/fountain/Bay/salt refills; drying and partial rust.
- [x] Seize/slump/heap simulation and cleared-heap lifecycle.
- [x] Shove, snatch, ad blast, handshake and interruptible forced updates.
- [x] Base cone, good-robot repair, wet-adult penalties and protected-subject interception.
- [x] Bot Check scan and ping.
- [ ] Shared hook registration, actor/world providers and rendered browser acceptance.

### Acceptance tests
Passing scoped tests: conservation, dry thresholds, good-robot non-seizure, 120-tick collapse, three-second cone stop, forced-update interruption/cap, 10,000 seeded scans per tier, 50 protected crowd scenes, frozen-state replay equivalence, bounded history and vertical-range regressions. Full repository/browser verification pending.

### Contract changes
No edits to `src/sim/contract.ts`, top-level sim files, schemas or `SIM_VERSION` in this checkpoint. Temporary types remain inside `src/sim/combat/` until Lane 2 publishes the authoritative shared contract.

### Requests for other lanes
See the detailed handoffs above. Core owns shared definitions/registration; actors own firmware/movement; world owns sources/colliders; player owns economy; renderer owns visible effects.

### For the owner to judge
Open as draft. Gameplay feel and visible collapse require the integrated renderer; this reducer does not establish a high-definition playable build by itself.

## Wave-3 draft pull request
Base: `lane/sim-combat/wave2` until `integrate/wave3` exists.  
Head: `lane/sim-combat/wave3`  
Title: `Sim-Combat: add vehicle spray and weather combat effects`

### Summary
Adds wave-gated driver and running-board fire, the fog sight handoff and Tidy heap retention. Existing phone hacks, rain/fog rust, drone rates and puddle refills are enabled by the wave-3 context. Window shots consume 60% flow, travel sideways up to 8 m, and stop above 7 m/s.

### Roadmap deliverables
- [x] Phone hack, window spray and running-board spray.
- [x] Fog rust/sight, rain rust, fresh/salt puddle refills, drone rust rate.
- [ ] World-provided rain/King-tide puddle locations and agent consumption of sight constraints.

### Acceptance tests
Scoped tests cover speeds just above/below the driver limit, sideways aim, full running-board flow, empty tanks, weather/shelter boundaries, all three fog sight densities, drone rates and Tidy retention. Typecheck passes. Full verification will run on the combined core/combat branch.

### Contract changes
None authored in shared files. Inherits the wave-2 interface once the intake is merged. The weapon helper includes disabled wave-4 roof/boost branches to preserve one source of firing rules.

### Requests for other lanes
Lane 1/2: publish per-location weather, puddles and King-tide salt sources. Lane 3: use `sightRange`, `movementLimit` and emit monotonic phone-hack requests; Tidy removes collected heaps. Lane 5: add a passenger-seat signal for full-flow co-op passenger fire (driver/running-board are implemented).

### For the owner to judge
Draft sim behavior; visible stream, weather and NPC reactions require rendering/agent integration.
