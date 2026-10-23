# San Francisco house feature kit

> **Evidence files.** The scripts, outputs and screenshots this document names (paths such as `critic/c2-drive-all.mjs`, `synth/h1-head-sim.mjs` or `houses/shots/h03-sunset-30th.png`) lived in the QA run's scratch space (`qa-world/`, outside the repository) and are not committed. The numbers quoted from them are the record; the gate (`world-continuity-gate.md`) re-measures them in the repository's own tests.

Fog City's houses have real massing: 175,595 footprints in the right places, roofs stepping lot by lot down the hills, and walls that reach the drawn ground. But as San Francisco houses they are not feature complete. Every house is the same extruded box with a flat roof, the same pastel and the same window grid, which is drawn on street fronts, party walls and rear walls alike.

This spec turns the houses audit (`qa-world/houses/`, verified in `qa-world/verify-houses/`) into a ranked kit. It covers defects W-15, W-29, W-36 to W-38 and W-46 to W-50 of `world-qa-report.md`. All of them are open on head 54ee728: the facade, material and geometry code is byte-identical to the audited build.

## The checklist today

The SF house checklist as scored by the houses audit (pass / partial / fail), with the kit item that fixes each line.

| Feature | Today | Evidence | Kit |
|---|---|---|---|
| Street-facing facade identified | fail | One `_FACADE` per building. Residential wall: 19.2% front, 47.2% party, 33.6% side or rear (7,529 km). 1,461,979 m² of exposed party wall is drawn with windows | K1 |
| Window grid matches storeys | partial | 63% of houses with storeys are drawn at 5 m or more per storey (95,269). Sunset/Parkside: 74% | K2 |
| Colour variety, Painted Ladies | partial | 96.7% of footprints use one pastel class; 34 colours, saturation ≤ 0.23; the Painted Ladies look like any row | K3 |
| Garage doors (Sunset, Richmond, Marina) | fail | 52,774 to 74,504 candidates, none drawn | K4 |
| Commercial ground floors | fail | 9,775 of 10,641 storefront anchors (91.9%) sit on walls with no shop glazing; `storefronts.json` is never rendered | K5 |
| Bay windows | fail | 46,283 houses from 1915 or earlier; none have bays | K6 |
| Raised entries, stoops, stairs | fail | 12,542 houses have a blank band of 3.5 m or more at the foot of the front; 2,499 have 5 m or more | K7 |
| Roofs: parapets, cornices, gables, rooftop kit | partial | 0 of 177,857 ranges have geometry above the flat roof; 90,110 houses have their flat roof at the LiDAR ridge height | K8 |
| Party walls (row houses touching) | partial | They touch in the source, but the pipeline opens 5 to 60 cm cracks: 82,927 pairs, 735 km | K0 |
| Stepped foundations on hills | partial | Walls reach the drawn ground, but 18 roofs lie under the hill (W-05), 479 parts span more than 10 m of relief under one roof (W-28), and facade storeys start at the centroid's ground (W-29) | K0, K2 |
| Era styles | fail | The only era cue is narrower sashes before 1910 | K2, K3, K6, K8 |
| Downtown curtain walls | pass | 467 glass-class buildings with storey-matched grids | - |
| Night window lights | pass | Houses are sparsely lit (2 lit windows on Liberty St) | K9 |
| Window artefacts | low | 48% of corners split a window; 21,321 rows are sliced by the roofline | K9 |

## Budget

The per-tile budget is 1.5 MB.
- Tiles today: p50 177 KB, p90 390 KB, max 532 KB.
- Residential tiles: 0.33 to 0.43 MB, which leaves at least 1.07 MB.

Costs by technique:
- **Shader features** (window grid, garage doors, door rectangles, parapet bands) cost about 0 bytes. They read per-vertex `_FACADE` data.
- **Splitting wall vertices per edge,** which is needed to give each wall its own class, adds about 40 to 60% to the buildings node: +80 to 150 KB per residential tile.
- **Instanced modules** (bays, stoops, shopfronts, rooftop props) need a per-tile anchor list, about 10 to 30 KB gzipped each, plus shared prototypes loaded once, as `src/render/props.ts` does for trees and lamps. Each prototype adds one draw call per tile.

