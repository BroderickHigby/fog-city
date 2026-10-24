# Testing Fog City

Everything here runs without a GPU and without the network. Browsers render with
SwiftShader (software WebGL), so browser tests check behaviour through
`window.__fogcity` and never assert frame rate.

## Run it

```sh
pnpm install
E2E_PORT=4196 pnpm verify     # typecheck + unit tests + e2e: the bar for "done"

pnpm typecheck                # tsc --noEmit
pnpm test                     # Vitest: tests/**/*.test.ts
E2E_PORT=4196 pnpm e2e        # Playwright: tests/e2e/*.spec.ts
E2E_PORT=4196 pnpm shots      # screenshots -> test-results/shots/index.html
E2E_REQUIRE=all E2E_PORT=4196 pnpm e2e   # after integration: absent prerequisites fail, not skip
pnpm build                    # the static web build for hosting -> dist/ (see "Static web build")
```

One file or one test: `pnpm exec vitest run tests/sim`, `E2E_PORT=4196 pnpm e2e dev-world`,
`E2E_PORT=4196 pnpm e2e -g "wall"`, `E2E_PORT=4196 pnpm e2e --project chromium`.

`pnpm shots` is the `package.json` script `playwright test --config tests/e2e/shots.config.ts`;
if a checkout lacks the script line, run `E2E_PORT=4196 pnpm exec playwright test --config
tests/e2e/shots.config.ts` instead.

### The E2E_PORT rule

Every Playwright run starts its **own** Vite dev server on `E2E_PORT` (default 4173) with
`--strictPort` and `reuseExistingServer: false`. Several checkouts (one per track) share
this machine, so **each checkout uses its own port, every time**: pass `E2E_PORT=<your
port>` to `pnpm e2e`, `pnpm verify`, `pnpm shots` and any script that starts Vite. If two
runs ask for the same port, the second fails at once ("port is already in use") rather than
quietly testing another checkout's code. If that happens, a run is still going or a stale
`vite` holds the port: wait or stop it, never switch to `reuseExistingServer`.

### Memory

The agent machines have 16 GB of RAM, no swap, and several checkouts at once; the whole
city costs real memory in every process that holds it. The configs keep a plain
`pnpm verify` safe without flags:

- `vitest.config.ts` caps Vitest at `maxWorkers: 3`. Peak RSS per worker, one whole-city file
  at a time (2026-10-21): `tests/sim/agent-budget.test.ts` 1.64 GB, `pack` 0.96,
  `sf-agents` 0.94, `tests/pipeline/sf-world` 0.71, `world-colliders` 0.65, `boundary` 0.60,
  `citywide` 0.52, `sf-glb` 0.44, every other file under 0.25; pnpm and Vitest's main process
  add 0.4. The whole suite peaks at 2.9 GB with three workers (47 s) and 2.5 GB with two
  (59 s); 3.9 GB if the three biggest files ever ran together. Vitest's own default (cores - 1)
  would load 15 cities at once on a 16-core machine.
- `playwright.config.ts` runs one worker locally (CI keeps Playwright's default, one job per
  runner). With one worker the e2e suite peaks at 3.0 GB (runner, Vite server and one
  SwiftShader Chromium on the city) and takes about 9 minutes.
- A Node script that builds the whole city's sim world (`buildWorld` over the collider pack
  and the road graph, as `agent-budget` does) peaks at about 1.6 GB; the pipeline and
  `pnpm build` are heavy too. On a shared machine, run heavy jobs one at a time
  (`flock <lockfile> pnpm verify`), and stop dev servers and browsers when done.

Override for one run with `pnpm exec vitest run --maxWorkers=N` or
`pnpm exec playwright test --workers=N`.

### Browsers

`pnpm e2e` needs Chromium (every test) and, for the cross-engine tests, Firefox and WebKit:

```sh
pnpm exec playwright install --with-deps chromium firefox webkit
```

A missing Firefox or WebKit is not a failure: those tests skip and say why (unless
`E2E_REQUIRE` names `engines`). Chromium is required. `PLAYWRIGHT_BROWSERS_PATH` decides
where browsers live (`/opt/pw-browsers` on the agent machines, `~/.cache/ms-playwright` by
default).

Live-game replays use `E2E_GAME_WAVE` (default `2`) to match the page's enabled gameplay
systems. A combined wave-4 build should run them with `E2E_GAME_WAVE=4`. Pure cross-engine
fixtures keep their explicit wave-2 scenario independently of the live page.

## Prerequisites, skips and E2E_REQUIRE

