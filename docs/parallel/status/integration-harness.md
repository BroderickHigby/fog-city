# Integration harness

## Now
Current frozen runtime includes the reviewed bus admission, pedestrian/taxi clearance and same-tick activity reward-order fixes. Typecheck and **25 focused tests passed** on the current harness. Full campaign browser acceptance reached signup with exact Node/browser state after **13,654 input frames**, and the real purchase passed all financial, inventory, capacity, save and replay checks. It then failed because the required `mission:hot-desk:squatter` never spawned for the cone objective (`test-results/campaign-browser-v3.log`, 14.9 minutes). This production defect is under targeted review; the campaign is not signed off. The last complete unit gate was **2,975 passed**, one existing opt-in skip on `76fcc02`; a final complete run is still required for the corrected runtime. The original prototype and other active worktrees are untouched.

The retained browser trace supplied the exact pre-signup state at tick 13,715 and its real `startup-define` command at tick 13,716. `test-results/hot-desk-pre-signup.json` and `hot-desk-browser-commands.json` permit a short reproduction. At tick 13,731 the mission binding exists but no squatter runtime actor or allocated identity exists; a blocked one-shot stage placement appears to have been discarded.

Integrated `8dea622` as `136d8c3`: the parked actor is now physically admitted at the authored site, with bounded stage retries. The focused continuation then exposed a separate combat-wall error: all three legitimate cone throws ended on a wall in their birth tick. Core confirmed that building `201006.0000770` uses an AABB that covers clear space outside its true concave footprint. The shooter is outside the footprint but inside that AABB; the muzzle falls within its vertical range. `test-results/cone-recovery-events.log` and `cone-recovery.json` retain the input tape and events. No cone, collision or mission assertion was lowered.

The bounded walking probe exposed a QA planner omission: its static route ignored accepted NPC bodies. It now uses full physical vehicle hulls, including explicit service dimensions, and walker bounds, with one bounded replan after a 120-tick stall. Recovery from the exact saved state reached the real signup objective after **6,376 input frames**, with **zero contacts and failures** (`test-results/walk-recovery-v2.log`, 144.26 seconds). This is recovery evidence, not a substitute for the active complete browser test.

## Done
- Node and browser replay builders retain the authored gameplay, sidewalk and transit layers.
- Running-game replay explicitly uses `createGameSystems()`; pure base-simulation tests retain their intentional default.
- Regression checks prove a missing gameplay registry fails replay, and curved sidewalk metadata survives both builders.
- Chromium determinism can use a configured executable and cannot silently skip because the bundled binary is absent. A separate composed-gameplay cross-engine scenario is included.
- Added an input-only route driver; it advances production simulation controls, without assigning player poses, mission outcomes or wallet state.
- `pnpm typecheck` passed on the composed source plus harness changes. Focused harness tests: **24 passed** (11.35 seconds), including delayed UI command placement and an input-only walk / return-to-car replay.
- Chromium dev smoke **passed** (57.1 seconds): no console or request errors, the game loop advances, and the frame is nonblank. The sandbox required loopback permission for Vite; the same test passed when run with that permission.
- Baseline canonical SF physical probe: **600 ticks took 51,430 ms** (11.7 ticks/second) without rendering. The car moved approximately 95 m with zero recorded car hits / person bumps. This is below the required real-time throughput and has been reported to Core and Agents for profiling. The bounded route probe intentionally stopped before reaching the distant vendor; it is not purchase acceptance.
- The same 600-tick drive after `f9ca263` took **5,734 ms** (104.6 ticks/second), approximately nine times faster. All gameplay, sidewalk and transit layers were present; actor counts were 330 initially and 363 at the end, with 363 runtime actors, zero clearance contacts/failures and zero car hits/person bumps. This resolves the measured simulation-throughput blocker on this scenario, not every possible city load.
- Added real-SF first-purchase acceptance: drive to the FiDi counter using production controls, click the HUD, check cash/item/capacity changes, replay the recorded command, and capture first/third-person screenshots. Pending full browser execution.
- First complete unit run: **2,968 passed, three failed, one skipped** in 233.28 seconds. The failures were the missing `gameplay` entry in the manifest test, tests looking for `gameplay.schema.json` instead of canonical `tile-gameplay.schema.json`, and an old whole-extension-empty assertion despite intentionally registered player systems. Fixes retain schema validation and positive population/player/wallet checks. The skipped unit is the existing opt-in content generator, not gameplay coverage.
- Integrated controller release guards, authored signup choices and the UI fix that reopens a dismissed active mission interaction from the objective or phone.
- Full repaired unit gate passed on `76fcc02`; log: `test-results/full-verify-v2.log`. The supervising shell was deliberately stopped after Vitest exited so the shared lock could be released before browser testing; its final exit 143 is not a failed test.
- Review found that the legacy standalone Ramen prototype could precede Spill in automatic mission selection. Integrated the isolated campaign-only selector fix `6edaba1`; browser acceptance will cover the corrected handoff.
- Review found that a mission-start command also answered its own phone call. Integrated the isolated `13d54de` correction so Spill waits for a real mission acknowledgement; focused and browser validation are pending.
- Handoff follow-up typecheck and **11 focused tests passed** on `9c65082`. Chromium partial gate: **7 passed, one deliberately interrupted, 39 not run** to release the runner for a concrete game fix; log `test-results/browser-build-gate.log`. This is not a full browser pass.
- Real input-only Hot Desk approach exposed two overlapping transit buses at tick 1201. Integrated isolated `5e8bf5b` as `7269504`; its planner checks full vehicle hulls, without relaxing physical admission.
- The corrected physical route completed **180 observed Watch ticks**, melted the canonical thief, and held a real hydrant refill from 1.84 L to the **8 L capacity**. Continuing the route exposed a **1.062 mm** ambient pedestrian/taxi overlap at tick 3078. The zero-contact assertion remains in place; exact one-tick state/input reproduction is `test-results/hot-desk-contact-repro.json`.
- The input driver now retains its immutable pre-step snapshot so later failures can be reproduced in one tick without replaying the whole route.

