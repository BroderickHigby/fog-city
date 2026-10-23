# Lane 5: Player, missions & economy

## Now
Building wave 2 on `lane/sim-player/wave2` from the published core interface `9a6a107`, in `/workspace/fog-city-player`. The existing prototype remains untouched.

## Done
- Read the player-lane handoff, design, roadmap and current content schemas.
- Confirmed existing Hot Desk and Spill data can drive the mission runtime; no duplicate mission catalog will be invented.
- Coordinated recorded ID-only commands, HUD projections and shared type publication with core, UI and content lanes.

## Next
Implement economy, threat, mission interpretation, safehouse/vendor interactions, bounties and the Ambient Director; add deterministic/adversarial checks; then continue wave 3–8 progression and activities.

## Blocked on
- Production world/agent observations and shared gameplay type publication are being coordinated with Lane 2.
- GitHub API is blocked; Git pushes work. Draft PR title/body will be recorded here.

## Requests for other lanes
- Lane 2: publish gameplay state/event/provider types from this lane's provisional `player/types.ts`, and wire the registered systems into the integrated runtime.
- Lane 3: consume `threat.spawn` and mission staging requests, return actual actor IDs and perception observations.
- Lane 4: consume loadout fields and streak grants, preserve event IDs for once-only rewards.
- Lane 7: use `gameplay.command` with monotonic sequence and ID-only payloads; consume the read-only gameplay projection.
- Lane 8: preserve authored mission IDs and node schemas, add later mission/catalog data, reconcile tank upgrade copy to the existing 8/12/16-litre combat contract.
- Lane R: mount UI and draw mission/encounter markers without advancing simulation.

## For the owner
No paid services, new external licenses, design changes or release merges are proposed. This is active lane work, not an integrated-game completion claim.

## Wave-2 checkpoint
Implemented six registered deterministic reducers: player recovery/startup kit; threat/VC; authored mission interpreter; wallet/bounties/vendor; progression/loadouts; activities/director. DTOs import core `gameplay-contract.ts`. Hot Desk and Spill execute actual trigger/stage/watch/scan/cone/melt/travel/form/reward steps; objective facts and rewards are deduplicated. Mission rewards honor authored XP, scanner unlocks and story-advance outcomes.

Validation: TypeScript passed; focused `tests/sim/player` passed **9 tests**, including two authored mission drivers, replay/double-payout prevention, purchases and tank loadout, DOWN ROUND/Bridge eligibility, fog decay, 20 seeded director starts and deterministic registration. Tests use `flock /tmp/fog.lock`, 8GB Node cap, two workers. Full suite/browser validation remains with the integration owner.

Still being integrated: actual agent perception/provider wiring, later authored content/mechanic producers, fully measured side activities. Default provider initializes a wave-2 simulation; production host must supply actual actors/perception using `createPlayerSystems(provider)` until the agent adapter is integrated. This checkpoint does not claim the final ten-mission game is complete.

## Draft pull request
Title: `Sim-Player: run wave-2 missions, economy and player recovery`

Body:
The player lane now registers deterministic player, heat, missions, economy, progression and activity systems. Hot Desk and Spill advance through measured world and combat objectives, pay once, allow retries, and expose HUD/loadout projections. Purchases validate proximity and funds; bounties reject friendly/unknown actors; recovery restores runway and applies cash/heat consequences. Ambient encounters use a persisted per-player random stream.

Validation: TypeScript and 9 focused player tests passed, including Hot Desk/Spill drivers and a 20-seed director check. Later-wave mission mechanics and the production agent/provider adapter remain visible integration work; see Requests for other lanes.

## Wave-3 integration checkpoint
The observed-provider bridge is published separately as `c93c84e`; portability/contract corrections are `83af5b1` and `de48876`; actual combat refill/cone event normalization is `e857ab4`. These small commits are suitable for immediate core integration without the later content stack.

