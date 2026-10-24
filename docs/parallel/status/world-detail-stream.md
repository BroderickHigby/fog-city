# World detail stream status

Stream id `world-detail`. Goal: street-level SF built from real open data and placed by the
pipeline (crosswalks, signals, stop signs, street-name blades, land cover, fences, real
trees, storefront signs). Coordinator session: `session_012u6jdJxkY41mYkqG3yG9Xk`.
Base: `origin/integrate/wave2` (`59e5a7b`, SIM_VERSION 13, release #67).

## Plan (one PR per feature, stacked: each branch builds on the previous)

| # | Branch | Feature | PR | State |
| --- | --- | --- | --- | --- |
| 1 | `work/world-detail/crosswalks` | Junction patches, continental/standard crosswalks, stop bars; Chestnut St regression test | #41 | **merged via #67** (closed as superseded) |
| 2 | `work/world-detail/signals` | Traffic signals and stop signs (SFMTA), render-only, lamps cycle from the tick | #52 | **merged via #67** |
| 3 | `work/world-detail/street-signs` | Street-name blades, one-way and kerbside parking signs (SFMTA `m48z-6ji4`) | #53 | **merged via #67** |
| 4 | `work/world-detail/landcover` | Lawns, fences/walls/hedges (Rec and Park, OSM), piers (OSM) | #54 | draft, merged with `59e5a7b`; diff is land cover only; **waits for owner ODbL sign-off and an OSM credit in the UI** |
| 5 | `work/world-detail/trees` | 135,647 real street trees (Public Works `tkzw-k3nq`); palms | #55 | **merged via #67** (DataSF part) |
| 6 | `work/world-detail/storefronts` | Icon-only storefront blade signs, blank sign slot, bar neon, barber pole | #84 (replaces #56) | draft on `59e5a7b`, independent of #54; local typecheck and 3,592 unit tests green; Actions blocked by billing |

## Findings

- **Crosswalk "sideways X" root cause.** SF GLB road ribbons carry `TEXCOORD_0` and the
  road shader (`src/render/materials.ts`, `ROAD_UV_FRAGMENT`) paints a dashed centre line
  along every ribbon. Each edge's ribbon runs right up to its end node, so at a junction the
  ribbons of every leg overlap and each paints its own dashes across the box: two crossing
  dash lines read as an X (or a chevron at a T). The ribbons also end square at the node,
  leaving notched corners. No crosswalk or stop-bar geometry exists for the SF world at all
  (the runtime `addRoad` crosswalks only run for tiles built without a glb road layer).
- DataSF datasets found and licence-checked (all PDDL 1.0, metadata read 2026-10-23):
  Continental Crosswalks `g9zy-srvv`, Traffic Signals `ybh5-27n2`, Stop Signs `4542-gpa3`,
  Street Signs `m48z-6ji4`, Street Tree Inventory `tkzw-k3nq`, Recreation and Parks
  Properties `gtr9-ntp6`, RPD Functional Areas `38b7-6db3` (Lawn, Boat Berth, Path…),
  RPD Linear Assets `rny7-88gk` (Fence, Gate, Handrail), RPD Assets `e3jj-mbb3`, Curb
  Ramps `ch9w-7kih`, Parking Meters `8vzz-qzz9`, Port Jurisdiction `gtk5-z9iw`.

## Coordination

- New producers only, in new files: `pipeline/build-street-detail.ts`, `pipeline/lib/street-*.ts`.
  Input is the committed `public/tiles/sf/roads.json` plus pinned DataSF snapshots; output goes
  to new files under `public/tiles/sf/street-detail/`. No existing generator is changed.
- Render-only placement first (no colliders, no SIM_VERSION change). New render files under
  `src/render/street-detail*.ts`; hook-up lines in `src/render/scene.ts` and the static build's
  file list in `scripts/build-web.ts` are listed in each PR body.
- Every placed object carries a stable id (for the Impacts stream's knockables).
- OpenStreetMap: the owner's local session pushed a pinned SF extract on `data/osm-sf`
  (`ec64af5`, sha256 `90f1a33c…`). PR 4 reads it with a small PBF reader and writes the
  OSM-derived data to its own file, `street-osm.json`, under the ODbL. That is the repo's first
  OSM data: the "no OSM" note in `docs/data-sources.md` and a visible "© OpenStreetMap
  contributors" credit need the owner's sign-off. (Replying to that session was not possible:
  this cloud session cannot message other sessions.)
- PR 5 adds a small placement API to `src/render/foliage.ts` (Lane R's file) so real trees
  reuse Lane R's tree look; palms are drawn by the stream's own `src/render/street-trees.ts`.

## Log

- 2026-10-23: started; baseline screenshots taken; root cause of the X found.
- 2026-10-23: PR #41 (crosswalks) opened as a draft. Branches 2 to 6 pushed with unit tests.
- 2026-10-24: screenshots of every feature committed (PNG; the privacy test bans JPEGs);
  draft PRs #52 to #56 opened. GitHub Actions jobs are not starting for any branch ("recent
  account payments have failed or your spending limit needs to be increased"): the owner must
  fix billing before any PR can be marked ready.
- 2026-10-24: Actions is running again. Merged `integrate/wave2` (`86dfb90`, SIM_VERSION 10) into
  the whole stack with merge commits, no conflicts. The top of the stack is green locally, and
  all six branches are pushed with CI running. Each PR is marked ready once its CI is green;
  #54 also waits for the owner's ODbL sign-off.
- 2026-10-24 01:48: #53 CI green, marked ready. CI is still running on #41, #52, #54, #55 and #56.
- 2026-10-24 04:30: release #67 merged #41, #52, #53 and the DataSF part of #55 into `integrate/wave2` (`59e5a7b`). I checked the merged result: the markings, furniture, signs and trees data are byte-identical to my branches, and the code differs only by the excluded land cover. #67 left `street-detail.json` reformatted, so `--check` reports it stale on the base; #84 regenerates it. Storefronts moved to #84 (new branch on the base, no OSM ancestry) and #56 is closed. #54 is merged with the base. Actions is blocked by billing again, so both PRs stay drafts with local evidence.
