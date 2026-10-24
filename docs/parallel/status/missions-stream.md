# Missions stream status

Stream id `missions`. Scope: handoff §6 items 1 and 2, plus browser completions for the existing
wave-3 routes. Base: `origin/integrate/wave2` (`ff7db5b`, gameplay checkpoint `80a05c4`, `SIM_VERSION = 8`, `GAME_WAVE = 3`).

## Branches and PRs (one seam each; stacked where they share the activity reducer)

| PR | Branch | Seam | State |
| --- | --- | --- | --- |
| #74 | `work/missions/wave3-campaign-browser` | Launch Day / Demo'd Correctly drivers, long browser playthroughs, two-player session, curbside save spawn | Draft. First Launch Day browser session green (exact replay `b439bf4c`); v10 re-run in progress |
| #76 | `work/missions/activity-ui` (on #74) | Start side activities from the HUD; sprint and hill-delivery stops on real streets; hill-delivery browser playthrough | Draft; unit tests green |
| #77 | `work/missions/plain-words` (on #76) | Plain Words: boards, washing, spinners, `board.washed` | Draft; unit tests green; not winnable on foot until #44 (unlimited water) |
| #78 | `work/missions/office-hours` (on #77) | Ramen Office Hours: real `demo.robotPresented`; ramen-house marker removed | Draft; unit and composed real-demo tests green |
| #79 | `work/missions/search-and-park` (on #78) | Search & Park: physical legal stop, `parking.legalStop` | Draft; unit and real-SF legal-bay tests green |
| #80 | `work/missions/coit-recon` (on #79) | Coit Tower Recon producer at the design's wave four | Draft; unit tests green |

All are based on integrate/wave2 `86dfb90` (SIM_VERSION 10).

## Done (in branches, not merged)

- Launch Day completes in the real SF world in Node through real inputs only: drive, walk past
  gridlock, watch, scan, the false positive, compare, melt, pivot form. Result: scanner tier 2,
  `launch-day:complete` paid once, 0 protected contacts, 0 safety failures.
- Hill delivery completes in Node through real inputs once its stops are on real streets: walk,
  start at the marker, drop, Interact. Paid once, 0 contacts.
- Office Hours: a composed run with real staged robots, water and recorded answers pays the
  term-sheet outcome once per booking, across two bookings.

## Findings

- **Loaded saves spawned the car inside a block.** The restore put the car at the safehouse pin.
  The FiDi desk pin is 41 m from the nearest drivable lane, in a 2 m passage. Fix:
  `src/save/restore-spawn.ts` places the car on the nearest drivable lane, facing along it
  (one hook-up line in `src/main.ts`).
- **No UI started a side activity.** Nothing sent `activity-start`, so the "available" routes
  could not be played. Fixed on `activity-ui`: a non-modal panel offers the activity at its start
  marker and guides the running route.
- **Authored activity checkpoints were off the map.** Hand-placed lat/lon points were 50-170 m
  from the intersections their labels name:
  - The Embarcadero Sprint finish ("Mission Bay waterfront") was in China Basin, so the sprint
    could never finish.
  - Hill delivery's Hyde/Union and Lombard/Leavenworth stops were inside blocks.
  - Plain Words' Columbus/Bay point was 170 m off.
  - The Office Hours door was inside the Ramen house, and the Search & Park bay point was 34 m
    from any street.

  Each now sits on its road-graph junction (node ids in the commits). A real-SF test keeps every
  offered checkpoint on open ground within 25 m of a street.
- **Ambient traffic gridlocks permanently (motion layer, not missions).** `src/sim/motion.ts`
  `applyMotionBodies` vetoes a walker's step toward a vehicle, but the agents brain never learns
  of it: the walker stays in `go` with wait 0, its turnaround never fires, and the robotaxi waits
  for the person forever. Reproduced at (-620, 746), (-866, 625) and (-1169, -252), seed 1, wave 3.
  All 9 driving plans out of the FiDi desk stall. Reported to the coordinator for the World
  stream. Impact: Demo'd Correctly (which needs the car at Pier 70), the Embarcadero Sprint and
  Search & Park cannot yet be completed reliably in the browser. Launch Day, hill delivery,
  Plain Words and Office Hours can be done on foot.
- **Closing a dialog resumes the game clock.** The UI unpauses on close. A browser test that
  pauses and then closes the dialog lets the page run on while Node plans. The wave-3 spec now
  closes first, then holds.

## Decisions

- Wave-3 browser playthroughs start from a save holding Hot Desk and Spill as completed. It goes
  in through the save panel's own Import and Load buttons; every step after that uses real
  controls. Hot Desk is covered by `tests/e2e/campaign.spec.ts`; Spill is outside this stream.
- A save holds progression only, so a reload restarts the mission in progress. Rewards already
  granted (`rewardedIds`) are never paid again.
- Mission drivers that meet a jam first overtake when the road has room, then rewind and try
  another plan (traffic is deterministic, so only the plan that arrives stays in the recorded
  inputs), then walk where the mission allows any travel mode.
- Office Hours pays by outcome through its mission ($1,500 / $700 / $300, `docs/design.md`).
  The activity reward is zero, so a booking is never paid twice. Rewards are keyed per booking,
  so it repeats.
- The legacy `ramen-house` marker is removed. It was a second, generic start at the same door
  with no objective, and the design's Office Hours lives at that door as the `office-hours`
  activity.
- Coit Tower Recon is wave 4 in `docs/design.md` (Side activities), `docs/roadmap.md` (wave-4
  Sim-Player) and `docs/ai-layer.md` (the wave-4 Hallucination Tour bank). The `wave: 3` in
  `activity-rules.json` contradicts them. Planned: build the recon producer and tests, and set
  the activity to wave 4 so it stays hidden in the wave-3 game.
- Plain Words at the top of the ladder ("made by humans"): a rebrand counts as plain words, as
  the design says ("every rebranded board counts for the holdouts: the hype ate itself").

## SIM_VERSION

`PlayerActivities` gains two optional fields: `plainWords` (a run) and `parking` (legal-stop
progress). Both are additive; an older state simply lacks them. Before marking ready:
- merge `integrate/wave2`;
- take the next unused number (9 is reserved for the World stream);
- add the no-op upgrade step and fixtures.

## Blocked

- The agents/motion gridlock above: Demo'd Correctly browser completion, Embarcadero Sprint and
  Search & Park browser completions.

## Requests for Lane R

- Plain Words: a sandwich-board mesh that shows its current word (the ladder text in
  `content/activity-rules.json`) or plain words. A sign-spinner robot model; the spinners stage
  as `footman` bad robots for now. Board positions and headings are in
  `content/activity-rules.json` (`plainWords.boards`), and the run's state is in
  `state.ext.activities.players[id].plainWords`. Until then boards show only as minimap blips.
- Office Hours / Demo'd Correctly: the partners behind a rope line at the Ramen demo floor.
- Search & Park: painted bay outlines and "Street Cleaning" signs at the generated bays
  (`buildMissionParkingWorld` targets).
- Coit Tower Recon (wave 4): the coin-op viewer view and relay-object models.
