# Next serial mission acceptance runs

Prepared from working tree on `codex/consolidated-game-upgrade`, HEAD `96048e15b486dc2a81c67b0e4677a6f5e415477c`. Runtime source is dirty; each actual run must record its own source/data fingerprint. None of the runs below has been executed as part of this inventory.

## Full Coit: prepared, await explicit CPU slot

`node --max-old-space-size=2048 scripts/qa/coit-recon.ts --out test-results/coit-first --max-frames 120000 --deadline-seconds 1800`

The new input-only driver reuses the accepted physical pedestrian planner. Initial state comes from the existing savedAfterSpill/restoredState boundary at FiDi, with prior campaign completion IDs explicitly seeded so automatic campaign triggers cannot interrupt this bounded activity. It does not seed Coit progress or actors. It walks the authored path and pod, proves an out-of-range purchase refusal, buys a real quarter, waits for a real visible-landmark guide claim, submits a genuinely late refused flag, closes, and buys a fresh viewing. The second viewing must obtain a timely guide correction and a physically present, full-fidelity remote robot's actual observed sabotage. It must run the paid thirty seconds and settle once. A physical return to the path entrance tests cooldown refusal. Every frame/command, initial/completion/final snapshot, quarter/payout event, actual behavioral evidence, tag pose/3D LOS and source hashes is preserved on success or failure.

Caption IDs/text are derived from actual viewer state and checked against generated media hashes. This is explicitly an expected-queue contract; audible/browser queue acceptance requires the later packed browser replay. A viewing with no legitimate observable sabotage fails without staging a target or synthesizing evidence. Maximum two paid viewings: one deliberate negative and one completion attempt.

## Launch Day: existing real-control path, stricter Node wrapper needed first

Existing `tests/e2e/campaign-launch-day.long.ts` and `Wave3Driver.launchDayToFalsePositive/launchDayToPivot` cover the actual watch, scan, false positive, suspect heap, dialogue, reward, restore and fresh retry identities. `campaign-two-players.long.ts` also verifies per-player mission/actor/reward isolation.

The existing `Wave3Driver.travelTo` can rewind unsuccessful planning attempts. Before using it as strict forward-only acceptance, wrap it to forbid rewinds and record every failed step. For walking fallback legs, use one driving plan with `walkIfStuck:true, plans:1` so it leaves the car at the actual stopped position and continues on foot. Stop on a concrete failure rather than trying hidden reset routes. Keep recorded gameplay commands as the only dialogue/mission boundary, with responses selected from actual authored IDs. A bounded Node run from the disclosed post-Spill save should precede the long browser replay. Do not claim this is a full new-game campaign.

The existing browser config is `tests/e2e/campaign-long.config.ts`; use one worker and `E2E_GAME_WAVE=4` to match the current page. Its four-hour per-test limit is intentionally long, so it is not a substitute for a bounded diagnostic run.

## Demo'd Correctly: helper exists, complete acceptance script is missing

`Wave3Driver.demoedToParking`, `legalBay`, `parkIn` and `demoedPresent` provide the physical billboard pass, actual car drive to Pier70, whole-hull legal parking, three authored partner answers, observation of both good robots, and water on only the bad robot. No existing long browser file completes this mission. Launch Day's browser test stops after verifying that Demo'd Correctly starts next.

The parking leg must arrive with the real car; a foot fallback cannot satisfy it. Use one recorded driving plan, preserve the current vehicle/traffic clearance guard, and fail immediately if the forward car route stalls. `parkIn` uses throttle/steer/brake only. The next harness must select partner answers from the real current dialogue state, retain the authored420s deadline, verify the real demoBad heap while both good robots/partners remain dry, and assert one final reward plus fresh actors on an actual failed retry.

## Office Hours repeat: booking and producer are implemented, physical driver is missing

The current Office Hours backing mission shares demoGoodA/demoGoodB/demoBad aliases, so `demoedPresent` can be reused after the real booking and partner dialogue reach `present`. Booking must use the actual phone command at the Ramen doorway, on foot and stopped. Seeded post-Demo progression is allowed only as an explicitly labelled activity boundary; a future from-campaign proof should continue the real Demo completion snapshot.

Run two interviews through actual dialogue and three-robot demos, wait the real cooldown, and record one payout for each distinct booking. A third booking on the same absolute game day must refuse without consuming allowance. If the physical route crosses midnight, report that and test the rollover rule separately; do not alter the calendar. Failed/out-of-range/cooldown bookings must not consume an allowance. Existing backend tests cover these guards, but do not replace the missing physical repeat proof.

## Search & Park: parking controls reusable, activity adapter is missing

`legalBay` is currently tied to the active campaign mission/step, and `parkLegally` expects Demo's next pitch step. They cannot be called unchanged for Search & Park. A small activity adapter should query `buildMissionParkingWorld` for the active Search & Park target's real bay IDs, choose a genuinely free legal bay with `checkParking`, then reuse `parkIn`. The final position must be the real accepted whole hull, with the authored stopped interval and a fresh Interact press. Preserve wrong-side, occupancy, tariff/street-cleaning and contact guards. No placed-car snapshot or `parking.legalStop` injection is acceptable.

The current `activities.long.ts` proves hill delivery only; it has no Office Hours or Search & Park completion scenario. New bounded Node drivers should be established before adding their browser replays.
