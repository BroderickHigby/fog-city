# Additive structural-world renderer candidate

Branch: `qa/world-render-integration`, based on core `6f1d91b`.

This branch integrates the visual parts of the Ferry/world work without replacing the current gameplay entry point, generic human avatar, civilian car, HDR sky, quality controls, or existing surface scans. It is a candidate for the new structural world, not a release certification of that world. The combined QA checkout uses world checkpoint `76c1bc0` and temporary `main.ts` wiring; that wiring is intentionally not committed here.

## Main integration contract

Import `houseKit` from `virtual:fogcity-assets` and pass it as `RenderOptions.houseKit`.

Pass these loaded values to `SceneRenderer`'s `WorldData`:

- `boundary: files.boundary` for quay/shore detail.
- `sidewalks: files.sidewalks` for raised sidewalk bands. Readonly pipeline graphs are accepted.
- `storefronts: storefrontDoc.storefronts`, loaded from `tiles/<world>/storefronts.json` with an empty-list fallback. A storefront has `id`, `x`, `y`, `z`, `heading`, `naics`, `buildingId`, and optional `category`.
- `cameraGround: (x, z, nearY) => surfaceAt(world, x, z, nearY, false).y` when the new structural core is available. This prevents chase and fly cameras in a tunnel from snapping to the hill above it. Older worlds may omit it and keep the previous terrain clamp.

The renderer reads `world.bakedGround ?? world.manifest.rendering?.bakedGround ?? false`. Set the producer's manifest marker when the tile colours and far seams are authoritative. This disables only the legacy runtime park tint and seam mutations for that world.

An explicit house palette override is optional. `houseLookFn(colours: HouseColours | null): LookFn` is exported from `src/render/house-colours.ts`; the renderer already constructs its default from collider building metadata and districts. `LookFn` is exported from `src/render/house-kit.ts`.

## Included changes

- New facade flags and house geometry migrate together: rear `0`, party `85`, front `170`, roof `255`. Near houses gain bays, stoops, cornices, roof detail, palette variation, and shopfronts.
- Drawn triangular ground sampling, tunnel clipping/portals, bridge structures, skirts, lake water, quays and raised sidewalks integrate with streaming and avatar-ground indexing. Missing GLBs retain tunnel cuts and structures, including colliders without a heightfield.
- Optional Ferry detail adds scanned sandstone/plaza materials, crosswalk paint, F-line track detail and palms. Shared fog/light uniforms and scanned-material hooks remain intact; asynchronous disposal closes completed textures even after teardown.
- Detailed foliage accepts both legacy `street-trees-0/1` and baked `foliage-broadleaf/conifer` instances. Baked unit-prototype crown width/height are normalized per LOD, preserving world roots, tint and instance transforms. The existing near/far budgets and eight-draw limit remain.
- Late house-kit meshes receive shadows. Late ground materials receive shared surface scans and unregister on disposal.
- Hosted builds include house metadata, detail textures, and storefront JSON; the licensed generic avatar remains included and the retired personal likeness remains excluded.

## Validation

- Combined core/world/render TypeScript check passed before the final camera addition.
- 467 focused rendering, content, schema and model tests passed.
- The later foliage and hosted asset round-trip tests passed: 20 tests. The hosted world is built twice, compared byte-for-byte, and decoded over HTTP; new house/texture/storefront assets are explicitly checked.
- First software-Chromium run passed all four views with no page/shader errors and unchanged simulation hash. It exposed the baked-tree name mismatch, now fixed. The original Broadway street view was not inside the tunnel and is not tunnel-visibility proof.
- The second software-Chromium four-view run with the tree fix passed in 3.0 minutes, with no page/shader errors and unchanged simulation hash. The Ferry Building, Alamo houses, Broadway street and Stow Lake captures were inspected.
- The final height-aware camera addition has two focused unit tests and a dedicated tunnel-interior browser probe, but these have not run. Its queued check was canceled before acquiring the shared test lock so the coordinator's safe-gameplay version checks and release QA could proceed. This is an explicit remaining verification item; no tunnel-interior visual pass is claimed.
- Independent read-only review confirmed fallback tunnel clipping, late kit shadows, shared atmosphere uniforms, mask-only material coverage and texture lifetime handling.

The representative [before/after Ferry pair](../../shots/world-integration/README.md) is committed with explicit unreleased/software-rendering labels. Other QA images are under `/workspace/fog-city-world-render-qa/test-results/`; the before-tree screenshots were copied to `/tmp/fog-world-render-before-foliage/`.

To rerun the new-world browser probes after wiring the contract above, use `E2E_PORT=4224 pnpm exec playwright test --config tests/render/world-integration.config.ts --workers=1`. The tunnel test can be selected with `--grep 'height-aware camera'`.

## Remaining limits

This candidate does not certify the new world's strict geometry/coverage gate, mission integration or production deployment. The coordinator keeps the existing physical world for the safe runtime release while generated-world failures are addressed separately.

The world still has coarse lake shore silhouettes from heightfield cell coverage and simple distant building forms. Removing cone/diamond trees is an integration fix, not a claim that the game now matches a modern AAA visual target. Software-renderer frame rates are not hardware performance evidence.
