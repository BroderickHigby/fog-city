# Original Fog City landmark recovery

These are original project-generated models, recovered selectively from commit
`451f4dc7beba9b81420bfb4f8b7a33ee2754dec0` in this same repository. No external
model library, photograph texture, brand logo or OSM data is imported. The models
are simplified authored architecture, not photogrammetry or a claim of survey accuracy.
The manifest records exact source/ref and runtime byte hashes. Project ownership
and DataSF site measurements are the source basis; this recovery does not assert
that every historical file carries an external MIT asset licence.

The present Palace of Fine Arts, Ferry Building and R-evolution assets and their
placement/collision remain intact. The recovered dedicated Coit Tower, Salesforce
Tower (historical filename `415-mission.glb`) and Transamerica Pyramid
(`600-montgomery.glb`) use their original DataSF footprints. City Hall, Sutro Tower,
Grace Cathedral, Mission Dolores, Conservatory of Flowers, Dragon Gate, Sutro Baths
and bridge silhouettes extend the named coverage. The old generic building IDs
are hidden in both near and far rendering only after a model loads. Existing
world collisions remain authoritative. Bridge visuals do not clear the inherited
span/support, route or crest-launch holds.

`source/` retains the exact historical procedural generators, helper and DataSF
site packet. Their layout is preserved for inspection. Regeneration must run in
an isolated historical source checkout with Blender 4.5 LTS and select only the
wanted functions (`coit`, `mission415`, `montgomery`, etc.); do not run the entire
old landmark generator into the current public directory: its obsolete Palace
would overwrite the modern open-arch model. Only optimized selected GLBs live in
`public/models/`. No build script invokes Blender or copies this source archive.

Map destinations for recovered models use a measured nearby dry, unobstructed
SF sidewalk node instead of a solid building's centre. Such a point is a viewing
candidate until the final route/browser checks prove reachability and sightline.
