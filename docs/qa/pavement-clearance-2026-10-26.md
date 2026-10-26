# Pavement and grass — 2026-10-26

The older preview on port 5175 predates the literal DataSF lawn layer. Its broad
green surfaces come from park-district terrain coloring. The same park tint path
was still active in the current build without excluding paved footprints.

A current native-browser witness on Spreckels Lake Dr at
(-8476.1225, 2621.7275) found green terrain at 47.644484 m and the actual rendered
asphalt at 47.382911 m. The green surface was about 26 cm above the road.
The literal lawn layer had no surface at that point. Current Ferry-area lawns
already excluded roads, sidewalks and junctions in the independent geometry probe.

This change protects every vertex of terrain triangles intersecting paved
footprints, including roads, sidewalks, junctions and buildings. The mask includes
one 100 m far-terrain cell outside park bounds, preventing green interpolation
onto neighbouring pavement. Only masks near parks are retained in the spatial index.

The road repair splits affected ground-level pavement triangles along the same
heightfield cells and diagonals as the visible terrain. It preserves paint, UVs,
normal attributes, material groups and draw ranges. Existing positive surface
offsets are retained; slightly embedded vertices receive a 2 cm minimum offset.
Bridges, walls, unsupported/missing terrain and work exceeding explicit bounds
retain their supplied geometry. The repair runs once when a tile is admitted,
including the fallback path. Fields are selected using the road mesh's bounds and
deduplicated by lattice, so long fallback edges and separate collider copies work.
Fallback roads sample the actual terrain triangles rather than the bilinear field.

All changes are in rendering and tests. Simulation rules, saves, the city inventory
and SIM_VERSION 19 are unchanged. Existing authored lawns remain enabled. There is
no new per-frame pavement loop, download or dependency.

Validation includes indexed/non-indexed and transformed geometry, normalized
attributes, material groups, idempotence, bridge preservation, missing terrain,
output bounds, narrow roads between vertices, park edges, fallback field deduplication,
long fallback roads, grass exclusions and startup readiness. The static build is
185.8 MB, within the existing host budget.

Final native witness: asphalt is at 47.792875 m and visible terrain at 47.644484 m,
so pavement now clears the terrain by 0.148391 m. Under-road terrain keeps its
original neutral color; two of three nearby park samples retain green. The actual
road mesh has 3,702 triangles. One observed JavaScript heap sample was about
819 MiB; this is a point observation, not a memory plateau or capacity result.
The screenshot and geometry assertions completed without browser errors. The
browser-close call stalled after capture; the exited browser's remaining helper
and crash reporter were terminated, releasing the serial QA lock.

The final focused test run passed 86 tests across 9 files. Local evidence is kept
separate from hosted checks.

Hosted CI is skipped at the owner's request. The inherited sustained-performance,
allocation and 1 GB capacity hold remains open; bounded visual checks do not clear it.
