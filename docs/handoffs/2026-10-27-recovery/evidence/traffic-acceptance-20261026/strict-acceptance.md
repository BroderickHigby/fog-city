# Strict traffic and safety acceptance

Measured branch: `codex/consolidated-game-upgrade`, checkpoint HEAD `96048e15b486dc2a81c67b0e4677a6f5e415477c`, plus the independently copied dirty and relevant untracked source declared in each manifest. No fetch or source mutation was performed during a frozen-copy case. `node_modules` is the shared, unchanged installed dependency directory; source/world/harness files are independent read-only copies.

| Case | Snapshot | Physical guard | Result | Process bound |
| --- | --- | --- | --- | --- |
| Existing Marina, seed606/wave4,9000ticks | f9489b7282af6d90920ef312c57732b889203c064329864d3ad4b0c58b6146b5 | strict standstill<2700ticks; positive travel each30s; zero contact | FAIL:1075 stood7913ticks; every travel window positive |67.55s,300s cap,no timeout |
| Exact first-threshold capture | samef948 | stop at first2700ticks of1075 | reached tick3787; state2345d299; contacts0/failures0 |29.06s,65s cap,no timeout |
| Existing Marina A/B, only agents.ts changed | f00973c1170e7b0bda57622b26db89e11ed55706ff42a5c5f288c0c83a337bc1 | all original guards and test unchanged | INCONCLUSIVE:70s process cap before result; entire process group terminated |70.04s,70s cap |

The f948 source inventory was rehashed after the failed full case: all2710files unchanged. No actor was deleted, moved or reseeded by the diagnostic harness. The short-link fix itself does not add actor deletion or alter physical/signal thresholds.

1075 had a legal green and no physical forward blocker. Its intended exit,c5573000, is1.567m long. Car677 entered from the unsignalled node26797000 as the downstream node26791000's green ended, then stopped red while its body occupied both junctions. The existing opposite-short-link ownership ban blocked1075 throughout the next green. Exact full sweeps of the two current poses do not intersect, but the future paths do: deleting that ban would discard a legitimate guard.

The SIM21 fix instead adds an upstream admission condition for links shorter than a full-body stop: the downstream approach must be green now and remain green for the connector/link/rear-bumper travel plus a launch from rest. Existing priority, opposite-link ban, future hull reservations, red-line clamp, pedestrian/building/prop clearance and final contact seam remain. Regulatory waiting on this condition does not trigger jam ghosting. SIM20 and older do not run this new admission check.

The captured retry uses d4fc530d6cf64ff8c09f61d2778c2261f8fb346dc352d9e495b546d9d570fc2a: the originalf948copy with only updatedagents.ts and a new observation-only copy of the existing strict test. It also includes the conservative single-axis check that cannot skip a yellow/all-red gap merely because both endpoints are green. That copy preserves every original assertion and saves full state, hash, external still counters and progress each600ticks. Its120s process bound changes diagnostic wall time only; the physical2700tick limit and existing540s test timeout stay unchanged. Pending the root CPU slot.

Fillmore, the three reported junctions, Ferry join clearance, actual taxi fare delivery and historical replay pins remain pending. Current traffic acceptance is not green.


The120s captured strict Marina run finished normally in70.49s and still FAILED:4229ticks versus2700, nowactor1359. Every travel window remained positive and contacts stayed0. All2711manifest files were rehashed unchanged. The short-link1075 starvation was removed, but a different tightly separating turn stalled.

The exact9000→9001 proposal identifies the new blocker:1359 is stationary on a connector yielding to1075;1075 has no route blocker and proposes a0.000694m forward turn. Current full-body gap is+0.001463523m; proposed endgap is+0.002491804m. The32-iteration conservative sweep exhausts at t0.166 with gap+0.001756438m and refuses motion;64also exhausts, while128/256/512/1024all prove the same motion clear. See marina-proposal-1359.json.

The bounded correction retains the default32budget for legacy behavior and uses128only atSIM21 callers, with the same physical hulls, safety skin, closing bound and fail-closed fallback. Reverse metadata is now signed-.8m/s (bounded by movement effects) atSIM21; prior versions retain their original0metadata. The strict standstill predicate was not changed to exempt reversing actors.29focused physical/phase/reverse/separating-turn tests passed, including the actual producer on a small two-road fixture and old20/new21 final-seam behavior.

