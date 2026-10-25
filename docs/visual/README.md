# Visual stream: the Ferry/Market slice, the renderer decision and the targets

The owner's brief (`docs/FOG_CITY_HANDOFF.md` §3) is Slop New York-level visual coherence for San
Francisco. This page gives three things:
- the repeatable slice that every visual change is judged on;
- the rendering approach and the evidence behind it;
- the hardware and performance target proposed for the owner's sign-off.

The stream's live status is `docs/parallel/status/visual-stream.md`.

## The Ferry/Market vertical slice

`tests/render/visual-slice.views.json` fixes eight cameras: position, height above ground, compass
yaw, pitch and lighting preset. They cover the Ferry Building plaza (golden and night), Market St,
a crosswalk close-up, the Embarcadero promenade, the Bay view of the skyline (golden and night) and
415 Mission from the street. All views use the renderer's 62° vertical FOV and the high tier
(`&gfx=high&shadows=1`). Weather is clear: the sim's fog is zero in this checkpoint.

```bash
export NODE_OPTIONS=--max-old-space-size=8192 E2E_PORT=4241
SLICE_OUT=docs/shots/visual-stream/<step> flock /tmp/fog.lock \
  pnpm exec playwright test --config tests/render/visual-slice.config.ts
# one or two views:  SLICE_VIEWS=ferry-plaza-golden,crosswalk-noon ...
# on a machine with a GPU:  SLICE_GPU=1 ... (drops the SwiftShader flags)
```

The run writes one 1920×1080 PNG per view and a `slice.json` with these figures per view:
- camera and lighting preset;
- draw calls and triangles;
- renderer resources (geometries, textures, shader programs);
- texture and render-buffer memory, from GL allocation accounting (`?gpumem=1`, `src/render/gpu-memory.ts`);
- median and 90th-percentile frame time over 30 frames.

Shots are committed as WebP (quality 88): `.jpg` is banned by the likeness privacy test, and PNG is ten times larger.

```bash
python3 -c "from PIL import Image;import glob,os;[(Image.open(f).save(f[:-4]+'.webp',quality=88,method=6),os.remove(f)) for f in glob.glob('docs/shots/visual-stream/<step>/*.png')]"
```

Under SwiftShader the frame times are software figures and say nothing about a GPU.

## Reference

The reference is <https://github.com/mrdoob/slop-newyork> (MIT code; NYC data under its own
licences). It was audited at `12593c9963f141665fe91881b1b4a2290db51d15`, the same commit as the
handoff's audit.

The live page (<https://mrdoob.github.io/slop-newyork/>) answers HTTP 200 from this environment. It
does not render here, though: the reference runs three r187dev `WebGPURenderer`, and this
container's Chromium WebGPU throws `Failed to execute 'createView' on 'GPUTexture'` (`swizzle` is not
a `GPUTextureComponentSwizzle`). The page stops at "Initializing Three.js r187dev WebGPURenderer &
TSL Shaders…". The repository has no screenshots. **There is no reference capture from this
environment.** The comparison is by technique (below), and the owner compares images on real
hardware.

What the reference does, by module:

| Area | Reference technique (module) |
|---|---|
| Sky, IBL | Preetham `SkyMesh` with clouds, calibrated to exposure 1; a live PMREM environment from it (`lighting.js`) |
| Sun shadows | `SunLight` 2-cascade CSM: 3072² per cascade, near cascade about 0.35–80 m, normal bias 0.05 m (`lighting.js`) |
| Fog | Aerial perspective tinted from the baked sky, not a flat `FogExp2` colour (`lighting.js`) |
| Grade | Exposure before bloom; ACES once; a cool-shadow/warm-highlight split; contrast about middle grey; a soft vignette (`post-processing.js`) |
| Facades | Procedural masonry and curtain wall. Ray-marched 3D room interiors behind the glass, with curtains, AC units and lit storefronts. Derivative bump; patterns filtered to their mean below a few pixels (`tsl-materials.js`) |
| Roads | Two-scale aggregate, patch pours, oil stains, crack seams, manholes. Puddles and a wet film with water Fresnel. Paint from the road network: lane lines, double yellow, stop bars, continental crosswalks, filtered over the pixel footprint (`tsl-materials.js`, `road-paint.js`) |
| Trees | Leaf-card atlas, wind, translucency, crown AO (`trees.js`, `tsl-materials.js`) |
| Street furniture | Signals, streetlights, hydrants and more as instanced meshes, split into spatial chunks with distance culling; position-only shadow stand-ins for big static casters (`street-details.js`, `scene-culling.js`) |

## Decision: WebGL2 + EffectComposer, techniques ported; WebGPU later as an opt-in path

Fog City keeps `WebGLRenderer` (three 0.186.1, pinned) and its `EffectComposer` chain as the
production renderer. The reference's techniques are adapted into it one at a time, each measured on
the slice. A WebGPU path is not added now. Reasons:

1. **It cannot be tested here or in CI.** CI and this container run SwiftShader WebGL. Chromium's
   WebGPU here fails on the reference itself (above). A renderer the gate cannot exercise would ship
   untested.
2. **The cost is a rewrite, not a switch.** The facade, ground, road, water and agent shaders are
   `onBeforeCompile` GLSL injections (`materials.ts`, `surface-textures.ts`, `water.ts`,
   `foliage.ts`). `WebGPURenderer` needs every one of them as TSL node graphs. The reference's own
   pin is the mutable three `dev` build, which is unsuitable for a stable game.
3. **The look comes from techniques, not the backend.** Everything in the table above has a WebGL2
   equivalent:
   - CSM in `three/addons/csm`;
   - PMREM from a sky scene;
   - fog chunks in GLSL;
   - interior mapping and filtered paint in fragment shaders;
   - instanced chunk culling on the CPU.
4. **Reach.** WebGL2 runs on every target browser, including software fallbacks. The game already
   steps down tiers on weak devices.

**Revisit when:** a GPU runner exists in CI (or the owner's hardware runs the slice), and a pinned
three release with a stable `WebGPURenderer` covers our features. The new shading code is written
as self-contained functions (hash/noise, interior mapping, filtered lines) so it can move to TSL
later. The sim stays independent of either choice.

## Proposed hardware, resolution and frame-rate target (for the owner's sign-off)

| Tier | Hardware class | Resolution | Target |
|---|---|---|---|
| high (`gfx=high`, auto on capable GPUs) | Mid-range discrete GPU or recent Apple silicon (RTX 3050 / GTX 1660 / Radeon RX 6600 / M1) | 1920×1080 at device pixel ratio 1 | 60 fps (16.7 ms), p90 frame under 20 ms |
| default | Integrated GPU (Intel Iris Xe / AMD 680M) | 1280×720 (or 1080p at 0.67 scale) | 30 fps (33 ms) |
| software | SwiftShader / llvmpipe | any | Correct images; no frame-rate claim |

Budgets per frame at the slice views, high tier:
- at most 1,500 draw calls;
- at most 6 M triangles;
- at most 512 MB of texture memory (GL accounting);
- at most 120 shader programs;
- the browser tab under 2.5 GB.

The baseline's measured figures are in `docs/parallel/status/visual-stream.md`. Every visual PR
reports the slice's figures against these budgets. Only a real-GPU run can confirm the frame-time
column.
