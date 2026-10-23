# Step 4: plaza trees, species, the 415 Mission crown

SwiftShader, `?gfx=high`, 1100x700.

The HUD's x/z (13.6, 67.0) is the player's parked car, not the camera. The fly camera is placed with `flyTo` at the listed coordinates.

| File | Camera | View |
|---|---|---|
| owner-golden.png | x -110.5, z 112.5, eye 2.4 m, heading 028°, golden | the owner's spot (x -106, z 108), moved about 6 m to clear the streetlight there |
| plaza-above.png | x -150, z 60, 30 m up, heading 060°, noon | Harry Bridges Plaza from above |
| mission415-street.png | x -215, z 555, eye 1.7 m, heading 220°, noon | 415 Mission from the street |
| skyline-bay.png, skyline-bay-night.png | x 450, z -150, 10 m up, heading 245° | the skyline from the Bay |

What changed since step 2:

- **Plaza trees.** Park and plaza trees that stand on the paving mask are thinned to a quarter, chosen by a stable hash of their position. The plaza is open paving again, with trees left near its edges and the palms on the median.
- **Species.** Two ash seeds and an oak: broadleaf crowns standing in for London planes. The aspen variant is gone, and with it the white bark and autumn-yellow leaves.
- **Leftover prop trees.** A tile's foliage node that straddles the showcase edge used to stay whole, leaving low-poly diamond and cone trees inside the radius. Each instance inside the radius is now scaled to nothing instead.
- **Bare trees** in the step-2 tower shots were rendered before the leaf-material fix.
- **415 Mission crown.** The open lattice is replaced by a solid screen in the lit material:
  - it carries the shaft on past the roof and rounds over to a blunt top;
  - it is pale by day and glows plain at night (no content).
- **415 Mission shaft.** Fins are 0.55 m wide and stand off the glass every 4.5 m, following the crown. The floor lines are toned down, so the shaft reads vertical rather than as a grid.

Measured (SwiftShader: calls and triangles only):

| View | Draw calls | Triangles |
|---|---|---|
| owner spot | 381 | 2.87M |
| plaza from above | 344 | 2.70M |
| 415 street view | 556 | 4.77M |
| Bay, golden / night | 760 / 868 | 5.2M / 5.1M |

Frame rate, feel and how it reads are the owner's call.
