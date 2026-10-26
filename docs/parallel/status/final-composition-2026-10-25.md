# Final candidate composition — 25 October 2026

This candidate combines the render/audio tranche, impacts and vehicle dynamics, citylife/conversion/natural-dodge behavior and multiplayer code on release base `889bef146ae16062f91ff42f5632940e916a2393`. All unreleased simulation behavior lands as one deliberate13→14 transition. The migration uses `upgradeDodgeOnFoot` for ongoing human/player dodges and preserves the optional damage, prop, ride, density and incident fields. Previously released fixture files remain unchanged; competing unpublished14 receipts are preserved under named variants.

Final composed14 and unchanged-input wave2-v14 checkpoints are recorded from this complete composition. Legacy replay pins also change because impacts, street-prop bodies, vehicle dynamics and natural dodge are now combined. Earlier branch pins remain in comments or named JSON receipts. The old v11-prefix payload equality assertion was removed: additive dodge velocity/profile fields and revised vehicle behavior mean that payload is intentionally no longer equal. Final14 hash equality, JSON round-trip determinism and migration/protected-body assertions remain enforced.

The [mission activities #76](https://github.com/BroderickHigby/fog-city/pull/76) and [#80 stack](https://github.com/BroderickHigby/fog-city/pull/80) are excluded from this production candidate. Their integration remains on local held branch `codex/fog-held-mission-final-20261025` at `d1382aff`. Plain Words lacks visible board geometry and current real-controls completion proof; other side-activity completions remain unverified. Coit is incomplete wave4 work. Demo Day remains explicit wave4 preview, defaultwave3.

Multiplayer source and loopback tests do not establish a hosted relay. No relay hosting, credentials or spend changes are made here. OSM landcover remains held pending the owner policy decision; icon-only DataSF storefronts do not require it.

Final-head typecheck and focused gates must be attached before release. No full browser verification or public production proof is claimed by this document.
