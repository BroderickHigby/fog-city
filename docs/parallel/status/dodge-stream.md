# Dodge stream status

Stream id `dodge`. Branch `work/dodge/natural` (from `integrate/wave2` `ff7db5b`). Coordinator: session_012u6jdJxkY41mYkqG3yG9Xk.

## Diagnosis (done; evidence in `docs/shots/dodge-stream/before/`)
- **Sim:** a dodging person "dives" at 9 m/s (13.5 m/s when scrambling). It reaches full speed in one tick (measured peak acceleration 500–1,600 m/s²) and hops 0.45 m. A chasing car re-aims the dive every tick, and a redirect keeps the hop near its peak, so the body hovers 0.4–0.45 m above the ground for over a second while gliding sideways (`before/14.json`, `strip-14.png`). Even a car at 6 m/s triggers the 9 m/s, 0.45 m-hop dive (`before/motion.json`).
- **The override is not the cause:** 0 overrides in the 11 real-city soak runs and in the 160 fuzz scenes. It is drawn as a hop of up to 2 m, but it barely fires.
- **Rendering:** ambient people are the procedural placeholder from `src/render/person.ts` (rigid limbs swung by a walk gait). They play **no** clips. The dive is that body translated plus the sim's hop in y, with the walk swing still running. The player on foot is the Rocketbox `generic-player.glb`, which has only idle/walk/run. **The Mixamo clips on `assets/mixamo-raw` are not loaded, retargeted or played anywhere.** The VAT humanoid crowd in `public/models/humanoid-vat*` (it has a `dive` clip) is also not wired into the game.

## Plan / progress
- [x] Measurement: `tests/sim/dodge-motion.ts` (per-tick speed, acceleration, lift, leaps, pull-ups), the report `tests/sim/dodge-motion-report.ts`, browser strips `tests/e2e/dodge-stream.capture.ts`.
- [x] Sim v10 (`d6654fd`): on-foot dodge at ≤4.8 m/s (6 when scrambling), 7 m/s² acceleration (late lunge 28), braking to a stop on the spot, 0 lift, look-ahead 1–2.5 s, body faces its run. Straight-at-person drives at 6–30 m/s: 0 overrides, p99 acceleration 7 m/s². Real-city soak: 0 contacts, overrides within bounds.
- [x] Player avatar: real clips in `public/models/generic-player-dodge.glb` (612 KB, Rocketbox sprint/runStart/runStop/recover plus Mixamo stumble/flinch retargeted onto the Rocketbox rig). Played by dodge phase and time-scaled to the sim's speed.
- [x] Crowd (procedural placeholder): stride lengthens with speed (no foot sliding); run swing and lean measured off the Rocketbox clips; startle, stumble and recover poses.
- [x] Tests: motion bounds, v8 mid-dodge upgrade fixture, v10 re-pins (old fixtures kept), player-body clip binding, crowd poses.
- [ ] **Blocked:** `dodge-fuzz.test.ts` (override share ~24% against <5%, plus 4–6 sub-0.75 m passes in pursuit scenes) and the rival run in `dodge-soak.test.ts` (5 sub-0.75 m passes at ticks 919–923, pursuit). Waiting on the coordinator's decision (see Questions).
- [ ] After-evidence (`docs/shots/dodge-stream/after/`), e2e, PR.

## Not done / honest notes
- Ambient people are still the procedural placeholder (rigid limbs). They now move like people, but they play no skinned clips. Real clips for the crowd need the skinned or VAT crowd wired in (`public/models/humanoid-vat*` exists but is unused). That is Lane R's renderer work; I recommend it as a follow-up.

## Version
SIM_VERSION **10** (9 is reserved for the World stream). `upgradeState` takes v8 and v9 straight to v10. When World's v9 lands, the chain becomes 8→9 (world) then 9→10 (dodge). Only the dodge fields change; the World stream should keep the `version === 9` branch going to the dodge step.

## Assets the owner should download
None so far. The Rocketbox clips come from the pinned upstream (MIT).
