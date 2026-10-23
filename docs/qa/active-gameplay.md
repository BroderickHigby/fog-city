# Active gameplay integration — 2026-10-23

This candidate continues `feature/campaign-hd` on `feature/active-gameplay`. It is not a production release. The inherited world gate remains blocking; no geometry baseline or threshold was relaxed.

## Changes and review scope

The candidate integrates PR #7, the #13–15 combat stack (including #19 pause support), #11 input/UI primitives and #20 private relay commands/aim. Conflict resolutions preserve current terrain support, gravity and pedestrian dodges; stronger existing network recovery tests remain. The dormant mode composition is not presented as a playable online mode. Full canonical agent/player/mission integration remains separate: those branches carry competing `ext.missions` ownership and older physical movement code.

Live controls now use the input aggregator and bounded, building-visibility-filtered aim assistance. Mouse drag/right-button pointer lock and controller right-stick aim feed recorded simulation inputs. The on-foot camera follows aim, Watch zooms, and a reticle provides visible robot/scan/rust feedback. Sound effects and narration unlock on a gesture; music has an independent radio mute. Reduced-motion users do not get speed-induced field-of-view changes.

Mission completion saves progression to IndexedDB. Validation rejects unknown fields, mismatched content/world, future simulation versions, nonsequential completions and unknown unlocks. Restoring starts fresh transient physics/combat; it does not restore projectiles or heat. Storage failure is nonfatal and visible. This is local completion checkpoints, not cloud saves or three manual profile slots.

High graphics adds private clear-coated car materials and a procedural marine-cloud layer. Shared source materials and geometry are preserved. Engineering references and remaining visual limitations are recorded in [the research notes](../research/active-gameplay.md).

Cross-lane edits were necessary for integration: input/audio/UI, rendering/main, mission aiming, persistence and harness tests. `SIM_VERSION` remains 6; optional recorded aim and PR event/resistance extensions are retained.

## Evidence

- Initial integration sweep: 252 tests passed across 24 files.
- Focused final sweep: typecheck passed; 475 tests passed across 53 files, including all ten campaign objectives, combat, pause, persistence validation, input/render and network recovery.
- Production build passed: 178 files, 182.1 MB; configured limits are 450 files and 240 MB.
- Browser checks passed: recorded mouse spray direction, checkpoint reload with fresh combat, and HD assets/all lighting presets without shader errors (3 tests).

The last source cleanup uses the exact building-intersection helper for aim filtering and releases mouse drag on focus/pointer-lock loss. The full regression/browser runs below include that cleanup. The campaign harness relocates between objectives, so it does not certify all SF driving routes. SwiftShader screenshots/test timing do not certify GPU performance.

## Release limits

The world/ballpark gate requires source-data access and regeneration, as documented in [the prior report](campaign-hd-integration.md). This environment has no configured paid speech credentials or publication target; no ElevenLabs recording or live deployment is claimed. Original CC0 music and browser speech fallback remain available. Contemporary AAA asset quality, every proposed mode, full mission cinematics, all-device input/accessibility and real-GPU performance remain work, not completed claims.

Fresh PR refs were fetched again during QA. #9 advanced to `b7a5fab` (measured navigation/population improvements); #21 advanced to `ee7b65e` (equipment/progression fixes and final handoff). Both remain deliberately unactivated pending the shared canonical-runtime migration. Their own handoffs identify missing consumers and do not claim a full release.

## Full regression result

The full Vitest run completed in 422 seconds: **3,557 passed, 91 failed, one skipped across 183 files**. All failures are in the same inherited release-blocking areas: 89 world-gate assertions and two missing-ballpark assertions. No unit failure was reported in the new aiming, checkpoint, UI, combat, pause, campaign or networking code. This is a red full-suite result, not a release certificate. The earlier 97 failures included six intake issues repaired in the previous integration; the remaining 91 are still open.