Tracks build in parallel, so a test that needs something another track delivers checks for it
and **skips with a reason** when it is absent: each branch is green alone, and the test starts
running, unchanged, when the prerequisite lands. A skipped test is not a pass: read the skip
reasons in the report.

After integration a skip can hide a regression (tiles that left plain git, a renamed debug
method). `E2E_REQUIRE` lists prerequisites that must be present; their tests then **fail**
instead of skipping. Names are separated by commas or spaces; `all` means every one; an
unknown name fails the run at load time, so a typo cannot require nothing.

| Name | Present when |
|---|---|
| `sf` | `public/tiles/sf/manifest.json` exists (pipeline track) |
| `dev-city` | `public/tiles/dev-city/manifest.json` exists (render track) |
| `foot` | the sim state has `PlayerState.foot` (sim contract v2) |
| `render-debug` | `window.__fogcity` has the render track's extras: `renderInfo()`, `setNight()`, `setCameraMode()`, `flyTo()`, `tilesSettled()` |
| `landmarks` | `content/landmarks.json` exists with a Ferry Building entry (assets track) |
| `landmark-ids` | `window.__fogcity.landmarks()` reports each landmark's id, position and whether its model is in the scene (asserted unconditionally since the wave-1 integration; the name stays valid) |
| `roads` | the game builds its sim world with the road graph its manifest names (asserted unconditionally since the wave-1 integration; the name stays valid) |
| `engines` | Firefox and WebKit are installed |
| `step-frames` | `window.__fogcity.stepFrames(frames, events)` exists (asserted unconditionally since the wave-1 integration; the name stays valid) |

CI reads `E2E_REQUIRE` from the repository variable of the same name (GitHub: Settings,
Secrets and variables, Actions, Variables). Leave it empty while tracks are separate; set it
to `all` (or the delivered subset) once they are merged.

### Known gaps: expected failures

A test that finds a **known** cross-track gap marks itself `test.fail()` with a "known gap"
annotation and then makes the strict assertion, so the run stays green, the gap stays
visible, and the test turns into an ordinary pass by itself when the gap is fixed (and fails
if the game matches neither construction). The list reporter draws these with a ✘, but the
summary counts them as passed ("expected"); the HTML report shows the annotation.
`E2E_REQUIRE` can name a gap's prerequisite to make it a hard failure.

There is no known gap at the moment. The last one (the game built its sim world without the
road graph its manifest names, so sim v2 traffic never ran in the game) was closed by the
wave-1 integration: `src/main.ts` passes the roads to `buildWorld()`, and the running-game
determinism tests now assert the "colliders + road graph" construction as an ordinary
expectation.

## What each suite proves

### Unit tests (Vitest, `tests/**/*.test.ts`)

Owned by each track: `tests/sim`, `tests/render`, `tests/pipeline`, `tests/content`,
`tests/assets`, `tests/schemas`, plus `tests/io` for the asset layer and the web build.

The city runtime has its own suites:

- `tests/sim/pack.test.ts`: the sim's reader for the citywide collider pack
  (`src/sim/pack.ts`) round-trips everything the pipeline's encoder writes and decodes exactly
  what the pipeline's reference reader (`pipeline/lib/world-colliders.ts`) gives, on synthetic
  packs and on the whole committed city; it refuses a foreign, newer, truncated or lying file;
  it matches the per-tile JSON (minus `meta`) and builds the same world. The tile index:
  `groundHeight` looks pipeline tiles up by `floor(x / 500)`, `floor(z / 500)` and returns
  exactly the old scan's heights at 170,000 points of a synthetic 2 x 2 pack including every
  border and corner, and at 20,000 seeded points over the whole city (half on tile borders and
  corners); hand-made worlds keep the scan.
- `tests/sim/boundary.test.ts`: `boundary.json` walls (`src/sim/boundary.ts`), two-sided. A
  car at full throttle (and at 50 m/s) into a wall stops at it from any angle and counts the
  hit; a walker stops; nobody gets out onto the water side; a wall never reaches a point well
  behind it; a car on the water side a few metres from the wall stays there and never lifts
  off the bank; a car pressed into a pier's corner at any angle never ends a tick across a
  wall; walls reach past free ends and outward corners only. Roads over water: a synthetic
  bridge's corridor cuts the shore only between its kerbs, a car drives across it untouched,
  one steered off it stays on it, a dead-end pier road is capped, a divided road's corridors
  merge, a freeway gets none. On the city: the spawn and every surface lane are clear of walls,
  a car driven at the southern land edge stops there instead of dropping off the world, one
  driven at Ocean Beach stops above the sea (without the walls it ends on the water), the 3rd
  St bridge over Mission Creek can be driven end to end but not driven off, a car on Mission
  Creek stays on it, and 60 seeded drives along the creek's banks never reach open water and
  never rise 10 m above the ground.
