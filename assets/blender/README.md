# Fog City hero assets (scripted Blender)

Every hero model is built by a Python script running in headless Blender 4.5 LTS and exported
as a GLB into `public/models/`. Nothing is hand-edited in a GUI; the `.py` files are the source
and the `.glb` files are committed build outputs. `tests/assets/` checks the outputs without
Blender.

```sh
BLENDER=/path/to/blender assets/blender/build.sh             # all models + content/landmarks.json (~12 s)
BLENDER=/path/to/blender assets/blender/build.sh robotaxi    # one model
BLENDER=/path/to/blender assets/blender/build.sh --lookdev   # models, then the three renders (~6 min on 4 cores)
pnpm vitest run tests/assets                                 # budgets, nodes, orientation, sizes, validator
```

The build is deterministic: rebuilding produces byte-identical GLBs. It needs no network; the
outside data it uses is committed in `data/` (see Sources). A quick look at any model:
`"$BLENDER" -b --factory-startup -noaudio -P assets/blender/tools/preview.py -- public/models/robotaxi.glb views=front3q,side`
writes Cycles previews to `assets/blender/.renders/` (gitignored).

## Conventions (all models)

- Metres. glTF +Y up. **The front faces glTF -Z** (Blender +Y; the exporter maps Blender +Y to
  glTF -Z). The model's right side is +X, so **L parts are at -X**. The renderer places a
  model with `rotation.y = -heading`.
- Origin on the ground (y = 0) at the centre of the footprint, except the Ferry Building
  (origin = clock tower centre) and wheels/limbs (origin = hub/joint, see below).
- Simple metallic-roughness PBR, one material per surface kind, named.
- **Night lights:** emissive surfaces use materials whose names start with `light_`, and no
  other material is emissive. Exported with emissive on (strength 1); the renderer should
  scale `emissiveIntensity` up at night and to 0 by day. Nodes that are only night light carry
  extras `{"nightLight": true}` (`tower_outline_lights`, R-Evolution `glow`).
- Alpha is `MASK` (alpha test) or opaque, never `BLEND`.

## Models and their contracts

| File | Tris (budget) | Size | Named nodes / materials the game uses |
|---|---|---|---|
| `ferry-building.glb` | 31.9k (100k) | 204.9 x 59.5 m, tower 75.4 m | `ferry_building` > `building`, `tower`, `tower_outline_lights`, `clock_hour_N/E/S/W`, `clock_minute_N/E/S/W`; `light_tower_outline`, `light_clock_face` |
| `r-evolution.glb` | 32.2k (40k) | 14.3 m on a 7.2 m plinth | `r_evolution` > `frame` (rods), `shell` (`steel_mesh`, MASK), `glow` (`light_sculpture_glow`, MASK), `plinth` |
| `player-car.glb` | 3.0k (8k) | 4.33 x 2.04 x 1.50 m | `player_car` > `body`, `wheel_FL/FR/RL/RR`; `paint` (recolourable), `light_headlight`, `light_taillight` |
| `robotaxi.glb` | 4.1k (10k) | 4.78 x 2.21 x 2.12 m | `robotaxi` > `body`, `sensor_dome`, `wheel_FL/FR/RL/RR`; `light_status` (teal ring), `light_headlight`, `light_taillight` |
| `errand-robot.glb` | 4.5k (6k) | 1.75 m tall | `errand_robot` > `torso` > `head`, `arm_upper_L/R` > `arm_lower_L/R` (> `bag` on R), `leg_upper_L/R` > `leg_lower_L/R`; `light_face` |
| `sidewalk-bot.glb` | 2.0k (3k) | 0.62 m to the lid, flag to 1.42 m | `sidewalk_bot` > `body`, `flag`, `wheel_L1/L2/L3`, `wheel_R1/R2/R3` (1 = front); `light_eyes` |
| `muni-bus.glb` | 3.0k (12k) | 12.5 x 3.19 x 3.48 m | `muni_bus` > `body`, `livery_panel`, `wheel_FL/FR/RL/RR`; `livery`, `light_destination_sign`, `light_headlight`, `light_taillight` |

**Clock hands** (Ferry Building). Each hand's origin is its dial's centre; local +Z is the
dial's outward normal and the hand points at 12 at rest. Turning clockwise as seen from the
front is a negative rotation about local +Z. Extras: `{"clockHand": "hour"|"minute",
"clockAxis": [0,0,1], "clockFace": "N"}`, which is what `src/render/landmarks.ts` already
looks for. N/E/S/W are model-frame directions: N is the front dial (-Z, facing Market St once
placed), E is +X, S is +Z, W is -X.

**Wheels** (cars, bus, sidewalk bot). Origin at the hub, identity rest rotation, spin about
local +X. Rolling forward (toward -Z) is a *negative* rotation about +X: `rotation.x -=
distance / radius`. Extras: `{"wheel": "FL", "spinAxis": [1,0,0], "radius": 0.35, "steer":
true}` (steer only on front wheels; steering is a rotation about local +Y).

**Robotaxi `sensor_dome`** spins about its local +Y (extras `spinAxis`), origin on the axis.

**Errand robot.** Every rigid part is a node whose origin is the joint it turns about: torso
at the hips (0.90 m), head at the neck, arms at shoulder and elbow, legs at hip and knee. A
positive rotation about a limb's local +X swings it forward (toward -Z). `bag` hangs from
the right hand and follows `arm_lower_R`.