## Next
1. Finish Hot Desk, purchase and Spill acknowledgement through real controls and recorded UI commands.
2. Rerun the full unit gate on the corrected runtime.
3. Complete the remaining browser and hosted-production-build checks without lowering assertions.

## Blocked on
- Firefox and WebKit are not installed. An official Playwright installation attempt failed with HTTP 403 `Domain forbidden` from `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`; it stopped before downloading WebKit. This remains explicit missing cross-engine evidence. System Chromium continues to work through the local executable override.

## Requests for other lanes
- UI: keep the read-only `commands()` log and shared `buildLoadedWorld()` API stable for replay verification.

## Consolidated browser assertion map
The pending campaign browser test now owns the first-purchase assertions previously in `sf-world.spec.ts`. Only the duplicate physical journey was removed; the suite still has 47 browser cases.

| Check | Retained coverage in `campaign.spec.ts` |
| --- | --- |
| Real counter arrival | Production movement, controlled body within 18 m, speed below 0.3 m/s, exact Node/browser state equality |
| Purchase accounting | Actual Counter/Buy controls, cash decreases exactly 60,000 cents, exactly one `tank-1`, exactly one recorded buy command |
| Idempotency and capacity | Owned button disabled, HUD displays the 12 L capacity |
| Replay | Purchase replays at its recorded tick; the complete mission and UI-command sequence replays to the same final hash |
| Save | Purchased inventory and cash survive capture and restoration into the earlier snapshot |
| Presentation | First- and third-person screenshots and no console/request errors |
| Campaign | Real Watch, water melt, held 8 L refill, authored `travel:any` foot route, signup, physical hood cone, reward/unlocks, then Spill waits for real acknowledgement |

Live-game replay factories accept `E2E_GAME_WAVE` (default 2); the combined later-wave UI sets 4. Pure cross-engine and unit fixtures retain their explicit wave-2 semantics.

## For the owner
No release or protected integration branch is modified. First purchase and the first two missions are not yet signed off. Visual realism and real-hardware feel remain separate owner review items.

## Draft pull request
Base: `integrate/wave2`

Title: `Verify the playable campaign, purchase persistence and composed-game replay`

Body:
Exercise Hot Desk, the first counter purchase and the Spill phone acknowledgement through production controls, with exact browser/replay state checks, persistent inventory and cash, mission rewards, and strict protected-contact assertions. Share the authored world layers and configurable game-system registry between the browser and Node replay. The route planner observes accepted physical bodies, uses their full collision dimensions, and stops or replans within a fixed budget.

Validation at this checkpoint: current typecheck and 25 focused checks passed; exact walking recovery reached signup with zero contacts/failures. Complete campaign browser acceptance is running; final full unit and remaining browser/hosted-build verification remain pending. Earlier full unit baseline: 2,975 passed and one existing opt-in skip. Firefox/WebKit installation was blocked by the environment's download-host policy. No harness contract or SIM_VERSION change; no QA collider migration is included.

## Compatibility review
The visual checkpoint `ce41d92` was merged only into a disposable local comparison. It brought 1,449 changed paths versus the physical checkpoint, including a pack decoder with DECK/TUNL/SPAN/LAKE extensions. The approved `b7c412c` world/vehicle code does not consume those added surfaces. The binary header remains FCWC version 1, so this combination can load while lacking matching deck/tunnel/lake physics. The comparison is retained as `harness/qa-compatibility`; no broad comparison merge was pushed. The active branch uses the source-only UI and reviewed gameplay metadata instead.
