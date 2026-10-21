# Fog City — roadmap

The wave plan after wave 1. `docs/design.md` says what the game is; this file says what gets built
in which order. Each wave has parallel tracks with disjoint ownership, concrete deliverables and
acceptance tests. The most playable, most valuable things land first, and the territory grows
every wave. Every new district arrives with something to do in it.

Sizes: **S** ≈ one agent session, **M** ≈ 2–4 sessions, **L** ≈ 5+ sessions or a split.

## Rules for every wave
- `pnpm verify` is green before anything is called done. Tests never hit the network (loopback
  servers inside a test are allowed).
- A wave is done when its per-PR acceptance tests pass in CI, its nightly tier has passed on the
  wave-close commit, **and** the user has played its "playable result" on real hardware and
  reported `?bench=` numbers. A playable result that needs a deployed server counts as done on
  two browsers over localhost or LAN until the hosting decision (below) is made; the online part
  is then marked "pending hosting".
- Every wave adds `?bench=<new district>` and keeps `?perf=1` working.
- **Interface PR first.** Day one of every wave is one PR from Sim-World with the wave's `ext` key
  types, event kinds (for example `robot.melted`, `update.interrupted`, `player.down`) and stub
  systems registered in the area `systems.ts` files. This PR is the one allowed exception to
  ownership: it may create or edit the stub `systems.ts` file in each area directory, including a
  new area's first one. Once it merges, each area track owns its own `systems.ts` again and builds
  against the stubs. Sim events carry ids, enums and integers only.
- **Contract changes** (`src/sim/contract.ts`, `schemas/tile-*`) are additive and are called out in
  the report. Docs never hard-code a version number: a wave bumps to "the next `SIM_VERSION`",
  whatever the current one is. Every bump adds an `upgradeState` step and a test that loads a
  recorded log from the previous version and replays it.
- **Deterministic drivers, not open-loop logs.** Mission, soak and replay tests drive the game
  with closed-loop policies (input = f(state, world)) in `tests/helpers/drivers/`, which re-plan
  from state, so a tuning change does not break them. Per-PR tests assert outcomes (melts, mission
  complete, minimum clearance). Golden state hashes live in `tests/golden/` and are regenerated
  with `pnpm golden:update`; the sim track whose change moved them commits the new files in the
  same PR, and Harness pins them at wave close.
- **Two test tiers.** Per PR: at most 50 seeds with wider bounds, at most 4 clients × 2 minutes,
  and short soaks. Nightly: the full 1,000-seed suites, long soaks and large-client netcode runs,
  sharded, outside `pnpm verify`. Rates that would need thousands of long sims (streaks) are
  measured per event from about 50 full sims, then checked by a cheap Monte Carlo over the points
  table (100k draws).
- **Safety tests run every wave from wave 2:** the vehicle–person clearance soak, the no-touch fuzz
  test (water never reaches an animal, a child, or a person who is seated, lying down or using a
  mobility aid), and the renderer-attached-vs-headless hash test. Each wave that adds a vehicle, a
  mode or a player role adds a clearance driver for it.
- **Content lint** (lexicon, real brands, real people, punch-down terms, font fit) and the
  waypoint-inside-shipped-tiles test run on all content. From wave 2 the brand and person
  deny-lists include "YC", "Y Combinator", real accelerator partner names, "Modern Warfare" and
  "Call of Duty", and their streak and loadout terms ("Scorestreak", "Killstreak", "Field
  Upgrade", "Tacticals") anywhere in content, and their mode names ("Domination", "Hardpoint") in
  mode and item names. In-game names use Hype streaks, gear and gadgets. The parody accelerator is
  **Ramen**. From wave 2 every invented proper name must be in `content/cleared-names.json`
  (searched before use, `design.md` Legal and taste). The AI notice's "(Anthropic's API)" is an
  intentional, listed exemption: a legal disclosure, not branding (`docs/ai-layer.md`).
- **Territory coverage.** Each wave's Sim-Player track ships at least one activity in that wave's
  new territory step, and its Content track ships a district content pack (see `docs/ai-layer.md`)
  for each new district, including one bounty template set with a local tell.
  `tests/content/territory-coverage.test.ts` checks that every shipped district has at least 1
  activity marker, at least 1 bounty template, and a safehouse or garage within 1.5 km (`design.md`
  lists every safehouse and garage by wave; the wave-1 districts are covered from wave 2 by the
  FiDi coworking desk, the Marina garage and the Mission Bay garage). The areas
  where `design.md` allows no mode instance (the excluded areas: the Tenderloin, Civic Center/UN
  Plaza, the 6th St corridor, the Division St / 13th St corridor) are exempt from the activity and
  bounty-template counts and must have no mode instance. A bounty in any protected area is a single
  robot from the baseline population, as `design.md` says.
- **The world-continuity gate gates every territory step and wave.** No territory step and no
  wave merges until both hold (`docs/qa/world-continuity-gate.md`):
  - the gate passes: the per-PR world suites are green with no metric worse than its baseline in
    `tests/golden/world-qa-baseline.json`, the nightly tier (`pnpm world:nightly`) has passed on
    the candidate, and the screenshot tour (`pnpm tour`) has been reviewed and signed in the QA
    note;
  - no verified blocker, high or medium world defect (`docs/qa/world-qa-status.md`) is open: each
    is fixed, with its id flipped to `fixed` in the baseline so its acceptance test is a hard
    assertion from then on.

  After each round of fixes the world is audited again (the six dimensions and a completeness
  critic) until an audit finds nothing new; new findings join the baseline and the tour.
- **Budgets gate every territory step.** Each tile is at most about 1.5 MB on disk; the shipped
  world, the boot collider bytes and the far-LOD layer each have a total in
  `tests/pipeline/budgets.json`. A step does not merge while any budget test fails.
