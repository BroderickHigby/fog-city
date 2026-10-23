# Ferry showcase, step 2: trees, paint and the two towers

SwiftShader, `?gfx=high`, 1100x700. The HUD's x/z is the parked car's position, not the camera's.
The camera stands at the owner's spot (x -106, z 108, chase distance behind, moved 2 m sideways
off the streetlight that stands there).

| File | View |
|---|---|
| owner-noon.png / owner-golden.png | the owner's spot: ez-tree trees (MIT) replace the low-poly stand-ins inside the showcase |
| crosswalk-noon.png | the foot of Market St: worn but solid paint, raised kerb, CC0 asphalt (rendered before the leaf fix: its trees are bare) |
| mission415-street.png | the new 415 Mission tower (326 m) from the street (also before the leaf fix) |
| pyramid-street.png | the pyramid tower's window rows from Montgomery St (partly behind the block in front) |
| skyline-bay.png / skyline-bay-night.png | the skyline from the Bay with both towers; the night crown is plain light (before the leaf fix) |

Measured (SwiftShader: draw calls and triangles only):
- The owner's spot: 339-365 calls, 3.2M triangles. The trees add about 2M: 90 ez-trees nearest the camera.
- Street views of the towers: 430-590 calls, 5.1-6.6M triangles.
- The Bay: 750-850 calls, 5.5M triangles.

Next: thin the leaf cards further or add a tree LOD, better street views of the pyramid, and buildings
within the radius.
