# Lane 7: combined game integration and final QA

## Final candidate

Branch: `lane/input-aim/wave4`. Worktree: `/workspace/fog-city-aim`.

Application source `7a267e3` passed the full unit/build gate. The complete browser run used `4a2c285`; the isolated hosted-browser correction and final SF control proof used `33a6c34183fafdeeed89f2966372aa7e4a1da254`. These later commits change tests and documentation only.

Merge `8465b98196f1b36bf57fd1b6f7b0f996da819e32` records published `integrate/wave2` at `c36a550061101346e07fcb9b3bc00663707d7267` as its second parent. All nine patch-unmatched base production commits were audited: their geometry, mission staging, phone acknowledgement, campaign selection, interaction reopening, map-distance eligibility and follower fixes are already included. The merge preserves the tested combined tree. `src`, `content`, `public`, package, lockfile and TypeScript configuration fingerprints are identical before/after, and merge-tree is clean. The audit is saved in `/workspace/visual-review/final/merge-audit.json`. Final status documentation follows that merge without application changes.

The original `/workspace/fog-city` prototype remains preserved. Owned QA servers on ports 4198/4199 are stopped; the parent owns the verified preview handoff on 5173.

## Implemented

- Mounted HUD, objectives, GPS map, phone, vendor, mission dialogs, accessible controls, touch/gamepad navigation and the shared FreeTextBox safeguards.
- Connected the wave-4 campaign, combat, accepted actors, authored refill sources, weather/recovery, and source-only renderer improvements through the shared game-system composition.
- Added recorded mouse/right-stick aim shared by camera, spray, scan and Watch; modal transitions release held controls.
- Enabled local Bot Sweep and Clean Streets through the canonical isolated match runner. City state is preserved independently; cancel restores it, and explicit result return settles validated rewards once.
- Added progression-only versioned saves, IndexedDB slots and recoverable autosaves. Durable profiles, world progression and the settlement ledger survive capture/restore without serializing transient actors.
- Integrated the completed private relay and offline AI service modules. The browser host exposes local modes; it does not expose an online lobby.
- Applied verified bus/vehicle admission, pedestrian clearance, same-tick activity rewards, durable mission-stage retry, and exact building-footprint combat fixes found by adversarial testing.

## Verification

- Application source `7a267e3`: typecheck passed; 13 focused mission/admission/footprint checks passed; complete unit suite passed **3,408 tests**, with **one existing opt-in skip**, across **173 files**. Production Vite bundle built successfully (216 modules).
- Complete browser run on `4a2c285`: **36 passed, 10 engine-specific skips, one stale hosted-skyline assertion**, 43.5 minutes. The assertion expected all 33 skyline cells under the approved bounded software-renderer budget. Test-only correction `33a6c34` verifies required regional cells, empty load/error queues, the cache limit, actual drawing, and full native-GPU loading. Typecheck and all **three hosted-static cases passed** afterward (53.2 seconds). No browser failure remains unaddressed.
- The real-control campaign passed in **26.4 minutes**: Watch, melt/refill, travel, authored signup, Tank I purchase, cash/inventory/save checks, Hot Desk completion and actual Spill acknowledgement. It replayed **14,632 input frames and five commands** through tick **14,633**; both hashes were **`6d86cb0a`**. First/third-person completion screenshots passed and were visually reviewed.
- Final ordinary-control SF proof on `33a6c34` passed in **1.9 minutes**: drove **4.0469 metres**, braked, exited, aimed, sprayed, opened Playlists and launched active Bot Sweep with **121 accepted actors**. Page and console error lists were empty. This proof uses keyboard/pointer/UI controls without teleporting or injecting outcomes.
- The complete browser run left `E2E_GAME_WAVE` unset, verifying its default matches the wave-4 host. Six earlier Chromium UI fixtures passed, covering signup, modal recovery, controls, IndexedDB and explicit autosave recovery.

Historical content failures were fixed and all 120 content/provenance checks passed. An earlier scheduling-stall run had two timeout failures; those unchanged files passed a 26-test isolated retry. The final application unit run above passed without retries. The earlier wave-2 campaign's screenshot-only timeout is separate from this combined campaign, which completed successfully within its bounded 45-minute allowance.

## Evidence

All evidence is under `/workspace/visual-review/final/`:

- `final-runtime-validation.log`: final full unit/typecheck/build results.
- `combined-4a2c285/`: preserved complete-browser log, campaign screenshots, trace, performance report and `repo-test-results/campaign-replay-proof.json`.
- `hosted-retry-and-sf.log`: successful corrected hosted cases and ordinary-control SF proof.
- `command-state-proof.json`: final control actions, exact tested head, displacement, water, accepted mode actors and empty error lists.
- `sf-gameplay.png`, `sf-mode-menu.png`, `sf-mode-active.png`: final clean gameplay/menu/match screenshots.
- `hot-desk-complete-first-person.png`, `hot-desk-complete-third-person.png`: completed campaign views copied from the archived run.
- `merge-audit.json`: base fix audit, unchanged application fingerprints and clean ancestry check.

## Scope limits and requests for other lanes

The renderer is stylized. Native GPU frame rate and AAA visual fidelity have not been established; full-view SwiftShader rendering is slow (SF median frame times around 1.6–2.2 seconds in the report-only probe). Default SF startup can exceed 30 seconds on software rendering; the parent's longer-window readiness check confirmed it advances without an application change. The ordinary-control capture used `radius=300&pr=1`; full-browser SF cases exercised default graphics settings. The host enables the implemented wave-4 campaign and two local modes. Advanced online lobbies, higher-wave finale content and unsupported mode providers remain gated.

No implementation request remains. Parent owns the final preview handoff. Feature work and QA stop after this completed gate.

## Draft pull request

Base: `integrate/wave2`

Head: `lane/input-aim/wave4`

Title: `Game: connect campaign, local matches, recorded aim and progression saves`

Body:

Connect the San Francisco renderer to the shared mission, combat and progression systems, with an accessible HUD, phone, vendor and mission dialogs. Add recorded mouse/gamepad aim and progression-only save/load, including recoverable autosaves and a persisted settlement ledger. Local Bot Sweep and Clean Streets run in isolated simulations, preserve the city on cancellation, and settle rewards once on explicit return.

Include the completed offline AI/private-relay service modules and physical admission, same-tick reward, mission-stage retry and building-footprint fixes identified by adversarial play-throughs. Consolidate published wave-2 ancestry after auditing its already-included fixes, preserving the exact tested application tree. Online lobby UI and higher-wave finale content remain gated. The renderer is stylized; this change makes no AAA visual or native-performance claim.

Validation: typecheck; 3,408 passing unit tests and one skip; production build; complete browser coverage (36 passes, 10 engine skips, one stale test assertion corrected with three passing hosted cases); successful actual Hot Desk → Spill campaign and deterministic replay; final SF driving/spray/local-match control proof with no page or console errors. Runtime source: `7a267e3`; full-browser head: `4a2c285`; corrected hosted/SF head: `33a6c34`; ancestry-only merge: `8465b98`. Detailed logs, screenshots and unchanged-tree proof are retained in the final evidence folder.

Compare link: https://github.com/BroderickHigby/fog-city/compare/integrate/wave2...lane/input-aim/wave4?expand=1
