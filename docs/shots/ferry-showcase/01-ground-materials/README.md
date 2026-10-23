# Ferry showcase, step 1: ground, street and lighting materials

Rendered under SwiftShader (software WebGL, 1100x700) with `?gfx=high`, so frame rate is not meaningful
here. The owner judges look and feel on real hardware. HUD clock reads 18:52 in every shot (the lighting is set by `?tod=`).

## before/ (qa/housekit, default renderer, before this branch)
| File | View |
|---|---|
| owner-spot.png | the owner's spot: x -106, z 108, heading 028, eye height 2.6 m (fly camera standing in for the chase camera) |
| owner-spot-night.png | same, night |
| embarcadero.png | the Embarcadero roadway looking NNW |
| water.png | from the Bay, looking at the Ferry Building |

## after/ (feature/ferry-showcase, high tier)
| File | View |
|---|---|
| owner-golden.png / owner-noon.png / owner-night.png | the owner's spot at golden hour (the default), noon and night |
| crosswalk-noon.png | the crosswalk at the foot of Market St: CC0 asphalt with cracks, raised kerb, paint |
| median-noon.png | the Embarcadero median: pavers, palms and their shadows, the F-line trackbed |
| facade-noon.png | the Ferry Building's front with the CC0 sandstone (triplanar) |
| water-golden.png / water-night.png | the Bay with planar reflections |
| onfoot-noon.png | the player on foot (skinned founder-default body) with the animated crowd |

## What is in
- CC0 Poly Haven scans: asphalt_02, concrete_pavement, concrete_pavers_02, white_sandstone_blocks_02 and leafy_grass (logged in `public/models/textures/textures.json`).
- Lighting: N8AO ambient occlusion, bloom, 4K soft sun shadows and planar water reflections.
- Street detail: raised kerbs, crosswalks, stop bars, the F-line tracks and palms.
- People: the VAT crowd and the skinned player.

## Still procedural or placeholder
- Paint wear on the markings, palm models, the tile foliage (low-poly trees) and buildings other than the Ferry Building (house-kit facade shader).
- Cars, robots and the sky.

Measured (SwiftShader, so only draw calls and triangles mean anything):
- Owner's spot: 340-368 draw calls, 1.2-1.25M triangles.
- Median: 535 calls, 2.2M triangles.
- From the water, with the reflection pass: 765-868 calls, 3.7-3.8M triangles.
