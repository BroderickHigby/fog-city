# Dodge stream status

Stream id `dodge`. Branch `work/dodge/natural` (from `integrate/wave2` `ff7db5b`). Coordinator: session_012u6jdJxkY41mYkqG3yG9Xk.

## Diagnosis (done; evidence in `docs/shots/dodge-stream/before/`)
- **Sim:** a dodging person "dives" at 9 m/s (13.5 m/s when scrambling). It reaches full speed in one tick (measured peak acceleration 500–1,600 m/s²) and hops 0.45 m. A chasing car re-aims the dive every tick, and a redirect keeps the hop near its peak, so the body hovers 0.4–0.45 m above the ground for over a second while gliding sideways (`before/14.json`, `strip-14.png`). Even a car at 6 m/s triggers the 9 m/s, 0.45 m-hop dive (`before/motion.json`).
- **The override is not the cause:** 0 overrides in the 11 real-city soak runs and in the 160 fuzz scenes. It is drawn as a hop of up to 2 m, but it barely fires.
- **Rendering:** ambient people are the procedural placeholder from `src/render/person.ts` (rigid limbs swung by a walk gait). They play **no** clips. The dive is that body translated plus the sim's hop in y, with the walk swing still running. The player on foot is the Rocketbox `generic-player.glb`, which has only idle/walk/run. **The Mixamo clips on `assets/mixamo-raw` are not loaded, retargeted or played anywhere.** The VAT humanoid crowd in `public/models/humanoid-vat*` (it has a `dive` clip) is also not wired into the game.

## Coordinator decision (2026-10-23): option A, with conditions
- The fuzz's override bound becomes per driver: 0 for straight; at most 25% for each pursuit driver (chase, weave, drift, handbrake, random and **bank**: approved).
- Fix the close passes. Overrides read as human: no lift, a drawn speed bound, and a test for both.
- List every test change in the PR body under "Test spec changes". Add the design.md decision-log entry (done).
- SIM_VERSION: integrate/wave2's current version + 1 at ready time. Release #67 brought integrate to 13, so dodge is **14**, and its upgrade is written as 13→14.

## Plan / progress
**PR #61** (draft, `work/dodge/natural` into `integrate/wave2`).
- [x] Measurement and evidence tooling (`tests/sim/dodge-motion*.ts`, `tests/e2e/dodge-stream.*`, `docs/shots/dodge-stream/make-strips.py`).
- [x] Sim v14: on-foot dodge (≤4.8 m/s, scramble 6; 7 m/s² acceleration, lunge 28; no lift; look-ahead 1–2.5 s; facing follows the run).
- [x] Tuned to the coordinator's bounds. Fuzz, 160 seeds: 847 dodges, 58 overrides (6.8%, down from ~24%):

  | Driver | Overrides / dodges | Share |
  | --- | --- | --- |
  | chase | 37/294 | 12.6% |
  | bank | 9/201 | 4.5% |
  | weave | 5/127 | 3.9% |
  | drift | 3/84 | 3.6% |
  | handbrake | 2/44 | 4.5% |
  | random | 2/76 | 2.6% |
  | straight | 0/21 | 0 |

  Unexplained close passes: 0. Real-city soak: 0 contacts, `nobrake` 0 overrides, 0 overrides from robotaxis.
  The two changes that mattered: the override prefers a spot clear of the path by the margin (no repeat overrides in a chase), and a car predicted into a wall widens its footprint.
- [x] Override drawn as an eased shove aside: ≤6 m/s on screen, no lift.
- [x] Player clips (`public/models/anim/dodge-clips.glb`) and the crowd set for Lane R (`public/models/anim/crowd-clips.glb`). Provenance: `assets/imports/rocketbox/clips.json`.
- [x] Typecheck; full vitest (165 files, 3,367 passed, 1 skipped).
- [ ] After strips (capturing), full e2e, local evidence comment on #61. Kept as a draft while GitHub Actions is blocked (coordinator).

## Interface for Lane R (skinned crowd), stable
- **Clips:** `public/models/anim/dodge-clips.glb` (dodge) and `public/models/anim/crowd-clips.glb` (16 varied walks and idles: `walkStroll`, `walkSlow`, `walkFast`, `walkCool`, `jog`, `walkCasual`, `walkTexting`, `idleBreathe`, `idleTexting`, `idleWaiting`, `idleHappy`, `idleLookAround`, `idlePhone`, `idleArguing`, `wave`, `clap`; walk speeds in `sourceSpeedMps`). Skeleton-only Rocketbox `Bip01` rig (the same bone names as `generic-player.glb`; three.js binds by name). Clips: `sprint`, `runStart`, `runStop`, `recover` (Rocketbox, MIT) and `stumble`, `flinch` (Mixamo, retargeted). Each clip's `sourceSpeed` (m/s) is in the root node's extras `clips` JSON; sprint is 5.84.
- **`src/render/human-motion.ts`:**
  - `motionFor(speed, dodge, have) → Motion`. `speed` is the drawn horizontal speed, whichever way the body moves; `dodge` is `AgentState.dodge` / `FootState.dodge` (a full `DodgeState`); `have(m)` says whether a clip loaded.
  - `MOTIONS` and `ONCE` (the clips to play once and hold).
  - `leapDrawOffset(dodge, alpha, out)`: the offset to add to the sim position while an override leap is drawn.
- **Speeds:** run is time-scaled by speed over `runSpeedMps` and sprint over its `sourceSpeed`, clamped as in `player-body.ts`. A dodging agent's `speed` is along its facing; use the drawn displacement for gait.
- The crowd near tier is yours; the procedural fallback poses (`dodgePose`, `strideFor`) stay in `person.ts`.

## Not done / honest notes
- Ambient people are still the procedural placeholder (rigid limbs). They now move like people, but they play no skinned clips. Real clips for the crowd need the skinned or VAT crowd wired in (`public/models/humanoid-vat*` exists but is unused). That is Lane R's renderer work; I recommend it as a follow-up.

## Version
SIM_VERSION **14** on top of integrate's 13 (59e5a7b, release #67). The upgrade step is `upgradeDodgeOnFoot(s, 14)`, run from version 13. Fixtures: `legacy-saves/v8-mid-dodge.json` (a real v8 save mid-dodge), `composed-v14.json` and `wave2-v14.json`. Every older fixture is kept. `crowd-humans.ts` `add()` now takes an optional `dodge` (Lane R told, 2026-10-24). CI is billing-blocked; PR #61 stays a draft with local evidence (comment of 2026-10-24).

## Assets the owner should download
None so far. The Rocketbox clips come from the pinned upstream (MIT).