- **Names shown to other players** (lobby nameplates from wave 4, leaderboard entries from wave 5)
  are built from the generated name parts or pass the server-side content lint. No free-text or
  voice chat is scheduled; wave 5's report, mute, block and age gate are its prerequisites if it is
  ever added.

## Decisions the user makes
| Decision | Needed before | Default if undecided |
|---|---|---|
| Tile storage: plain git with compression (current), Git LFS, or a versioned release artifact | only if a budget in `tests/pipeline/budgets.json` is exceeded | **Decided 2026-10-20: plain git, compressed** (see the design decision log) |
| Hosting for the relay: provider, region, monthly budget, who holds the credentials | wave 4 online play | wave 4 closes on localhost/LAN, online pending |
| The user's own Anthropic key as a server secret, and a Console spend limit | wave 6 live AI | scripted versions only |
| Model per runtime route and Trust & Safety option A or B (see `docs/ai-layer.md`) | wave 6 | Opus, option B |

## Ownership
From wave 2 the Sim and Render areas split into tracks with disjoint directories, and new areas
are added. `CLAUDE.md` carries this table; change both together.

| Track | Owns |
|---|---|
| Pipeline | `pipeline/`, `public/tiles/sf/` (incl. `roads.json`), `docs/data-sources.md`, `tests/pipeline/` |
| Render-World | `src/render/`, `src/main.ts`, `src/debug.ts`, `src/io/` (asset layer, world loading), `src/env.d.ts`, `index.html`, `vite.config.ts`, `scripts/build-web.ts` (the static build), `public/tiles/dev-city/`, `tests/render/`, `tests/io/` |
| UI-Audio | `src/ui/`, `src/audio/`, `src/input/`, `tests/ui/` |
| Sim-World | the files directly in `src/sim/` (`contract.ts`, `step.ts`, `index.ts`, the top-level `systems.ts`, `dmath.ts` and the other shared files; additive changes to `contract.ts` only: bump to the next `SIM_VERSION` and say so in the report), `src/sim/vehicles/`, `src/sim/fog/`, `src/sim/clock/`, `tests/sim/world/` and the files directly in `tests/sim/` |
| Sim-Agents | `src/sim/agents/`, `src/sim/robots/`, `tests/sim/agents/` |
| Sim-Combat | `src/sim/combat/`, `tests/sim/combat/` |
| Sim-Player | `src/sim/player/`, `src/sim/heat/`, `src/sim/missions/`, `src/sim/economy/`, `src/sim/progression/`, `src/sim/activities/`, `tests/sim/player/` |
| Sim-Modes (from wave 4) | `src/sim/modes/`, `src/sim/bots/`, `tests/sim/modes/` |
| Content | `content/` (except `landmarks.json`), `src/content/`, content `schemas/`, `tests/content/` |
| Assets | `assets/blender/`, `assets/audio/`, `public/models/`, `public/audio/`, `content/landmarks.json`, `tests/assets/` |
| Harness | `tests/e2e/`, `tests/helpers.ts`, `tests/helpers/`, `tests/golden/`, `playwright.config.ts`, `vitest.config.ts`, `.github/`, `scripts/bench/`, `scripts/golden/` |
| Server-Net (from wave 4) | `server/net/`, `server/main.ts`, `server/deploy/`, `src/net/`, `tests/net/`, `tests/server/net/` |
| Server-AI (from wave 6) | `server/ai/`, `tests/server/ai/` |

- **Systems.** Each sim track registers its systems in its own `src/sim/<area>/systems.ts`. The
  top-level `systems.ts` (Sim-World) only imports those lists in a fixed order and changes only
  when an area is added. Each system owns one `ext` key. The one exception to this ownership is
  the Sim-World interface PR on day one of a wave, which may create or edit the stub `systems.ts`
  in every area (see the rules); after it merges, each area track owns its file.
- **Golden files** in `tests/golden/` are Harness-owned but regenerated by `pnpm golden:update` in
  any sim PR that changes behaviour (see the rules).
- **Render split.** UI-Audio is testable under SwiftShader through `window.__fogcity`, so the
  GPU-dependent work stays in Render-World and goes to the user for review.

## Wave 1 (in progress)
Real SF tiles (downtown and North Beach, Embarcadero north, the Marina, Dogpatch); the renderer;
vehicle handling and on-foot; content (bot tells, billboards, storefront types, the pitch mission
JSON); Blender assets (Ferry Building, R-Evolution, car,
robotaxi, errand robot, sidewalk bot, Muni bus); CI and e2e.

**Agent scope, stated honestly:** robotaxis and cars follow lanes on the road graph. Robots and
people walk on offset road edges as a placeholder, because the sidewalk graph arrives in wave 2.
Wave 1 contract work (car handling fields, `FootState`, `ext.agents`) may land as the next
`SIM_VERSION`.

**For wave-2 branches: the static `World` changed in the citywide integration** (SimState and
`contract.ts` did not; `SIM_VERSION` stays 2). `world.grid` (string keys) and `world.bounds` (a
Map per building) are gone: use `nearbyBuildings`, or `world.cells` (numeric `cellKey`) with
`world.cellBoxes` (bounding boxes, 4 numbers per building). Ground goes through `groundHeight`
(tile-indexed, `world.tileGround`). `world.walls` holds the edge, shore and road-over-water walls
(`src/sim/boundary.ts`: two-sided, with `onWater` and `inCorridor`); `resolveBox` and
`resolveCircleAll` take the body's start-of-tick pose so walls act on motion. Recorded sf
replays from before these walls diverge (the world changed, not the state format).

## Wave 2 — Bot Hunt is a game
**Playable result:** start at the Ferry Building, drive to a bounty, read a bad Porter's tells,
scan it, spray it, watch it seize, slump and melt, survive its friends at threat 1–2, escape, get
paid, and spend the money on a bigger tank. Missions 1–2. Muni buses with AI ads run on real
routes. Dogpatch is reachable by road.
**Territory:** step 3 (SoMa, Mission Bay, Rincon Hill, the Bay Bridge approach) plus the 3rd St /
King St connector.

