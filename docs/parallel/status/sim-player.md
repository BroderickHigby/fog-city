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
