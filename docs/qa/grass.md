# Grass and lawns

Requested October 25, 2026: also add grass to the current local game.

## Visible result

- Real mapped lawns have a clear grass surface, including the small Ferry-area lawns and larger city park lawns. Grass has natural green/dry variation and short blade detail near the camera, with a clean appearance at distance.
- Use the existing city Rec/Park Functional Areas Lawn records only. Pin the reused snapshot and its provenance. No OpenStreetMap data or held OSM dependency is introduced.
- Turf follows the terrain. Polygon holes, paved paths, roads, buildings and the Bay remain clear. Blades stay short, grounded and contained; avoid z-fighting and floating edges.
- Preserve the building detail, cars, grounded people, robotaxi controls and contextual targeting reticle. No simulation, save-version, collision or road-graph changes.

## Rendering and evidence

- Grass uses at most 96 lawn patches, two draw calls and 80,000 triangles (60,000 for surfaces and 18,000 for blades). Surface selection stays within 550 m; nearby blade selection stays within 140 m and fades from 70 to 110 m. Update work is incremental. Dispose replaced/removed grass geometry and keep resource counts stable across warmed return visits. Missing optional grass data must leave a working game.
- Capture matched before/after views at the Ferry-area lawn and at least one larger lawn, including a close blade-height view and a path/boundary view. Check daylight and one golden-hour/night view, actual shader compilation and packed-asset loading.
- Record grass statistics, shader/page/load errors, world calls/triangles and tile lifecycle counts. Keep world rendering below 1,500 calls / 3M visible triangles and far terrain below 600k triangles. Software-renderer FPS is not a hardware result.
- Run meaningful grass data/geometry tests, typecheck and a packed static build. Independently review Standards and Spec at the exact pushed head. Keep inherited full-verification and hosted-CI holds separate from local preview evidence.
