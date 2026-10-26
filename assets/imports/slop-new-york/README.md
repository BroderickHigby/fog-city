# Slop New York rendering methods and attribution

Reference requested by the owner: [Slop New York](https://mrdoob.github.io/slop-newyork/).

Pinned source: [mrdoob/slop-newyork at 64ad03022bee9065a170ea286e2fd8e9d2b9a268](https://github.com/mrdoob/slop-newyork/tree/64ad03022bee9065a170ea286e2fd8e9d2b9a268), reviewed October 25, 2026 (local time). This updates the earlier reference review at `039a32796faf6ff914a07946b3d3d058d291e251`.

The source code is MIT licensed, copyright 2026 Mr.doob. The complete notice is retained in [LICENSE.md](LICENSE.md) and included in the packed game's `third-party-notices.txt` by `scripts/build-web.ts`. No new licence applies to Fog City's geographic data through this code reuse.

## Methods being adapted in the local renderer refactor

- WebGPU/TSL material and post-processing boundaries, physical sky/environment lighting and two-cascade sunlight.
- Filtered procedural masonry, facade/window framing, parallax room interiors and analytic height-based street-canyon ambient shading.
- World-metre asphalt/concrete shading, restrained reflections, bloom and a single final tone-map/grade.
- Spatially bounded architectural attachments and open, branch-driven foliage with leaf-spray coverage across distance levels.

Primary implementation references are `js/main.js`, `js/lighting.js`, `js/tsl-materials.js`, `js/post-processing.js`, `js/buildings.js`, `js/fire-escapes.js`, `js/trees.js` and `js/scene-culling.js` at the pinned commit. Fog City keeps its pinned installed Three.js package; the reference's moving `three.js@dev` CDN import map is not reused.

## Data boundary

No New York geometry, street graph, geographic database, business names, map labels, landmarks, character models or audio are imported. San Francisco source footprints, the existing street network, original vehicles and names, and their separately documented licences remain in place. The reference's NYC Open Data and OpenStreetMap/ODbL inputs are outside this adaptation.

## Evidence boundary

A source-method port does not by itself establish a visual match or performance parity. Fog City's actual backend, shader readiness, shadows, scene counts, lighting, fallback, gameplay and packed output must be checked on the resulting local build. Hardware FPS is a separate observation. Current work remains local until the complete request is ready for one consolidated PR into main.