- `tests/sim/agent-budget.test.ts`: on the whole city, agents exist only in the seeded budgets
  of the areas around the player (a few dozen of ~1,900 areas), deterministically; a second
  player across town gets their own traffic (each player at most `MAX_AGENTS`, the state at
  most `MAX_AGENTS_TOTAL`); robotaxis never route onto a freeway, a ramp joining one (directly
  or through other ramps), or a pedestrian street, no drivable ramp dead-ends, and walkers never
  onto a freeway.
- `tests/io/assets.test.ts`: the web build's packer and `src/io/assets.ts`. Files packed and
  gzip + base64 encoded come back byte for byte through the index (file -> pack, offset,
  length) from a loopback server under a sub-path, a pack is fetched once however many files
  it holds, packs split before they pass the size cap (a file alone over it is a pack of its
  own), the host-limit check flags `.glb` and `.bin`, every `manifest.layers.<name>` the game
  reads is in `RUNTIME_LAYERS` (the only layers the build ships), and the dev world still loads
  from its collider JSON. Files in parts: a synthetic 30 kB binary under a 12 kB limit is cut
  into 4 even parts of whole base64 quanta, named `.part0.txt` on, that join back to the exact
  bytes, fetched concurrently (all in flight at once) and each once; a missing part, a part cut
  short on the host, two parts listed out of order, and an index length the decoded bytes miss
  (by one either way) each fail with an error naming the file and the part, never a truncated
  decode, and a part's error names it by the number in its file's name (`part 1 of parts 0..3
  (….part1.txt)`); a version 1 index (no parts) still loads and version 3 is refused. On the
  real SF world: built twice with a 5 MB part limit (the collider pack in 3 parts), every part
  on disk at its listed size and under the limit, the host check clean, the two builds
  byte-identical, and the world loads back over HTTP from the parts (the collider pack byte for
  byte, the sim world from the pack, a tile and a model; about 6 s, 1 GB). The out directory:
  the build clears one that is new, empty or an earlier build's (whole or half-written), and
  refuses anything else (a stray `notes.txt`, a raw `.glb`, a source tree) unless forced; the
  checkout, the `public/` it reads and any directory holding either are refused even forced;
  and a refused build, or one whose world is missing, deletes nothing.
- `tests/render/far-seams.test.ts`: the far layer finds its terrain lattice among the hulls;
  at the city's outer edge it finds the far quads just outside, hides them and stitches in
  strips whose inner side follows the streamed tile's ground every 10 m and whose outer side
  meets the far lattice, facing up; and it carries the land on past the far terrain's north and
  south ends as an apron that eases down and faces up.

