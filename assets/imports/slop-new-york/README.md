# Slop New York rendering reference

Source: [Mr.doob / Slop New York](https://github.com/mrdoob/slop-newyork)

Reviewed commit: [`039a32796faf6ff914a07946b3d3d058d291e251`](https://github.com/mrdoob/slop-newyork/tree/039a32796faf6ff914a07946b3d3d058d291e251), retrieved 23 October 2026.

Live reference requested by the owner: <https://mrdoob.github.io/slop-newyork/>.

The source project code is MIT licensed, copyright 2026 Mr.doob. Its exact licence notice is retained in [LICENSE.md](LICENSE.md). This attribution does not extend that licence to the source project's geographic data or to third-party assets and dependencies.

## What Fog City uses

Fog City's `src/render/quality.ts` draws on the reference's `js/post-processing.js` approach to restrained highlight bloom, contrast around middle gray, saturation, and subtle vignette. These ideas and grading formulas are implemented in Fog City's WebGL post-processing chain using Three.js `EffectComposer`, `OutputPass`, and FXAA. The reference uses a WebGPU/TSL render graph; its complete module was not copied into Fog City.

Source review also informed the choice of coherent sun/sky/environment-light presets, clearer façade recesses, and detailed foliage. Fog City's implementations remain adapted to its existing renderer, streamed world and simulation. This is a rendering reference and attribution record, not a claim that the two projects share a renderer or equivalent visual results.

## Data boundary

No New York City geometry, street network, geographic data, map labels, landmarks, textures, character model or audio was imported from Slop New York. Fog City retains its San Francisco world data and its separately documented asset sources. Slop New York's README attributes its geographic data to NYC Open Data and OpenStreetMap contributors under their respective terms; that data is outside this reuse.

## Verification boundary

The direct live URL was blocked by this environment's outbound network policy. The pinned source was available from GitHub and reviewed locally. The exact reference could not be rendered successfully in the current software-GPU environment, so this work does not claim a verified side-by-side visual match, performance parity, or equivalent WebGPU support. Fog City's own screenshots and QA results are recorded separately against its build.