The continuing branch `lane/sim-player/wave3` consumes reviewed content catalogs for all ten missions, rank XP, purchases, activities and loadouts. Actual runtime additions include observed actor line of sight and watch duration, validated route trials/delivery/photo/relic interactions, route checkpoints and repeat cooldowns, safehouse purchase proximity/funds checks, canonical perk/streak IDs, delayed mission VC grants, one car-wash reduction per visit, and an explicit idempotent `applyModeSettlements` for restoring free roam after a match. Missions now honor preselected startup kits and authored clock gates.

Latest focused validation: TypeScript and **66 tests across four files passed**, including 15 player tests and the repository's deterministic forbidden-API checks. This includes real combat event-name normalization, authored XP/scanner unlocks, mode payout replay protection, and activity route/cooldown checks.

Remaining work is explicit: parking/bell/cable-car mechanics come from the mechanics lane and still need production request wiring; later mission-specific facts and cinematics cannot be inferred from content alone. Doom/faction runtime, subscription billing, foil/cargo physics, and activity-specific encounter producers remain incomplete. Wide-nozzle sales are withheld until combat supports the persistent nozzle, rather than charging for no effect. Core owns respawn/clock/body application; player emits the recovery requests.

## Wave-4 clock and mode isolation
Added `progression/doom-clock.ts`: 24-month initial clock, one-month daily hype drift, idempotent ±3-month faction contracts, AGI reset with a 180-tick pause request, and one-day AI Winter effects. The Pauser and Accelerator contracts now use authored physical routes, timers and rewards; the Pauser's 12 mph rule is enforced against accepted body speed. Their observed completion events move the clock. `doomEffects` exposes bounty/bad-rate/speed/ad/associate/pause outputs for core/render consumers, and mode wins apply their faction movement once at settlement.

Actual combat integration corrections: player damage is owned by the event target, and forced-update interruption is attributed to the cone/water owner rather than the attacking robot. Refill and cone events are normalized from combat's real vocabulary. Stale earlier water ownership does not claim unrelated later interruptions.

`isMatchInstance` recognizes match sessions and standalone crowd/royale/vibes states. All free-roam reducers are bypassed while in those instances, so a Royale bell result cannot trigger free-roam ACQUI-HIRED or wallet/mission penalties.

Latest verification: TypeScript plus **73 tests across seven files passed** (player scenarios and the repository deterministic forbidden-API checks). Work is isolated from the uncommitted prototype; only lane-owned implementation/tests/status are in the owned commits. Dependency commits are authored by the core/content/mechanics lanes.

Wave-4 PR title: `Sim-Player: connect faction routes, Doom Clock and safe mode returns`

Wave-4 PR body: Faction deliveries now complete from accepted routes and enforce the Pauser speed cap, then move a persisted Doom Clock with daily drift, AGI and AI Winter state. Mode rewards settle once into the restored profile, and free-roam reducers skip all recognized match instances. This also fixes real combat damage/interruption attribution and upgrades the gameplay projection. Validation: TypeScript and 73 focused/determinism tests. Core still applies the exposed world effects and recovery proposals; specialized mission staging, cinematic/boss, subscription and foil/cargo interactions remain separate integration work.

## Observed mission producers
Added `missions/observed.ts`, called by the actual mission reducer, for Launch Day's false-positive scan, Demo'd Correctly's observed three-robot demonstration, Fleet Week's quiet pitch gaps and vehicle recovery, and Marine Layer's night fog and fleet lure. These outcomes now depend on actual scan/melt/cone events, observed actors, watched duration, accepted movement, time and weather. Retry clears attempt-local evidence; different fleet aliases must resolve to different actors.

Integration requests emitted once: `mission.airshow-request` (period/loud ticks), `mission.weather-request` (night/fog/duration), and `mission.vehicle-recovery-request` (actual stopped, coned actor at the player's interaction). The recovery objective waits for `GameplayContext.recoveredVehicleIds[playerId]` and an accepted player vehicle body at the recovery position; it does not award on request alone. `createObservedGameplayProvider` supplies actor bodies/rust and accepts a recovered-ownership callback.

Validation: TypeScript and **81 tests across eight files passed**, including seven observed-mission scenarios, negative ownership/weather/identity cases, clean retry recovery, and portable deterministic APIs. Remaining specialized story mechanics: teleoperation, finale/boss scene, and physical rendering/audio integration owned by the integration lanes.
