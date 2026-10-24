# Missions stream status

Stream id `missions`. Scope: handoff §6 items 1 and 2, plus browser completions for the existing
wave-3 routes. Base: `origin/integrate/wave2` (`ff7db5b`, gameplay checkpoint `80a05c4`, `SIM_VERSION = 8`, `GAME_WAVE = 3`).

## Done

- (none merged yet)

## In progress

- `work/missions/wave3-campaign-browser`: closed-loop drivers (`tests/helpers/drivers/wave3-campaign.ts`)
  for Launch Day and Demo'd Correctly in the real SF world, then browser playthroughs on `?world=sf`.

## Findings

- **Loaded saves spawned the car inside a block.** The restore put the player's car at the safehouse
  pin. The FiDi desk pin is 41 m from the nearest drivable lane, in a 2 m passage between buildings,
  so the car could not drive out after loading a save. Fix: `src/save/restore-spawn.ts` places the
  car on the nearest drivable lane, facing along it. `src/main.ts` changes by one line (hook-up).
- **No UI starts a side activity.** Nothing in `src/ui` or `src/main.ts` sends `activity-start`, so
  `embarcadero-sprint` and `hill-delivery` are reachable only through sim tests today. Planned: an
  activity prompt/objective UI as a new `src/ui` file, plus a small `main.ts` hook-up.

- **Ambient traffic gridlocks permanently in the real SF world (agents, not missions).** Seed 1, on
  the drive from the FiDi desk toward Washington Square, measured in Node with the production step:
  - At about (-866, 625), one-way edge `c12318002`, three robotaxis sit in `wait` forever. Person
    517 stands at speed 0 in `go` mode, 1.4 m from the lead taxi, and never moves. Measured for
    6,000 ticks.
  - At about (-1169, -252), edge `c6399000`, robotaxis wait in every direction at an intersection,
    with frozen pedestrians beside them.
  - Another jam appears on the FiDi to Embarcadero/Harrison drive near (-627, 750).

  A player can sometimes drive or walk around these jams, so the mission drivers overtake when the
  road has room, back off and re-plan, or walk (Launch Day allows any travel mode). The deadlocks
  themselves belong to the agents system and are not fixed here. Request: agents owner to add
  deadlock release (a waiting pedestrian or taxi yields after a bounded wait).

## Decisions

- Wave-3 browser playthroughs start from a save slot holding Hot Desk and Spill as completed. The
  slot goes in through the save panel's own Import and Load buttons, and from there every step uses
  real controls. Hot Desk is already covered by `tests/e2e/campaign.spec.ts`. Spill is outside this
  stream's scope.
- A save holds progression only, so a reload restarts the mission in progress. Rewards already
  granted (`rewardedIds`) are never paid again.

## Blocked

- (none)

## Requests for Lane R

- (none yet)
