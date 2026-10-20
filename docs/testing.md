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
```

One file or one test: `pnpm exec vitest run tests/sim`, `E2E_PORT=4196 pnpm e2e dev-world`,
`E2E_PORT=4196 pnpm e2e -g "wall"`, `E2E_PORT=4196 pnpm e2e --project chromium`.

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

A missing Firefox or WebKit is not a failure: those tests skip and say why. Chromium is
required. `PLAYWRIGHT_BROWSERS_PATH` decides where browsers live (`/opt/pw-browsers` on the
agent machines, `~/.cache/ms-playwright` by default).

## What each suite proves

### Unit tests (Vitest, `tests/**/*.test.ts`)

Owned by each track: `tests/sim`, `tests/render`, `tests/pipeline`, `tests/content`,
`tests/assets`, `tests/schemas`. The harness adds `tests/e2e/harness.test.ts`, which tests
the harness itself: the PNG decoder used for blank-frame checks (every PNG filter type), the
geometry helpers, and that the determinism scenario really exercises several players,
joins and leaves, steering and collisions (so the cross-engine test cannot silently become
weak). The test timeout is 60 s because whole-world tests (SF agents) take several seconds.

### End-to-end tests (Playwright, `tests/e2e/*.spec.ts`)

| Spec | Proves | Skips when |
|---|---|---|
| `dev-world.spec.ts` | The dev world boots with no console error, uncaught exception, HTTP error or failed request, and draws a frame that is not blank. Real keys reach the sim (W moves the car north, D turns it clockwise). Stepping `stepN(1)` 600 times at full throttle ends against the wall: the car centre is never inside it or past its face, and `hits` counts the impact. While paused, KeyC never changes the sim hash or tick, and `resume()` restarts the loop. KeyC cycles `renderInfo().cameraMode` and comes back. | `renderInfo()` absent (camera-mode test only) |
| `determinism.spec.ts` | **Cross-engine determinism**, below. | the world is absent; a browser is not installed |
| `sf-world.spec.ts` | Data: the spawn is within 400 m of the Ferry Building, on a road carriageway and pointing along it; at least 10 buildings within 300 m and a tower over 100 m within 1 km. Browser: SF boots clean with the car at the spawn and draws; from the Embarcadero, tiles load, none fail, and more than 10 000 triangles are on screen; 10 s of full throttle along the spawn heading covers more than 30 m (20 m along the heading) and never ends inside a building; the Ferry Building landmark is within 150 m of the clock tower, its model file exists, and `renderInfo().landmarks` reaches 1. | `public/tiles/sf/manifest.json` absent; landmark test: `content/landmarks.json` absent |
| `on-foot.spec.ts` | With real keys: F gets out of the stopped car, W walks while the car stays parked exactly where it was, S walks back, F next to the car gets back in, and W drives again. | the sim state has no `foot` (sim contract v1) |
| `perf.spec.ts` | Nothing: it **reports**. See the perf probe below. | never (absent worlds are listed as skipped in the report) |

Tests that need something another track has not delivered skip with a reason saying what
is missing; they start running, unchanged, once it lands. A skipped test is not a pass:
read the skip reasons in the report.

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
2. **The running game** (Chromium): the real game loop is paused, its state snapshotted, and
   p1 is stepped through `stepN()` segments (straight, turning, into the wall, reversing,
   braking, out and back in) with render-only pokes between them (C, V, N keys, night,
   fly camera, camera mode). Every poke must leave the hash unchanged, and every segment's
   hash must match Node stepping the same snapshot. The game decides whether its sim world
   includes the road graph, so Node tries both and one must match every hash; the test's
   annotation says which, and whether the boot state is reproducible from
   (seed, players, spawn).

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
skipped. An absent world is skipped. Each run starts from an empty `test-results/shots/`.

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
- Behaviour tests use `FAST_VIEWPORT` and `FAST_QUERY` (a small viewport and `?pr=0.5`).
  Under SwiftShader a full-size frame can take a second, and the game loop catches up at most
  0.25 s of sim per frame, so slow frames slow the sim itself. Visual tests keep the defaults.
- Never assert frame rate, frame time or wall-clock durations.
- Need a feature another track has not delivered? Check for it (`features(page)`, the file's
  existence, a contract field) and `test.skip(condition, "what is missing")`.
- Tests never touch the network: worlds come from `public/tiles/<world>/`, read in Node with
  `tests/helpers.ts` (`worldExists`, `loadWorldFiles`, `loadWorld`).
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
`package.json`), with the pnpm store and Playwright browsers cached: `pnpm install
--frozen-lockfile`, typecheck, unit tests, Playwright browsers with system dependencies,
`pnpm e2e`, then `pnpm shots` (informational: it never fails CI). Each check runs whenever
install succeeded, so one failure does not hide another. `test-results/` (Playwright
artefacts and HTML report, `perf.json`, `shots/`) is uploaded as an artifact for 14 days.
With `CI` set, `test.only` fails the run.

## Output layout

| Path | Written by | Notes |
|---|---|---|
| `test-results/playwright/` | `pnpm e2e` | traces and screenshots of failed tests; cleared at the start of each run |
| `test-results/html-report/` | `pnpm e2e` on CI | `pnpm exec playwright show-report test-results/html-report` |
| `test-results/perf.json` | `perf.spec.ts` | overwritten each run |
| `test-results/shots/` | `pnpm shots` | cleared at the start of each shots run |
| `test-results/playwright-shots/` | `pnpm shots` | artefacts of failed shots |