| Track | Deliverables | Size |
|---|---|---|
| Pipeline | **First:** a data spike that records each dataset's id and licence in `docs/data-sources.md` (hydrants, fountains, sidewalks, crosswalks and signals, turn restrictions, car-wash and kiosk anchors, Muni routes and stops, and for wave 3 cable car track, parking regulations and Street Cleaning schedules), with a procedural fallback for each: hydrants at intersections about every 120 m, crosswalks and signal phases at every arterial node, sidewalks offset from road edges, stairs as walk-only edges, and no turn bans (the GPS then respects one-ways only). No OSM-derived (ODbL) data is committed unless the licence check passes. **Second:** the sidewalk navigation graph per tile. Then: tile storage (decided 2026-10-20: plain git, compressed); meshopt or Draco plus quantisation; source snapshot dates pinned in `pipeline/areas.json`, so a refresh is a deliberate PR; tile and world budgets in `tests/pipeline/`; step-3 tiles; the connector so the road graph joins the Ferry Building to Pier 70; citywide far-LOD massing (every footprint, decimated); hydrant and fountain points; Muni route and stop geometry inside the built tiles; the Bay-edge refill polygon and the sea-wall collider; deck profiles for the step-3 bridges (the Lefty O'Doul drawbridge on 3rd St) from a hand-authored overrides file; car-wash and repair-kiosk anchor points | L |
| Sim-World | The interface PR; the next `SIM_VERSION` (aim yaw and pitch; actions `gadget`, `cone`, `interact`, `streak`, `emote`, `watch`, `altFire`) with its `upgradeState` step; the additive tile-collider schema change (`decks`, `tunnels`, `movable`) with `surfaceHeight(x, z, yHint)` replacing the ground lookup; the world-collider choice in `design.md` (a compact binary citywide collider, preferred, or deterministic paging) with an indexed tile lookup; `src/sim/clock/` (tick to game time, weekday, game week and month on a seeded calendar); a `fogDensity(world, state, x, z)` interface that returns 0 until wave 3; the vehicle steering follower in `src/sim/vehicles/` with pursue, intercept, park-across-lane and stuck/reverse recovery modes | M |
| Sim-Agents | Migrate people and robots to the sidewalk graph; the bad-robot brain (`disguised` / `wary` / `alerted` / `attack` / `flee`) with the knowledge model and goal tables; good-robot and people reactions; the person-clearance override and collision layer; fidelity radius with deterministic handoff; minimal animal agents (pigeons, leashed dogs) so the no-touch test has subjects; Moat Labs vans that answer `threat.spawn` (dispatched from Moat Labs HQ or a depot, entering the fidelity radius about 120 m from the player, driven by the steering follower and bound by the person-clearance override); ambient Muni buses on timetabled routes inside the built tiles, wearing ad-inventory wraps (falls back to a hand-picked road-graph loop if the route data fails its licence check) | L |
| Sim-Combat | Water particles; refills (hydrant, fountain, Bay edge, salt); rust (rates, drying rule, partial-rust effects); the melt state machine; heaps (a heap clears when it leaves the fidelity radius until Tidy arrives in wave 3); attacks: shove, grocery snatch, ad blast, The Handshake, forced update; the Traffic Cone as a base item (the `cone` action: thrown 8 m on foot or from the car window at any speed; a cone on a rule-obeying vehicle's hood pulls it over within 3 s; blinds a bad robot for 3 s); wrong-target outcomes (good robot limps to a kiosk, person gets wet); no-touch removal for animals, children, and people who are seated, lying down or using a mobility aid; Bot Check scan and ping | L |
| Sim-Player | Runway, cash, reputation; DOWN ROUND; threat levels 1–2 with decay, car wash and line-of-sight rules (threat requests units by emitting `threat.spawn{kind, count}`); a vendor at the FiDi coworking desk selling 2 tank tiers, 1 flow tier and burritos for runway; FiDi coworking safehouse (save, sleep); the Marina garage (east end of Marina Blvd, toward Fisherman's Wharf) and the Mission Bay garage (save, car repair) for the 1.5 km rule; bounty board; mission runtime (`trigger`, `goto`, `timer`, `dialogue`, `branch`, `reward`); missions Hot Desk (with the coworking sign-up's "What are you building?" step, which records a `StartupDefined` kit id) and Spill; the Ambient Director (one card within 150 m after 45–75 s with no objective); coning (the activity); the repair-kiosk apology tour; one activity in step 3 (delivery shifts on SoMa's flat blocks; the hill shifts follow in wave 3) | L |
| Render-World | Water stream, splashes, wet decals, puddles; rust shader and slump shape-key playback; heap prop; instanced humanoids playing vertex-animation clips; buses with wraps; aim camera; the Watch zoom and path trail | L |
| UI-Audio | HUD (runway, cash, tank, salt, threat); ad-blast overlay; minimap with the GPS line on the road graph; phone shell with Map, BotBounty and Bot Check; the vendor screen; aim assist and touch controls for spray, scan, watch, cone and interact; the `FreeTextBox` component (the only way typed text enters the game) with the client crisis check, length caps and deny-list gates, and the lint that forbids raw text inputs elsewhere; the coworking sign-up form; `?perf=1` overlay | M |
| Content | **Audit first:** every wave-1 content, id, mission and asset file for "YC", "Y Combinator", the orange Y mark, real partner names and Modern Warfare / Call of Duty terms, renamed to Ramen and invented names, and those strings added to the deny-lists. **Name search before the wave-2 content freeze:** a trademark and company-name search (run in an agent session with web access, outside the tests, and signed off by the user) for every invented name in use, Moat Labs, Meander, Clout, FogCast, Marine Layer, Bramblecot Home, Dry Powder and Brackish among them, each recorded with its date and source in `content/cleared-names.json`; a name that fails is renamed; then the lint rule that rejects an invented proper name missing from that file. Then: `bot-tells.json` to ≥ 24 tells and 6 archetypes, with false tells; `robot-goals.json`; 300 shared robot barks (good apologies, bad growth-hack taunts), 100 wet barks, plus district packs; shared bounty templates; district content packs for every shipped district (steps 1–3); 40–60 hand-written director cards (`content/director-cards.json`); missions Hot Desk and Spill; vendor prices; SoMa billboards and bus wraps; the content lint library in `src/content`; the crisis phrase list and crisis lines; `[ai-02]` startup kits (~200, the fallback for every refusal), the keyword matcher and the name composer with `banned-pairs.json` | M |
| Assets | **Humanoid line (L):** one parametric scripted-Blender humanoid (a shared rig, 6–8 body variants as shape keys, tint slots) with a clip library (walk, idle, dive, wet shake, sit, talk), baked to vertex-animation textures for instancing, with headless Cycles turntable renders for the user to review; it is also the player's on-foot body. Animals (pigeons, a leashed dog) as static-pose or 2-frame instanced meshes. **Props line (M):** hydrant, fountain, blaster prop, three heap variants, repair kiosk, traffic cone, vendor cart, the Moat Labs van (graphite, teal accent, original design); slump shape keys for Porter and Trundle; spray, splash, rust creak and melt fizz sounds | L + M |
| Harness | Closed-loop drivers in `tests/helpers/drivers/` (hunter, escaper, mission runner, chaser, competent player); `pnpm golden:update`; golden replays for three Bot Hunt scenarios; the clearance soak (chase, jump and no-brake drivers, with Moat Labs vans and buses in traffic: zero vehicle–person contacts, clearance ≥ 0.75 m); the renderer-attached hash test; a cross-browser determinism e2e (Playwright replays one seeded 2-minute run in Chromium, Firefox and WebKit under software rendering and compares per-second state hashes with Node), a required check from this wave on; the nightly workflow; e2e `?world=sf&scenario=spill`; `scripts/bench/` with `?bench=embarcadero` and `?bench=soma` | M |

**Acceptance tests**
- The hunter driver melts at least 3 bad robots within 10 game minutes on each of 3 pinned seeds,
  and the state hash at the last tick matches the pinned golden file.
- A good robot under the full starting stream for 1.5 s (0.25/s, so rust about 0.375: past 0.3,
  short of seizing) does not seize and walks to a repair kiosk; reputation drops by 5 and cash
  by $50.
- At threat 2 a Moat Labs van brings 2 units within 20 s, entering about 120 m from the player.
- A cone thrown from the car at 25 m/s onto a robotaxi's hood stops it within 3 s.
- A forced update completes in 6 s unopposed and is interrupted when the pusher reaches rust 0.2.
- No water particle ever reaches an animal, a child, or a person who is seated, lying down or
  using a mobility aid (fuzz over seeded scenes: 50 per PR, 1,000 nightly).
- Scan accuracy over 10,000 seeded scans is within ±2% of the table for each subtlety.
- Buying tank tier 1 changes the tank capacity in sim state and costs the listed price; a burrito
  restores the listed runway.
- The road graph routes the Ferry Building to Pier 70 in ≤ 5.5 km.
- The steering follower leaves no AI car stuck for more than 10 s (2 minutes of seeded traffic
  per PR, 30 minutes nightly).
- Per-second state hashes match across Node, Chromium, Firefox and WebKit for the 2-minute run.
- A recorded wave-1 log loads through `upgradeState` and replays.
- `fogDensity` returns 0 everywhere; the clock maps a table of known ticks to the expected time,
  weekday and game week.
- Every tile is within budget, and no `*.glb` is stored outside the chosen tile storage.
- The content lint fails on fixtures containing "YC", "Y Combinator", "Modern Warfare" and
  "Scorestreak", on a mode named "Domination", and on an invented proper name missing from
  `content/cleared-names.json`, and passes on the audited wave-1 content.
- At least one bus with an ad wrap passes the Ferry Building every 10 game minutes.
- `window.__fogcity` shows a `heap` within 30 s of the Spill driver's start in e2e.
- From each of 20 seeded start points, the Ambient Director stages an encounter within 150 m
  within 60 s.
- A seeded drive over the 3rd St bridge keeps y above 3 m, and nothing enters open water.
- Each `FreeTextBox` fed crisis phrases shows the sincere line, and no parser, comic line or
  network call runs; no raw text input exists outside `FreeTextBox`.
- Every composed two-part startup and player name passes the content lint or is in
  `banned-pairs.json`, and the composer never returns a banned pair.
- Territory coverage passes for every shipped district.

## Wave 3 — Heat, missions and the hills
**Playable result:** the full heat ladder to threat 5; ad drones overhead and a rogue robotaxi
boxing you in; VC associates chase you and a bell duel at Powell & Market decides your fate; ride a
cable car up Nob Hill; missions 3–4 including the Ramen interview with its live demo, and your
scripted startup on a billboard and a bus before you reach Dogpatch; the King tide; side
activities on the hills.
**Territory:** step 4 (Russian Hill, Nob Hill, Chinatown, Telegraph Hill, Lombard).

| Track | Deliverables | Size |
|---|---|---|
| Pipeline | Step-4 tiles; cable car line geometry and stops (Powell–Hyde, Powell–Mason, California), source and licence from the wave-2 spike; crest candidates for jumps across built tiles; parking regulations and Street Cleaning schedules for Search & Park (sign text reads "Street Cleaning", data ids use `street_cleaning`) | L |
| Sim-World | The interface PR; the fog module replaces the `fogDensity` body (district density, seeded weather by hour, rain in winter weeks); the King tide event (salt puddles everywhere, bad robots avoid the waterfront); cable cars on rails; scooters and e-bikes; robotaxi hail and commandeer, refused while anyone else is aboard | L |
| Sim-Agents | The flying agent type (ad drone: hover at 6 m, follow, line of sight); rogue robotaxi box-in using the steering follower; Patrol units with Terms of Service; swarm; car theft of an empty parked car to a Moat Labs depot, and recovery; VC associates on scooters and in cars; Tidy hauling heaps and restore from backup at repair kiosks; sign-spinners; the 3 a.m. firmware freeze; the Tuesday siren | L |
| Sim-Combat | Phone hack; window spray; running-board spray; fog rust and fog sight effects; rain rust and rain and King tide puddle refills; ad-drone rust rate | M |
| Sim-Player | Threat 3–5 (spawn requests for drones, box-in, Patrol units, swarm); VC attention, cornering, bell duel, the Bridge Round, ACQUI-HIRED; coffee; missions Launch Day (grants Bot Check tier 2; the "...and it also spots bad robots" pivot) and Demo'd Correctly (Search & Park leg, the first Ramen Office Hours with its scripted interview and live demo, and the reveal of the mission-1 startup kit on the Embarcadero billboard and on a bus that passes the mission-4 route); Ramen Office Hours as a repeatable activity at the Ramen house (booked on the phone, at most twice a game day, rewards by outcome); Daily Standup (a 5-minute date-seeded Bot Hunt and its result grid); side activities: rogue robotaxi on the run, SF-Bench public routes (4), Backseat Prompt Rally (local phrase table), Plain Words, Oranges down Filbert, Lombard races, delivery shifts on the hills; the Russian Hill garage for the 1.5 km rule | L |
| Render-World | Day/night lighting; per-district fog volumes; rain; night glow; cable cars; canvas-text billboard and bus-wrap slots fed by kit ids; ad drones; Tidy | L |
| UI-Audio | Phone apps Ride, Radio, FogCast, Messages; the Meander support bot in Ride (a scripted keyword bot behind `FreeTextBox`, registered in its box registry); VC stars HUD; bell duel UI; scripted interview UI (multiple choice) and Office Hours booking; the Daily Standup result grid; radio text ticker with music playback | M |
| Content | Scripted interview bank (Metrics One, Philosopher, Vibes Partner), demo script and Office Hours outcome emails; the shared tagline bank; VC DMs; radio ticker v1 (Dry Powder); FogCast lines; Meander personality reviews; the Meander support bot's keyword table and replies; Plain Words boards and ladder; SF-Bench routes and headlines; 150 more shared people lines; district content packs for step 4; missions 3–4 | M |
| Assets | Cable car, Patrol unit, ad drone, Tidy, sign-spinner, sandwich boards, rogue-robotaxi decals, associate scooter and car, Coit Tower, Grace Cathedral, the Lombard crooked block hedges; bell, foghorn and cable hum sounds | L |
| Harness | Mission drivers for missions 1–4; Chinatown no-state-change test; Plain Words area test; fog-perception tests (sight range at density 0, 0.5, 1); a cable-car clearance driver (car beside a cable car with riders on the running board); `?bench=nob-hill` | M |
| Save-Profile | `src/save/`: the `SaveStore` interface; the private-page storage backend (each person's saves and profile in their private page storage) and the IndexedDB cache/fallback; save format = progression only, stamped with `SIM_VERSION` and the content bundle hash, loaded through `upgradeState`; safehouse save (3 slots), autosave after missions and every 5 game minutes; export/import with confirmation; profile v1 (generated display name, settings, lifetime stats); the **playable link**: build and publish the game as the private page, republished on every wave close | M |

**Acceptance tests**
- The escaper driver brings threat 3 to 0 in under 90 s by entering fog; the same route in sun
  takes longer.
- Bell duel: a perfect input sequence always wins; an all-late one always loses.
- The interview's 1,000 fixed seeds land a 30–50% pass rate on the scripted path (a pure state
  machine, cheap enough per PR); the demo step passes only when the bad robot is called and no
  partner gets wet.
- A player can commandeer only an empty robotaxi or one they ride alone; a robotaxi with anyone
  aboard never turns rogue; car theft only ever takes an empty parked car.
- Every Office Hours outcome completes mission 4 and pays its listed reward.
- On the mission-4 driver, the scripted startup is on the Embarcadero billboard and on a bus the
  player passes before reaching Dogpatch.
- During a King tide, salt refills work at puddles and no bad robot paths within 30 m of the Bay
  edge *(tune)*.
- At 03:00:10 game time no good robot in North Beach is moving.
- Missions 1–4 complete on their drivers; every mission waypoint lies inside the tiles shipped by
  its wave.
- The Meander support bot's `FreeTextBox`, fed crisis phrases, shows the sincere line and runs no
  keyword parser, comic line or network call.
- Every dataset the pipeline reads has an id, licence and pinned snapshot date.
- Territory coverage and budgets pass.

## Wave 4 — Progression, loadouts and streaks, and online co-op
**Playable result:** earn XP and ranks, buy upgrades, tune your car at Pier 70, customise your
character, choose a loadout and call streak rewards; recruit robots; Conference Week fills SoMa;
play Bot Sweep with up to 3 friends (online if hosting is decided, otherwise two browsers on
localhost or LAN).
**Territory:** step 5 (the Presidio, the Golden Gate Bridge approach, Pacific Heights, Cow Hollow).

**Before this wave:** the user decides hosting (see "Decisions the user makes").

| Track | Deliverables | Size |
|---|---|---|
| Pipeline | Step-5 tiles; Presidio forest roads; the Fillmore and Lyon St grades | M |
| Sim-World | The interface PR; Microclimate-as-a-Service (a local fog sphere); gripman controls; the air-show rehearsal and Fleet Week events on the clock (an invented jet team on a fixed path over the water off the Marina, ambient only) | S |
| Sim-Agents | Recruits (follow and spot); the parrot flock; Conference Week density (lanyard crowds, bad density ×1.5) | M |
| Sim-Combat | Gadgets (water balloon, sprinkler, decoy speaker; the cone is already a wave-2 base item); gear (Rubber Boots, Airplane Mode; Microclimate-as-a-Service is Sim-World's); the trunk tank and the Roof Cannon; streak reward effects (Confidence Score, Buzzword Parrots, Tensor Brick Drop, Blimp Impressions, Open Hydrants, AGI Achieved) | M |
| Sim-Player | XP, ranks and gates; blaster upgrades; perks with the per-mode table; loadouts; streak points for free roam; safehouse purchase (the North Beach studio, the Dogpatch loft, the Marina flat); the Presidio garage; the vibe-coded bench; Doom Clock, faction contracts, AGI Achieved and AI Winter events; Conference Week alongside mission 5's convention center; missions 5–7; the step-5 activities (Stair Watch on the Lyon St steps and the Presidio forest-road SF-Bench route); the Fleet Week Pitch Window on Marina Green; Coit Tower Recon, Mother Dough Run, Term Sheet Jumps, Muni shifts (ride and drive the wave-2 buses), Human in the Loop, Robotaxi Choir, Scenic Route, Tensor Brick Run, All Fleeced Up; scripted Explain It to Your Mom (after the bus reveal; its clarity token carries into Office Hours); the phone Pivot action (3 a day, $500 or a VC star each) | L |
| Sim-Modes | Match framework (own SimState, carry-in and carry-out rules, results); Bot Sweep rules (instance, Update Relay, lives, revive); Bot Sweep instances only outside the excluded areas | M |
| Server-Net | Relay: invite-only lobbies with codes that expire after 30 minutes and cap at 4 players; server-ordered inputs; client rollback in `src/net/`; headless server sim with per-second hash checks and snapshots; join and leave as recorded `SimEvent`s; display names from generated name parts or passing the server-side content lint; no chat message types; deploy config (a container plus a health check, no secrets in the repo); the netcode test | L |
| Render-World | Blimp, parrot flock (instanced), pallet drop; the jet team flypast; Coit viewer view; remote players; the Elizabeth Homes silhouette in the western fog on foggy nights (foreshadowing; out of reach) | M |
| UI-Audio | Loadout and upgrade screens; streak call UI; Mom in Messages and the phone Pivot action; lobby UI and generated-name picker; nameplates above other players (name, rank badge, team colour, distance fade, occlusion fade; hidden for disguised players; opt-in claude.ai first name on the private page); the manual character customizer (enum lists for hair, outfit and tint, frozen at wave close so the user's offline avatar script can map to them) | L |
| Content | `streaks.json`, perks, gadgets, XP table, upgrade prices; faction contracts (8, inside built tiles); Doom Clock headlines; Conference Week lines; pivot cards; bench prompt cards; Coit guide lines (Hallucination Tour) and the cofounder bank; the scripted Mom bank; streak and announcer lines; missions 5–7; humblebrag posts; name-part lists for player names; district content packs for step 5; customizer enum lists | M |
| Assets | Blimp (invented livery), the jet team's aircraft (original design, invented livery), parrots, Tensor Brick pallet, sprinkler, water balloon, decoy speaker, Palace of Fine Arts, Golden Gate Bridge approach (legal checklist), safehouse interiors (simple), customizer hair and outfit meshes on the wave-2 rig; a low-detail Elizabeth Homes silhouette for the fog foreshadowing (the full boss is wave 8) | L |
| Harness | Perk test (every perk changes a sim output in every enabled mode); streak rate measurement and Monte Carlo; a 2-player Bot Sweep clearance driver (one car, one teammate on foot); e2e: two browser contexts join one Bot Sweep lobby; `?bench=presidio` | M |
| Save-Profile | Profile v2: the character customizer settings, achievements and the avatar saved to the profile; cross-device continuity tests (save on one browser context, load on another); **private co-op over the page's live messaging** for Bot Sweep between invited players (non-authoritative; the Server-Net relay remains the path for public and competitive play); a save-migration test that loads a wave-3 save | M |

**Acceptance tests**
- Bot Sweep: a 2-player driver run completes on 3 districts; the timer loss fires at 12:00.
- The 2-player Bot Sweep clearance driver runs with zero vehicle–person contacts and clearance
  ≥ 0.75 m.
- No Bot Sweep instance intersects an excluded area.
- Tuning: "Make it faster" changes top speed and brakes; the clearance soak still passes with it.
- Streaks: per-event point rates measured from about 50 ten-minute free-roam sims of the competent
  driver (nightly); a 100k-draw Monte Carlo over the points table (per PR) shows the first streak
  reward in ≥ 50% of sessions and AGI Achieved in > 0% and < 2%.
- A recruit is targeted by a forced update within 60 s in a seeded crowd scene.
- Netcode: headless clients and the server over loopback with 100 ms injected jitter keep
  identical hashes (2 clients × 2 minutes per PR; 4 clients × 10 minutes nightly).
- The server rejects a display name not built from name parts that fails the lint, rejects any
  chat message type, refuses a 5th player, and refuses a lobby code older than 30 minutes.
- The server container builds and its health check answers on localhost in CI.
- The customizer's enum lists validate against their schema and are frozen in the wave-close tag.
- Territory coverage and budgets pass.

## Wave 5 — PvP and Clean Streets
**Playable result:** Clean Streets solo against rival-founder bots and online; flowers in hair;
photo spots and Bubble Relics; scripted Customer Discovery; public rooms with report, mute,
block and an age gate.
**Territory:** step 6 (Hayes Valley, Civic Center, the Tenderloin, the Western Addition, Alamo
Square, Haight-Ashbury), with no mode instance in the areas `design.md` keeps free of them.

| Track | Deliverables | Size |
|---|---|---|
| Pipeline | Step-6 tiles | M |
| Sim-World | The interface PR | S |
| Sim-Combat | The blaster's flower alt-fire (the wave-2 `altFire` action, PvP modes only: one slow lob every 1.5 s, 20 m; hits put flowers in hair; no rust, no knockback, never hits an NPC) | S |
| Sim-Modes | Rival-founder objective planner (reuses the wave-2 steering follower); Clean Streets (solo against bots, and online team race); the PvP streak table | L |
| Sim-Player | Photo spots (the Painted Ladies at Alamo Square, a step-6 activity, and the Palace of Fine Arts); Bubble Relics; scripted Customer Discovery (the North Beach baker, the Marina dog walker, the Washington Square chess player) and its three local bounty chains (the baker's bad-Trundle crew in North Beach); the Octavia Blvd bounty chain, the other step-6 activity (Trundle crews on the side lanes; crews spawn only in Hayes Valley, outside every protected area); the Hayes Valley micro-unit for the 1.5 km rule, plus a plain garage wherever the coverage test still finds a district out of range | M |
| Server-Net | Rooms up to 8; a simple matchmaking queue; global Doom Clock and faction tally; SF-Bench and Daily Standup leaderboards with server re-simulation of each submitted run, under the name rule; report, mute, block; invite sign-up accounts with the age attestation (used by rooms, and by live AI routes from wave 6); age gate before rooms with strangers | L |
| Render-World | Flowers in hair; spectator camera | S |
| UI-Audio | Scoreboards; Clean Streets HUD; report, mute and block controls; age gate screens; leaderboard screens | M |
| Content | Mode text and faction announcer lines; Clean Streets text; discovery cast deck; diligence memo bank; the ambient director deck to ~100 cards; district content packs for step 6 | M |
| Assets | City Hall dome, Painted Ladies facade set, the flower alt-fire mode on the wave-2 blaster prop (one asset: a flower hopper and its alt-fire state) | M |
| Harness | Clean Streets bot soak; PvP clearance drivers (a car at a rival on foot, on a scooter, on a cable car running board); PvP e2e; `?bench=alamo-square` | M |

**Acceptance tests**
- Clean Streets bot soak: matches finish in time, no bot is stuck for more than 10 s, and each
  side wins 25–75% over 50 seeds per PR and 35–65% over 1,000 seeds nightly.
- The three PvP clearance drivers run with zero vehicle–person contacts and clearance ≥ 0.75 m.
- No Bot Sweep or Clean Streets instance intersects an excluded area.
- The leaderboard rejects a tampered run and a name that breaks the name rule.
- Matchmaking refuses a player without the age attestation; mute and block take effect in e2e.
- Territory coverage and budgets pass; no mode instance lies in an excluded area, and every bounty
  in a protected area is a single baseline robot.

## Wave 6 — Runtime AI v1, the Mission and Potrero, Fog Royale
**Playable result:** with the user's key on the server, type freely in the Ramen interview, name
your own startup and see it on a billboard and a bus, and explain it to Mom; play Fog Royale solo
against 7 bots, the weekly Fog Front, and Fog Royale with 8 people; ride an e-bike up the
Mission's hills with a burrito.
**Territory:** step 7 (the Mission, the Castro, Noe Valley, Twin Peaks, Sutro Tower) and step 9a
(Potrero Hill, Bernal Heights, Bayview, Hunters Point).

| Track | Deliverables | Size |
|---|---|---|
| Pipeline | Step-7 and step-9a tiles, each gated on the budgets; 22nd St and Twin Peaks crests | L |
| Sim-World | The interface PR; the Fog Front boundary in the fog module | S |
| Sim-Modes | Fog Royale solo (always 5 phases, crates, Bridge Round, duel redeploy) against 7 bots; the Fog Front event; the Royale streak table; as territory lands, the area the front covers and the final-circle landmarks grow, never the phase count | L |
| Sim-Player | AI verdict events wired to the existing scripted outcomes; Foil Integrity; Term Sheet Jumps on new crests; the Twin Peaks photo spot; one activity each in steps 7 and 9a; the Mission flat and the Potrero Hill garage for the 1.5 km rule, plus a plain garage wherever the coverage test still finds a district out of range | M |
| Server-AI | The AI proxy (key as a server secret; one fixed route per feature; closed schemas); sign-in with server-issued sessions on the wave-5 accounts; the 401 and 403 tests; transcript retention and the notice; Trust & Safety gates; GPU allocation meter; routes: freestyle interview, One-Sentence Startup, live Mom | L |
| Server-Net | Fog Royale online for 8 on the wave-5 rooms | M |
| Render-World | Fog front boundary and local fog spheres; live kits on the wave-3 billboard and bus-wrap slots | M |
| UI-Audio | Typing UI, "typing..." states, GPU allocation meter, Royale HUD | M |
| Content | Recorded fixtures (great answer, buzzword soup, injection, refusal, each deny-list category); eval cases; Royale crate and announcer text; district content packs for steps 7 and 9a | M |
| Assets | Sutro Tower, Twin Peaks summit, Dolores Park palms, Fleece and cloud-credit crates | M |
| Harness | Network-blocked AI tests; fixture contract tests; the proxy refuses a route with no recorded eval pass; Royale bot soak; `?bench=mission` | M |

**Acceptance tests**
- No AI test reaches the network; every live route falls back to its scripted outcome on timeout,
  refusal or a malformed reply.
- The proxy refuses to load a route with no recorded eval pass.
- A live request without a valid server-issued session gets a 401, and a free-text request from an
  account without an 18+ attestation gets a 403, both with no model call. A transcript expires
  within 24 h and never reaches disk.
- The content lint passes the AI notice, whose "(Anthropic's API)" is a listed exemption (a legal
  disclosure, not branding), and fails "Anthropic" in any other content string.
- Royale solo: matches end, no bot is stuck for more than 10 s, and win shares stay in band (50
  seeds per PR, 1,000 nightly).
- Royale online: 8 clients keep identical hashes (2 minutes per PR, a full round nightly).
- Territory coverage and budgets pass for steps 7 and 9a.

## Wave 7 — The west side, Hide in the Crowd, Royale for 24
**Playable result:** the fog heartland; play as a robot in Hide in the Crowd, solo against 3
rival-founder Spotters and online; missions 8 and 9, with mission 9 at night on the Great Highway;
Fog Royale for 24.
**Territory:** step 8 (Golden Gate Park, the Richmond, the Sunset, Ocean Beach).

| Track | Deliverables | Size |
|---|---|---|
| Pipeline | Step-8 tiles | L |
| Sim-Agents | Robot-body player controller (gait, burst tell, emotes) reusing the robot gait code; merged fidelity radii for 24 players | L |
| Sim-Modes | Hide in the Crowd: a solo variant (you hide while 3 rival-founder bots spot, using the knowledge model) and the online mode (players disguised as bad robots among real ones), on the `design.md` instance list | M |
| Sim-Player | Mission 8 (Acqui-hire Offer, played in a robot body) and mission 9; Ocean Beach side activities; the Sunset in-law unit for the 1.5 km rule, plus a plain garage wherever the coverage test still finds a district out of range | M |
| Server-Net | Royale for 24 | M |
| Server-AI | Live Customer Discovery classifier route | M |
| Render-World | The west-side fog look at night | M |
| UI-Audio | Hide in the Crowd emote wheel and task list | S |
| Content | Hide in the Crowd tasks; missions 8 and 9; district content packs for step 8 | M |
| Assets | Conservatory of Flowers, windmills, Sutro Baths ruins, charging dock | M |
| Harness | Hide in the Crowd bot soak; mission drivers for 8 and 9; `?bench=sunset-fog` | S |

**Acceptance tests**
- Royale for 24 opens only when the sim budget test holds with 24 anchors, or the server does
  interest management.
- 24 headless clients hold identical hashes (4 × 2 minutes per PR; 24 × 15 minutes nightly,
  sharded).
- No Hide in the Crowd instance intersects an excluded area.
- Hide in the Crowd solo: the bot Spotters find a still player within the round and miss a player
  who copies the crowd's routine in a share of seeds that stays in band *(tune)*.
- Missions 8 and 9 complete on their drivers.
- Fog rust melts an exposed robot in the Sunset at night in the expected time.
- Territory coverage and budgets pass.

## Wave 8 — The rest of the south, the finale, Vibes Night
**Playable result:** the whole city is drivable; the finale against Elizabeth Homes, the ~500 m turtlenecked robot colossus, from the Golden Gate to the Bay Bridge;
the ferry to Treasure Island; a Vibes Night party room online.
**Territory:** step 9b (the Excelsior, Glen Park, West Portal, Lakeshore, Visitacion Valley and the
rest), the Bay Bridge deck and Treasure Island.

| Track | Deliverables | Size |
|---|---|---|
| Pipeline | Step-9b tiles, the bridge deck, Treasure Island, each gated on the budgets | L |
| Sim-World | The ferry | M |
| Sim-Agents | The Moat Walker (threat 5); the final boss state machine (footfall route, weak points with rust, evacuation waves that clear every footfall zone, shed robots) | L |
| Assets | Elizabeth Homes: the giant boss model with LODs, joint rig and weak-point nodes; damaged-building chunk sets for the stomp route; the fireboat | L |
| Render-World | Boss rendering at 500 m scale (far plane, LOD, footfall shockwave and dust), scripted facade destruction, the overnight rebuild time-lapse | M |
| Sim-Player | Mission 10; one step-9b activity; the step-9b garages for the 1.5 km rule | M |
| Sim-Modes | Vibes Night party room (named apart from mission 5, Demo Day): 2–8 players present their startup kits, each plays a 90 s live demo in the mission-4 format (scored by the sim), they hear roasts, vote for the Vibes Award, keyed-hash tie-break; its own mode JSON; template roasts first | M |
| Server-AI | Live Vibes Night roasts route (one call per kit, fallback to templates) | M |
| Server-Net | Vibes Night rooms on the wave-5 room server | S |
| Content | Template roasts; mission 10; district content packs for step 9b | M |
| Assets | Moat Walker, ferry, Bay Bridge hero geometry | L |
| Harness | Citywide `?bench=` pass; whole-city clearance soak (nightly); a Vibes Night driver for headless test clients (presents a kit, plays the mission-4 demo, votes) | M |

**Acceptance tests**
- A driver goes from Ocean Beach to Treasure Island.
- Mission 10 completes on its driver.
- The clearance soak runs on the whole city with zero contacts.
- A Vibes Night room of 8 headless clients run by the Vibes Night driver completes (no
  rival-founder bots); a tied vote resolves the same way on every client.
- Territory coverage and budgets pass for the whole city.

## Later
South San Francisco (needs a data source and a licence check); Alcatraz by ferry; Demo Unit (M),
Last Outlet (M), Hype Cycle party mode (M), The Incumbent (M); WeFloat as a pier-rail hold with
static instanced sea lions (M); the portrait booth (runtime, only if players ask); photo mode;
replays and a shareable Melt Cam.

## Mode costs at a glance

| Mode or system | Size | Wave | Needs a server |
|---|---|---|---|
| Steering follower (pursue, intercept, park across, recover) | M | 2 | No |
| Match framework | M | 4 | No |
| Bot Sweep | M (+ server L) | 4 | Online only |
| Rival-founder objective planner | M | 5 | No |
| Clean Streets | M | 5 | Online only |
| Plain Words | S | 3 | No |
| Daily Standup | S | 3 | Leaderboards only (wave 5) |
| Fog Royale solo + Fog Front | M + M | 6 | No |
| Fog Royale online 8 | M | 6 | Yes |
| Hide in the Crowd (solo and online) | M + M (robot-body controller) | 7 | Online only |
| Fog Royale 24 | L | 7 | Yes |
| Vibes Night party room | M (+ roasts route M) | 8 | Yes |
| Hype Cycle, Demo Unit, Last Outlet, The Incumbent | M each | Later | Online only |
