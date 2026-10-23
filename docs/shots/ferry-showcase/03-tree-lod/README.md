# Step 3: street-tree LOD

`owner-golden.png`: the owner's spot (x -110.5, z 112.5, heading 028°, eye 2.4 m, `?gfx=high&tod=golden`).

Each ez-tree variant now has two builds. The 10 trees nearest the camera per variant get the near build (the step-2 tree). The next 20 get a far build: 35% of the branch sections, half the segments, and 18% of the leaves at twice the size, so the crown keeps its mass.

| | step 2 (`owner-noon`) | step 3 (`owner-golden`) |
|---|---|---|
| scene triangles | 3.16M | 2.48M |
| tree triangles (`renderInfo().gfx.treeTriangles`) | not measured | 424k (90 trees) |
| draw calls | 339 | 383 |

The two shots use different times of day, so the draw calls are not directly comparable: the golden-hour shot draws more shadow casters.

Frame rate and how the trees read are the owner's call; SwiftShader frame rates mean nothing.