In `tests/render`, the agent renderer's pure parts have
their own suites: `agent-lod.test.ts` (interpolation between ticks, tier selection and
hysteresis, tier capacities and instance budgets, wheel/steer/gait helpers, brake and hazard
cues, with slowing measured over distance so an agent the sim steps every 4th tick reads like
one it steps every tick, and the brake hold that keeps its lights from flashing, model scale,
the step windows that let an agent the sim steps every 4th tick glide at constant speed, the
proxy simplifier, which keeps cells on the ground plane on the ground), `lights.test.ts`
(night scaling of every `light_*` material, and the channel ratio that keeps each agent light
at its own night level) and `agent-models.test.ts` (the committed GLBs split at their joints
with every triangle kept, proxy budgets, every box proxy lengthwise at `AGENT_SPEC` size and
within 15% of its model's footprint, every mid and far proxy on the ground, the procedural
person's size, the instance capacity `AgentLayer` allocates for every part mesh, checked
against the budget rule, with no more drawn than that, a far agent drawn gliding, and the
errand robot's bag contents hidden by `setBags(false)`, which the debug handle exposes as
`setAgentBags()`). `hud-clock-actors.test.ts`
covers the HUD, the game clock, the exit hint, and player car colours (a slot per player id,
the GLB's `paint` cloned per car). The harness adds `tests/e2e/harness.test.ts`, which tests
the harness itself: the PNG decoder used for blank-frame checks (every PNG filter type), the
geometry helpers, that the determinism scenario really exercises several players, joins and
leaves, steering and collisions (so the cross-engine test cannot silently become weak), that
the recorded multiplayer session and the Node replay used against the running game behave,
`E2E_REQUIRE` parsing, and that CI and this document keep up with the specs. The test
timeout is 20 s: whole-world sim tests take ~5 s on a loaded machine; a test that needs more
sets its own (`it(name, fn, 60_000)`).

### End-to-end tests (Playwright, `tests/e2e/*.spec.ts`)

| Spec | Proves | Prerequisites (skips without) |
|---|---|---|
| `dev-world.spec.ts` | With its road graph answering 404, the game refuses to start (HUD "Failed to start: road graph ...", no debug handle) instead of running a roadless world. The dev world boots with no console error, uncaught exception, HTTP error or failed request, and draws a frame that is not blank. Real keys reach the sim (W moves the car north, D turns it clockwise). Stepping `stepN(1)` 600 times at full throttle ends against the wall: the car centre is never inside it or past its face, and `hits` counts the impact. **KeyC never changes the sim**: with the car moving and turning, C is pressed (and once held) while paused, the paused sim must not move, then the game's own loop runs ~36 ticks consuming input and Node replays the snapshot with neutral input for as many ticks: the states must be identical. KeyC also cycles `renderInfo().cameraMode` and comes back, with the same check after every press. | `render-debug` (camera-mode test only) |
| `determinism.spec.ts` | **Cross-engine determinism**, below. | `dev-city`, `sf` (per world); `engines` (Firefox, WebKit). `stepFrames()` is asserted present, not a skip |
| `campaign.spec.ts` | Physical Hot Desk arrival, held Watch, water melt, hydrant refill to 8 L, and the authored walking route to FiDi; real signup and Counter/Buy controls; exact purchase accounting, inventory idempotency, save restoration and recorded-command replay; physical hood cone, tutorial reward/unlocks, then Spill waits for an actual acknowledgement. Captures first- and third-person screenshots. No player pose, wallet or mission outcome is assigned by the test. | `sf`, `step-frames` |
| `sf-world.spec.ts` | Data: the spawn is within 400 m of the Ferry Building, on a road carriageway and pointing along it; at least 10 buildings within 300 m and a tower over 100 m within 1 km. Browser: SF boots clean with the car at the spawn and draws; it boots from the citywide collider pack (`world.colliders.bin` fetched once, **not one `*.collider.json` request** in the page's log, `simInfo().colliders === "pack"`, more than 1,000 edge and shore wall segments); from Twin Peaks every far-LOD cell is loaded, more than three are drawn in the last frame (`renderInfo().farCells`, `farCellsDrawn`), and the camera sees at least 15 km; from the Embarcadero, tiles load, none fail, and more than 10 000 triangles are on screen; 10 s of full throttle along the spawn heading covers more than 30 m (20 m along the heading) and never ends inside a building; parked at the southern city limit facing out, the far terrain is stitched to the tiles' ground (`renderInfo().farSeamEdges`) and no sea-coloured pixels show below the horizon (the crack showed about 11,000). Landmarks: the Ferry Building entry is within 150 m of the clock tower and its model exists; the renderer fetched that model (HTTP 200); `renderInfo().landmarks` (models actually placed) reaches the number of `landmarks.json` entries whose model file exists, so another landmark cannot stand in for it; `landmarks()` (asserted present) has one entry per `landmarks.json` entry, `ferry-building` and `r-evolution` are reported loaded, every one with a model is in the scene, and the Ferry Building is placed within 150 m of the origin. Traffic: after 120 ticks `state.ext.agents` holds robotaxis, errand robots, sidewalk bots and people, a quarter of them have moved, `simInfo()` says the road graph was built; the renderer draws them (`renderInfo().agents`, with full models near the chase camera, the three robot kinds from their model files) in at most 27 agent draw calls, and the player car is `models/civilian-car.glb`. | `sf`; `landmarks`; `render-debug` (browser half of the landmark test, traffic test) |
| `realism.spec.ts` | SF high-quality rendering compiles without errors, uses the requested lighting preset, loads the licensed scanned surfaces, draws bounded leaf foliage, and preserves the paused simulation hash across night toggles; captures real daylight and night frames. | `sf`, `render-debug` |
| `avatar.spec.ts` | In normal SF play, F exits into the actual skinned human model (`walkersFromFile === 1`). Captures front and third-person views, verifies first-person hides the local avatar, and proves camera changes preserve the paused simulation hash. | `sf`, `foot`, `render-debug` |
| `on-foot.spec.ts` | With real keys: F gets out of the stopped car, the walker is drawn (`renderInfo().walkers`), W walks while the car stays parked exactly where it was and the HUD shows walking speed "on foot", S walks back, F next to the car gets back in (no walker drawn), and W drives again. Boxed in by four other players' cars (joined through `stepFrames()` events, 2 m to each side and 5.2 m ahead and behind), F leaves the player in the car and `hint()` reads "No room to get out" on screen; once they leave, F gets out with no hint. | `foot` |
| `multiplayer.spec.ts` | Online Bot Sweep against the real relay (`node server/main.ts`, as `pnpm relay` runs it, on loopback port `E2E_PORT + 1101` or `E2E_RELAY_PORT`) with two browser contexts on SF, through the lobby UI only: create a private room, open the invitation link (code prefilled), join, ready, host-only start; each player's held W moves their car in the *other* browser; the free-roam city does not step during the match; a mid-match reload rejoins the same seat (`p2`) and both browsers and the relay report zero hash mismatches; the host ends the match, both pages credit the payout to the city once (`settledIds` holds the settlement id, XP rises by exactly the payout); a reload in the results restores the city's autosave and reports the payout as already paid with XP unchanged; Back to city leaves the room and free roam steps again. A quick-play test: the second browser sees the first's public room in the room list, Play online puts both in it, the host adds a bot teammate (only the host has the control), the match holds `bot-1,p1,p2`, the bot gets out of its car, zero mismatches, end and payout. A Clean Streets test: only the host can pick the mode, everyone sees it, the match has two teams (`p1` team 0, `p2` team 1) and the team-score HUD, a held B (flower lob) keeps both browsers in agreement with zero mismatches, and the end pays once. A last test boots with no relay: no lobby, single-player runs. The relay's abuse limits are unit tests (`tests/server/net/relay.test.ts`). | `sf` |
| `player-feel.spec.ts` | The owner's playtest notes through real controls in SF: H sounds the synthesized horn (Web Audio tones counted by an init script) and people within earshot leave `idle` with the player as their reaction source. | `sf` |
| `weather.spec.ts` | Wave-3 weather in the running SF game: the page registers the weather reducer in its real step (`state.ext.fog` present), 240 ticks of real driving input stepped in the browser match Node replaying the same snapshot and recorded commands hash for hash, and the browser's fog density, daily weather and traction agree with `src/sim/fog` at the final tick. Rain and King-tide rules themselves are covered by `tests/sim/fog.test.ts`. | `sf`, `step-frames` |
| `perf.spec.ts` | Nothing: it **reports**. See the perf probe below. | never (absent worlds are listed as skipped in the report) |
| `web-build.spec.ts` | The static web build (`scripts/build-web.ts`, the same code as `pnpm build`), built into `test-results/web-build/site/fog/city/` and served by a loopback server from the sub-path `/fog/city/`: it fits the host (allowed extensions only, at most 450 files, 240 MB, 15 MB a file), its index has no per-tile collider, lists every file written in parts at its size on disk and at most 14 MB (and says version 2 exactly when there are parts), and agrees with the build's report; the page boots SF by default with `simInfo().assets === "packed"` and the collider pack, each of the pack's files (whole, or every part) fetched exactly once; every request stays under the sub-path, none fails, none is a raw `.glb`, `.bin` or `*.collider.json`; 10 s of throttle drives more than 30 m; tiles stream from several packs with none failed, every far cell loads, the player car comes from its packed model, and the frame is drawn (`test-results/web-build/hosted-chase.png`). The committed collider pack fits one file, so a second build (`test-results/web-build/split-site/`) lowers the part size to 5 MB so every run boots the split path in Chromium: the pack is written in parts (version 2 index, each part at its size on disk) that join and decode to `world.colliders.bin` byte for byte, the page boots SF from them and drives more than 30 m, fetching every part once and never the whole file, and with one part missing on the host the boot stops with `Failed to start: … part 1 of parts 0..N (….part1.txt): HTTP 404`. `WEB_BUILD_PUBLIC=<dir>` builds both from another `public/` directory. | `sf` |

### Cross-engine determinism

The sim is the source of truth for replays, saves and netcode, so the same world, seed,
inputs and events must give bit-identical states on every JavaScript engine.

1. **Pure sim** (tests tagged `@engines`, run in Chromium, Firefox and WebKit):
   `tests/e2e/determinism-scenario.ts` runs a scripted multiplayer session: three players,
   then joins and leaves on fixed ticks (five players in all), p1 ramming the dev wall,
   random steering, braking and reversing, enter/exit presses (on foot when the sim has it),
   out-of-range and NaN controls the sim must clamp, and ambient traffic when the sim and
   world have a road graph. Node runs it in the test process; the browser runs the same file
   in `tests/e2e/sim-lab.html` (no renderer, no game loop) with the world fetched over HTTP
   exactly as the game loads it (`src/io/world-load.ts`: the collider pack, so its decoder
   runs in every engine, the road graph and the boundary).
   Every 15th tick's `hashState` must match, and so must the whole final state (compared as
   canonical JSON, so a hash collision cannot hide a difference). A companion test hashes the
   exact bits of `dsin`, `dcos`, `dtan`, `datan`, `datan2`, `wrapAngle`, `Math.sqrt` and
   `hashState` over 20 000 inputs, so a divergence names the function. The scenario's own
   inputs come from integer arithmetic only, never `Math.sin` or `Math.random`. Worlds: dev
   (3600 ticks), dev-city (1200) and sf (900) when present. A 1e-12 rad change to the spawn
   heading fails it at the first checkpoint.
2. **The running game** (Chromium, dev and sf): the real game is paused, snapshotted, and p1
   is stepped through `stepN()` segments (straight, turning, into the wall, reversing,
   braking, out and back in). Between segments come render-only pokes: C, V and N pressed or
   held, `setNight`, `flyTo`, `setCameraMode`. After each poke the paused sim must not have
   moved, and then the **game's own loop runs ~36 ticks**, sampling the keyboard as it does
   for a player, before it is paused again (`pokeThenRun` in `fixtures.ts`). Node replays the
   snapshot with the same `stepN` inputs and neutral input for each loop run
   (`tests/e2e/replay.ts`): every chunk's hash and the final state must match. A key that
   leaks into the sim (an action bit latched on press, an axis while held) shows up as a
   divergence; mapping C to the enter/exit action, or to throttle while held, fails both
   this test and the dev-world KeyC test. A leak on a press that switches **to** the fly
   camera cannot show, by design (the fly camera feeds the player neutral input), so V is
   checked on the press that leaves it. The world must be built as its manifest says (with
   the road graph and the boundary when it names them, so ambient traffic runs and the edge
   walls stand in the game and in Node).
3. **The running game, multiplayer** (Chromium, dev and sf, through `stepFrames()`): the
   scenario's session recorded in Node (`recordSession`: p2 and p3 join on the first tick,
   then the same drivers, joins, leaves and junk input) is fed to the game 60 frames at a time
   and compared with Node chunk by chunk, with the game's world built as its manifest says.

