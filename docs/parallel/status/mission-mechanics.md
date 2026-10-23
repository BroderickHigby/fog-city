# Special mission mechanics

## Scope

Independent reducer under `src/sim/missions/mechanics/`, on `lane/mission-mechanics/wave3`.
Base: shared core `991aaff`, then player checkpoint `9c4cc8d`. No changes to the player
interpreter, core scheduling, renderer or original prototype.

## Implemented

- Legal parking: complete oriented car footprint and correct height inside an authorized bay;
  stationary accepted pose for 120 continuous ticks; driver nearby; fresh Interact input; source
  parking restrictions, weekday/time windows, overnight Street Cleaning, holidays, permits and
  paid-until coverage. Unknown regulation fails closed. Emits `demo.parkedLegally` once.
- Bell duel: authorized opponent/turntable request; player on foot and near the turntable;
  seeded 4–8-ring patterns; repeat timing within 7 ticks (116.7 ms); best of three. Holding input,
  late/missing rings and leaving the turntable cannot win. Emits `bell.duelStarted`, `bell.cue`,
  `bell.ring`, round outcomes, and exactly one `bell.duelWon` or `bell-duel.lost`.
- Both share one persisted fact sequence and produce `source: "world"`,
  `id: "mission-mechanics:<sequence>"`. `sequenceFloor` supports a central world allocator.
  No player-supplied completion command exists.
- Cable-car boarding: the player must be at an open running board on a stopped cable car.
  Recorded interaction creates a `boardingIntent`; it does not move the player or complete
  the objective. The fact `cableCar.runningBoardMounted` requires core to echo the exact accepted
  intent and the accepted player pose to match the vehicle's current board position. Missing,
  stale, rejected and wrong-vehicle attachments cannot complete it. Physical transit/attachment
  integration is being coordinated with Lane 3 and core; the reducer does not invent a bus body.

## Runtime handoff

Call `stepMissionMechanics(previous, input)` once per simulation tick using accepted car and
player poses, recorded `InputFrame`, authoritative active mission/cornering requests, world
parking bays/rules and game calendar. Persist the returned state in the owned mission state;
feed returned facts into the player interpreter. Submit `boardingIntents` to core's physical
attachment acceptance and return accepted records through the next tick's `cableBoarding` input.
The player lane is wiring this adapter.
Do not invoke separately for every subsystem, and do not derive requests from untrusted UI.
The bell state's `cues` and `responseTicks` expose fixed simulation times for audio/UI.

## Validation

Thirteen focused tests cover oriented footprint/elevation, overnight and holiday cleaning,
unknown/paid/permit restrictions, continuous stopping, stale-frame replay, held interaction,
best-of-three success/failure, late rings, distance, deterministic patterns, sequence floor,
and cable-car intent/acceptance/current-pose checks. The focused tests plus the repository
forbidden-API scan pass **71 tests**. Typecheck passes. All distances use explicit squared
arithmetic, headings use `dmath`, and the reducers remain pure plain-JSON state transitions.
No full browser/full-suite run is duplicated here.

## Draft pull request

Title: `Missions: verify parking, run bell duels and confirm cable-car boarding`

Base: `lane/sim-player/wave2`; head: `lane/mission-mechanics/wave3`.

Body: Add deterministic, world-driven completion producers for the partner-meeting parking
objective, bell duels and cable-car boarding. Parking uses accepted geometry and current restrictions, and the
duel measures a repeated bell pattern at simulation-tick resolution. Both use recorded
interaction edges and persisted event sequences, so holding input or replaying a completed
frame cannot create rewards. Boarding completes only after core confirms the matching physical
attachment. Player/core integration remains with the corresponding owners.
