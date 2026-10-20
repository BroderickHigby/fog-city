# Fog City — instructions for agents working in this repo

A browser open-world game set in San Francisco about five years from now: real streets
and buildings from SF open data, robotaxis and errand robots everywhere, satire of the AI
startup scene. Three.js renders; a pure-TypeScript deterministic simulation is the truth.

## Commands
- `pnpm install`
- `pnpm typecheck` · `pnpm test` (Vitest) · `pnpm e2e` (Playwright, software WebGL) · `pnpm verify` (all three)
- `pnpm dev` then open `http://127.0.0.1:5173/?world=dev` (hand-made test world) or `?world=sf` (real SF, once the pipeline has run)
- Blender 4.5 LTS runs headless only (no GUI): the binary path is in the `BLENDER` env var or given in your task.

`pnpm verify` must be green before you call anything done.

## Game design
Read `docs/design.md` before building gameplay. It is the source of truth for pillars, combat, robots, territory
and the decision log.

## Architecture and contracts
- `src/sim/contract.ts` and `schemas/tile-*.schema.json` are the contracts every part builds against.
  Do not change them casually: a change breaks saves, replays and netcode. If you must, say so loudly in your report.
- The sim (`src/sim/`) is pure and deterministic. `step(world, state, inputs, events)` returns a new state and never
  mutates its input. SimState is plain JSON. No three.js, DOM, network, clock or `Math.random`; transcendentals come
  from `dmath.ts`. `tests/sim/forbidden-apis.test.ts` enforces this. Iterate players with `sortedIds()`.
- Multiplayer-ready by construction: inputs are keyed by player id; outside facts (AI replies, server decisions,
  joins) enter only as `SimEvent`s recorded with their tick.
- Coordinate frame (`src/geo/project.ts`): metres, origin at the Ferry Building clock tower, +x east, +y up,
  +z south (north is -z). Headings are compass bearings (radians clockwise from north); the renderer sets
  `rotation.y = -heading` on models that face -z.
- Data flow: `pipeline/` (Node, offline) fetches SF open data and writes `public/tiles/<world>/` (committed).
  The sim reads `*.collider.json`; the renderer reads `*.glb`. The game makes no network calls at runtime.
- TypeScript: relative imports use the `.ts` extension; erasable syntax only (no enums, namespaces or
  constructor parameter properties). Node runs `.ts` files directly (`node pipeline/x.ts`).

## Ownership
Each area has one owner. Edit only your own directories; anything else, describe in your report.

| Area | Owns |
|---|---|
| Pipeline | `pipeline/`, `public/tiles/sf/` (incl. `roads.json`), `docs/data-sources.md`, `tests/pipeline/` |
| Renderer | `src/render/`, `src/main.ts`, `src/debug.ts`, `src/input/`, `index.html`, `vite.config.ts`, `public/tiles/dev-city/`, `tests/render/` |
| Sim | `src/sim/` (additive changes to `contract.ts` allowed: bump `SIM_VERSION`, say so), `tests/sim/` |
| Content | `content/` (except `landmarks.json`), `src/content/`, `schemas/` content schemas, `tests/content/` |
| Assets | `assets/blender/`, `public/models/`, `content/landmarks.json`, `tests/assets/` |
| Harness | `tests/e2e/`, `playwright.config.ts`, `vitest.config.ts`, `.github/`, `tests/helpers.ts` |

Adding a dependency: pin an exact version that is at least two weeks old (`pnpm add --save-exact`).

## Content and taste rules (non-negotiable)
- Non-violent. Players fire flowers at each other; the water blaster rusts robots (they seize, slump and melt into a
  rust heap). People are never harmed: water makes them wet and annoyed and costs the player. Vehicles never hurt
  people (they dodge; contact is a gentle push). Bad-robot attacks are slapstick and satire, never injury.
- No real brands, logos or trademarks. Invent startup and product names. Storefronts stay unnamed for now:
  iconography only (beer-neon shape, barber pole), empty sign slot reserved.
- Robotaxis and robots are original designs: nothing that copies a real vehicle or a film robot.
- Public figures only as obvious caricature that never claims to be the real person; never real private people.
- Punch up at tech and VC culture. Never make homelessness, poverty, drug use or crime victims the joke.

## Tests
- Tests never hit the network. Pipeline downloads are cached in `pipeline/.cache/` (gitignored); tests use
  committed outputs and fixtures.
- Browser tests run under SwiftShader: assert behaviour through `window.__fogcity`, never frame rate.