### Perf probe (`tests/e2e/perf.spec.ts` -> `test-results/perf.json`)

For dev, dev-city and sf (those present): boot time, time for tiles to settle, per-frame wall
time (median, p95, max, mean over up to 60 frames or 4 s), draw calls and triangles per frame,
`renderInfo()`, sim cost per tick, and the JS heap (Chrome rounds it), at the spawn and from
fixed viewpoints. Draw calls and triangles are counted twice: from `renderInfo()` and by
wrapping WebGL's draw functions, which works with any renderer and cross-checks it. The file
records the GL renderer string (SwiftShader), CPU and viewport.

It never fails on a number: software rendering times say little about a GPU, and the agent
machines are shared. Compare runs on the same machine for direction (draw calls doubling,
sim ticks getting slower). It fails only if it cannot measure the dev world at all.

### Screenshots (`pnpm shots` -> `test-results/shots/`)

For people and reviewers, not a test of correctness. Boots each world present and saves
1280x720 PNGs, `index.json` (camera, timings, render stats, blank-frame flag) and
`index.html`, a contact sheet. Views:

- **dev**: spawn (chase camera), overview.
- **dev-city**: spawn, street level, overview.
- **sf**: spawn; the Ferry Building from the Embarcadero; Market Street at Montgomery
  looking to the Ferry Building; the Salesforce Tower base from Mission Street; Columbus
  Avenue in North Beach; the Marina Green; Market Street at night; downtown from over the bay.

