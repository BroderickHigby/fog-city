# Integration harness

## Now
Running full typecheck, unit and browser verification on `lane/harness/wave2`, including core `f9ca263`, source-only UI `7382472`, bounded rendering `5c0c598` and the isolated wave-2 purchase correction `cad8993`. The original prototype and other active worktrees are untouched.

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

## Next
1. Complete the active full verification run and repair concrete failures without lowering assertions.
2. Verify Hot Desk / Spill through real controls and recorded UI commands.

## Blocked on
- Firefox and WebKit are not installed. An official Playwright installation attempt failed with HTTP 403 `Domain forbidden` from `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`; it stopped before downloading WebKit. This remains explicit missing cross-engine evidence. System Chromium continues to work through the local executable override.

## Requests for other lanes
- Core / Agents: the later Fleet Week recovery producer still needs a physical ownership consumer and current controlled-actor identity.
- UI: keep the read-only `commands()` log and shared `buildLoadedWorld()` API stable for replay verification.

## For the owner
No release or protected integration branch is modified. First purchase and the first two missions are not yet signed off. Visual realism and real-hardware feel remain separate owner review items.

## Draft pull request
Base: `integrate/wave2`

Title: `Harness: replay the composed game with authored world metadata`

Body:
The browser now runs registered gameplay systems and authored world layers, so replaying only base vehicle physics cannot reproduce its state. Pass the same explicit registry and all authored metadata through the replay harness, and add regressions that detect a missing registry or discarded navigation curves. Add a short composed-gameplay cross-engine scenario and require Chromium to execute even when its binary is supplied through a local override.

Validation: typecheck and 24 focused harness tests passed; Chromium dev boot, tick progress and nonblank-frame smoke passed. Full unit/browser acceptance is pending the current runtime performance investigation. No harness contract or SIM_VERSION change. Reviewed Core/UI commits are integrated separately; no QA collider migration is included.

## Compatibility review
The visual checkpoint `ce41d92` was merged only into a disposable local comparison. It brought 1,449 changed paths versus the physical checkpoint, including a pack decoder with DECK/TUNL/SPAN/LAKE extensions. The approved `b7c412c` world/vehicle code does not consume those added surfaces. The binary header remains FCWC version 1, so this combination can load while lacking matching deck/tunnel/lake physics. The comparison is retained as `harness/qa-compatibility`; no broad comparison merge was pushed. The active branch uses the source-only UI and reviewed gameplay metadata instead.
