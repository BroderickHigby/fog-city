# Lane 1: Pipeline & territory

**Lane id:** `pipeline` · **Roadmap track:** Pipeline, waves 2 to 8 · **Branches:** `lane/pipeline/wave<N>`

## Paste-ready prompt
> You are Lane 1, Pipeline & territory, on Fog City (<https://github.com/BroderickHigby/fog-city>).
> It is a browser open-world game of a satirical, near-future San Francisco built from real SF open
> data. Eight lanes are building the rest of the game in parallel, and you own the city data:
> `pipeline/`, `public/tiles/sf/`, `docs/data-sources.md` and `tests/pipeline/`. Edit nothing else.
>
> Read these first, in order: `CLAUDE.md` (the agent rules apply to you whatever model you are),
> `docs/parallel/README.md` (the shared rules on branches, commits, PRs, running the game, memory
> and stop-and-ask), this file `docs/parallel/lane-1-pipeline.md`, the Pipeline row of every wave
> in `docs/roadmap.md`, `docs/data-sources.md`, `docs/qa/` (the world-continuity gate) and
> `docs/handoff.md`. Skim `docs/design.md` for the territory steps.
>
> Your goal: grow the drivable city from today's tiles to the whole of San Francisco, one
> territory step per wave. Every step passes the tile budgets and the world-continuity gate, and
> carries the data that gameplay and the photoreal renderer need: sidewalks, crosswalks, signals,
> Muni, hydrants, cable cars, parking and so on.
>
> Work wave by wave, starting with wave 2. Create `docs/parallel/status/pipeline.md` first. Then:
> 1. Check what already exists. `qa/pipeline` (structures, landscape and house data) may not yet
>    be merged into `integrate/wave1`. If it isn't, base your branch on a local merge of
>    `origin/integrate/wave1`, then `origin/qa/gate`, `origin/qa/sim` and `origin/qa/pipeline` in
>    that order, so you don't regenerate tiles twice. Say so in your PR, and switch to
>    `integrate/wave2` once it includes them.
> 2. Do the wave-2 data spike: record each dataset's id and licence in `docs/data-sources.md`,
>    with the procedural fallback for each. No ODbL or OSM-derived data, and no Google, Apple or
>    Street View data.
> 3. Build the per-tile sidewalk navigation graph and the crosswalk and signal data. Lane 3 needs
>    the graph for people and robots, and Lane R needs the crosswalk polygons and markings for the
>    photoreal streets. Publish both in the tile schema through a request to Lane 2.
> 4. Do the rest of the wave-2 row, including the step-3 tiles, and then waves 3 to 8.
>
> Follow the README for branches, commits, pushes and draft PRs into `integrate/wave<N>`. Run
> every pipeline job under the memory rules. Regenerated tiles must be byte-identical under
> `--check`. Push at least hourly and keep your status file current.
>
> Stop and ask the owner before adding any data source whose licence isn't clearly open, and
> before raising a budget.

## What to build, by wave
Copy the exact deliverables from your track's row in `docs/roadmap.md`. Summary:

| Wave | Territory | Pipeline deliverables (summary) |
|---|---|---|
| 2 | Step 3: SoMa, Mission Bay, Rincon Hill, the Bay Bridge approach, plus the 3rd St / King St connector | Data spike: licences and procedural fallbacks for hydrants, fountains, sidewalks, crosswalks and signals, turn restrictions, car-wash and kiosk anchors, Muni routes and stops, cable-car track, parking regulations and Street Cleaning. The sidewalk navigation graph per tile. meshopt or Draco plus quantisation. Source snapshot dates pinned in `pipeline/areas.json`. Tile and world budgets. Step-3 tiles. A road connector from the Ferry Building to Pier 70 of at most 5.5 km. Citywide far-LOD massing. Hydrant and fountain points. Muni geometry. The Bay-edge refill polygon and the sea-wall collider. The Lefty O'Doul drawbridge deck from the overrides file. Car-wash and kiosk anchors. |
| 3 | Step 4: Russian Hill, Nob Hill, Chinatown, Telegraph Hill, Lombard | Step-4 tiles. Cable-car lines and stops (Powell–Hyde, Powell–Mason, California). Crest candidates for jumps. Parking regulations and Street Cleaning schedules, with sign text "Street Cleaning" and the data id `street_cleaning`. |
| 4 | Step 5: the Presidio, the Golden Gate Bridge approach, Pacific Heights, Cow Hollow | Step-5 tiles. Presidio forest roads. The Fillmore and Lyon St grades. |
| 5 | Step 6: Hayes Valley, Civic Center, the Tenderloin, the Western Addition, Alamo Square | Step-6 tiles. |
| 6 | Steps 7 and 9a: the Mission, the Castro, Noe Valley, Twin Peaks, Sutro Tower, Potrero and others | Step-7 and step-9a tiles, each gated on the budgets. The 22nd St and Twin Peaks crests. |
| 7 | Step 8: Golden Gate Park, the Richmond, the Sunset, Ocean Beach | Step-8 tiles. |
| 8 | Step 9b: the Excelsior, Glen Park, West Portal, Lakeshore, Visitacion Valley and the rest of the south | Step-9b tiles, the bridge deck and Treasure Island, each gated on the budgets. **The whole city is drivable.** |

## Done means
- Your rows' acceptance tests in `docs/roadmap.md` pass. Examples: the Ferry Building to Pier 70
  route is at most 5.5 km; a seeded drive over the 3rd St bridge keeps y above 3 m; every tile is
  within budget; no `*.glb` outside tile storage.
- The **world-continuity gate** (`docs/qa/`, from `qa/gate`) passes on every new tile. That means
  no hill through a roof, no gap under the downhill side, no walled streets and no ground
  mismatch between the renderer and the sim. Fixed defects stay hard assertions.
- `node pipeline/<build> --check` regenerates byte-identically. `pnpm verify` and CI are green.
- The territory-coverage test passes for every shipped district. You supply the data; Lane 5
  places the garages and activities.

## Hand-offs
- **To Lane 2:** additive tile-schema changes (`schemas/tile-*`) for sidewalks, crosswalks,
  signals and Muni, as a request with the exact JSON shape.
- **To Lane 3:** the sidewalk graph and the Muni routes and stops.
- **To Lane 5:** hydrants, fountains, car-wash and kiosk anchors, garage candidate sites, and
  parking data.
- **To Lane R:** crosswalk and marking geometry, curb lines, plaza polygons and tree species
  points, for the photoreal streets.

## Watch out for
- DataSF downloads need network access. If a host is blocked in your environment, list it in
  your status file for the owner. Cache everything in `pipeline/.cache/`; tests never download.
- The tile host limits: about 1.5 MB per tile on disk, and a 15 MB per-file limit for the static
  build, whose packer splits larger files.
- Pipeline runs are among the heaviest jobs. Run them alone under the lock.