Street views snap to the named street in `roads.json`, and the Salesforce Tower view aims at
the tallest collider near its address, so they stay framed when the data moves a little.
Views other than the spawn need `window.__fogcity.flyTo()`; without it they are listed as
skipped. An absent world is skipped (shots ignore `E2E_REQUIRE`). Each run starts from an
empty `test-results/shots/`.

```sh
E2E_PORT=4196 pnpm shots --grep sf                                  # one world
SHOT="sf -669 677 45 -2 3" E2E_PORT=4196 pnpm shots --grep custom   # world x z yaw pitch [up]
```

`x`, `z` are local metres (`src/geo/project.ts`), yaw a compass bearing in degrees, pitch in
degrees (+ up), `up` metres above the ground there.

## Writing browser tests

- Use `tests/e2e/fixtures.ts`: `bootWorld()` (fails fast with the HUD's "Failed to start"
  text and returns the live list of console errors, uncaught exceptions and HTTP errors:
  assert it is empty at the end), `settle()`, `frames()`, `features()`, `simState()`.
- Drive the sim deterministically: `pause()`, then `stepN(n, input)`. Real keys are for
  proving input reaches the sim, not for measuring it.
- To prove something does **not** reach the sim, let the game's loop consume input after it
  (`pokeThenRun()`) and compare with a Node replay (`tests/e2e/replay.ts`). Checking the hash
  while paused proves nothing: the paused loop never samples the keyboard, and `stepN()`
  ignores it.
