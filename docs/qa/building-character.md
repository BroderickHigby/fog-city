# Building character and detail

Requested October 25, 2026: add more detail and uniqueness to the buildings.

## Visible result

- Neighboring buildings have coherent, repeatable architectural identities. Existing facade color, glazing, storey height and available construction-era data guide the style; missing data does not invent a real building's use or name.
- Historic stone, Art Deco, brick industrial, residential stucco and contemporary glass facades differ in their window shapes, framing, floor bands and entrance treatment. Variation belongs to each building, rather than changing with the camera or time.
- Nearby buildings have actual raised architectural detail and roof elements, with sensible scale and placement. Details follow the source wall coordinates and floor grid, including on hills.
- The original San Francisco footprints, building massing and hand-authored landmarks remain recognizable. Storefronts have no real brands or business names. New visual trim must not become an apparent obstacle in the street or at pedestrian height.
- Glass, masonry and trim remain legible in daylight, golden hour and at night. Thin detail filters away at distance instead of shimmering.

## Bounded rendering

Nearby geometry has explicit distance, building-count and triangle caps, shared materials and merged batches. Loading and rebuilding remain incremental. Removing a streamed tile or hiding its landmark-replaced building removes the corresponding detail and releases its GPU resources.

Existing packed world data and collision data remain unchanged. This change does not alter the simulation, saves, traffic, robotaxi driving or the targeting-only reticle. Historical simulation golden files stay intact.

## Evidence

Capture the same committed SF street and facade camera views before and after the change, including mixed downtown stone/glass, a historic low-rise street and SoMa. Record shader/page/load errors, draw calls, triangles and resource counts alongside the images. Include at least one night view and a tile unload/reload check. Check that both geometry and facade variation are visible in the actual packed build.

Verify real shipped GLB range decoding and world transforms, deterministic style/geometry generation, valid bounded geometry, landmark exclusion, lifecycle cleanup and shader compilation. Compare rendering counts against the documented budgets (1,500 calls and 3 million visible triangles); software-renderer frame rate is not a hardware-performance result. Run focused checks, typecheck and the packed static build. Keep existing full-verification and hosted-CI holds explicit.