The exact saved-state recovery then PASSED600ticks under a15s cap (11.21s process), on sealed overlay1b5d01f3dc0f384ddf4962914480fd28ffc3e76ae746ba0b208cd238e0e50d22. Initial8ff00eb8→651ff13e.1075 resumes at9002;1359 at9130;2499 at9244;917 at9378;514 at9538. All five IDs remain. Contacts/failures remain0; overrides stay1. Initial gap+0.001463523m and accepted after-step gaps at least+0.002491804m. This proves the captured-state numerical repair, not a fresh full-soak pass. No further full soak has been run yet.


Fresh strict Marina with the numerical/signed-reverse overlay1b5d01f3 completed normally in71.01s (120s cap), still FAILED at3721ticks for514. The1359 numerical stall disappeared; all street-travel windows were positive and contacts stayed0. Every2711source/world/harness file rehashed unchanged. Raw speed<0.05 still counts negative reverse velocity as stationary;514's recorded worst-position changed between tick4800 and5400 while that counter grew600. This is evidence to inspect a precise pose/speed prefix, not grounds to declare the45s condition passed or to exempt an actor. The first raw2700threshold for514 is near tick4816 and must be inspected before another full soak.


The exact514 prefix completed normally in31.39s. At tick4666 it begins accepted reverse at-0.8m/s and moves0.013333m each frame. At the old raw-counter threshold4816, it is still physically reversing: rawStill2700, velocity-magnitude still0, independently measured pose still0. Longest actual stationary span before that point is2549ticks (42.483s), under the unchanged2700limit. Full per-tick pose/signed-speed trace and state333643dd are in marina-514-prefix.json; source1b5d01f3 unchanged. No physical motion or actor identity was altered to obtain that trace.

The two strict city test counters now use Math.abs(a.speed)<0.05 for every actor, matching their definition of stationary movement and their existing Math.abs-based travel metric. The45s/40s/90s limits,0.05m/s threshold, seeds, exposure, contact, target and travel checks remain unchanged. This is a generic signed-velocity measurement correction, not an exemption for514 or reversing actors. A full rerun is still required to check all actors, including any genuine stationary case hidden under the old largest counter.


The corrected generic magnitude counter rerun on415f134bcced8134444459ab8f3d2c6a5a2c770b0b6f85fe9b9ce1dd75fc91b3 completed in67.15s and still FAILED: actual stationary2499 reached3628ticks. Final state86a30a9c exactly matches the prior raw-counter run, proving the measurement correction did not change simulation behavior. The raw counter independently recorded3721 for reversing514.

Exact tick4300 statec4825d88 exposed a second admission deadlock:1075 still holds the near junction while waiting to enter the far unsignalled turn; red-queued514's nose blocks both the retained path guard and full physical sweep.514 has wait0 because its red is regulatory, and the original reverse-yield logic only saw already-entered holders. No expired stale holder was found.

SIM21 now records a prospective yield request when an otherwise eligible contender is rejected by a stopped queue nose. The contender remains unadmitted until both guards clear. The queue may back only on its existing lane with the existing complete physical/building/prop/pedestrian/vehicle forecast checks; no signal, admission or standstill threshold changes.33focused hull/contact tests pass, including red wait0, pedestrian obstruction, rear-car margin and legacy20.

The saved4300→4900 recovery on0865c50d05fe06849c947b94ef8e44c41a4676878b62ea30535bfc5cecfef17d completed normally in9.90s/15s cap. All2711source files rehash unchanged.514 physically backs at4301;1075 resumes at4618 and travels7.17m. IDs1075/2499/514 all retained, contacts/failures0, existing overrides1 unchanged.2499 remains behind the now-red signal, so this saved recovery does not prove a fresh full-soak pass. Final state81240307. Fresh Marina acceptance is pending the next CPU slot.


Fresh Marina on0865c50d PASSED all9000ticks in68.09s/120s cap. Strict2700tick stationary guard unchanged; actualmaximum2543ticks (42.38s), 882 at -3859.8,-1179.7 on c10969000. Contacts0; travel positive in all five30s windows. Every2711source/world/harness file rehashed unchanged, process group gone. Final statea9e0d947, saved asmarina-pending-yield-final-state.json. Fillmore/junction/taxi still pending.


