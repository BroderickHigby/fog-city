# Reviewed gameplay integration — 23 October 2026

This continues the tested `d2400e8` integration. The playable city keeps its existing physical world and generic licensed human avatar. The newer Ferry geometry is a separate review candidate because its strict physical-world gate detects regressions.

## Integrated runtime

- Core PR #26, `6f1d91b`: indexed navigation, bounded actor identities, spawn retry, calendar rollover, save migration coverage and composed-game harness.
- Combat PR #13 plus reviewed repairs: moving-car projectile behavior, gradual taxi stops, real movement caps, correct water/fog observation, protected actors and clearance heights.
- Content PR #18 and selected wave-three player mechanics: observed Launch Day and Demoed Correctly missions, legal full-hull parking, retries with fresh actors, early-melt evidence, one-time rewards, real car-wash interaction and director timing.
- Integration repairs: blocked actors remain quarantined from combat/perception/rendering until admitted; distant transient actors and ambient taxis retire; parking and street-cleaning data reach the production game; mission navigation and acknowledgement use current per-player bindings.
- The live page and browser replay driver enable wave three. Side activities without production completion events remain unavailable. The authored race and delivery routes remain available.

The integration preserves later-wave source material without presenting it as complete gameplay. It does not certify every open pull request as approved or merged on GitHub.

## PR inclusion check

Git head refs were fetched and compared to the tested source. Exact ancestry is a code-inclusion check, not a claim about GitHub reviews or CI.

| PRs | Disposition in this integration |
| --- | --- |
| #7, #8, #10, #12, #13, #18, #23, #24, #26 | Current fetched heads are exact ancestors. |
| #9, #11 | Reviewed runtime functionality is present or patch-equivalent; full head ancestry is not claimed. |
| #16 | Selected mission mechanics were integrated with production wiring and retry repairs; the complete PR head was not merged. |
| #1, #3 | New world/render work retained on separate review branches because physical-world gates remain red. |
| #2, #4–#6, #14–#15, #17, #19–#22, #25 | Full heads not merged. These include historical documentation, superseded work and later-wave dependencies. |

## World and renderer hold

