# Ordered PR integration — 23 October 2026

Base: `c36a550061101346e07fcb9b3bc00663707d7267` (`integrate/wave2`).
Candidate: `f59cc251e9b4bd3026d0c7cdaaceab242c22eb87`.

## Integrated changes

1. PR #23, `a1c64824ca04f35507c75a8ecc988657c5d867e9`: recursive legacy-save upgrades and per-tick extension isolation. Merge `ba6ceaa`.
2. PR #24, `fac7f1db232d7233dafa281200fbb357124d2974`: shared gameplay generation predicates and deterministic metadata. Merge `beed637`.
3. Reviewed render lane, `5d7c235a79d48a895b58207b5dc8a2ba1ceffe19`: generic licensed human avatar, original civilian car, foliage, scanned surfaces, lighting, and associated tests. Merge `f59cc25`.

The sole merge conflict was the schema lookup in `tests/pipeline/sf-world.test.ts`. The canonical layer-key lookup was preserved: the `gameplay` layer selects `tile-gameplay`, regardless of its filename. An independent read-only comparison confirmed the Core and Pipeline implementations match their reviewed heads. The simulation version, schemas, collider format, city geometry and gameplay index bytes are unchanged. SF data changes only reorder one manifest key and add two report counts.

## Other PR heads

All advertised GitHub PR head refs #1–#25 were fetched. Git refs do not establish whether a PR is open, approved or green. GitHub API access is unavailable in this environment; no current GitHub check/review certification is claimed.

| PRs | Disposition |
| --- | --- |
| #7, #8, #10 | Exact heads already contained in the integration base. |
| #9, #11, #12 | Runtime changes already present or patch-equivalent; remaining unique commits in #9/#11 are historical status documentation. Canonical fixes were preserved. |
| #13–#16, #18–#21, #25 | Held: later-wave dependencies or unresolved reviewed findings. No blind merge of these stacks. |
| #5, #17 | Documented duplicate/superseded lines; not merged or closed through this environment. |
| #1–#4 | Historical wave-1/showcase lines; not reintroduced into the current wave-2 kernel. Their world gate is not certified by this pass. |
| #6, #22 | Documentation targeting the earlier integration line. Read as evidence; no gameplay merge required. |

## Remaining release blockers and limits

The independent review on `origin/docs/parallel-resync`, `docs/parallel/reviews/integrate-wave2.md`, identifies pre-existing problems that these narrow PRs do not fix:

- Whole-road-network route searches repeatedly sort the queue; claimed ambient bodies can accumulate and eventually reach the runtime actor cap.
- Blocked runtime admission can throw. This requires a focused lifecycle/physical-admission repair and long-session regression coverage.
- The simulation's content dependency still calls `Math.hypot`, outside the current forbidden-API scan scope.
- Some reviewed UI, activity timing, car-wash and later-wave mission/event findings remain unresolved.

This integration is not a production-release or full-world-gate approval. Full SF source regeneration also remains unverified because the pinned raw source cache is absent. The committed gameplay-index check and synthetic full-builder/reindex equivalence are separate, runnable checks. Native-GPU performance and Firefox/WebKit are not certified here.

## Combined QA

All results below are from the combined candidate, not a sum of separate lane results. No tests or thresholds were relaxed to admit a merge.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed. |
| Full Vitest, two workers | **3,040 passed**, one existing opt-in skip; all 134 files passed in 140.01 seconds. |
| `node pipeline/build-gameplay.ts --check` | Byte-identical: 583 tiles, 5,205 refills, 807 anchors, 10 territory rows. |
| Full Chromium end-to-end suite | **39 passed**, 24.8 minutes; 10 Firefox/WebKit cases explicitly skipped because those engines are absent. All non-engine prerequisites were required. |
| Standalone UI fixture suite | **5 passed**, including mobile controls, IndexedDB reload, gamepad input isolation and mission-dialog recovery. |
| Standalone live-SF UI suite | **1 passed**: HUD, driving, phone/map, exit and spraying. |
| Source freeze | SHA-256 checks verified all 1,793 source, data, test and asset files unchanged throughout the browser runs. |

The real campaign completed Hot Desk, bought the first upgrade, retained the correct money and inventory, and acknowledged Spill. The complete replay recorded **14,644 input frames and five UI commands**, from tick 1 to tick 14,645; actual and expected hashes both equal **`845bcfc6`**. The protected-contact assertions passed along this tested route.

The 45 Chromium checks include the human avatar, high-quality foliage/material shaders, camera/simulation separation, Node/browser deterministic stepping, city traffic and skyline, driving, static sub-path boot, asset decoding, split collider packs and refusal to boot with a missing pack. The performance probe records software-renderer measurements; it is not a hardware frame-rate acceptance test.

The final remote recheck found the selected Core, Pipeline and Render heads and the integration base unchanged. GitHub review/CI status remains unavailable. The later-wave holds and production-release limitations above remain in force despite the passing combined regression suite.

Local evidence:

- `/tmp/fog-integration-unit.log`
- `/tmp/fog-integration-e2e.log`
- `/tmp/fog-integration-ui.log`
- `/tmp/fog-integration-ui-game.log`
- `/tmp/fog-integration-browser-driver.log`
- `test-results/campaign-replay-proof.json`
- `test-results/fog-city-integrated.zip` (the hosted build exercised by the browser suite, archived for download)
