# Lane 4: Sim-Combat

## Now
Combat waves 2–5 are implemented and pushed, with wave-2 shared-interface intake `ef74fe5` merged through the wave chain. Combat imports Lane 2's authoritative shared contract and exposes its registered factory. The separate core pause `4ffe076` is merged on wave 4 and later. Verification is complete: unit and combat parity checks pass; all packaged-build checks pass with the separate, tested favicon fix `ec7c771`. Production render/actor/provider integration remains with the owning lanes. The handoff rules are on `docs/parallel-handoff` at `38065dd3c48970ab42c97d2bb0d104eee403ed7c`.

## Done
- Inspected the handoff, current shared simulation, and combat design.
- Created a separate checkout to preserve existing uncommitted prototype work.
- Pushed initial status in `ab785bd`. The original prototype remains untouched in `/workspace/fog-city`; this lane uses `/workspace/fog-city-combat`.
- Pushed wave-2 foundation `3a9da2d`; no prototype changes were included.
- Wave 3: driver window spray at <=7 m/s, sideways-only 8 m shots at 60% flow; full running-board spray; phone hacks; fog/rain exposure and drone resistance rates; typed puddle refills with fresh/salt inputs; sight range 30 m / 21 m / 12 m at fog density 0 / 0.5 / 1. Marine Layer halves sight, and blindness removes it. Distant heaps persist for Tidy from wave 3.
- Wave 4: equipped balloons, sprinklers and decoy speakers; Rubber Boots/Airplane Mode; fresh trunk-fed roof cannon; all six authorized streak effects. Wide boost splits one shot's water/rust budget over three pellets. AGI holds combat timers/projectiles for exactly 180 ticks; core's matching movement pause is supplied separately.
- Device review fixed out-of-order banked reward use, blocked-muzzle bypasses, vertical water/ping ranges, unbounded/stale confidence markers and hallucination proportions. Replay cursors are tracked independently per reward kind.
- Wave 5: rival-authorized flowers with 90-tick cooldown and 20 m ballistic range; NPCs and teammates are transparent to the projectile. Clean Streets suppresses spray/scan for 90 ticks; Royale emits its runway/score events. Hair effects persist until the mode resets combat state.
- Implemented a pure combat reducer, swept water/cone collision with terrain and walls, deterministic scans, fresh/salt refills, wrong-target penalties, rust/drying, and seized/slumping/heap lifecycle. A heap reaches 30% height by tick 120 after seizure.
- Added shove, snatch, ad blast, handshake, and interrupted/capped forced updates with monotonic request sequences. Phone hacks remain wave-3 gated.
- Exposed an explicit compatibility adapter and movement constraints without modifying shared simulation files or registering an incomplete system.
- Consumed the published shared contract through a type-only re-export. Added `createCombatSystem(provider)` for the core's registered post-movement hook; recorded fire, scan, cone, alt-fire, aim, equipped gadget and nearest valid refill inputs map into the reducer. Explicit provider inputs replace those defaults. The default system list stays empty until real actor/world providers are supplied.
- Hardened compatibility metadata: actor classification may be supplied, but body IDs, ownership and current poses remain authoritative at runtime and in the metadata type.
- Adversarial fixes: protected subjects intercept projectiles; vertical interaction limits; huge finite aim values; canonical player-body constraints; non-resurrecting heaps; bounded attack history; unknown attackers cannot exhaust it; no zero-speed cap on unaffected actors.
- Final typecheck and the combined combat/registered-pause checks pass. Scan accuracy has 10,000 seeded samples per tier; protected-crowd regression covers 50 scenes. Portable Node/Chromium parity is checked in with final hash `1a8363b9`.
- Intake validation: typecheck and all 110 wave-2 combat tests passed across five files. `git diff --check` and a direct Node registered-step smoke also passed. Seven new owned tests cover registration, unrelated extension preservation, sanitized controls, explicit input overrides, refill selection and metadata identity.

## Next
Open the prepared drafts, integrate core before combat, and have Render-World review the separate favicon patch. Then connect the real actor/world/loadout providers, controls and visible effects through the documented interfaces.

