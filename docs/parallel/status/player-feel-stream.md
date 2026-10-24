# Player feel stream (`player-feel`)

Owner playtest of `integrate/wave2` (`ff7db5b`): horn silent, walking too slow / no run,
no mouse-drag camera, cannot ride robotaxis. One PR per item, in order.

| # | Item | Branch | PR | State |
|---|---|---|---|---|
| 1 | Horn | `work/player-feel/horn` | #31 | **merged** (batch 1, #42) |
| 2 | Sprint and walk speed (v11) | `work/player-feel/sprint` | #40 | draft; local full e2e 40/40, vitest green; CI blocked by Actions billing |
| 3 | Camera drag orbit + hill clip | `work/player-feel/camera` | #48 | draft; vitest green, camera/avatar/dev-world specs pass; CI blocked by billing |
| 4 | Robotaxi hail and ride (v12) | `work/player-feel/robotaxi` (stacked on #40) | #58 | draft; vitest green, robotaxi spec passes; full e2e running; CI blocked by billing |

## 1. Horn
Diagnosis: H / pad L3 already set `Action.horn`, and the sim already reacts (people and good
robots within 40 m `startle` then step away; bad robots learn your position by hearing, per
`docs/design.md`). What was missing: any sound, a touch button, and anything visible.

- `src/audio/horn.ts`: `hornBlasts(frame, state)` reads the horn from the exact input frame the
  sim stepped (keys, pad, touch, and other players' frames), `HornVoice` synthesizes a two-tone
  car horn (pocket air horn on foot) with Web Audio, fading to silence at 60 m. No sample file;
  the Audio stream (PR #28) can swap in a recorded cue behind the same hook.
- `src/main.ts`: plays every blast after each `step`; unlocks on the first gesture.
- `src/render/runtime-actors.ts`: startled or glancing actors are drawn facing the source
  (render only; sim heading and hashes unchanged).
- `src/ui/touch.ts`, `content/ui-copy.json`: a Horn touch button.
- Tests: `tests/sim/agents/horn.test.ts` (sim startle + audio hook + drawn facing),
  `tests/e2e/player-feel.spec.ts` (real H key in SF: tones start, people react).

## 2. Sprint (SIM_VERSION 11)
W jogs at 3.0 m/s; Shift (held, `Action.sprint`) + W sprints at 7.0 m/s, with a quick ramp and a slower turn.
Space and pad LT still sprint. There's no stamina rule (design.md has none). The first jogs after getting
out show "Hold Shift to sprint". The Controls menu gains a Shift row. Chain: 8 → 10 (weather) → 11.

## 3. Camera
Mouse click-hold-drag, one-finger drag on touch, and the pad's right stick orbit the chase camera. It eases
back behind you 1.2 s after the input stops while you move. Render only. Hill clip root cause: a fully
occluded pull-in ended the arm 1.6 m behind the car's centre, inside its body. Fixed with a 3.6 m minimum
arm, rising over the target instead, an arm that follows the pitch, and a roof guard.

## 4. Robotaxi rides (SIM_VERSION 12)
F hails a passing empty taxi within 20 m (it waits 10 s); F beside a stopped one hops in. A phone-map
waypoint becomes a recorded `ride.destination` event; the taxi drives there and you step out, or F stops it
and you step out. The own car stays parked. An occupied taxi is `occupied` to combat, so it pulls over and
you step out. Commandeering is a follow-up.

## Blockers
- GitHub Actions is not starting jobs ("recent account payments have failed or your spending limit
  needs to be increased"). This is repo-wide; the owner needs to fix billing. PRs can't be marked ready
  until CI runs green.
- Stuck taxis behind a stalled errand robot in the road (City-life's area).
