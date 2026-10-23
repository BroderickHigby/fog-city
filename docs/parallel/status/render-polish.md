# Render polish checkpoint

Branch: `lane/render-polish/wave8`, based on clean renderer `7bc823b` plus owner fix `1fbf6b7` (locally `4e8fdc4`). No broad QA branch, models, pipeline files or tile data were imported.

Draft PR title: `Render: bound software skyline loading and add player contact shading`

Draft PR body:

The software renderer previously loaded every city skyline cell at boot. Recognized CPU renderers now load nearest cells within 6 km, retain at most 24 cells within 8 km, discard stale in-flight regions, and dispose distant geometry as the camera travels. Native GPUs retain all-city loading. `renderInfo().farBudget` exposes the active radius, queue, loading and failure counts. Existing SF browser checks that require all cells should retain that condition for a null budget and check the settled current region for software rendering.

Player vehicles and walkers receive soft instanced contact shading (one draw call, up to 32 quads). Golden-hour fill is balanced against the direct light, and optional sun shadows move in small map-sized steps instead of 20 m jumps. Authored models and their style are preserved.

Validation: typecheck and 31 focused render tests passed. Regression coverage includes ordinary GPU detection, region switching, disposal, obsolete in-flight loads, contact transforms and bounded draw geometry. Two default-tier screenshots at 800×450, radius 300 m, pixel ratio 1 completed without browser/shader errors. The same scene/261 drawn agents changed from 86 calls / 166,401 visible triangles / 33 cached far cells (471,607 triangles) to 82 calls / 160,121 visible triangles / 17 cached far cells (225,351 triangles). These are draw/cache counts, not a frame-rate claim.

Images are local review artifacts under `/workspace/visual-review/{baseline,candidate}/day.png` and `day-canvas.png`; reports include measured counters. The visual change is deliberately modest and does not make the game photorealistic. Root reviewed the images and approved the bounded-loader checkpoint; a more visible material pass follows separately.

## Material follow-up

Base: `lane/render-polish/wave8`. Head: `lane/render-polish/wave9`.

Draft PR title: `Render: add tiered pavement and car surface detail`

Draft PR body:

The street view previously showed unbroken flat pavement and almost black car glass. A shared, generated 256 KiB data texture now adds aggregate and fine repairs at world-metre scale. Native GPUs also receive gentle normal/roughness variation and concrete joints with distance fading. The player car retains its authored geometry and light materials, while private surface clones give its glass, paint, rubber and rims distinct responses.

Recognized software renderers use a single albedo texture sample, standard car materials and anisotropy 1. They skip clearcoat, normal/roughness detail and procedural slab calculations. `renderInfo().surfaceDetail` reports `full` or `albedo`. Full-detail appearance previews are under `/workspace/visual-review/surfaces/` and `/workspace/visual-review/surfaces-final/`; the final software path is under `/workspace/visual-review/bench-software/`. No asset, tile, simulation, input or main-entry files changed.

Typecheck and 32 focused render tests pass, including car geometry/light preservation, private material ownership and the standard-material software fallback. The compressed-tile loader test requires the existing loopback server and passed with that access. The final browser check also compiled all four full-detail surface shader programs in a small separate WebGL fixture; it reported no browser/shader errors.

The short initial warm comparison used the same 800×450 view, 4 near tiles, 17 far cells and 261 drawn agents. Previous checkpoint: 9 frames over 6.85 s, median 733 ms / p95 1,417 ms. Albedo candidate: 8 frames over 6.65 s, median 817 ms / p95 983 ms. Both drew 82 calls and 160,121 triangles with no browser errors. These small shared-cloud samples are insufficient to claim a native frame rate or a performance improvement. Full-detail native hardware performance remains unmeasured; the full path stays separate from software rendering.

Final albedo check after reducing software anisotropy: 8 frames over 6.32 s, median 783 ms / p95 883 ms. The debug simulation tick was 1 before and after the entire warm sample, proving the measurement did not include advancing simulation. Draw counts were unchanged and the diagnostic reported `surfaceDetail: "albedo"`. These remain short software-renderer samples, not a native performance certification.

Known visual follow-up: pipeline road ribbons sit 0.15 m above terrain (fallback ribbons 0.20 m), while physical body feet use the terrain/roof surface. This can hide lower tires and contact quads. A future sampler of the actual loaded road triangles should supply a bounded visual-only offset; a blanket body height change would be wrong off-road and on roofs. No physics height or collider was changed here.
