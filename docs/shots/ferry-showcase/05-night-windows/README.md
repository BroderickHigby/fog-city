# Step 5: lit windows at night

SwiftShader, `?gfx=high&tod=night`, 1100x700. Same camera as step 4's Bay view (x 450, z -150, 10 m up, heading 245°).

| File | View |
|---|---|
| before-skyline-bay-night.png | step 4: the towers are dark slabs |
| skyline-bay-night.png | now: lit office floors on the towers |
| near-night.png | near the foot of Market St (x -205, z 143, eye 1.7 m, heading 235°, under the park's trees): window-by-window lighting up close, unchanged |

What changed:

- **Near tiles** (`facade-shader.ts`). Past the distance where windows average out, the glow used to be a flat 12% of the window share, so downtown went dark. It is now drawn in strips: each storey's 24 m run of windows is either on or nearly dark, picked by a hash of the wall and position.
  - Every building type uses the same rule: the average lit share is the type's own (offices 25%, houses 42%, others 30%).
  - Up close, the per-window rule (clusters, blinds, three light colours) is unchanged.
- **Far skyline** (`far-layer.ts`). The window dots now cluster in blocks of a few storeys and bays, so blocks are mostly on or mostly off, and they are a little brighter.
- Bloom is unchanged: the night preset's bloom picks up the lit floors.

Draw calls and triangles are unchanged, because this is a shader-only change. Whether it is too bright or too busy is the owner's call.
