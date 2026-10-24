# Player feel stream (`player-feel`)

Owner playtest of `integrate/wave2` (`ff7db5b`): horn silent, walking too slow / no run,
no mouse-drag camera, cannot ride robotaxis. One PR per item, in order.

| # | Item | Branch | PR | State |
|---|---|---|---|---|
| 1 | Horn | `work/player-feel/horn` | pending | tests green locally |
| 2 | Sprint and walk speed | `work/player-feel/sprint` | — | next |
| 3 | Camera drag | `work/player-feel/camera` | — | — |
| 4 | Robotaxi ride | `work/player-feel/robotaxi` | — | — |

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