[`qa/world-integration`](https://github.com/BroderickHigby/fog-city/tree/qa/world-integration) contains the regenerated Ferry world and matching structural physics. [`qa/world-render-integration`](https://github.com/BroderickHigby/fog-city/tree/qa/world-render-integration) contains its additive renderer, house assets, detailed tree admission and camera support. The renderer has before/after evidence under `docs/shots/world-integration` on that branch. Both review branches were pushed; neither changes the playable integration.

The strict world baseline remains unchanged. The initial comparison found 66 improving metrics, 37 unchanged and 13 worsening. Material problems include steeper freeway approaches, road/render height disagreement, an additional stopped route, more airborne crossings and incorrect far-building heights. A follow-up source fix reduces Lake Merced driving from 780 m to 0 m, but a corrected real southern-boundary probe exposes 2.1978 m overshoot against a 0.02 m limit. These results do not waive the remaining problems.

The held physical-world branch's provisional version eight must become version nine, with an eight-to-nine migration and separate golden replay fixtures, before any future merge into the released gameplay version eight.

The pinned raw SF source cache is absent, and the source endpoint returns a proxy denial here. A complete regeneration therefore remains unverified. No generated geometry was manually edited to conceal a failed gate. This candidate is not part of the playable release.

## External limits

Git fetch and push are available. GitHub API access is unavailable, so current review/check status and pull-request closure cannot be certified or changed through that API. No connected production host is available in this session; the output is a tested static build ready to serve or deploy.

Chromium uses software rendering. Hardware frame-rate performance and Firefox/WebKit are not certified by these local results.

## Combined validation

Tested source commit: `c34e38328cf001b58a7996d907fad8a419fa7bf2`.

| Check | Result |
| --- | --- |
| TypeScript | Passed. |
| Full unit suite | 3,270 passed, one existing opt-in skip; all 154 files passed in 144.41 seconds. |
| Gameplay index | Byte-identical: 583 tiles, 5,205 refills, 807 anchors, 10 territory rows. |

Focused integration checks additionally covered production SF parking, per-player mission guidance, real timeout/retry/refill/recompletion, one-time rewards, rejected unsupported activities, physical movement limits and quarantined actor admission. These are included in the full suite rather than added to its total.

The first full browser run passed 38 Chromium checks and skipped ten cases for unavailable Firefox/WebKit engines. Its one failure was the campaign walker exhausting four route replans beside a stopped taxi on the way to the desk. The avatar, deterministic stepping, protected movement, SF rendering, traffic, packed sub-path boot, split-pack loading and missing-pack refusal checks passed. All 1,858 source/data/test/asset files were verified unchanged throughout this run.

The failure was isolated to the test driver: it counted route recovery attempts across the entire walk, including long stretches of successful movement. Harness-only commit `371fd72450ebd8636998e3c2942ac94a3c0ae0a0` resets the recovery count after at least 0.5 m of actual checkpoint progress. Four consecutive stalls, total walking ticks and total campaign inputs remain bounded. No game runtime or asset changed.

Ordinary turn-and-walk controls escaped the exact failed snapshot, and the corrected driver then reached the desk in 3,183 input frames with zero contacts or safety failures. All 24 affected harness checks passed again. The rerun reached signup in 14,931 input frames with exact browser/Node state equality; its upgrade purchase passed cash, inventory and replay checks.

Final browser results:

| Check | Result |
| --- | --- |
| Main Chromium coverage | 38 checks passed in the initial run; the affected campaign passed after the driver correction. No production code changed between these runs. |
| Campaign | Hot Desk, first upgrade purchase and Spill acknowledgement completed using real controls and UI commands. Full replay matched: 15,551 frames, five commands, tick 1 to 15,552, expected/actual hash `2c322366`. Zero protected contacts or safety failures. |
| Standalone UI fixture | Five passed: mobile controls, modal disposal, IndexedDB reload, gamepad isolation and mission-dialog recovery. |
| Live SF UI | One passed: HUD, driving, phone, exit and spraying. |
| Total Chromium checks | 45 passing checks across the full run and focused rerun. Ten unavailable-engine cases were explicitly skipped. |
| Source freeze | All 1,858 source/data/test/asset files stayed unchanged during each browser run. The only intervening change was the reviewed test-driver correction. |

The final Git fetch still showed Core `6f1d91b` and Ferry `451f4dc`; the playable integration base was unchanged and can be advanced without a force push.

Local evidence:

- `/tmp/fog-wiring-unit.log`
- `/tmp/fog-wiring-e2e.log` (initial run and isolated campaign failure)
- `/tmp/fog-walk-escape.log`, `/tmp/fog-walk-replan.log`, `/tmp/fog-walk-harness.log`
- `/tmp/fog-wiring-driver-check.log`, `/tmp/fog-wiring-campaign-retry.log`
- `/tmp/fog-wiring-ui.log`, `/tmp/fog-wiring-ui-game.log`
- `/tmp/fog-wiring-campaign-driver.log` (final unchanged-source verification)
- `test-results/campaign-replay-proof.json`

## Tested build

The downloadable archive is copied directly from the static sub-path build exercised by the browser tests. It includes the existing city data, generic licensed avatar, wave-three gameplay and attribution notices. It does not include the held regenerated world.

Artifact: `test-results/fog-city-integrated-wave3.zip` — 126 files, 124,985,247 uncompressed bytes, 76,219,928 archive bytes. The largest hosted file is 12,349,300 bytes. ZIP integrity and the source manifest were verified after packaging. SHA-256: `0d026f97bb13bbe7fb96036b73d9853b0770381e9c4575d2b6409a8526f9dc59`.

Unzip it into a folder and serve that folder, for example with `python3 -m http.server 8000`. Open `http://localhost:8000/?world=sf&gfx=high&tod=golden`. This is a ready-to-host static build; no public-host deployment is claimed.