| Kit | Bytes per residential tile | Draw calls per tile |
|---|---|---|
| K1 wall classes | +80 to 150 KB | 0 |
| K2 storeys | +0 to 4 KB (a street-level and storey-height pair per building) | 0 |
| K3 palette and trim colour | +15 to 25 KB (if trim needs a second colour attribute) | 0 |
| K4 garage doors | 0 | 0 |
| K5 storefronts | +10 to 30 KB anchors | +3 to 5 |
| K6 bay windows | +10 to 30 KB anchors | +3 to 5 |
| K7 stoops and entries | +10 to 20 KB anchors | +1 to 2 |
| K8 roofs (pitched roofs as geometry, parapets in the shader, roof props instanced) | +40 to 80 KB | +2 |
| **Total** | **≤ +360 KB, so residential tiles stay ≤ 0.8 MB** | **≤ +14** |

## Prerequisites (pipeline): K0

These come first, because every kit feature anchors to walls that touch, stand on the right ground, and know their street.

1. **Shared-edge simplification** (W-36). Snap vertices within 5 cm across neighbouring footprints, simplify each shared chain once, and reuse it on both sides.
   - **Test:** 0 touching-to-crack transitions in the four sample boxes (Sunset, Mission, Marina, Russian Hill), and a citywide crack count no higher than the raw data's.
2. **Terraced massing** (W-05, W-28). Split footprints with more than 6 m of relief into strips of 4 m relief or less, by ground terraces or condo units. Each strip gets its own base and roof.
   - **Test:** 0 roofs under the ground, and 0 drawn parts with more than 10 m of relief under one roof.
3. **Street level per building** (W-29). Store `meta.streetY`: the ground at the wall nearest a road edge.
   - **Test:** at most 1% of street-facing buildings have their first-storey line more than 1.5 m off the sidewalk (baseline 11.1%).

## The kit, ranked by how visible it is in play

The ranking assumes driving at 10 to 38 m/s with the chase camera. Viewed from a hilltop, roofs (K8) move up to second.

### K1 Wall classes: front, party, side and rear (W-46)

Prerequisite for K4 to K8.

- **Data:**
  - A per-wall class from the road graph and the neighbouring footprints. The method is `houses/12-frontage.ts`, and the pipeline's `storefronts.ts` `frontageWalls` already finds street fronts.
  - A wall is "party" where another footprint lies within 0.6 m along at least 60% of it.
  - A wall is "front" where a road centreline lies within roadHalfWidth + 12 m along its normal.
  - Expected: 140,924 houses have a front wall.
- **Technique:**
  - Split wall vertices per edge.
  - Encode the class in `_FACADE.w`: 0 rear, 85 party, 170 front, 255 roof.
  - The shader branches:
    - party walls are blank, with a slightly different stucco tone;
    - rear walls get fewer, smaller windows;
    - front walls carry the full kit.
- **Budget:** +80 to 150 KB per residential tile.
- **Test:** `tests/pipeline/house-kit.test.ts`:
  - On t-6_8, t-17_8 and t-7_4, party walls have 0 window texels.
  - The front class agrees with a hand-labelled 40-house block (a committed fixture) at 95% or better.

### K2 A believable storey grid with a garage or entry storey (W-15, W-29)

- **Data:** heightM, assessor storeys, year, use, district, `meta.streetY` (K0), and the LiDAR median against the maximum.
- **Technique (shader, with per-building values in `_FACADE`):**
  - Residential storeys = round((heightM - roof allowance) / 3.2), with each storey capped at 4.2 m.
  - Row houses from 1920 to 1960 get a ground garage storey of 2.4 to 2.8 m. They then show at least assessor storeys + 1 levels, because the roll leaves out the garage level.
  - The grid is anchored at the wall's own ground: `streetY` on front walls, local ground elsewhere. The first sill sits 0.9 m above the floor line.
  - Ignore assessor storeys when heightM / storeys exceeds 4.5 m (residential) or 6 m (other uses).
- **Budget:** about 0 bytes.
- **Test:** `tests/pipeline/facade-storeys.test.ts`:
  - Residential records drawn with storeys of 5 m or more: under 2% (baseline 61%).
  - Street-facing first-storey offset over 1.5 m: at most 1%.
  - Tour view 14 (30th Ave) shows a garage storey with 2 floors above.

### K3 Palette by era and district, with hand palettes (W-37)

