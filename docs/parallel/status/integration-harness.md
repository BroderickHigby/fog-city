# Integration harness

## Current checkpoint

Branch: `lane/harness/wave2`. Current code checkpoint: `8fe1e47`.

The real browser completed Hot Desk, bought Tank I through the counter, received the mission rewards and unlocks, and acknowledged the Spill call. The complete recorded-input and UI-command replay matched final hash **`953e8a72` at tick 14633**. The original campaign test exceeded its 20-minute allowance only when taking its first screenshot, after those assertions passed; it is **not reported as an entirely green test**. Its measured duration was 22.3 minutes. The campaign-only allowance is now 45 minutes, with replay proof written before screenshot work. No gameplay, command or state assertion was removed.

| Verification | Result |
| --- | --- |
| TypeScript and complete unit suite | Passed on `5944424`: **128 files, 3,001 tests passed, one existing opt-in skip**, 229.42 seconds |
| Real browser campaign and purchase | Functional assertions and full replay hash passed on `cd60020`; screenshot-only timeout as described above |
| Recorded final checkpoint visuals | Both first- and third-person views passed nonblank checks, zero errors and unchanged hash `953e8a72`; four tiles loaded, 55/52 draw calls |
| Remaining 46 browser/build cases | **35 passed, 10 unavailable-engine skips, one stale hosted-skyline assertion**, 15.6 minutes |
| Corrected hosted-skyline assertion | Passed on `8fe1e47`: TypeScript and all three hosted-static Chromium cases, **52.7 seconds**, session `74755` exited 0 |

The remaining-case coverage is therefore **36 passed and 10 explicitly unavailable engine cases**, combining the original run with the focused correction retry. The other two hosted-static cases passed again as dependencies of the corrected streaming case. The separate campaign's screenshot timeout remains disclosed above.

The checkpoint screenshots render the exact recovered browser state through the production scene renderer and UI projection. They do not advance simulation or inject outcomes into a running game. They are labeled **Recorded checkpoint**. The images document the current prototype presentation; they are not evidence of GTA-level visual fidelity or hardware frame rate.

## Fixes integrated and verified

- Replay uses the same explicit game-system registry and authored gameplay, sidewalk and transit metadata as the browser. Live-game helpers select `E2E_GAME_WAVE`; this wave-2 branch defaults to 2.
- Real HUD purchases preserve money, inventory, capacity, command idempotency and save/restore behavior. A dismissed mission interaction can be reopened through the objective or phone.
- Campaign selection advances Hot Desk to Spill, and a phone call requires a real acknowledgement.
- Core/Agents corrected full vehicle-hull admission, stopped-taxi clearance, follower stopping and service-vehicle dimensions. Exact bus-spawn and pedestrian/taxi failures were reproduced without relaxing the zero-contact gate.
- Player/Core corrected same-tick activity payment ordering before immediate save, restore or replay.
- Agents fixed the parked Hot Desk actor: bounded full-hull placement inside the authored area, with retained staging until physical admission. Core fixed combat wall tests to use actual building footprints, preventing a clear concave corner from deleting a thrown cone.
- The input-only QA walker plans around accepted physical vehicle hulls and walker bounds. It has a 120-tick stall guard, at most four replans, and a fixed overall input budget. No player pose, mission result or wallet is assigned by the driver.
- The hosted-build skyline fixture now respects the explicit software-renderer budget. It requires all guaranteed camera-region cells, no queued/loading/failed cells, at most 24 cached cells and positive drawn cells; native rendering still requires the entire skyline. Driving, asset requests, model provenance and screenshot assertions remain intact.

## Recorded performance

The same 600-tick SF drive improved from 51,430 ms before the Core/Agents performance fixes to 5,734 ms afterward, with zero clearance contacts/failures and zero car hits/person bumps. This was a headless simulation comparison, not a hardware-FPS claim.

The final browser performance probe wrote `test-results/perf.json`. Under SwiftShader, SF simulation averaged 17.364 ms per tick over its 600-tick sample. Software-rendered frame times were much slower and are reported rather than used as evidence of real-GPU performance.

## Consolidated assertion map

