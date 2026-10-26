# Street trees and road clearance — 2026-10-26

The old SF inventory admitted trees without checking the rendered carriageway. Tree
135582 was about 2 cm from the centreline of Drumm Street. The previous far foliage
also hung lower than the near model. Hiding instances alone would leave invisible,
solid tree props, so this change corrects the shared source inventory.

The offline producer now checks the actual near/far bark and foliage geometry and palm
matrices against road widths, extended road ends and encoded junction polygons. It
allows high crowns to overhang, but reserves the lower 4.5 m and a 0.35 m lateral
margin for the street. Terrain checks include the corners of every touched bilinear
heightfield cell; elevated roads keep their separate elevation. The conservative
envelope omits 87,413 records and retains 48,234. Remaining records preserve their
coordinates, heights, IDs and order, and feed both drawing and collision props.

Both foliage tiers now have raised branch/crown bases within the original prototype
height. Real-tree scale remains based on its recorded height. Simulation rules,
SIM_VERSION 19, progression saves and the procedural fallback worlds are unchanged.
This is a new SF world-data snapshot: historical SF replays need their original
world data, and the existing tree-count fingerprint distinguishes old clients.

Reproduce without downloads:

```sh
node pipeline/clear-street-trees.ts --world sf
```

This is byte-idempotent; normal `pipeline/build-street-detail.ts` applies the same
filter to future raw imports. The raw download cache was unavailable locally, so
the full raw-import `--check` was not run. The committed-output serialization and
count tests cover the regenerated files.

Local validation covers tree geometry, hills, road bends, junctions, all tree classes,
matching collision props, source heights, near/far silhouettes, destructible props,
legacy saves and progression storage. The static build remains within host limits.
The native-browser check compares the same Drumm and Ferry camera poses against the
previous build, including both foliage LOD geometries and palms.

The final native comparison found zero road-overlapping low vertices or triangles in
both views (240 trees in the 350 m Ferry sample). Tree 135582 was absent from both
drawn instances and the simulation prop lookup; sampled retained trees still had
their props. Both runs had no browser errors and a stable simulation hash while
moving only the camera. Reapplying the offline curation retained all 48,234 records
and produced byte-identical files.

A separate hill view at (-865, 330) covered 79 trees, including two conifers,
158 road segments and 72 junctions. All 25,789 clipped low-band triangles cleared
the roads across both detail levels; the screenshot retained sidewalk foliage.

Hosted CI was not run, as requested. The inherited sustained-performance/allocation
and 1 GB capacity hold remains open; these checks do not clear it.