## Blocked on
- Production registration still needs current actor/world/loadout providers. `createCombatSystem` is ready, but no default provider invents classifications or water sources. Controls without a recorded shared action/value (gear, selected streak, close-ad, break-free, placement and boost) still require provider inputs from the owning lanes.
- GitHub API CONNECT returns HTTP 403. Git push works; owner can open the draft PR using the title/body below.
- Browser melt rendering and live play remain pending the renderer and actor integration. Unit simulation results do not establish visual quality or frame rate.
- Packaged-page readiness depends on the separate, tested favicon fix `ec7c771` on `fix/favicon-subpath`: the unchanged `index.html` lets Chromium request `/favicon.ico`, which fails the sub-path and no-404 assertions. The combat lane does not include that render-owned HTML change.

## Requests for other lanes
- Lane 2 (`systems.ts`): configure `createCombatSystem(provider)` with the real actor/world/loadout providers. The factory maps published recorded actions/aim and calls the pure reducer after movement. `ext.combat` has its own version 1 and tracks the simulation tick. Preserve it in saves/replays. Own the browser melt acceptance test. Shared contract intake is complete; later shared changes remain Lane 2-owned.
- Lane 3 (`src/sim/agents/`, `robots/`): provide stable actor IDs, firmware, model, posture/age/protection flags, occupancy and fidelity. Apply `movementLimit` before movement: null maxSpeed is unrestricted. Consume conversion/repair/pull-over/inventory events exactly once by tick+event ID. Supply a stable encounter `conversionCap`; absent cap intentionally forbids forced conversions. Never reinsert an already cleared heap as a fresh active actor.
- Lane 1: provide typed hydrant/fountain/Bay/puddle sources, accurate collider/ground geometry and weather exposure. Compatibility adapter building AABBs are conservative; extra walls are accepted explicitly.
- Lane 5: provide upgrade/loadout and trunk inventory inputs, consume `economy.penalty`/`player.runway` once, and publish earned streak grants. Attack requests need monotonically increasing per-attacker sequence numbers, even when display IDs repeat.
- Lane 6: supply explicit rival IDs and match mode for flowers/streak targeting; reset combat state at match boundaries.
- Lane 7: consume water/salt/reserve/scan fields and canonical player-target events; add recorded controls for refill/cone/gadget/gear/close-ad/break-free.
- Lane 8: supply content keys for wet/scan/melt dialogue rather than deriving text in simulation.

## Requests for Render-World / Assets
- Review the separate `fix/favicon-subpath` patch (`ec7c771`): an explicit data favicon avoids the browser's root-relative `/favicon.ico` fallback on `/fog/city/` deployments. All six packaged-build tests pass with that one-line change.
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
All 110 wave-2 combat tests pass, including seven integration/adapter tests. Coverage includes conservation, dry thresholds, good-robot non-seizure, 120-tick collapse, three-second cone stop, forced-update interruption/cap, 10,000 seeded scans per tier, 50 protected crowd scenes, frozen-state replay equivalence, bounded history and vertical ranges. Full combined repository/browser verification is tracked below.

### Contract changes
**Shared contract changed through the merge of Lane 2's published `39abfda`: `SIM_VERSION` is now 6.** That upstream interface adds optional recorded aim, action bits, typed `ext.combat`, deterministic system ordering and the published replay migration. The combat lane did not edit shared core files by hand; `combat/types.ts` now re-exports the authoritative `combat-contract.ts` types. Owned adapter changes preserve unrelated extension slots and leave default registration empty. Lane 2 owns all shared migration and baseline changes.

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

## Wave-4 draft pull request
Base: `lane/sim-combat/wave3` until `integrate/wave4` exists.  
Head: `lane/sim-combat/wave4`  
Title: `Sim-Combat: add gadgets, gear, roof cannon and authorized streak effects`

### Summary
Adds equipped water balloons, placed sprinklers/speakers, timed defensive gear, trunk-fed roof shots and the six Hype reward effects. Rewards require owner-provided grants and cannot be replayed or lost by redeeming another reward first. AGI freezes combat timers for 180 ticks; the core pause must accompany it to hold world movement.