- **Data:**
  - Year built, district, use.
  - A Content override list for the Painted Ladies on the 700 block of Steiner. The houses audit lists the candidate ids 201006.0052851, 0088534, 0110065, 0109792, 0112685, 0112735, 0093068, 0105612 and 0072707; the verifier confirms 7 records. Content fixes the final list.
- **Technique:** vertex colours, plus a trim colour.
  - **1915 or earlier:** saturated Victorian and Edwardian colours (saturation 0.3 to 0.6) with a contrasting trim.
  - **Marina, 1920s to 1930s:** cream and ochre stucco, with red tile at the roof edge.
  - **Sunset and Richmond, 1930s to 1950s:** pastels and white.
  - **1960s:** beige and concrete.
  - **After 1990:** greys, with more glazing.
  - Colours are picked by a lot hash and re-picked on a collision, so adjacent houses on a block face never match.
- **Budget:** 0 to 25 KB.
- **Test:** `tests/pipeline/house-kit.test.ts`:
  - At least 30% of pre-1915 houses have saturation 0.3 or more.
  - 0 adjacent pairs on a block face share a colour.
  - The override is applied to every Painted Ladies id.
  - Tour view 13.

### K4 Garage doors (W-48)

- **Data:** K1 front walls, plus year 1920 to 1960, plus 5 to 16 m of frontage, plus the row districts. That gives 52,774 candidates: Sunset/Parkside 16,816, West of Twin Peaks 7,985, Outer Richmond 4,577, Excelsior 4,282, Marina 1,882.
- **Technique (shader):**
  - On the ground storey of the front wall only: a 2.4 to 2.7 m wide by 2.1 to 2.3 m tall door with panel lines, offset to one side by the lot hash.
  - A darker driveway apron where the sidewalk ribbon exists (W-45).
- **Budget:** 0 bytes.
- **Test:**
  - On 30th Ave between Kirkham and Lawton (37.75865,-122.48885), at least 90% of houses show one garage door at sidewalk level.
  - 0 doors on party walls.
  - Tour view 14.

### K5 Storefronts on commercial corridors (W-47)

- **Data:** the `storefronts.json` anchors (10,641: wall, heading, NAICS category), mapped to the Content storefront kit. Add `storefronts` to `manifest.layers`.
- **Technique:**
  - One instanced shopfront per anchor: a 5 m glazed bay, 3.5 to 4.5 m tall.
  - An awning shape by category.
  - An empty sign slot, with iconography only: no names, logos or brands, per `CLAUDE.md`.
  - Shop glazing on the anchor's wall only.
  - The civic landmarks lose the shop band they get today (City Hall, Mission Dolores).
- **Budget:** +10 to 30 KB anchors, and 3 to 5 prototypes.
- **Test:** `tests/render/house-kit.test.ts`:
  - An instance for every anchor within 300 m of the camera.
  - At least 95% of anchors sit on walls with shop glazing (baseline 8.1%).
  - Mission St from 16th to 24th shows continuous shopfronts (tour view 17).

### K6 Bay windows (W-49)

- **Data:**
  - Front walls of 4.5 m or more on residential buildings from 1925 or earlier, with their storeys: 46,283 houses.
  - Where the DataSF footprint already includes the bay (201006.0052851, a 1.25 x 2 m projection on Steiner), skin that prism as a bay instead of adding one.
- **Technique:**
  - 3 to 5 instanced prototypes: angled Italianate and Queen Anne, square Edwardian, and a corner turret, 0.6 to 1.0 m deep.
  - One bay per 7.5 m of front, on storeys 1 to n-1. They start at the second floor, so they clear the sidewalk.
  - Cosmetic only: no collider change.
- **Budget:** +10 to 30 KB anchors, and 3 to 5 prototypes.
- **Test:**
  - On Liberty St (37.75733,-122.42275) and Steiner 710 to 722, every pre-1915 house with a front of 4.5 m or more has at least one bay.
  - At 20 m the bays break the roofline silhouette (tour views 12 and 13).

### K7 Stoops, entry stairs and doors (W-50)

- **Data:** the front wall's ground (`streetY`) against the first-floor height from K2.
- **Technique:**
  - An instanced parametric stair of 5 to 12 risers wherever the first floor is more than 1 m above the sidewalk. On slopes the stair follows the sidewalk grade.
  - A door rectangle in the shader.
  - A downhill plinth gets a garage or entry storey instead of a blank band.
