# Lane 7: combined game integration and final QA

## Current candidate

Branch: `lane/input-aim/wave4`. Worktree: `/workspace/fog-city-aim`.

The verified application source is `7a267e3`. Browser-only follow-ups through `9df2432` add the canonical campaign driver, recorded-command replay, a wave-4 default matching the host, bounded traffic replanning, and temporary small-viewport Node planning. No application code changed in those follow-ups. The original `/workspace/fog-city` prototype remains preserved.

## Implemented

- Mounted HUD, objectives, GPS map, phone, vendor, mission dialogs, accessible controls, touch/gamepad navigation and the shared FreeTextBox safeguards.
- Connected the wave-4 campaign, combat, accepted actors, authored refill sources, weather/recovery, and source-only renderer improvements through the shared game-system composition.
- Added recorded mouse/right-stick aim shared by camera, spray, scan and Watch; modal transitions release held controls.
- Enabled local Bot Sweep and Clean Streets through the canonical isolated match runner. City state is preserved independently; cancel restores it, and explicit result return settles validated rewards once.
- Added progression-only versioned saves, IndexedDB slots and recoverable autosaves. Durable profiles, world progression and the settlement ledger survive capture/restore without serializing transient actors.
- Integrated the completed private relay and offline AI service modules. The browser host exposes local modes; it does not expose an online lobby.
- Applied the verified bus/vehicle admission, pedestrian clearance, durable mission-stage retry, and exact building-footprint combat fixes found by adversarial campaign testing.

## Verification

- On application source `7a267e3`: typecheck passed; 13 focused mission/admission/footprint checks passed; the complete unit suite passed **3,408 tests**, with **one skipped**, across **173 files**. Production Vite bundle built successfully (216 modules).
- Six earlier Chromium UI fixtures passed, covering signup, modal recovery, controls, IndexedDB and explicit autosave recovery. Later application fixes do not change those UI files.
- The ordinary-control SF proof on the preceding application source `d6fce5a` drove 4.401 metres, braked, exited, aimed, sprayed, opened Playlists and started Bot Sweep with 121 accepted actors. It recorded zero page or console errors. This proof is being refreshed on the final candidate.
- Final complete browser acceptance and refreshed SF screenshots are pending the independent campaign gate. Existing artifacts and logs are in `/workspace/visual-review/final/`; their recorded source hashes identify the exact run.

The first full run's two content failures were corrected and all 120 content/provenance checks passed. A later historical run encountered two 60-second timeouts during a scheduling stall; both files passed unchanged in a 26-test isolated retry. The final `7a267e3` full run above passed without retries.

## Scope limits

The renderer is stylized; native GPU frame rate and AAA visual fidelity have not been established. The host enables the implemented wave-4 campaign and two local modes. Advanced online lobbies, higher-wave finale content and unsupported mode providers remain gated.

## Draft pull request

Base: `integrate/wave2`

Head: `lane/input-aim/wave4`

Title: `Game: connect campaign, local matches, recorded aim and progression saves`

Body:

Connect the San Francisco renderer to the shared mission, combat and progression systems, with an accessible HUD, phone, vendor and mission dialogs. Add recorded mouse/gamepad aim and progression-only save/load, including recoverable autosaves and a persisted settlement ledger. Local Bot Sweep and Clean Streets run in isolated simulations, preserve the city on cancellation, and settle rewards once on explicit return.

Include the completed offline AI/private-relay service modules and the physical admission, mission-stage retry and building-footprint fixes identified by adversarial play-throughs. Online lobby UI and higher-wave finale content remain gated. The renderer remains stylized; this change makes no AAA visual or native-performance claim.

Validation: full typecheck, 3,408 passing unit tests (one skipped), focused mission/geometry checks, and production bundle build. Final complete browser results and the exact browser-fixture head will be filled in after the pending acceptance run; detailed evidence is recorded above and in the final artifact folder.
