# World collider pack (`world.colliders.bin`), format FCWC version 1

Everything the sim collides with, for the whole world, in one binary file: every tile's
ground heightfield and water mask, and every building's footprint and heights. The sim
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
| 28 | `u32` | reserved, 0 |
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
   table).
5. **Vertex stream**: `V` bytes. For each building in record order, its remaining `n − 1`
   vertices, each as `i16 dx, i16 dz` (cm, relative to the previous vertex). A `dx` of
   `−32768` is an escape: the next 8 bytes are the vertex's absolute `i32 x, i32 z` (cm), and
   that vertex takes 12 bytes. Footprints are not closed (the last vertex is not the first).

The file ends after the vertex stream, padded to 4 bytes.

## What the sim should do with it

* Load `manifest.worldColliders` once at boot (13 MB for the whole city) instead of every
  `*.collider.json` (86 MB of JSON), decode it, and build its spatial index from it.
* Look ground up by tile index (`floor(x / T), floor(z / T)` into a map), never by scanning
  tiles: `PackGroundIndex` in the reference reader does this, with the same bilinear
  arithmetic as `src/sim/world.ts`. Where no tile exists the ground is sea level (0).
* The per-tile JSON colliders stay for tools and the renderer's facade metadata (`meta`); the
  sim needs nothing from them.