**Sidewalk bot `flag`** origin is the pole's foot; sway it about local X (extras `swayAxis`).

**Bus livery.** `livery_panel` holds the two large side panels between the axles (5.3 x 0.6 m,
aspect about 8.8:1) and is the only mesh with UVs. Material `livery`; on each side u runs 0..1
left to right as seen from outside (front of the bus on the right on the right-hand side,
on the left on the left-hand side) and v runs 0..1 bottom to top. Replace the material's map
with a generated ad; the committed texture is an abstract placeholder with no words.

## Landmarks (`content/landmarks.json`)

Generated by `tools/landmarks.py` (run by `build.sh`).

- **Ferry Building.** From the DataSF building footprint `201006.0000058`
  (`data/ferry-building-footprint.json`): the minimum-area rectangle gives the long axis
  (bearing 143.8), the front is the perpendicular facing the city (heading **233.8**), the
  footprint's projecting central pavilion fixes the tower's position along the facade, and
  the tower is set 7 m behind the pavilion front (the footprint does not locate the tower;
  that offset is from photographs). Origin lat/lon = tower centre, 37.7954097, -122.3936604.
  `replacesBuildingIds` lists the footprint id and the pipeline's synthetic
  `201006.0000058-tower`. `collider` is the footprint, simplified, in model-local `[x, z]`.
  The model's walls follow the same footprint: the test places the real polygon with the
  landmark entry and checks the model's extents against it (within 3 m along the facade,
  2.5 m front to back).
- **R-Evolution.** Installed in Embarcadero Plaza in April 2025, at the foot of Market Street
  on its axis, facing up Market with its back to the Ferry Building (photographs in the SF
  Arts Commission's February 2026 extension proposal). Position: Wikipedia's coordinate
  37.794742, -122.394502, which lies 3.7 m from DataSF's Market St centreline and 36 m
  north-east of Steuart St. Heading 225.3 = Market St's bearing toward the south-west (DataSF
  streets, segment Steuart-Spear). The brief's approximate 37.7953, -122.3958 is about 120 m
  away inside the plaza lawn, so the cross-checked point is used. The extension proposal lists
  a removal date of 5 October 2026; the game is set five years on and keeps her.

## How each model is made

- **Ferry Building** (`models/ferry_building.py`): facades are runs of wall bays pierced by
  round-arched openings (`arch_bay`, `wall_row`): a two-storey arcade on the Embarcadero
  wings, arched windows with mullions, pilasters, belt course, cornice and balustrade, taller
  end pavilions, the projecting central pavilion with three entrance arches, and a hipped
  roof with the long nave skylight. The tower is stacked like the Giralda: quoined shaft,
  clock stage with four 22 ft (6.7 m) dials, band of small windows, cornice, belfry arcade
  with a balcony, terrace balustrade, an upper stage with three arches a side, an octagonal
  lantern, cupola, finial and flagpole. Sandstone buff palette.
- **R-Evolution** (`models/r_evolution.py`): the CC0 MakeHuman base figure
  (`data/makehuman-female.ply`, made by `tools/make_base_female.py`) is re-posed with a small
  distance-weighted skin over the MakeHuman joint centres (arms opened to about 25 degrees from
  the body as in the real sculpture, which keeps her arms low and open rather than overhead;
  chin lifted), given a short bob, voxel-remeshed, then: decimated to 2,000 triangles and
  turned into 7.5 cm rods by a Wireframe modifier (`frame`); decimated to 5,200 and textured
  with a generated diamond chain-link pattern, alpha-tested (`shell`); an inner offset skin
  with the same pattern, emissive lavender for night (`glow`); and the round plinth.
- **Cars** (`lib/vehicle.py`): a lofted, welded body whose sill line rises over each wheel to
  carve round arches, a greenhouse loft with A/B/C pillars, light bars, cladding, arch liners
  and hub-centred wheel nodes. The player car is an original orange hatchback; the robotaxi
  an original white crossover with a roof sensor crown, spinning lidar dome, four corner
  pods, camera pods for mirrors and a teal status ring. No real vehicle, badge or livery.
- **Errand robot, sidewalk bot, bus**: capsules, lathes and boxes from `lib/fc.py`.

## Look-dev renders (`lookdev/`)

`01-ferry-revolution-golden-hour.png`, `02-ferry-revolution-night.png`,
`03-street-robots-dusk.png`: Cycles CPU, 960x540, 64 samples + OpenImageDenoise, mist pass
for fog, bloom at night. Each scene imports the exported GLBs and places the landmarks from
`content/landmarks.json`, so the renders show exactly what the game loads. The plaza set
(`lib/plaza.py`) and the dusk street (in its script) exist only for the renders; the
storefronts carry no names or words (iconography only, blank sign slots).

## Sources and licences

- SF Building Footprints, DataSF `ynuv-fyni` (record committed in `data/`); SF Streets
  `3psu-pn9h` for Market St (used to check the R-Evolution placement). Open data, City and
  County of San Francisco.
- MakeHuman hm08 base mesh, female/proportion targets and joint helpers: CC0 1.0
  (github.com/makehumancommunity/makehuman, LICENSE.md section C). Re-fetch with
  `tools/fetch_sources.py`, regenerate `data/makehuman-female*.{ply,json}` with
  `tools/make_base_female.py`.
- Photographs (SF Arts Commission extension proposal, Wikipedia) were used as reference
  only; no imagery is in the assets. All textures are generated by the scripts.
