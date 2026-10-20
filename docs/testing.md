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

### Browsers

`pnpm e2e` needs Chromium (every test) and, for the cross-engine tests, Firefox and WebKit:

```sh
pnpm exec playwright install --with-deps chromium firefox webkit
```

A missing Firefox or WebKit is not a failure: those tests skip and say why (unless
`E2E_REQUIRE` names `engines`). Chromium is required. `PLAYWRIGHT_BROWSERS_PATH` decides
where browsers live (`/opt/pw-browsers` on the agent machines, `~/.cache/ms-playwright` by
default).

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
`tests/assets`, `tests/schemas`. In `tests/render`, the agent renderer's pure parts have
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
| `sf-world.spec.ts` | Data: the spawn is within 400 m of the Ferry Building, on a road carriageway and pointing along it; at least 10 buildings within 300 m and a tower over 100 m within 1 km. Browser: SF boots clean with the car at the spawn and draws; from the Embarcadero, tiles load, none fail, and more than 10 000 triangles are on screen; 10 s of full throttle along the spawn heading covers more than 30 m (20 m along the heading) and never ends inside a building. Landmarks: the Ferry Building entry is within 150 m of the clock tower and its model exists; the renderer fetched that model (HTTP 200); `renderInfo().landmarks` (models actually placed) reaches the number of `landmarks.json` entries whose model file exists, so another landmark cannot stand in for it; `landmarks()` (asserted present) has one entry per `landmarks.json` entry, `ferry-building` and `r-evolution` are reported loaded, every one with a model is in the scene, and the Ferry Building is placed within 150 m of the origin. Traffic: after 120 ticks `state.ext.agents` holds robotaxis, errand robots, sidewalk bots and people, a quarter of them have moved, `simInfo()` says the road graph was built; the renderer draws them (`renderInfo().agents`, with full models near the chase camera, the three robot kinds from their model files) in at most 27 agent draw calls, and the player car is `models/player-car.glb`. | `sf`; `landmarks`; `render-debug` (browser half of the landmark test, traffic test) |
| `on-foot.spec.ts` | With real keys: F gets out of the stopped car, the walker is drawn (`renderInfo().walkers`), W walks while the car stays parked exactly where it was and the HUD shows walking speed "on foot", S walks back, F next to the car gets back in (no walker drawn), and W drives again. Boxed in by four other players' cars (joined through `stepFrames()` events, 2 m to each side and 5.2 m ahead and behind), F leaves the player in the car and `hint()` reads "No room to get out" on screen; once they leave, F gets out with no hint. | `foot` |
| `perf.spec.ts` | Nothing: it **reports**. See the perf probe below. | never (absent worlds are listed as skipped in the report) |

### Cross-engine determinism

The sim is the source of truth for replays, saves and netcode, so the same world, seed,
inputs and events must give bit-identical states on every JavaScript engine.

1. **Pure sim** (tests tagged `@engines`, run in Chromium, Firefox and WebKit):
   `tests/e2e/determinism-scenario.ts` runs a scripted multiplayer session: three players,
   then joins and leaves on fixed ticks (five players in all), p1 ramming the dev wall,
   random steering, braking and reversing, enter/exit presses (on foot when the sim has it),
   out-of-range and NaN controls the sim must clamp, and ambient traffic when the sim and
   world have a road graph. Node runs it in the test process; the browser runs the same file
   in `tests/e2e/sim-lab.html` (no renderer, no game loop) with the world fetched over HTTP.
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
   the road graph when it names one, so ambient traffic runs in the game and in Node).
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
- Need something another track has not delivered? Check for it (`features(page)`, the file's
  existence, a contract field) and call `gate(prerequisite, present, "what is missing")`
  (or `gateWorld(name)`), which skips with the reason or fails under `E2E_REQUIRE`. A new
  kind of prerequisite goes in `tests/e2e/prereq.ts` and the table above.
- Tests never touch the network: worlds come from `public/tiles/<world>/`, read in Node with
  `tests/helpers.ts` (`worldExists`, `loadWorldFiles`, `loadWorld`). A Git LFS pointer file
  in place of a tile fails with "run `git lfs pull`".
- Playwright runs only `*.spec.ts`; Vitest runs only `*.test.ts`. Both may live in
  `tests/e2e/`.

## Seeing the game without a GPU

`pnpm shots` covers most needs. For anything else, write a throwaway script outside the repo
(or in an untracked directory) using the SwiftShader launch flags exported by
`playwright.config.ts` (`SWIFTSHADER_ARGS`), start Vite on your `E2E_PORT`, drive
`window.__fogcity` (`flyTo`, `setNight`, `setCameraMode`, `stepN`) and take
`page.screenshot()`.

## Continuous integration (`.github/workflows/ci.yml`)

On every push and pull request, on Ubuntu with Node 22 and pnpm (version from
`package.json`), with the pnpm store and Playwright browsers cached: check out (with Git
LFS, in case tiles move there), `pnpm install --frozen-lockfile`, typecheck, unit tests,
Playwright browsers with system dependencies, `pnpm e2e` (with `E2E_REQUIRE` from the
repository variable), then `pnpm shots` (informational: it never fails CI). Each check runs
whenever install succeeded, so one failure does not hide another. `test-results/`
(Playwright artefacts and HTML report, `perf.json`, `shots/`) is uploaded as an artifact for
14 days. With `CI` set, `test.only` fails the run. The workflow has passed `actionlint` and
its commands have run locally with `CI=true`; its first run on GitHub's runners happens on
the first push.

## Output layout

| Path | Written by | Notes |
|---|---|---|
| `test-results/playwright/` | `pnpm e2e` | traces and screenshots of failed tests; cleared at the start of each run |
| `test-results/html-report/` | `pnpm e2e` on CI | `pnpm exec playwright show-report test-results/html-report` |
| `test-results/perf.json` | `perf.spec.ts` | overwritten each run |
| `test-results/shots/` | `pnpm shots` | cleared at the start of each shots run |
| `test-results/playwright-shots/` | `pnpm shots` | artefacts of failed shots |
