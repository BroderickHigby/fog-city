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

## Reviewed wave-3 integration

The integration preserves the canonical combat attribution, aimed watching, Hot Desk/Spill
phone and form gates, and same-tick activity/economy ordering. PR #18 supplies the authored
catalog; duplicate content from PR #16 is not used to replace it. Later-wave content remains
behind its declared wave and no later mode, property or cable-car mechanic is enabled here.

Launch Day derives its false-positive lesson from a real incorrect scan of the good courier
and a separate acknowledgement. Demoed Correctly derives presentation from three observed
robots, the bad robot's actual melt, and both good robots remaining dry. Their named success
facts cannot be supplied externally to bypass these conditions. Attempts retain their own
evidence and reset it on a retry.

Legal parking uses committed street rules and cleaning windows, accepted car hulls and a
continuous two-second stop followed by a new interact press. The mission's Pier 70 point is
over 200 m from the nearest committed signed edge, so the provider searches within 350 m,
then validates dry, unobstructed curb positions. An unknown rule never becomes permission.
The world loader must supply both declared rule layers; the shared composition mounts
`buildMissionParkingWorld` through `createObservedGameplayProvider.missionParking`.

The Director starts and recurs in the seeded 45–75 second range and rejects protected stage
locations. A stopped car's recorded car-wash interaction reduces heat once per visit; mission
VC grants survive the one-tick ordering boundary without duplicate awards.

Verification is recorded in the integration report after the final focused run. Composed
mission tests use accepted stage-position fixtures and production combat/mission reducers;
they are not a claim of a browser-driven route through San Francisco. The tests also retain
Hot Desk/Spill regressions, spoof rejection, parking-rule negatives and deterministic reruns.

Final focused verification on this branch: TypeScript passed; **34 test files passed,
1,279 tests passed, one existing opt-in skip**. This includes the two composed wave-3
missions repeated deterministically, spoof rejection, real-SF signed parking, parking
negatives, car-wash/delayed-grant checks, the existing player and content suites, the
composed wave-2 regression and every forbidden-API check. No full browser campaign or
later-wave gameplay completion is claimed by this lane.
