# Render polish checkpoint

Branch: `lane/render-polish/wave8`, based on clean renderer `7bc823b` plus owner fix `1fbf6b7` (locally `4e8fdc4`). No broad QA branch, models, pipeline files or tile data were imported.

Draft PR title: `Render: bound software skyline loading and add player contact shading`

Draft PR body:

The software renderer previously loaded every city skyline cell at boot. Recognized CPU renderers now load nearest cells within 6 km, retain at most 24 cells within 8 km, discard stale in-flight regions, and dispose distant geometry as the camera travels. Native GPUs retain all-city loading. `renderInfo().farBudget` exposes the active radius, queue, loading and failure counts. Existing SF browser checks that require all cells should retain that condition for a null budget and check the settled current region for software rendering.

Player vehicles and walkers receive soft instanced contact shading (one draw call, up to 32 quads). Golden-hour fill is balanced against the direct light, and optional sun shadows move in small map-sized steps instead of 20 m jumps. Authored models and their style are preserved.

Validation: typecheck and 31 focused render tests passed. Regression coverage includes ordinary GPU detection, region switching, disposal, obsolete in-flight loads, contact transforms and bounded draw geometry. Two default-tier screenshots at 800×450, radius 300 m, pixel ratio 1 completed without browser/shader errors. The same scene/261 drawn agents changed from 86 calls / 166,401 visible triangles / 33 cached far cells (471,607 triangles) to 82 calls / 160,121 visible triangles / 17 cached far cells (225,351 triangles). These are draw/cache counts, not a frame-rate claim.

Images are local review artifacts under `/workspace/visual-review/{baseline,candidate}/day.png` and `day-canvas.png`; reports include measured counters. The visual change is deliberately modest and does not make the game photorealistic. Root reviewed the images and approved the bounded-loader checkpoint; a more visible material pass follows separately.