- Behaviour tests use `FAST_VIEWPORT` and `FAST_QUERY` (a small viewport and `?pr=0.5`).
  Under SwiftShader a full-size frame can take a second, and the game loop catches up at most
  0.25 s of sim per frame, so slow frames slow the sim itself. Visual tests keep the defaults.
- Never assert frame rate, frame time or wall-clock durations.
- **Load-proof.** Under SwiftShader on a loaded 4-core machine the game runs at about one frame
  a second, and each frame catches up at most 0.25 s of sim. Drive anything that is about the
  sim through `pause()`, `stepN()` or `stepFrames()`; when a test must use the game's own
  loop (real keys, render-only pokes), every real-time wait allows at least 60 s, and the test
  sets a timeout that covers all of them (the default is 180 s). Never skip or weaken an
  assertion to make a slow machine pass.
- Need something another track has not delivered? Check for it (`features(page)`, the file's
  existence, a contract field) and call `gate(prerequisite, present, "what is missing")`
  (or `gateWorld(name)`), which skips with the reason or fails under `E2E_REQUIRE`. A new
  kind of prerequisite goes in `tests/e2e/prereq.ts` and the table above.
- Tests never touch the network: worlds come from `public/tiles/<world>/`, read in Node with
  `tests/helpers.ts` (`worldExists`, `loadWorldFiles`, `loadWorld`), which reads the collider
  pack, road graph and boundary exactly as the game does. Tiles live in plain git; a Git LFS
  pointer file in place of one fails with a message that says so.
- Playwright runs only `*.spec.ts`; Vitest runs only `*.test.ts`. Both may live in
  `tests/e2e/`.

## Seeing the game without a GPU

`pnpm shots` covers most needs. For anything else, write a throwaway script outside the repo
(or in an untracked directory) using the SwiftShader launch flags exported by
`playwright.config.ts` (`SWIFTSHADER_ARGS`), start Vite on your `E2E_PORT`, drive
`window.__fogcity` (`flyTo`, `setNight`, `setCameraMode`, `stepN`) and take
`page.screenshot()`.

## Continuous integration (`.github/workflows/ci.yml`)

On every pull request and every push to main, on Ubuntu with Node 22 and pnpm (version from
`package.json`), with the pnpm store and Playwright browsers cached: check out (tiles are in
plain git), `pnpm install --frozen-lockfile`, typecheck, unit tests, `pnpm build` (the static
web build; it fails if the build breaks the host's limits), Playwright browsers with system
dependencies, `pnpm e2e` (with `E2E_REQUIRE` from the repository variable), then `pnpm shots`
(informational: it never fails CI. Playwright's 9-minute `--global-timeout` stops it before
the step's 12-minute backstop, because a step that reaches its own `timeout-minutes` fails
the job even under `continue-on-error`). Each check runs whenever install succeeded, so one
failure does not hide another. `test-results/` (Playwright artefacts and HTML report,
`perf.json`, `shots/`) is uploaded as an artifact for 14 days. With `CI` set, `test.only` fails the run. The workflow has passed `actionlint` and
its commands have run locally with `CI=true`; its first run on GitHub's runners happens on
the first push.

## Static web build (`pnpm build`)

`pnpm build` (also `pnpm build:web`) runs `scripts/build-web.ts`: `vite build` with `base: "./"`
(every URL relative, so `dist/` works from any sub-path; `public/` is not copied), then the
world and the models in the layout `src/io/assets.ts` reads in a production build:

- the page host serves only text-like types (`.html .css .js .mjs .wasm .json .map .geojson
  .webmanifest .txt .md .csv .xml .svg .png .jpg .jpeg .gif .webp .avif .ico .woff .woff2 .ttf
  .otf .mp3 .wav .ogg .mp4 .webm .pdf`; no `.glb`, no `.bin`), so every binary is
  gzip-compressed, base64-encoded and written as a `.txt` file, decoded in the page with
  `atob` and `DecompressionStream("gzip")`;
- tile glbs are concatenated into packs, one per 3 x 3 block of tiles
  (`tiles/sf/packs/tiles-NNN.pack.gz.b64.txt`), the far-LOD cells into `far-NN` packs; a pack
  is fetched whole the first time a file in it is needed, cached, and sliced by offset;
- `world.colliders.bin` and each model are encoded on their own, one `.gz.b64.txt` file each
  while that stays within the build's 14 MB margin (`PACK_MAX_BYTES`, under the host's 15 MB);