Fresh Fillmore on0865c50d PASSED all9000ticks in70.24s/120s cap; maximum3557ticks (59.28s)<5400. Contacts0, all five30s travel windows positive, source rehashed unchanged, process group gone. Final stated2b0936e, fillmore-pending-yield-final-state.json. The three reported junctions are next.


First reported junction(-620,746) ondf0e4de0 FAILED unchanged strict<2400ticks:2161 reached2401 at(-729.4,734.6). Contacts0, all5400ticks completed in70.02s/90cap, every2712source/harness file unchanged. Final statecdb12843 and fullactorstate are retained. Other junctions/taxi remain pending; investigating this exact threshold before further full runs. Initial CLI attempt rejected a leading-minus pattern before tests ran; separately preserved asjunction-620-746-cli-error.log and not counted as physical evidence.


The exact5115→5116 holder-admission prefix completed in62.45s/90s cap, source unchanged.2161 had physically stood2116ticks. Both2161 and848 had identical wait413, because the yellow/red interval at4403→4703 cleared their jam clocks.848 won the tie bylower ID. The two planned turn routes genuinely conflict at5400, and full-sweep collision evidence is retained in junction-2161-admission-geometry.log; no guard was bypassed. A second bounded arrival observation is checking whether2161 actually queued before848, to decide whether preserving right-of-way age independently of jam age is warranted.


The arrival-order probe completed in38.11s:848 first queued on the shared approach at2094,2161 at3000. The admission order at5116 was therefore correct. No queue-priority/timer patch was applied. The former suggestion that a red reset had improperly reversed these two actors' order is rejected by this evidence. Current investigation follows holder5992, which stopped on its connector at4606 before848's later admission.


Exact5992 capture at4606 (9c92d81a),59.27s/75s cap, source unchanged: the car is lawfully yielding to actual sidewalkBot522, gap0.95m, moving1.0m/s across its connector. Nearby person467 and1855 and robots747/4961 remain real normal population. This is not a stale reservation or red-queue reverse deadlock; no clearance was bypassed. Removing that actor, shortening its berth, or treating the car as moving would violate physical acceptance. The remaining2161 stationary span is a real throughput/queue issue under the current authored junction and normal crossings.


The decisive4332→4333 admission observation (statead742eb6) confirms greedy starvation, independent of the lawful person/robot yield:2161 haswait132, a clear exit lane, and is rejected by current moving holder1976 (legacy/fulltrue). Newcomer5992 haswait0; its path misses both existing holders and is admitted, despite conflicting with2161's planned turn. Source-derived exact path predicate confirms that conflict. Logsjunction-4333-admission.log/junction-4333-priority.log retain the identities and geometry.

SIM21 now retains a deferred admission claim for an eligible older turn rejected by a holder. Current holders continue normally; a younger conflicting turn waits until the older one can enter. Deferred claims do not mark a car admitted, do not change node ownership, and do not relax any existing phase, full-exit, queued-nose, building, person or swept-hull guard. Disjoint turns still use the original conflict predicates. Legacy<=20 does not create deferred claims.36 focused tests and typecheck pass. Initial fixture assertions were corrected to expect normal braking (not an abrupt stop) and to drive the legacy0.2m later stop-line approach normally; physical thresholds unchanged. Immutable84776f1861f507a41423a6bbd87ce129f283cee29994aa0b7e1c4ea3f1346fb6 seals the updatedagents.ts overdf0e4de0. Fresh failed-junction rerun is in progress.


The deferred-priority full-junction candidate FAILED:1252 stood3586ticks versus2400, finalba96e299, contacts0. Process73.03s/90cap; all2712files rehashed unchanged. Because it worsened a different queue, the complete deferred-priority production change and its feature tests were reverted; copies remain underfair-admission-draft and snapshot-fair-admission. Liveagents.ts is restored byte-for-byte to0865c50d's passed Marina/Fillmore implementation. No threshold was relaxed. The previously measured2161=2401tick junction failure remains unresolved. Remaining junctions and taxi acceptance were not run after that failure.


Restored implementation checks:33 focused hull/contact tests PASS in1.69s;24 historical composed replays (all selected v16/v17/v18/v19 scenarios) PASS in14.85s; the two SF spawn/landmark premise checks PASS in3.96s. The historical process label initially expected20 tests but actual runner selected24, and its result metadata now records that actual count. No golden, performance baseline, speed/distance/clearance or standstill threshold changed. Final current-source typecheck is recorded separately.