- **Budget:** +10 to 20 KB anchors, and 1 to 2 prototypes.
- **Test:**
  - No front wall has more than 2.5 m of blank band (baseline: 12,542 with 3.5 m or more).
  - At least 90% of pre-1940 houses with a raised first floor show a stoop (tour views 12 and 16).

### K8 Roofs: parapets, cornices, false fronts, gables and hips, rooftop kit (W-38, HOUSES-14)

- **Data:** year, use, row or detached (from the K1 party share), the footprint's oriented box, the LiDAR median (eaves) and maximum (ridge), and the front walls.
- **Technique:**
  - **Flat-roof rows and Victorians:** a parapet band (0.6 to 1.0 m) and a cornice along the front wall, with false fronts on pre-1915 rows. These are shader bands plus one thin extruded strip per front wall.
  - **Detached houses and Sunset rows:** hips and gables from the oriented box, with the eaves at the LiDAR median and the ridge at the maximum. The collider keeps its flat `topY`, and no roof vertex rises above `topY + 0.1 m`, so collision still matches what is drawn.
  - **Commercial and tall residential:** instanced water tanks and mechanical boxes.
  - The 485 centred roof boxes on low houses (L-15) are reviewed with this item.
- **Budget:** +40 to 80 KB, and 2 prototypes.
- **Test:**
  - At least 80% of detached and Sunset houses get a pitched roof with the ridge within 0.5 m of the LiDAR maximum and the eaves within 0.5 m of the median.
  - Every flat-roof row front has a parapet or cornice.
  - 0 roof vertices above `topY + 0.1 m`.
  - Aerial tour views 14 and 3.

### K9 Polish: window artefacts and night occupancy (L-14)

- **Technique:**
  - Snap window columns to wall ends, so a corner never splits a window.
  - Stop window rows below the roofline.
  - Measure the ground-floor mask from `streetY`.
  - Night: occupancy by use and hour, so residential streets show more than 2 lit windows per block.
- **Test:**
  - Fewer than 5% of corners split a window (baseline 48%).
  - 0 rows sliced by the roofline (baseline 21,321).
  - Night tour view 3 shows at least 1 lit window per 3 houses.

### K10 Landmarks: interim shapes until the models land (W-25, W-27; Assets with Pipeline)

- **Data:** the places-table probe ids.
- **Technique:**
  - Tag landmark records `meta.landmark`, and draw them with glazing 0 in a stone or white palette.
  - Interim shapes: a tapered Transamerica; Coit as a fluted 64 m column; City Hall with a dome; the Palace of Fine Arts rotunda; Grace Cathedral's twin spires.
  - Fort Point keeps its podium (W-16).
  - Sutro Tower: a three-leg lattice proxy.
  - Dragon Gate as a small instanced prop.
  - Models follow the roadmap waves.
- **Test:** `tests/assets/landmarks.test.ts`:
  - Every places-table landmark has a model or a documented interim shape with no office window grid.
  - Sutro's top is at least 290 m above the ground.
  - Coit is within 5% of 64 m.
  - At 200 m height, the Transamerica silhouette is narrower than 40% of its base.

## Order of work and owners

1. **Pipeline:** K0 (cracks, terraces, `streetY`). Then the K1 wall classes and the anchor lists for K5, K6 and K7. Then the storey and palette data for K2 and K3.
2. **Render:** K2 and K4 in the shader, which costs no bytes and is the most visible. Then the K1 shader branches, K3 colours, the K5, K6 and K7 instancing, the K8 parapets and cornices, and K9.
3. **Assets:**
   - Prototypes: bays (3 to 5), stoops, shopfront and awnings (with Content), rooftop props.
   - K10 landmark proxies.
4. **Content:** the era and district palettes, the Painted Ladies override, the storefront kit by category, and the landmark tags.

Each step lands with its test in `world-continuity-gate.md`, and with the tour views named above, shot before and after.

No wave in `docs/roadmap.md` schedules house-kit or storefront rendering today; the only facade item is the wave-5 Painted Ladies facade set. Scheduling K0 to K4 in the next render and pipeline waves would fix the two most visible problems on every residential street: the storey grid and the single palette.
