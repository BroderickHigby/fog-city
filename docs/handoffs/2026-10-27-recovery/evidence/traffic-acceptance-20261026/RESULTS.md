# Traffic and safety handoff

Branch `codex/consolidated-game-upgrade`, checkpoint HEAD `96048e15b486dc2a81c67b0e4677a6f5e415477c` plus shared dirty implementation. Baseline remote `origin/main` was fetched by the coordinator at `66b1e6f51fd1799612d6319980fca7f2241b17a9` before this work. Original checkout remains untouched. No child commit or push.

## Retained source

Live `src/sim/agents.ts` SHA256 `904d96a15d6969f5217962c7de303207f233008e000b11044ddc8f83570fde23` matches the exact implementation in sealed snapshot `0865c50d05fe06849c947b94ef8e44c41a4676878b62ea30535bfc5cecfef17d`.

- Actual 2.5m half-length physical hulls, complete future turn sweeps and guarded reverse queue yielding are SIM21-only. Reversing reports accepted negative velocity; contact rollback reports zero when a move was refused.
- A car-length connector box requires enough continuous downstream green to clear the full body. No phase duration changed.
- SIM21 contact/reservation callers may spend128 conservative-sweep iterations, retaining the same safety skin, closing bound and fail-closed result. Legacy callers retain32. The captured separating turn had positive gap throughout but exhausted32.
- A stopped red queue can receive a prospective reverse-yield request before a conflicting contender is admitted. Both original and full-hull guards still have to clear; all person, building, prop, rear-vehicle and final contact checks remain.
- The city test counters use absolute signed speed for every actor. Limits and0.05m/s cutoff unchanged. The exact old/new measurement rerun produced the same final simulation hash.

Other owners have continued integration outside this isolated traffic source. These snapshot cases do not establish final combined-source acceptance.

## Verification

| Case | Result |
| --- | --- |
| Marina seed606/wave4,9000ticks | PASS; maximum2543ticks/42.38s against strict<2700; contacts0; all five30s travel windows positive.68.09s process/120s cap. Statea9e0d947. |
| Fillmore seed606/wave4,9000ticks | PASS; maximum3557ticks/59.28s against strict<5400; contacts0; all five30s travel windows positive.70.24s/120s cap. Stated2b0936e. |
| Junction(-620,746), seed1/wave3,5400ticks | FAIL;2161 stationary2401ticks against strict<2400, contacts0.70.02s/90s cap. Statecdb12843. |
| Focused physical hull/contact suite |33PASS,1.69s. Includes full-body adjacent queue, truthful reverse, blocked rear/person, downstream-green wrap, tight separating-turn and legacy20 fixtures. |
| Recorded composed replays |24PASS,14.85s; all selected v16/v17/v18/v19 hashes and coverage unchanged. |
| SF spawn and authored landmark premises |2PASS,3.96s; thresholds unchanged. |
| Current restored-source typecheck |Exit0, 12.12s, no timeout. |

All physical cases completed normally within process caps and rehashed every sealed source/world/harness file unchanged. Full states, process metadata, source manifests and detailed chronology are beside this report.

The other two junctions, actual taxi fare delivery, Ferry join override/clearance, final combined-source full suite and performance acceptance remain pending. No performance baseline or historical golden was updated.

## Remaining blocker and rejected candidate

2161 truly stands still at(-729.4,734.6) on c9296000, approaching n30735000. At5400 its signal is green and no direct forward object blocks it; moving holder848 occupies the actual future turn. Both full hull and legacy path guards correctly reject entry.848 queued earlier (2094 versus2161 at3000), so swapping their priority would be wrong.

The earlier4332→4333 capture also proves greedy admission starvation:2161 wait132 is blocked by current moving holder1976, while newcomer5992 wait0 enters a different currently clear path that conflicts with2161's pending turn.5992 later lawfully stops0.95m before moving sidewalkBot522. Real crossing actors were retained; no berth was reduced.

A deferred-priority admission experiment passed its focused fixtures but FAILED the complete junction: another car1252 reached3586ticks. The complete production experiment and feature tests were reverted. The draft source/tests/fixture remain only under `fair-admission-draft/` and the sealed `snapshot-fair-admission/` for review. The retained source is exactly the passed Marina/Fillmore implementation; the40s junction failure is not cleared.

## Test premise corrections

Untouched-main controls reproduced the near-threshold failures. Drive exposure changed3→4s for SF spawn,240→300ticks for knockdown travel,120→150ticks for fast F exit launch, and360→420ticks for the walker pass. Original distance/speed, stopping, clearance, contact and near-miss assertions remain. The original stopped-yaw corner reproduction explicitly uses its canonical SIM12; the current-version matrix is unchanged. Palace requires all six actual authored replacement hull IDs and inclusion of the two point-probe IDs; other landmarks retain exact probe equality. Exact diff: `physical-premise-changes.patch`; four small-world selections previously passed and both SF checks now pass.

## Coordination

The parent agent stopped with GPT-ZIP HTTP413 while child work remained active; this was recorded with `gzfb error`. No unrelated heavy work was observed during these serial bounded cases. CPU and production ownership are released after the restored-source checks. The next integration pass should begin from the retained source, preserve the unresolved strict failure, and review the actual n30735000 queue/connector throughput before another source candidate. No further full soak was run after the failed admission experiment.
