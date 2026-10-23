# World collider pack (`world.colliders.bin`), format FCWC version 1

Everything the sim collides with, for the whole world, in one binary file: every tile's
ground heightfield and water mask, every building's footprint and heights, and (in the
extension block) building pieces and undersides and every tile's decks, tunnels and movable
spans. The sim
loads it whole at boot, on every client and on the server, so collision never depends on
what the renderer has streamed in.

The pipeline writes it (`pipeline/lib/world-colliders.ts`, `encodeWorldColliders`); the
reference reader is `decodeWorldColliders` in the same file. That reader is pure TypeScript
over a `DataView` and decodes to exactly the values in the per-tile JSON colliders
(`schemas/tile-collider.schema.json`): every coordinate and height is a whole number of
centimetres in both, so the conversion is exact. `tests/pipeline/world-colliders.test.ts`
proves the round trip for every tile.

## Conventions

* Little-endian throughout. Sections start on 4-byte boundaries (zero padding).
* Lengths in **centimetres** as integers, in the world frame of `src/geo/project.ts`
  (x east, z south, y up, origin at the Ferry Building clock tower).
* Tile `(ix, iz)` covers `[ix·T, (ix+1)·T) × [iz·T, (iz+1)·T)`, `T = tileSizeCm / 100`; its id
  is `t<ix>_<iz>`.

## Header (64 bytes)

| Offset | Type | Field |
|---|---|---|
| 0 | `char[4]` | magic `FCWC` |
| 4 | `u16` | version = 1 |
| 6 | `u16` | header length in bytes (64) |
| 8 | `u32` | tile count `N` |
| 12 | `u32` | building count `B` |
| 16 | `u32` | vertex stream length in bytes `V` |
| 20 | `u16` | heightfield samples per side `S` (51) |
| 22 | `u16` | lattice cell size, cm (1000) |
| 24 | `u32` | tile size, cm (50000) |
| 28 | `u32` | byte offset of the extension block, 0 when there is none (reserved and 0 in files written before the extension; a reader that ignores it reads the version-1 subset) |
| 32 | `f64` | origin latitude |
| 40 | `f64` | origin longitude |
| 48 | 16 bytes | reserved, 0 |

## Sections, in order

1. **Tile table**: `N` records of 12 bytes, sorted by `(iz, ix)` like the manifest:
   `i16 ix`, `i16 iz`, `u32 firstBuilding`, `u32 buildingCount`. A tile's buildings are
   records `firstBuilding .. firstBuilding + buildingCount - 1`.
2. **Heights**: `N × S × S` `i16`, centimetres, tile by tile, each row-major
   (`k·S + i` is the sample at `x = ix·T + i·cell`, `z = iz·T + k·cell`). The lattice's edge
   rows and columns lie on the tile border, so neighbours repeat their shared border with
   identical values. Open water is 0.
3. **Water**: `N × ceil(S²/8)` bytes; sample `i` of a tile is water when bit `i & 7` of byte
   `i >> 3` is set (least significant bit first).
