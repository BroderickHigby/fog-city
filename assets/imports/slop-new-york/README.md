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

## Targeted follow-up, October 26, 2026

The owner's follow-up retains **San Francisco, the existing characters, missions and robot interactions**. Current comparison source is [be65d0ab61b24718b6da8886b7d7bed2d68ac178](https://github.com/mrdoob/slop-newyork/tree/be65d0ab61b24718b6da8886b7d7bed2d68ac178). Its MIT notice is unchanged and remains included in packed output.

- `controllers.js` and `vehicle-physics.js`: adapt fixed-substep power/coasting, speed-sensitive steering, grip sharing and retained collision momentum for the versioned Fog City driving profile. Keep SF terrain, safe pedestrian settlement and our existing contacts.
- `cameras.js`: follow the moving vehicle in its own horizontal frame so uneven display frames do not add a changing trailing distance; retain Fog City's occlusion and hill support.
- `scene-culling.js` and `main.js`: freeze streamed SF tiles and use safe position-only building shadow stand-ins. Precompile the boot scene before starting normal rendering, then close the compiler queue. A tested attempt to overlap incremental async compilation with rendering caused an OOM in pinned Three r186 and was removed. Keep SF streaming; do not load a second city.
- `nyc-map.js`: reuse its static-geography/dynamic-overlay approach, road/footprint hierarchy, north-up radar, scale and legible route; build every layer from our existing SF data.

Our crowd retains its authored Rocketbox models, textures, skeletons and clips. A one-draw atlas prototype plus independent human detail admission fixes the model reversion; no reference pedestrian models replace our characters. Whole-game replacement, New York data and the moving development CDN are outside this targeted adoption. The benchmark records the reference's actual development engine version separately rather than treating unmatched city workloads as a speed comparison.

## Engine audio method, October 28, 2026

Source: [mrdoob/slop-newyork at 819a0ad](https://github.com/mrdoob/slop-newyork/tree/819a0ad), `js/audio-synthesis.js` (`combustionBuffers`, `createMotorVoice`), read with `js/audio-sources.js` and `js/audio-system.js`. Its MIT notice is the same as above.

Slop New York plays no recorded engine audio. It renders combustion loops in code: twenty four-stroke cycles of per-cylinder exhaust pulses (each cylinder a little stronger or later, each pulse jittered), with the exhaust's resonance kept in seconds, at two fixed rpms. It plays the two loops with proportional playback rates so their firings stay in step, and crossfades them at equal power by rpm, with a gearbox, a load low-pass and a mechanical layer on top.

`src/audio/vehicle-synth.ts` adapts that method and writes its own code for it: six rpm banks instead of two, an on-load and an off-load take of each, crossfaded by the load, a firing order, intake and valve layers, live saturation and exhaust resonances, and lift-off crackle. No audio file is imported. The gearbox stays Fog City's own (`src/audio/vehicle-sound.ts`).
