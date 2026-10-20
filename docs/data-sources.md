# Data sources and the world pipeline

The San Francisco world (`public/tiles/sf/`) is built offline from open data by one
command and committed. The game makes no network calls at runtime.

```sh
node pipeline/build-world.ts --world sf            # download (cached) + build + write public/tiles/sf/
node pipeline/build-world.ts --world sf --offline  # build from pipeline/.cache only; fail on a cache miss
node pipeline/build-world.ts --world sf --check    # rebuild in memory; exit 1 unless every file is byte-identical
node pipeline/build-world.ts --world sf --refresh  # re-download everything (DataSF reloads daily)
```

A cold run downloads about 70 s of data with at most 3 requests in flight, retrying
408/425/429/5xx with exponential backoff. A warm run takes about 3 s. Raw responses are
cached in `pipeline/.cache/http/` (gitignored, one file per URL plus a `.url` sidecar
naming it). The same cache always gives byte-identical output, and `--check` proves it.
The upstream datasets change daily, so a `--refresh` can legitimately change the output.

## Sources and licences

The DataSF licence of each dataset was read from its metadata
(`https://data.sfgov.org/api/views/<id>.json`, field `license`) on 2026-10-20. All four are
the **Open Data Commons Public Domain Dedication and License (PDDL) 1.0**
(<http://opendatacommons.org/licenses/pddl/1.0/>). The PDDL requires no attribution; we
credit the sources anyway. The strings are in `manifest.json` `attribution`.

| Data | Source | Fields used | Licence and credit |
|---|---|---|---|
| Building footprints and heights | DataSF *Building Footprints*, [`ynuv-fyni`](https://data.sfgov.org/resource/ynuv-fyni.json). Geometry `shape` (MultiPolygon). Queried with `intersects(shape, <tile-rectangle polygon>)` (`within_box` only returns footprints wholly inside the box), paged by `$order=sf16_bldgid`. | `sf16_bldgid`, `mblr`, `gnd_*cm` (ground NAVD88, cm), `hgt_*cm` (height above ground, cm) | PDDL 1.0. "City and County of San Francisco, DataSF" |
| Street centerlines | DataSF *Streets – Active and Retired*, [`3psu-pn9h`](https://data.sfgov.org/resource/3psu-pn9h.json). Geometry `line`. `active = true` only. | `cnn`, `streetname`, `st_type`, `classcode`, `layer`, `oneway`, `f_node_cnn`, `t_node_cnn` | PDDL 1.0. "City and County of San Francisco, DataSF" |
| Building year, use and storeys | DataSF *Assessor Historical Secured Property Tax Rolls*, [`wv5m-vpq2`](https://data.sfgov.org/resource/wv5m-vpq2.json). `closed_roll_year = 2025`, pinned in `pipeline/areas.json`. | `parcel_number`, `year_property_built`, `use_definition`, `number_of_stories`, `number_of_units`, `the_geom` | PDDL 1.0. "San Francisco Office of the Assessor-Recorder via DataSF" |
| Storefront anchors | DataSF *Registered Business Locations*, [`g8m3-pdis`](https://data.sfgov.org/resource/g8m3-pdis.json). Active rows only: `location_end_date`, `dba_end_date` and `administratively_closed` are all null. | `uniqueid` (hashed, never emitted), `self_reported_naics_code`, `location`. Names are never requested. | PDDL 1.0. "San Francisco Treasurer & Tax Collector via DataSF" |
| Elevation | USGS 3DEP bare-earth DEM, [ImageServer `exportImage`](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer), one uncompressed float32 GeoTIFF per area in WGS84 | metres NAVD88 | The service's `accessInformation` credit is "USGS National Map 3D Elevation Program (3DEP)". Its `licenseInfo` is empty. USGS-produced data are public domain under U.S. federal policy (17 U.S.C. §105). usgs.gov's policy page answered 403 from the build machine, so that last point comes from the policy and was not re-read. |
| Height corrections | `pipeline/overrides.json`: public-record heights for buildings newer than the LiDAR | `heightM`, with a `source` note per entry | Facts, cited per entry |

## Areas and tiles

`pipeline/areas.json` defines worlds. Each world lists areas as lat/lon bounding boxes, a
spawn rule, landmark probe points and pinned source parameters. Adding a neighbourhood is
a new area entry, not code.

**Every 500 m tile an area's box touches is built complete**: it gets every building whose
centroid lies in the tile, the full heightfield and every road crossing it. Areas therefore
never cut a block in half at a tile seam. Tile ids, the grid and the origin come from
`src/geo/project.ts`: `tileId(ix, iz)`, `TILE_SIZE_M = 500`, and the origin at the Ferry
Building clock tower.

| Area (`areas.json` id) | Milestone | Box N, W → S, E | Tiles | Buildings with centroid in the box (brief's estimate) |
|---|---|---|---|---|
| `downtown` | M0 | 37.805, −122.405 → 37.780, −122.385 | 28 | 1,664 (~1,617) |
| `north-beach` | M1 | 37.808, −122.417 → 37.797, −122.403 | 12 | 2,665 (~2,628) |
| `embarcadero-north` | M1 | 37.812, −122.425 → 37.795, −122.388 | 40 | 5,328 (~5,287) |
| `marina` | M1 | 37.810, −122.448 → 37.798, −122.425 | 20 | 3,251 (~3,204) |
| `dogpatch` | M1 | 37.766, −122.395 → 37.755, −122.385 | 9 | 746 (~754) |
| **world `sf`** | | | **77** (19.25 km², 14 all water) | **14,233** footprints in all tiles |

Dogpatch is an island: the tiles between it and downtown (SoMa, Mission Bay) are not in
any area. Adding one area would join it.

## Terrain

* **DEM request.** One `exportImage` per area covers the area's tile rectangle plus 150 m,
  at 0.000045° per pixel (about 4.0 m east–west and 5.0 m north–south). The ImageServer
  forces square pixels *in degrees*: if the requested `size` does not match the box's
  aspect, it silently stretches the box (we asked for north 37.805 and got 37.8082). The
  request therefore snaps the box to whole pixels, and the reader always trusts the TIFF's
  own `ModelTiepoint` and `ModelPixelScale`.
* **Reader.** `pipeline/lib/geotiff.ts` reads single-band float32 uncompressed TIFFs
  (strips or tiles, either byte order, PixelIsArea or PixelIsPoint). It rejects anything
  else loudly. No dependency.
* **Heightfield.** Every tile has a 51 × 51 lattice at 10 m (`x0 = ix·500`,
  `z0 = iz·500`, `cellSizeM = 10`). The edge rows and columns lie *on* the tile border.
  Each sample is a pure function of its world position: bilinear between DEM pixel centres,
  from the first area raster (in `areas.json` order) that covers it, rounded to cm. Two
  neighbours therefore compute their shared border identically, and a test asserts it.
* **Water.** Over the bay, 3DEP returns a hydro-flattened surface at almost exactly 0 m
  (tiny positive floats), bathymetry further out (down to −23 m) and about −1 m in some
  slips. Waterfront land (fill, pier decks) is 1–4 m. A sample is **water when below
  0.1 m**. Its height becomes 0 (sea level) and `ground.water[i] = 1`. `water` is an extra
  array beside `heights` with the same indexing. The collider schema allows it and the sim
  ignores it. 37 % of the world's lattice samples are water.
* Range: 0 to 114.8 m. The origin sits at 2.71 m and the ground at Coit Tower is 91.2 m.

## Buildings

**Footprints.** Outer rings only; courtyards and light wells are filled, and 529 rings had
holes. They are projected to local metres and rounded to cm, simplified with
Douglas–Peucker at 0.45 m, and nearly collinear vertices are dropped (11.7 vertices per
footprint on average, down from 21.9). Rings under 4 m² are dropped. Rings are ordered
**counter-clockwise on a north-up map**, i.e. a negative shoelace sum in (x, z).

**Ids.** The id is the DataSF `sf16_bldgid` (e.g. `201006.0000548`), so it can be searched
in DataSF and used in `landmarks.json` `replacesBuildingIds`. Extra parts of a multipart
footprint are `<id>-1`, `<id>-2` and so on (largest part first). A two-tier building's
tower is `<id>-tower` (see below). `report.json` `probes` lists the ids under named
landmarks:

| Probe | Building records |
|---|---|
| Ferry Building clock tower (origin) | `201006.0000058`, `201006.0000058-tower` |
| 415 Mission St tower | `201006.0000548` |
| 600 Montgomery St pyramid | `201006.0000687`, `201006.0000687-tower` |
| Coit Tower | `201006.0006230`, `201006.0006230-tower` |
| Saints Peter and Paul Church | `201006.0003946` (nearest, 9 m) |
| Pier 39 | `201006.0000037`, `201006.0000037-tower` |
| Palace of Fine Arts rotunda | `201006.0000986`, `201006.0000986-tower` |
| 315 Pennsylvania Ave (Dogpatch) | `201006.0010443`, `201006.0010443-tower` |

**Heights.** The footprint dataset's height statistics come from a **June 2010 LiDAR
survey** (the `201006` prefix and the `p2010_*` fields), even though the footprints
themselves are newer. For each footprint, in order:

1. **Override** (`pipeline/overrides.json`), keyed by `sf16_bldgid` and checked against
   the parcel. There is one: 415 Mission St (completed 2018), whose LiDAR median is 0.24 m
   (the 2010 site was the old Transbay ramps). It is set to its public-record 326 m roof.
2. **Assessor storeys** when the parcel was built in 2010 or later, has storeys, and the
   LiDAR median is below 2 m per storey (a construction site or empty lot in 2010). Also
   used when the LiDAR median is under 2 m but the assessor records storeys. The height is
   storeys × storey height (office 4.0, retail 4.5, industrial 5.0, hotel 3.4, residential
   3.2, otherwise 3.6 m) + 1.5 m. Used for 88 buildings.
3. **LiDAR** for the other 14,144:
   * If `hgt_max − hgt_median ≤ max(4 m, 0.3 × median)`, one prism at `hgt_max` (roof
     including parapets).
   * Otherwise **two-tier massing**, in 2,513 buildings: a podium at `hgt_median` over the
     whole footprint, plus a tower at `hgt_max` on the footprint scaled about its centroid
     to an area fraction `f = (mean − median)/(max − median)`, clamped to [0.04, 0.5]. This
     keeps the Ferry Building a three-storey hall with a clock tower rather than a 75 m
     slab.
   * A two-tier building is **two collider records**: `<id>` (the podium, `meta.tower`
     names the tower) and `<id>-tower` (`meta.towerOf`, `meta.podiumTopY`). Both have the
     same ground-level `baseY`, so a renderer that extrudes colliders draws the right
     massing. In the GLB, the tower starts on the podium roof.
4. Footprints with a LiDAR median under 2 m and no assessor storeys are dropped (69). They
   are not standing buildings in the source.

**Sitting on the ground.** Roofs are absolute: `topY = groundRef + height`. `groundRef` is
the LiDAR's own ground (`gnd_mediancm`), or the DEM when the two disagree by more than 3 m
(94 buildings: 2010 excavations, piers).

* `baseY` is the ground at the footprint's centroid as the sim computes it (bilinear over
  the heightfield), floored to cm. It is the building's street level.
* `meta.footY` is the lowest ground anywhere under the footprint, minus 5 cm. That is the
  minimum of the sim's bilinear surface *and* the rendered mesh's planar triangles, sampled
  every 2 m along each wall, at every lattice point inside, and at the centroid. On slopes
  the GLB's walls start at `footY`, so the downhill side never shows a gap. It can be up to
  14 m below `baseY` on Telegraph Hill. **A renderer that extrudes colliders should extrude
  from `meta.footY`**, not `baseY`.

**Assessor join (meta).** 97.1 % of kept footprints joined a 2025-roll parcel: 13,545 by
exact block/lot (`mblr` = `"SF" + parcel_number`) and 279 by a parcel point inside the
footprint. Of the kept footprints, 13,486 have a year built and 12,638 a storey count.

`meta` keys:

| Key | Meaning |
|---|---|
| `footY` | Lowest ground under the footprint, minus 5 cm |
| `heightM` | Height above the ground reference |
| `heightSource` | `lidar`, `assessor-stories` or `override` |
| `lidarM` | LiDAR `[median, max]` height |
| `parcel`, `year`, `use`, `stories`, `units` | From the assessor roll, when joined |
| `tower` / `towerOf`, `podiumTopY` | Two-tier pairing |

## Roads (`roads.json`, `schemas/roads.schema.json`)

* **Kept layers:** `STREETS`, `FREEWAYS`, `PRIVATE`, `PARKS*`, `STREETS_PEDESTRI`,
  `STREETS_*` (Treasure Island, etc.). **Dropped:** `PAPER`, `PAPER_FWYS`, `PAPER_WATER`
  (not real streets), `PRIVATE_PARKING`, `PSEUDO`, `UPROW` (unpaved, mostly stairways).
  66 segments were dropped this way.
* A segment is kept if any point along it lies in a world tile. Segments crossing the
  world's edge are kept whole, so their far ends lie outside the tiles.
* **Nodes** are the intersection CNNs (`n<f_node_cnn>`), placed at the mean of the segment
  endpoints that name them. Each edge's first and last points are snapped onto its nodes.
  A missing CNN gets a synthesised `p<x>_<z>` node (none in sf). `y` is the ground height
  at the node.
* **Edges** have id `c<cnn>`. `oneway`: `B` is two-way (a = from-node); `F` is one-way from
  → to; `T` is one-way to → from, so the edge is **reversed** (a = to-node, polyline
  reversed). Every one-way edge therefore flows a → b. Divided roads such as The
  Embarcadero are two one-way edges between the same nodes.
* Extra fields beyond the schema: `cnn`, `classcode` (source tracing), and
  `pedestrian: true` on `STREETS_PEDESTRI` (29 edges; not for vehicles).

**classcode → kind, lanes, width, speed.** `lanes` counts all directions on the edge.
`widthM` = lanes × lane width + extra (parking and shoulders), kerb to kerb.

| classcode (DataSF meaning) | kind | lanes two-way / one-way | lane m | extra m | limit |
|---|---|---|---|---|---|
| 1 Freeway | `freeway` | 6 / 3 | 3.6 | 3.0 | 50 mph |
| 6 Freeway ramp | `ramp` | 2 / 1 | 3.8 | 2.0 | 35 mph |
| 2 Major street/highway | `arterial` | 4 / 3 | 3.3 | 4.8 | 25 mph |
| 3 Arterial | `arterial` | 4 / 3 | 3.3 | 4.8 | 25 mph |
| 4 Collector | `collector` | 2 / 2 | 3.3 | 4.8 | 25 mph |
| 5 Residential (`st_type` `AL` → `alley`) | `residential` / `alley` | 2 / 1 · 1 / 1 | 3.2 · 4.0 | 4.6 · 0.5 | 25 · 15 mph |
| 0 Other (private, park roads; `AL` → `alley`) and `STREETS_PEDESTRI` | `other` | 2 / 1 | 3.0 | 0.5 | 15 mph |

sf result: 2,389 edges (1,578 residential, 380 collector, 281 arterial, 31 alley, 76
other, 24 freeway, 19 ramp), 1,570 nodes and 8 connected components. The largest has 1,370
nodes; Dogpatch is its own component.

## Storefronts (`storefronts.json`)

* NAICS kept: `722*` (food and drink), `44*`/`45*` retail (2017 and 2022 NAICS),
  `8121*` (personal care), `8123*` (laundry and dry cleaning). Excluded: `454*`
  (non-store retail: online, vending) and `7223*` (caterers, mobile food). Neither has a
  shopfront.
* Each anchor is assigned to the footprint containing its point, or the nearest within
  20 m (podium records only). It then gets a slot on a **street-facing wall**: a wall at
  least 3 m long, with a drivable non-freeway centerline within 30 m of it, 2.5 m of open
  ground in front, and the building right behind. Slots are 5 m apart. The anchor takes
  the nearest free slot and sits 0.3 m outside the wall, `heading` = compass bearing the
  shopfront faces.
* **No names, owners, addresses or registry ids** are ever requested or emitted. `id` is
  `sf-` + the first 12 hex digits of SHA-256(registry row id), stable across rebuilds.
* Fields: `id, x, z, y` (ground at the anchor), `heading`, `naics` (full code: storefront
  kits match on prefixes), `category` (coarse convenience label), and `buildingId`.
* sf result: 4,242 candidates → 2,817 anchors. 774 had a non-storefront code after the
  exclusions, 409 had no building within 20 m, and 242 had no free street-facing slot.

## GLB tiles (`tX_Z.glb`)

Written with `@gltf-transform/core` (vertex attributes interleaved). Positions are in the
**world frame** (local metres, the colliders' frame), and every node has an identity
transform. All 77 tiles pass the Khronos glTF validator with 0 errors and 0 warnings. The
only info notes are "TEXCOORD_0 may be unused": the UVs are for shaders, not textures.

| Node | Contents |
|---|---|
| `ground` | The heightfield as triangles split along the (i+1, k)–(i, k+1) diagonal. All-water cells are greedily merged into flat rectangles (an all-bay tile is one quad). `NORMAL` comes from central differences on the global lattice, so seams shade continuously. `COLOR_0`: water blue-grey, land warm grey. |
| `roads` | Surface road ribbons 0.15 m above the mesh ground, each side draped separately, densified to ≤ 8 m. `TEXCOORD_0` = (0 left kerb … 1 right kerb, metres along the edge, continuous across tiles). |
| `freeways` | Freeway and ramp ribbons, draped like roads. The source has no deck heights: they lie on the terrain, and stretches over the bay (the Bay Bridge) are not drawn. A separate node, so a renderer can hide it. |
| `buildings` | Every collider record in the tile, merged, with no normals (glTF loaders shade flat; three.js sets `flatShading`). `COLOR_0` is the facade colour, darker at the foot. `TEXCOORD_0` = (metres along the wall, metres above `baseY`); roof vertices use (x, z). `_FACADE` (three.js: `_facade`, normalized uint8 ×4) = (storey height / 8 m, glazing 0–1, (year − 1840)/190 or 0 if unknown, 1 on roofs). Node `extras.buildings` = `[[colliderId, firstIndex, indexCount], …]` in collider order, so a renderer can hide a building a landmark replaces. |

Materials are plain PBR (`metallic 0`, roughness 0.85–0.95) whose base colour multiplies
the vertex colour. Facade colours are chosen by use, year and height:

* pastel stucco for low-rise residential;
* sandstone or brick before 1945;
* concrete for 1945–1979;
* blue-grey glass for tall or modern buildings;
* brick or corrugated grey for industrial.

Each building gets a deterministic per-id variation. A tower shares its podium's colours.

## Manifest, spawn and report

* `manifest.json`: world `sf`, the origin from `src/geo/project.ts`, `tileSizeM` 500,
  the attribution strings, `roads: "roads.json"`, and per tile `id, ix, iz, bbox, collider,
  glb` plus `stats` (`buildings`, `roadEdges`, `waterFraction`, `maxTopY`).
* **Spawn:** on the street named in `areas.json` (The Embarcadero), at the point nearest
  37.7951, −122.3932, on a carriageway whose travel direction points toward
  37.7995, −122.3975. That gives x = 13.59, z = 66.97, heading 5.6451 rad (323°, NW): the
  northbound carriageway in front of the Ferry Building, on edge `c12553201`.
* `report.json`: build statistics (join rates, drops, height sources), the ten tallest
  records, the spawn and the probes. Deterministic, like everything else.

## Sizes

| Files | Bytes |
|---|---|
| 77 × `.glb` | 28.45 MB |
| 77 × `.collider.json` | 8.62 MB |
| `roads.json` | 0.65 MB |
| `storefronts.json` | 0.41 MB |
| `manifest.json` + `report.json` | 0.03 MB |
| **Total (M0 + M1)** | **38.17 MB** (36.4 MiB; the target was < 40 MB) |

## Determinism

Inputs are sorted by source id, coordinates are rounded to cm, JSON is written with a fixed
key order (one building, node, edge or storefront per line, so data changes diff as line
changes), and there are no timestamps. `--check` rebuilds from cache and compares every
byte. `tests/pipeline/build-fixture.test.ts` builds a synthetic world twice, in memory, and
compares SHA-256 of every file.

## Known limitations

* **The LiDAR is from 2010.** Buildings finished since then get assessor-storey heights,
  which are approximate (88 buildings), or an override (1). Buildings that replaced a
  different 2010 building on the same footprint keep the old height.
* **Two-tier massing is a model.** The tower's footprint is centred on the podium's
  centroid; the real tower may sit at a corner. Landmarks should be replaced by hand-made
  models.
* **Freeway and bridge decks** have no elevation in the source. The graph has them; the
  GLB drapes them on land and omits them over water.
* **Pier buildings** stand on water: the bare-earth DEM has no pier decks. Their roofs are
  at the LiDAR's absolute height.
* **The world's edge:** footprints and roads that straddle the outermost tiles extend past
  the last heightfield. The sim's ground outside the tiles is 0.
* `report.json` and the tests live with the data. `tests/schemas/schemas.test.ts` (harness)
  also validates every sf file against the schemas.

## Tests (`tests/pipeline/`, no network)

* `sf-world.test.ts`: goldens on the committed world:
  * schemas, tile grid, area coverage and the size budget;
  * the tallest building in the M0 box is the 415 Mission St tower at 325.1 m (within 10 %
    of 326 m), and 600 Montgomery St's LiDAR height is within 10 % of 260 m;
  * ground at the origin is a few metres up, the bay is water, Telegraph Hill is above 60 m,
    and tile borders are shared exactly;
  * every building's `baseY` is within 1 m of the ground under its centroid, and no
    footprint vertex has `footY` above the ground;
  * every road edge references existing nodes and starts and ends on them;
  * the spawn is on The Embarcadero, heading along it, and the sim drives 3 s from it
    without a hit;
  * storefronts face out of their building and carry no names or ids.
* `sf-glb.test.ts`: every tile through the Khronos validator and three.js's `GLTFLoader`;
  building ranges match the collider.
* `build-fixture.test.ts`: the whole build on a synthetic two-tile world. Byte-identical
  twice, plus every modelling rule above: oneway `T` reversal, layer drops, classcode
  mapping, two-tier pairing, the assessor-storey rule, overrides, footY on a slope, water,
  seams, storefront filtering and privacy, and GLB validity.
* `geotiff.test.ts`: the TIFF reader against TIFFs built byte by byte.