4. **Buildings**: `B` records of 20 bytes, in tile order, each tile's in the JSON collider's
   order (by id):

   | Offset | Type | Field |
   |---|---|---|
   | 0 | `u32` | the 7-digit number of the DataSF `sf16_bldgid` (`201006.0000548` → 548) |
   | 4 | `u8` | part: 0 for the footprint's largest part, `n` for the id suffix `-n` |
   | 5 | `u8` | flags: bit 0 = tower record (id suffix `-tower`); other bits 0 |
   | 6 | `u16` | vertex count `n` (≥ 3) |
   | 8 | `i16` | `baseY`, cm |
   | 10 | `u16` | `topY − baseY`, cm |
   | 12 | `i32` | x of the first footprint vertex, cm |
   | 16 | `i32` | z of the first footprint vertex, cm |

   The id is rebuilt as `201006.` + the number zero-padded to 7 digits, then `-<part>` when
   part > 0, then `-tower` when flagged. Every footprint id in DataSF's dataset has the
   `201006.` prefix; the encoder refuses any other id (a future version would add a string
   table). Numbers from 9000000 up are not DataSF's: they are buildings the pipeline adds
   because the footprint layer predates them (world QA W-04; 9000001 up from parcel polygons,
   9900001 up from `pipeline/overrides.json`; the tile JSON's `meta.outline` says which).
5. **Vertex stream**: `V` bytes. For each building in record order, its remaining `n − 1`
   vertices, each as `i16 dx, i16 dz` (cm, relative to the previous vertex). A `dx` of
   `−32768` is an escape: the next 8 bytes are the vertex's absolute `i32 x, i32 z` (cm), and
   that vertex takes 12 bytes. Footprints are not closed (the last vertex is not the first).

The vertex stream is padded to 4 bytes. A file without extensions ends there.

6. **Extension block** (from the header's offset 28 to the end of the file): a sequence of
   sections, each `char[4] tag`, `u32` payload length in bytes (a multiple of 4), payload.
   Readers skip a tag they do not know, so later sections can be added without a new version.
   Every payload starts with a `u32` count `n`. Lengths are centimetres as everywhere else.

   | Tag | Records |
   |---|---|
   | `STRS` | `n` strings, each `u16` byte length + ASCII bytes, packed; the section is padded to 4. Other sections name strings by index. |
   | `BEXT` | `n` × 8 bytes, by building record index ascending: `u32` record index, `u8` piece kind (0 none, 1 terrace strip, 2 span over a street or path), `u8` piece number, `i16` `underY` cm (−32768: none). A piece appends `-s<number>` or `-b<number>` to the version-1 id. |
   | `DECK` | per deck: `u16` tile index (tile table order), `u8` kind (0 freeway, 1 ramp, 2 bridge, 3 overpass, 4 pier), `u8` layer, `u32` id string, `u32` edge string (0xffffffff: none), `u32` vertex count, then per vertex `i32 x, i32 y, i32 z, i32 w` |
   | `TUNL` | per tunnel: `u16` tile index, `u8` kind (0 tunnel, 1 underpass), `u8` 0, `u32` id string, `u32` edge string, `u32` ceiling clearance cm, `u32` vertex count, vertices as in `DECK` |
   | `MOVE` | per movable span: `u16` tile index, `u8` kind (0 bascule), `u8` 0, `u32` id string, `u32` deck string, `i32` hinge `ax, az, bx, bz` cm, `i32` fully open angle in microradians |
   | `LAKE` | per tile with an inland lake (world QA W-11): `u16` tile index, `u16` 0, then `ceil(S²/8)` bytes of lake flags laid out like the water mask (sample `i`: bit `i & 7` of byte `i >> 3`), padded to 4. A lake sample's height is the lake's water level (the lattice is flattened across every lake); its water bit stays 0, which is sea level only. It decodes to the tile ground's `lake` array (0/1 per sample); the tile JSON's `ground.cover` digits say the same, with the lakes' names and levels in `ground.lakes`. |

   Each tile's decks, tunnels and movable spans decode, in section order, to the tile
   collider's `decks`, `tunnels` and `movable` arrays (`schemas/tile-collider.schema.json`),
   present only when non-empty; a building's `underY` and piece suffix decode onto its record.

The file ends after the last section.

## What the sim should do with it

* Load `manifest.worldColliders` once at boot (13 MB for the whole city) instead of every
  `*.collider.json` (86 MB of JSON), decode it, and build its spatial index from it.
* Look ground up by tile index (`floor(x / T), floor(z / T)` into a map), never by scanning
  tiles: `PackGroundIndex` in the reference reader does this, with the same bilinear
  arithmetic as `src/sim/world.ts`. Where no tile exists the ground is sea level (0).
* The per-tile JSON colliders stay for tools and the renderer's facade metadata (`meta`); the
  sim needs nothing from them.
* A building blocks a body only below its roof and, when it has `underY`, above its
  underside: a car on a street passes under the Transit Center deck, and a car in a tunnel
  bore under the houses above it.
* An inland lake (`LAKE`, `ground.lake`) is water at its sample's height: like the Bay, never a
  drivable floor (walls or the tow rule, as the sim treats the sea).
* Decks and tunnels are road surfaces: `surfaceHeight(x, z, yHint)` (docs/design.md) picks the
  highest surface at or below the body among the ground, the decks under it and the tunnel
  floors around it; in a bore the ceiling caps the body. `pipeline/lib/surfaces.ts` is the
  reference implementation of that lookup.
