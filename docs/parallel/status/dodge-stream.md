# Dodge stream status

Stream id `dodge`. Branch `work/dodge/natural` (from `integrate/wave2` `ff7db5b`). Coordinator: session_012u6jdJxkY41mYkqG3yG9Xk.

## Diagnosis (done; evidence in `docs/shots/dodge-stream/before/`)
- **Sim:** a dodging person "dives" at 9 m/s (13.5 m/s when scrambling). It reaches full speed in one tick (measured peak acceleration 500–1,600 m/s²) and hops 0.45 m. A chasing car re-aims the dive every tick, and a redirect keeps the hop near its peak, so the body hovers 0.4–0.45 m above the ground for over a second while gliding sideways (`before/14.json`, `strip-14.png`). Even a car at 6 m/s triggers the 9 m/s, 0.45 m-hop dive (`before/motion.json`).
- **The override is not the cause:** 0 overrides in the 11 real-city soak runs and in the 160 fuzz scenes. It is drawn as a hop of up to 2 m, but it barely fires.
- **Rendering:** ambient people are the procedural placeholder from `src/render/person.ts` (rigid limbs swung by a walk gait). They play **no** clips. The dive is that body translated plus the sim's hop in y, with the walk swing still running. The player on foot is the Rocketbox `generic-player.glb`, which has only idle/walk/run. **The Mixamo clips on `assets/mixamo-raw` are not loaded, retargeted or played anywhere.** The VAT humanoid crowd in `public/models/humanoid-vat*` (it has a `dive` clip) is also not wired into the game.

## Plan / progress
- [x] Measurement: `tests/sim/dodge-motion.ts` (per-tick speed, acceleration, lift, leaps), the report `tests/sim/dodge-motion-report.ts`, browser strips `tests/e2e/dodge-stream.capture.ts`.
- [~] Sim v10: on-foot dodge (≤4.8 m/s, 6 when scrambling; 7 m/s² acceleration, late lunge 28; 0 lift; look-ahead 1–2.5 s; the body faces its run). Real-city soak: 166 dives, 2 overrides, 0 contacts. **Blocked:** the adversarial fuzz shows 22.9% overrides against its <5% bound (see Questions).
- [ ] Render: Rocketbox phase clips for the player (turn/startle, run_fast, run_stop, dust-off recovery); phase-driven procedural crowd (run gait matched to speed, lean, stumble).
- [ ] After-evidence, tests, PR.

## Questions for the coordinator
- **Fuzz override share (sent 2026-10-23):** at human speeds, a perfect-pursuit car (lateral grip 18 m/s², up to 38 m/s) forces the override in about 23% of fuzz dives. Only ~9 m/s lunges get under 5%. I recommend changing the bound for pursuit scenes and keeping contacts at 0. Waiting on the decision.

## Version
SIM_VERSION **10** (9 is reserved for the World stream). `upgradeState` takes v8 and v9 straight to v10. When World's v9 lands, the chain becomes 8→9 (world) then 9→10 (dodge). Only the dodge fields change; the World stream should keep the `version === 9` branch going to the dodge step.

## Assets the owner should download
None so far. The Rocketbox clips come from the pinned upstream (MIT).