### Roadmap deliverables
- [x] Balloon, sprinkler, decoy speaker; Rubber Boots and Airplane Mode.
- [x] Trunk reserve and 30-degree/15 m roof cannon at half rust.
- [x] Confidence, Parrots, Tensor, Blimp, Hydrants and AGI effects.
- [ ] Real loadouts/grants, gear controls, safe-lot/world-source data and rendered effect integration.

### Acceptance tests
Combined verification below includes conserved shot volume/rust, 3D splash/jet limits, protected landing removal, stale grant rejection, out-of-order banks, bounded confidence state and exact 180-tick pause timing, including the real registered core/combat hook.

### Contract changes
No direct shared-file edits. Uses Lane 2's published combat types and separate wave-4 core pause commit. Wide fan width (12 degrees) and ordinary gadget reuse delays are tuning constants.

### Requests for other lanes
Lane 5 supplies earned grants, loadout/inventory and stable replayed selections. Lane 6 supplies explicit rival lists. Lane 1 supplies safe lots and water sources. Noncombat systems must preserve their absolute deadlines across AGI; merely skipping an update does not hold a deadline against the advancing outer tick. Renderer consumes gadget/mark/boost/pause state and events.

### For the owner to judge
All effects are deterministic simulation outputs. Their visible playback and gameplay feel require the integration lanes; no frame-rate or high-definition claim is made here.

## Wave-5 draft pull request
Base: `lane/sim-combat/wave4` until `integrate/wave5` exists.

Head: `lane/sim-combat/wave5`

Title: `Sim-Combat: add rival-authorized PvP flower alt-fire`

### Summary
Adds slow ballistic flower lobs only in PvP modes and only against explicitly assigned rivals. Projectiles pass through NPCs, teammates and the owner. Hits add persistent hair flowers; Clean Streets applies a 90-tick distraction, while Royale emits its runway and score changes without mutating another lane's economy state.

### Roadmap deliverables
- [x] 20 m flower alt-fire, one lob every 1.5 seconds, PvP only.
- [x] Hair flowers, mode effects, no rust/knockback and no NPC impact.
- [ ] Mode-provided rival assignments, reset lifecycle and renderer hair effect.

### Acceptance tests
Scoped tests pass for cooldown/range, raised ballistic aim, finite input, NPC/team transparency, changed permission at impact, exact mode effects and real-projectile suppression of rival spray/scan. The combined suite also tests real combat-hook/core pause integration; full verification results will be recorded below.

### Contract changes
None. Uses the shared core contract already merged into prior wave branches.

### Requests for other lanes
Lane 6 supplies mode/rivals and clears combat state between matches; Lane 5 consumes score/runway event IDs once; Lane 7 renders cooldown/distraction; Lane R renders flowers in hair and the slow projectile.

### For the owner to judge
Review as a stacked draft above wave 4. These are sim changes; final presentation and feel remain an integrated-game review.

## Combined verification
- Typecheck: passing on the core/combat integration.
- Full Vitest suite: 82 files, 2,713 passed, one skipped (2026-10-23). The added replay-baseline test and real registered-pause cases also pass in a subsequent seven-test run; final typecheck passes. Command: `pnpm exec vitest run --maxWorkers=2`.
- New combat Node/Chromium parity: 2,000 ticks, 33 per-second hashes and final canonical state identical; final hash `1a8363b9`, no page errors. Scenario exercises six authorized rewards, scan/refill/cone/balloon/flowers and melt, with a protected corridor remaining unaffected. Portable runner: `CHROMIUM_PATH=/usr/bin/chromium node tests/sim/combat/browser-parity.mjs`.
- Full Playwright suite on the combat branch: 30 passed, two favicon-related packaged-build failures, two serial dependants not run, eight skipped because Firefox/WebKit are absent. Node/Chromium determinism, SF/dev boot, driving, on-foot, tiles, landmarks, traffic, skyline and boundary checks pass.
- Favicon fix validation: all six unchanged `web-build.spec.ts` tests pass on detached combat `3bee8ce` plus `ec7c771` (1.1 minutes). Thus all 34 distinct Chromium cases pass across the combined validation. The favicon dependency remains a separate review branch; the unpatched combat branch alone still has the two documented failures. Cloud browser configuration stays outside the repository.
- Independent final integration review found no additional actionable defect after the documented fixes.
- Visible combat acceptance remains pending: the live renderer must consume these fields and the production provider must supply actors, world sources and recorded loadouts. Existing-world browser checks and sim parity do not substitute for that gate.

