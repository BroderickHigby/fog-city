# World detail stream status

Stream id `world-detail`. Goal: street-level SF built from real open data and placed by the
pipeline (crosswalks, signals, stop signs, street-name blades, land cover, fences, real
trees, storefront signs). Coordinator session: `session_012u6jdJxkY41mYkqG3yG9Xk`.
Base: `origin/integrate/wave2` (`ff7db5b`, SIM_VERSION 8, GAME_WAVE 3).

## Plan (one PR per feature)

| # | Branch | Feature | State |
| --- | --- | --- | --- |
| 1 | `work/world-detail/crosswalks` | Junction patches, continental/standard crosswalks, stop bars; Chestnut St regression test | in progress |
| 2 | `work/world-detail/signals` | Traffic signals (SFMTA `ybh5-27n2`) and stop signs (SFMTA `4542-gpa3`), render-only, phase from the tick | not started |
| 3 | `work/world-detail/street-signs` | White-on-green street-name blades, one-way and parking signs (SFMTA `m48z-6ji4`) | not started |
| 4 | `work/world-detail/landcover` | Lawns (RPD `38b7-6db3`, NPS for Fort Mason/Presidio), fences (RPD `rny7-88gk`), Marina waterfront | not started |
| 5 | `work/world-detail/trees` | Street trees (Public Works `tkzw-k3nq`) by species class and size | not started |
| 6 | `work/world-detail/storefront-signs` | Icon-only storefront signs from `storefronts.json` (no names, design.md) | not started |

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
- No OpenStreetMap needed so far.

## Log

- 2026-10-23: started; baseline screenshots taken; root cause of the X found.
