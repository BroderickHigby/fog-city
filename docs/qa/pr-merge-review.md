# Fog City integration review

The candidate branch `merge/review-prs-1-2-3-5` contains all four requested PR heads:

| PR | Head reviewed |
| --- | --- |
| #1 | bd1239e5e9dab301b3471f3e0439cb20464989a7 |
| #2 | 8c9b7a20589ce768aefbf9150f22168a876dfa5a |
| #3 | f3c845a7a697147d07e89a4264dd1e70cab85a0b |
| #5 | b788d11b1685c6d87870fb8de72b72fbc409fee0 |

PR #5 already includes #2. The candidate merges #1's additional documentation and #3's three newer rendering commits. It preserves both sides of the actor-rendering conflict: walking adults use the new character renderer; dodges, recovery poses and child proportions retain the existing rig. Regression tests exercise both paths and the rendered-player count. An inline favicon prevents a real missing-resource console error. The high-graphics browser check loads the actual character assets, renders all three lighting presets and checks that lighting does not change simulation state.

The candidate does not change the simulation, generated world data, landmark definitions or world-gate baseline relative to PR #5. It retains SIM_VERSION 5 from that PR, including its existing migrations.

Do not merge to main while the required checks are red. `docs/qa/world-continuity-gate.md` requires the world-PR gate, current nightly evidence and a reviewed screenshot tour. `CLAUDE.md` requires a green `pnpm verify`.

The ballpark/landmark failures are already documented in PR #5's `docs/qa/2026-10-23-integration-status.md`. Rebuilding the generated world is currently blocked: the raw DataSF building cache is absent, and both `data.sfgov.org` and `elevation.nationalmap.gov` return proxy policy HTTP 403. An offline `--check` reproduces the missing-cache failure. Generated geometry and thresholds have not been manually changed to conceal this.

Git fetch and remote-head verification work. GitHub's GraphQL API returns Forbidden, so GitHub review/check status and PR draft flags could not be confirmed. No GitHub PR merge was performed.

Browser checks use system Chromium 154 via an external local Playwright config with the repository's software-WebGL arguments. The pinned Playwright browser download remains blocked, and Firefox/WebKit validation is unavailable. This is not cross-engine certification.

## Validation results

- Node 24.19.0, pnpm 9.12.0; frozen-lockfile install succeeded. Typecheck passed.
- `pnpm test` completed: **3,061 passed, 93 failed, 1 skipped** across 143 files (130 passed, 13 failed). Of the failures, 90 are in the world gate, two are the missing ballpark/its storefront anchors, and one was the privacy test observing temporary JPEGs written by a concurrent Playwright trace. The isolated privacy rerun passed after the browser run completed; no privacy assertion was relaxed.
- A separate focused run of the character integration regressions, privacy checks, and all network/server-network tests passed: **43 tests, 9 files**. This includes delayed-input prediction, room boundaries, protocol handling and relay behavior.
- The two-browser multiplayer test passed: create/join, remote movement, leave and rejoin.
- The new high-graphics browser regression passed: actual character files loaded, three lighting presets rendered, simulation hash unchanged, no console or shader errors.
- `pnpm build` passed on the final code: 164 files, 179.6 MB, largest file 10.5 MB; within the configured host limits.
- A separate browser smoke test of that packed production build passed on SF: packed colliders, 333 agents, six detail texture sets, the showcase, both character renderers, post-processing and reflections loaded without console/HTTP errors.
- The broad browser suite was interrupted after the required unit/world gate was known to be red. It is not a full browser-suite pass. Nightly and the full screenshot tour were not run; their merge prerequisite remains unmet.

Representative world-gate observations (candidate data is unchanged from PR #5):

| Metric | Recorded baseline | Candidate |
| --- | ---: | ---: |
| Stopped driving routes | 2 | 3 |
| Maximum freeway grade (%) | 143.22 | 345.06 |
| 99th-percentile rendered road/sim surface difference (m) | 0.497 | 8.245 |
| Building ledger/count discrepancy | 0 | 2,667 |

Some other gate failures are improvements exceeding the stale-baseline threshold, and some need geometry/measurement reconciliation. They are not all new defects. No baseline was loosened or test disabled.

## Remaining work before main

1. Apply supported network access for DataSF/elevation, or supply the valid raw pipeline cache. Regenerate through the pipeline and verify byte identity; do not edit the collider pack or GLBs by hand.
2. Repair the remaining world defects and reconcile measurement definitions; lower baselines only for verified improvements.
3. Run a green `pnpm verify`, the world nightly and the required reviewed screenshot tour on the final candidate.
4. Recheck the four PR heads and main, GitHub checks and review state, then merge. The four heads above and main were rechecked unchanged during this review.

Raw logs and measurement files are retained locally in `/workspace/fog-city-review/` (not committed). The branch is a review candidate, not a claim of release readiness.