The campaign test owns the purchase assertions previously in a separate SF journey. Only the duplicate trip was removed; the configured suite remains 47 cases.

| Check | Evidence |
| --- | --- |
| Physical arrival | Production inputs, body within 18 m of counter, speed below 0.3 m/s, exact Node/browser state equality |
| Purchase | Actual Counter/Buy controls, exactly 60,000 cents charged, exactly one Tank I and one recorded buy command |
| Idempotency and capacity | Owned button disabled; HUD shows 12 L capacity |
| Save and replay | Purchased cash/inventory survive capture/restore; purchase and full campaign commands replay at their recorded ticks |
| Mission | Canonical thief watched for 180 ticks, real water melt, held 8 L refill, authored travel-any foot route, actual signup and hood cone |
| Handoff | Hot Desk reward/unlocks received once; Spill starts and waits for a real Continue acknowledgement |
| Safety | Zero recorded protected contacts/failures through the accepted campaign path |

## Preserved artifacts

These live outside Playwright's cleaned output directory:

- `test-results/campaign-browser-v5.log` and `campaign-v5-trace.zip`: original real-browser run, full-hash success and screenshot timeout.
- `test-results/campaign-v5-final-state.json`, `campaign-v5-commands.json`, `campaign-v5-browser-errors.json`: exact final state, five recorded UI commands and zero browser errors extracted from that trace.
- `test-results/checkpoint-visual-proof.json`, `checkpoint-visual.log`, `hot-desk-checkpoint-third-person.png`, `hot-desk-checkpoint-first-person.png`: read-only visual recovery and unchanged hash.
- `test-results/final-full-gate.log`: TypeScript, full units and the 46-case browser/build run.
- `test-results/web-build-stale-assertion-trace.zip`: original stale all-city expectation failure (33 expected, 19 budgeted cells loaded).
- `test-results/hosted-build-budget-retry.log`: TypeScript and all three corrected hosted-static cases passed.
- `test-results/hot-desk-pre-signup.json`, `hot-desk-browser-commands.json`, `cone-recovery-events.log`: short reproductions used to diagnose the parked actor and combat-wall defects.

## Limits and handoff

Firefox and WebKit are not installed. The official Playwright installation attempt failed with HTTP 403 `Domain forbidden` from `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`, before WebKit downloaded. The ten engine-only cases therefore remain explicitly unverified; Chromium ran through `/usr/bin/chromium`.

The focused hosted-static retry passed. Source checkpoint `8fe1e47` is ready for Core to publish to `integrate/wave2`; this lane stops after the evidence handoff. No main or `integrate/wave1` merge is authorized here. The pre-existing prototype and other active worktrees remain untouched. Git push works; GitHub API access is blocked.

## Draft pull request

Base: `integrate/wave2`

Title: `Verify the playable campaign, purchase persistence and composed-game replay`

Body:

Exercise Hot Desk, the first counter purchase and the Spill acknowledgement through production controls, with exact browser/replay state checks, persistent money and inventory, mission rewards and strict protected-contact assertions. Preserve authored world metadata in replay and use bounded physical route planning. Integrate the reviewed actor-admission, combat-footprint and same-tick reward fixes exposed by that path.

Validation: TypeScript and 3,001 unit tests passed, with one existing opt-in skip. The real campaign and complete replay hash passed; its original 20-minute test allowance expired during screenshot capture, and the exact final checkpoint was rendered separately with no state mutation. Of the remaining 46 browser/build cases, 36 passed across the full run and focused correction retry; ten could not run because Firefox/WebKit are unavailable. The corrected hosted-skyline expectation and its two hosted-static dependencies passed with TypeScript in 52.7 seconds. Production sub-path boot, packed assets, split collider parts and missing-part failure behavior passed. The campaign allowance is now 45 minutes, with proof persisted before rendering work.

## Compatibility note

The broad visual checkpoint `ce41d92` was evaluated only in disposable `harness/qa-compatibility`; it brought a collider format not consumed by this physical kernel. That comparison was not merged into this lane. This branch uses reviewed source-only UI and compatible gameplay metadata.
