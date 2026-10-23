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

## Runtime handoff

Call `stepMissionMechanics(previous, input)` once per simulation tick using accepted car and
player poses, recorded `InputFrame`, authoritative active mission/cornering requests, world
parking bays/rules and game calendar. Persist the returned state in the owned mission state;
feed returned facts into the player interpreter. The player lane is wiring this adapter.
Do not invoke separately for every subsystem, and do not derive requests from untrusted UI.
The bell state's `cues` and `responseTicks` expose fixed simulation times for audio/UI.

## Validation

Nine focused tests cover oriented footprint/elevation, overnight and holiday cleaning,
unknown/paid/permit restrictions, continuous stopping, stale-frame replay, held interaction,
best-of-three success/failure, late rings, distance, deterministic patterns and sequence floor.
Focused tests and typecheck are queued under `/tmp/fog.lock`; results will be recorded before
the completion checkpoint. No full browser/full-suite run is duplicated here.

## Draft pull request

Title: `Missions: verify legal parking and run timed bell duels`

Base: `lane/sim-player/wave2`; head: `lane/mission-mechanics/wave3`.

Body: Add deterministic, world-driven completion producers for the partner-meeting parking
objective and bell duels. Parking uses accepted geometry and current restrictions, and the
duel measures a repeated bell pattern at simulation-tick resolution. Both use recorded
interaction edges and persisted event sequences, so holding input or replaying a completed
frame cannot create rewards. Player/core integration remains with the corresponding owners.