- an encoded file over 14 MB is written as parts instead: `<name>.gz.b64.part0.txt`,
  `.part1.txt`, ... (numbered from 0, as few as fit, sizes as even as possible with every cut
  on a multiple of 4 characters, so each part is valid base64 on its own; the build checks
  every part is at most 14 MB). The page fetches a file's parts concurrently, checks each
  against the size the index lists, joins them in order and decodes once; a missing or
  wrong-sized part fails the load naming the file and the part, and the decoded length must
  equal the index's. The citywide collider pack needs this from the 2026-10-21 QA world on
  (14.87 MB raw, 14.26 MB encoded: two parts of 7.13 MB);
- the world's JSON the game reads is copied as is: the manifest, the road graph and the data
  layers in `RUNTIME_LAYERS` (`src/io/world-load.ts`: boundary and districts); the other layers
  (sidewalks, hydrants, ...) stay out until a feature reads them, and per-tile collider JSON is
  not shipped;
- the bundle's source map ships by default (useful on a private page); `node
  scripts/build-web.ts --no-sourcemap` leaves it out;
- `assets.index.json` maps each binary's logical path to `{src, offset, length}`; a src written
  in parts is listed under `parts[src]` as `[{src, bytes}, ...]` in join order (`src` in the
  entry then names the whole encoded text, which is not a file). An index with parts says
  `version: 2`; one without stays `version: 1`, the shape builds wrote before parts, so a page
  too old to know parts refuses a split build by its version. Its `defaultWorld` (`sf`) opens
  when the page has no `?world=`.

The build checks the host's limits (at most 450 files, 240 MB in all, 15 MB a file, the
extensions above; every part is a file of its own) and fails if one is broken; its summary
names each file written in parts. `--public <dir>` builds the world and models from another
`public/` directory, e.g. a pipeline branch's world before it merges. `--out <dir>` (relative
to the checkout, or absolute) is deleted before the build writes it, so the build takes only a
directory that is new, empty or holds nothing but an earlier build's files (`index.html`,
`assets/`, `assets.index.json`, `tiles/` and `models/` of `.json` and `.txt`), and checks the
world's manifest is there before it deletes anything; anything else stops the build, naming
what it found, unless `--force-clean`. The checkout, the `public/` it reads and any directory
holding either are refused even then. On 2026-10-22, from the committed world (`pnpm build`):
112 files, 92.9 MB (binaries 138.8 MB raw, 83.0 MB encoded: meshopt output gzips well; JSON
5.0 MB; the bundle 4.8 MB), largest file the collider pack at 12.3 MB encoded (12.7 MB raw),
in one file, so nothing in parts and a version 1 index; 81 packs; about 10 s.

Republishing a build to a page that already holds an earlier one: the host keeps every file an
update leaves out, so remove each path the earlier build had and this one lacks, e.g. the whole
`tiles/sf/world.colliders.bin.gz.b64.txt` once the pack is written in parts, or a pack name
that is gone. The page never reads them, but they count against the host's file and size
totals. To look at it from a sub-path:

```sh
pnpm build
python3 -m http.server 4299 --bind 127.0.0.1    # from the repo root, then open
# http://127.0.0.1:4299/dist/
```

`pnpm dev` keeps serving loose files from `public/`. `tests/e2e/web-build.spec.ts` builds and
boots its own copies from a sub-path on every e2e run (one as `pnpm build` writes it, one with a
5 MB part size, so the collider pack is always in parts); `WEB_BUILD_PUBLIC=<dir>` points it at
another `public/` directory, to prove a world that has not merged yet builds, fits the host and
boots (`WEB_BUILD_PUBLIC=/path/to/public E2E_PORT=4298 pnpm exec playwright test web-build`).

## Output layout

| Path | Written by | Notes |
|---|---|---|
| `test-results/playwright/` | `pnpm e2e` | traces and screenshots of failed tests; cleared at the start of each run |
| `test-results/html-report/` | `pnpm e2e` on CI | `pnpm exec playwright show-report test-results/html-report` |
| `test-results/perf.json` | `perf.spec.ts` | overwritten each run |
| `test-results/shots/` | `pnpm shots` | cleared at the start of each shots run |
| `test-results/playwright-shots/` | `pnpm shots` | artefacts of failed shots |
| `test-results/web-build/` | `web-build.spec.ts` | the static builds it serves from `/fog/city/` (`site/`, and `split-site/` with the collider pack in parts), and `hosted-chase.png` |
| `dist/` | `pnpm build` | the static web build (gitignored) |