## Separate render compatibility draft
Base: `integrate/wave2`

Head: `fix/favicon-subpath` (`ec7c771`)

Title: `Render-World: suppress root favicon requests in packaged deployments`

### Summary
Opening the packaged game under `/fog/city/` makes Chromium request `/favicon.ico` from the host root when no favicon is declared. That request escapes the deployment prefix and returns 404. Declare an empty data-URL favicon so startup needs no external favicon request.

### Validation
All six existing packaged-build tests pass with this patch plus the combat stack: normal and split collider packs, sub-path requests, scene drawing/driving, and a deliberately missing part. No assertions were changed.

### Scope
One `index.html` line, isolated on the render compatibility branch. No combat, shared simulation, dependency or prototype changes. No integration or release branch was merged.

## Objective resistance follow-up

Shared `CombatActor.rustScale` is now validated in (0, 1] and overrides model resistance for authored objectives. The Update Relay at 0.2 requires twenty seconds of the starting stream; absent metadata preserves existing model behavior. Focused effects/system validation: 51 tests passed. Core shared contract dependency: 991aaff.

## Wave-6 maintenance and equipment follow-up

Base: `lane/sim-combat/wave5` (`d8e6911`). Head: `lane/sim-combat/wave6`.

Draft PR title: `Sim-Combat: validate Tidy work and activate persistent wide/fog equipment`

Draft PR body:

Tidy now clears a heap only after three continuous seconds of valid work by an active, stationary, good-firmware Tidy in fidelity and within three metres. Restoring converted cargo or a repair-marked helper takes sixty continuous seconds at an authoritative kiosk. Missing workers, interrupted work, protected bodies, occupied taxis, blocked sight, different floors and completed request replays cannot complete the channel. Completed work emits the existing `robot.heap-cleared` / `robot.restored` events; the agent runtime owns hauling and restored firmware.

The purchased wide nozzle keeps the existing three-pellet fan without multiplying water or rust. Microclimate gear creates an eight-metre sphere for twenty seconds, follows the accepted owner pose, blocks robot sight, and applies 0.03 rust per second to bad firmware. It preserves the ninety-second reuse delay and pause timing. The registered provider consumes the published `Action.gear` bit, so recorded controls activate equipped gear.

Validation: the full combat scope passed 218 tests. After the recorded gear mapping, typecheck and 57 registered-system / forbidden-API tests passed, including the new actual-input activation regression. No browser or full-repository suite was rerun independently; root owns those checks on the composed game. Prototype changes were not included.

### Shared dependencies

Consumed exact core changes `224f7f3`, `357f711`, `dbd2eb6` and `d56a9f6` by cherry-pick; this lane authored no shared contract changes. The implementation remains in owned combat paths.

### Requests for other lanes

- Agent runtime: provide persistent maintenance intents and kiosk coordinates; retain cleared converted cargo in the context while hauling; reactivate its good firmware only after `robot.restored`. Sequence numbers are monotonic per worker. Repeating an uncompleted request continues work; all required poses and eligibility are rechecked each tick.
- Agent perception: consume `sightRange` or `activeFogZones` / `microclimateBlocksSight` so fog changes actual target acquisition. The exported zone has `id`, `ownerId`, `x`, `y`, `z`, `radius`, `untilTick`.
- Player progression/input: preserve purchased `nozzle: "wide"` and `gear: "microclimate"` in loadouts; map the gear control to `Action.gear`.
- Renderer: display the active sphere and work progress from combat state. Physical hauling and visual effects remain integration checks, not claims made by these reducer tests.
