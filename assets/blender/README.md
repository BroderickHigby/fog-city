# Fog City assets (scripted Blender)

**Runtime update, 23 October 2026:** the default player now uses the generic, MIT-licensed
[Microsoft Rocketbox conversion](../imports/rocketbox/README.md), and the default player car
uses the [civilian fastback](../imports/civilian-car/README.md). The `player.glb` and
founder-default sections below document the earlier source asset and its privacy rules.
That likeness asset is no longer loaded by the game or included in the hosted build.

Every model is built by a Python script running in headless Blender 4.5 LTS and exported into
`public/models/`. Nothing is hand-edited in a GUI; the `.py` files are the source and the
`.glb` / `.bin` / `.png` files are committed build outputs. The sound effects are synthesised
by `assets/audio/generate.py` (see `assets/audio/README.md`). `tests/assets/` checks every
output without Blender.

```sh
BLENDER=/path/to/blender assets/blender/build.sh             # every model, landmarks.json, sounds (~1 min)
BLENDER=/path/to/blender assets/blender/build.sh robotaxi    # one model (script name without .py)
BLENDER=/path/to/blender assets/blender/build.sh --lookdev   # models, then every look-dev render (slow)
pnpm vitest run tests/assets                                 # budgets, nodes, orientation, sizes, validator, VAT, audio
node assets/blender/tools/glb-stats.ts                       # triangles and sizes as exported
```

Order matters in one place: `heaps.py` imports the exported Porter and Trundle, and
`humanoid_impostor.py` adds its entry to the JSON `humanoid.py` writes; `build.sh` runs them in
that order. Renders use 2 threads (`FC_RENDER_THREADS` to change); `FC_LOOKDEV_DRAFT=1
FC_LOOKDEV_OUT=<dir>` renders a quick 40% draft of a look-dev script elsewhere.

`build.sh` stops with a non-zero status on any failure: Blender's exit status (a Python
exception exits 1 through `--python-exit-code`), a `Traceback` in its output, a model script
that did not report its GLB, or a look-dev script that did not write its PNG. After the
models it prints each GLB's triangle count read back from the file (`tools/glb-stats.ts`),
which is the number to quote: Blender's pre-export count can be a few triangles higher
because the exporter drops degenerate triangles.

The build is deterministic: rebuilding produces byte-identical GLBs. Two settings in
`build.sh` keep it so on any machine: Blender runs on a fixed 2 threads (`-t`,
`FC_BLENDER_THREADS` to change), because R-Evolution's remesh and decimate come out slightly
differently with a different thread count (so `r-evolution.glb` was rebuilt on 2 threads in
wave 2: its top moved 1.2 cm, the triangle counts are the same), and numpy's BLAS runs on one
thread (`OPENBLAS_NUM_THREADS=1`). The full build took 45 s on the shared 4-core machine. It
needs no network; the outside data it uses is committed in `data/` (see Sources). A quick look at any model:
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
- Shape keys export as morph targets with their names in the mesh's `extras.targetNames`.
  Custom vertex attributes start with `_` (glTF) and arrive in three.js lower-cased
  (`_RUST_MASK` -> `_rust_mask`).
- Flags the sim and renderer read are node extras (on the root, or on the crowd mesh nodes): `fcActor` (the model's key),
  `robot`, `vehicle`, `animal`, `child`, `noTouch` (water never reaches it), `mobilityAid`,
  `throwable`, `refill`, `interact`, `heap`, `toy`.

## Models and their contracts

| File | Tris (budget) | Size | Named nodes / materials the game uses |
|---|---|---|---|
| `ferry-building.glb` | 31,886 (100k) | 204.9 x 59.5 m, tower 75.4 m | `ferry_building` > `building`, `tower`, `tower_outline_lights`, `clock_hour_N/E/S/W`, `clock_minute_N/E/S/W`; `light_tower_outline`, `light_clock_face` |
| `r-evolution.glb` | 32,216 (40k) | 14.3 m on a 7.2 m plinth | `r_evolution` > `frame` (rods), `shell` (`steel_mesh`, MASK), `glow` (`light_sculpture_glow`, MASK), `plinth` |
| `player-car.glb` | 2,992 (8k) | 4.33 x 2.04 x 1.50 m | `player_car` > `body`, `wheel_FL/FR/RL/RR`; `paint` (recolourable), `light_headlight`, `light_taillight` |
| `robotaxi.glb` (Meander) | 5,252 (10k) | 4.98 x 1.95 x 2.02 m (1.95 m to the roof) | `robotaxi` > `body`, `door_slide_R`, `sensor_band`, `wheel_FL/FR/RL/RR`; `light_status` (teal line in the roof band), `light_headlight`, `light_taillight`. **No `sensor_dome`** |
| `errand-robot.glb` (Porter) | 4,948 (6k) | 1.95 m tall | `errand_robot` > `torso` > `head`, `arm_upper_L/R` > `arm_lower_L/R` (> `bag` > `bag_contents` on R), `leg_upper_L/R` > `leg_lower_L/R`; `light_face`; morphs `seize/slump/melt`; `_RUST_MASK` |
| `sidewalk-bot.glb` (Trundle) | 2,008 (3k) | 0.56 m tall, 0.75 m long | `sidewalk_bot` > `body`, `lid`, `cargo`, `wheel_L1/L2`, `wheel_R1/R2` (1 = front); `light_face`; morphs `seize/slump/melt`; `_RUST_MASK`. **No `flag`** |
| `moat-van.glb` | 3,904 (9k) | 5.81 x 2.28 x 2.50 m | `moat_van` > `body`, `wheel_FL/FR/RL/RR`, `door_rear_L/R`; `light_headlight`, `light_taillight`, `light_accent` |
| `humanoid-crowd.glb` + VAT | 2,879 / 871 per body | 1.78 m (adult), 1.18 m (child) | meshes `adult_lod0/1`, `child_lod0/1` (attributes `_VID`, `_SLOT`); see Humanoid line |
| `player.glb` | 7,896 (8k) | 1.83 m to the skull, 1.878 m to the quiff | skinned, 20 bones, 14 morphs, 8 animations, `tint_*` materials, `hair_quiff` on the `head` joint; the default look is founder-default (see Humanoid line) |
| `water-blaster.glb` | 922 (2.5k) | worn | `water_blaster` > `tank` (> `pump_handle`, `water_level`), `hose`, `wand` (> `nozzle`) |
| `hydrant.glb` | 684 (1.2k) | 0.79 m | `hydrant` > `body`, `refill_point` |
| `drinking-fountain.glb` | 342 (1.2k) | 0.96 m | `drinking_fountain` > `body`, `refill_point` |
| `traffic-cone.glb` | 220 (400) | 0.70 m | `traffic_cone` > `cone` |
| `repair-kiosk.glb` | 408 (3k) | 2.5 m | `repair_kiosk` > `booth`, `bay`; `light_kiosk_screen`, `light_kiosk_status` |
| `vendor-cart.glb` | 1,480 (4k) | 2.25 m | `vendor_cart` > `cart`, `sign_slot`, `wheel_L/R` |
| `wheelchair.glb` | 1,492 (2.5k) | 0.98 m | `wheelchair` > `chair`, `wheel_L/R` (> `push_rim_L/R`) |
| `heap-porter/trundle/mixed.glb` | 2,392 / 2,092 / 2,392 (2.5k) | 0.44 / 0.25 / 0.37 m | `heap` > `pile`, `puddle` |
| `pigeon.glb` | 194 (300) | 0.28 m | `pigeon` > `body` (morph `peck`) |
| `dog.glb` | 828 (1k) | 0.48 m at the shoulder | `dog` > `body` (morph `stride`), `leash` |
| `muni-bus.glb` | 2,956 (12k) | 12.5 x 3.19 x 3.48 m | `muni_bus` > `body`, `livery_panel`, `wheel_FL/FR/RL/RR`; `livery`, `light_destination_sign`, `light_headlight`, `light_taillight` |

**Clock hands** (Ferry Building). Each hand's origin is its dial's centre; local +Z is the
dial's outward normal and the hand points at 12 at rest. Turning clockwise as seen from the
front is a negative rotation about local +Z. Extras: `{"clockHand": "hour"|"minute",
"clockAxis": [0,0,1], "clockFace": "N", ...}`, which is what `src/render/landmarks.ts` already
looks for. **N/E/S/W are model-frame directions, not compass points:** N is the front dial
(-Z), E is +X, S is +Z, W is -X. Placed at heading 233.8 the N dial faces south-west up
Market St. Each hand's extras also carry `clockFaceFrame: "model"`, `clockFaceNormal` (the
dial's outward normal in the model frame) and `clockFaceBearingDeg` / `clockFaceCompass`, the
world direction the dial faces once placed by `landmarks.json`: N 233.8 SW, E 323.8 NW,
S 53.8 NE (the bay), W 143.8 SE. The Ferry Building's `source` note in `landmarks.json` says
the same. The test checks the bearings against the geometry and the landmark heading.

**Wheels** (cars, bus, sidewalk bot). Origin at the hub, identity rest rotation, spin about
local +X. Rolling forward (toward -Z) is a *negative* rotation about +X: `rotation.x -=
distance / radius`. Extras: `{"wheel": "FL", "spinAxis": [1,0,0], "radius": 0.35, "steer":
true}` (steer only on front wheels; steering is a rotation about local +Y).

**Meander robotaxi (`robotaxi.glb`).** Remodelled on 2026-10-27 at the owner's request
("make the robotaxis look more like bigger Zoox or something"): a tall, two-ended carriage pod
of its own, the same both ways round. 4.96 m long and 1.92 m wide (inside the sim's 5.0 x 2.0 m
robotaxi box, which did not change), 1.95 m to the roof and 2.02 m to the tops of its pods, on
a 3.40 m wheelbase with 0.38 m wheels at the corners. The body is a stack of horizontal rings
round one rounded, bow-ended outline, each offset inward by its own inset, so the sides lean in
above the belt and every column stays plumb; the rings below the belt rise over the wheels to
cut the arches. Big glass from the belt (0.88 m) to the band, wrapping round the corners past a
slim white post in each; dark cladding along the sills; a light bar across each end in a dark
housing (`light_headlight` at the front, `light_taillight` at the back: the same housing both
ways). The Meander's own marks stay: one dark sensor band (`sensor_lens`) round the roof edge
with the teal status line in it (`light_status`), and now a low white lantern pod with a dark
lens ring and a teal ring on each roof corner (still **no `sensor_dome` node**, nothing else on
the roof). Nobody drives it, so the sides still differ: the kerb side (right, +X) has one wide
sliding door in the middle with dark posts at its edges; the street side (left) has no door,
two windows either side of a white post, and a charging flap. No grille, badge, text or
livery. Root extras `fcActor: "robotaxi"`, `kerbSide: "right"` (traffic drives on the right, so
the door opens onto the pavement).
`door_slide_R`: the sliding door, shut; extras `door: "slide"`, `popAxis: [1,0,0]`, `popM`
(0.05), `slideAxis: [0,0,1]`, `slideM` (1.36). To open it, move it out along local +X by
`popM`, then back along local +Z by `slideM` (both in the model frame; the node's rest
rotation is the identity); close in reverse. The body under it is `cabin_dark`, so the
opening reads as the dark cabin. `sensor_band` (no mesh, extras `sprayTarget: true`) marks
the front of the band on the centre line: aim there when a mission says to water a rogue
robotaxi's sensors. The sim's robotaxi is still 1.6 m tall (`ROBOTAXI_BODY.height`), so the
top 0.35 m of the drawn pod is above its water and collision box. Built with Blender 5.2.2 LTS
(the only Blender on the build machine on 2026-10-27; the script needs nothing newer than
4.5). Wheels as for the other cars (`radius: 0.38`).

**Porter (`errand-robot.glb`).** Bramblecot Home's errand humanoid, remodelled in wave 2 to
the robot table: tall and slim (1.95 m to the carrying ring on its head), an opaque glazed
ceramic shell (every material is opaque; no face plate, no translucent torso), graphite
joints, bronze seams, and a lantern-shaped head (a ribbed barrel with a cap, finial and
carrying ring) whose face light (`light_face`) is one soft horizontal strip across the front.
Turn it amber for an attack wind-up. Every rigid part is a node whose origin is the joint it
turns about: torso at the hips (0.95 m), head at the neck (1.53 m), arms at shoulder (1.43 m)
and elbow, legs at hip and knee. A positive rotation about a limb's local +X swings it forward
(toward -Z). `bag` hangs from the right hand and follows `arm_lower_R`; the groceries (greens
and a baguette, materials `produce_*`) are the child node `bag_contents` (extras
`bagContents: true`, origin at the bag's mouth): hide it for an empty bag (the content track's
`emptyBag` tell), show it for `fullBag`. Root extras: `robot: "porter"`,
`slumpKeys: ["seize","slump","melt"]`. The node contract is the wave-1 one, so the renderer's
drop-in works unchanged.

**Trundle (`sidewalk-bot.glb`).** A knee-high (0.56 m) four-wheeled delivery bot shaped like a
bread bin: a cream body whose front top is a quarter-round, closed by a sage-green slatted
roll-top lid; graphite bumper band and fender skirts, one soft light strip along the front
lip under the lid (`light_face`, the same face-light name as the Porter's, so a forced
update's "Updating" glow and the night-light table treat both robots alike) and a camera slot
in the bumper. It has no pair of round "eye" lights: that is the nearest real sidewalk
robots' look (the trade-dress checklist). The wave-1 material was `light_eyes`; it is gone.
**No flag and no whip antenna** (the wave-1 `flag` node is gone),
and **four wheels**: `wheel_L1`, `wheel_L2`, `wheel_R1`, `wheel_R2` (1 = front; extras
`radius: 0.085`, `spinAxis`), so `wheel_L3`/`wheel_R3` no longer exist.
`lid`: origin on the roll axis; rotate about local +X by extras `lidOpenRad` (1.57) to roll it
back under the top panel and open the bin (`lidAxis: [1,0,0]`). `cargo`: two foil-wrapped
burritos and a paper bag inside the bin (extras `cargo: true`); hide it for an empty bin (a
grocery snatch). Root extras `robot: "trundle"`, `slumpKeys`.

**Moat Labs van (`moat-van.glb`).** An original driverless box van in graphite with a teal
accent: a faceted body with chamfered keep-like corners, a battlement of small blocks along
both roof edges, narrow vertical slit lamps at the corners, a teal moat band along the sills
with a light line above it (`light_accent`), camera pods instead of mirrors, and an invented
castle-over-water emblem built from geometry on both sides and the nose (no text, no texture).
Wheels as for the cars (`wheel_FL/FR/RL/RR`, extras `radius: 0.37`, `steer` on the front).
Rear barn doors `door_rear_L` / `door_rear_R`: origin on the hinge at the rear corner;
rotate about local +Y by extras `openRad` (R +1.75, L -1.75) to swing both outward
(`hingeAxis: [0,1,0]`). Units walk out of the back.

**Bus livery.** `livery_panel` holds the two large side panels and is the only mesh with
UVs. Each panel covers the whole red lower body, from the skirt to the window-line strip, and
lengthwise from the rear wheel arch to just behind the centre door: **4.22 x 0.74 m, aspect
5.70:1**, the same on both sides so one texture fits both, and clear of every door and
window (tested). Material `livery`; on each side u runs 0..1 left to right as seen from
outside (front of the bus on the right on the right-hand side, on the left on the left-hand
side) and v runs 0..1 bottom to top. Replace the material's map with a generated ad drawn at
that aspect, for example 1024 x 180 px. A 50-character line spans the panel at about 0.1 m
cap height (about 26 px at 1024 x 180), so the 0.74 m height takes a headline and a subline
with room to spare, or three lines. The node's extras carry the numbers: `livery: {material, uv,
aspect: 5.703, sizeM: [4.22, 0.74], placeholderPx: [1024, 180]}`. The committed texture is an
abstract placeholder with no words, written at the panel's aspect so it is not stretched.

## Melting and rust (Porter and Trundle)

Built by `lib/melt.py` and `fc.add_rust_mask`; the reference maths for the renderer is
`runtime/robot-melt.ts` (tested).

**Slump shape keys.** Every mesh part of both robots carries three morph targets, in this
order: `seize` (a stiff hunch, joints locked, the head tilts), `slump` (the body sags and
bulges, the head droops), `melt` (a low, rusty soft-serve mound with the head or lid on top).
They are authored at rest in model space, so before blending them ease every joint node
(limbs, head, lid, wheels) back to its rest rotation over the first 0.3 s of `seized`. Then
drive the influences from the sim's melt state and the seconds spent in it
(`meltWeights(state, t)`):

| Sim state | Seconds | seize | slump | melt |
|---|---|---|---|---|
| `seized` | 0 -> 0.5 | 0 -> 1 | 0 | 0 |
| `slumping`, first half | 0 -> 0.75 | 1 -> 0 | 0 -> 1 | 0 |
| `slumping`, second half | 0.75 -> 1.5 | 0 | 1 -> 0 | 0 -> 1 |
| `heap` | | swap to `heap-porter.glb` / `heap-trundle.glb` (`heap-mixed.glb` for two at once) | | |

The heap prop is the robot's own melt shape (re-centred within a few cm), so the swap does not
jump. Nothing in any key goes below the ground (tested).

**Rust mask.** Every primitive carries a float vertex attribute `_RUST_MASK` (three.js
`_rust_mask`): 0 rusts first (the graphite joints and the seams: panel edges, wheel hubs, the
lid's edges), rising over each panel to about 1 at its middle; 2 never rusts (the night lights,
the groceries, the cargo). Materials that may rust carry extras `{"rustable": true}`. The
contract, with `rust` the sim's 0..1 value:

```glsl
float rustCoverage(float mask, float rust) { return smoothstep(mask - 0.1, mask + 0.1, 1.1 * rust); }
// diffuse = mix(shellColour, rustColour(noise), rustCoverage(_rust_mask, rust));
// roughness = mix(roughness, 0.9, coverage); metalness can drop a little
```

At rust 0.3 the joints and seams are orange; at 0.6 most of the shell is; at 0.9 everything.
Look-dev 05 and 06 render exactly this formula through the imported attribute.

## Props

- **Hydrant** (`hydrant.glb`, 0.79 m): SF style: a white barrel on a cast-iron flange, a blue
  bonnet with a pentagon nut, two side outlets and a larger pumper outlet facing the street
  (-Z). Node `refill_point` (no mesh, extras `refillPoint`) is where the player couples; root
  extras `refill: "hydrant"`.
- **Drinking fountain** (`drinking-fountain.glb`, 0.96 m): a sage pedestal, a steel bowl and
  spout facing -Z, a bottle filler on the back. `refill_point` above the spout; `refill:
  "fountain"`.
- **Traffic cone** (`traffic-cone.glb`, 0.70 m): orange with two white bands on a 0.36 m
  square base; root extras `throwable`. Rests on a car's hood on its base.
- **Repair kiosk** (`repair-kiosk.glb`, 2.5 m): a ceramic booth whose service bay opens to -Z.
  Node `bay` (no mesh, extras `bay`) is where a robot stands to be "Restored from backup";
  a blank screen on the back wall (`light_kiosk_screen`, no words) and a status ring
  (`light_kiosk_status`) above the opening; a heart-and-wrench mark in geometry on the header.
  Root extras `interact: "repair"`.
- **Vendor cart** (`vendor-cart.glb`, 2.25 m to the awning): wooden counter, pour-over station,
  burrito warmer, three spare blaster tanks, a coral-and-cream striped awning. Customers stand
  at -Z. `sign_slot` (extras `signSlot`, `sizeM: [0.84, 0.34]`) is the blank menu panel where a
  generated sign texture can go (iconography only for now). `wheel_L/R` are static.
  Root extras `interact: "vendor"`.
- **Wheelchair** (`wheelchair.glb`): a manual wheelchair, seat at 0.45 m, the humanoid sit
  clip's seat height (extras `seatHeightM`), so a person in it plays `sit`. Root extras
  `mobilityAid: true, noTouch: true`: water never reaches the person using it (design.md).
  `wheel_L/R` turn about local X (extras `radius: 0.3`).

**Water blaster** (`water-blaster.glb`). A cartoon garden sprayer, plainly a water toy: a bright
yellow backpack tank with a red pump handle, orange straps, a green hose, and a blue wand with
a thumb lever on top and a wide orange adjustable nozzle. Nothing is shaped or named like a
firearm (tested: no gun words in any name or extra, nothing under or behind the grip, more
than 85% of its surface in bright toy colours). It is laid out as worn by `player.glb` in its default look (founder-default,
1.83 m in a bomber: `TANK_AT` and `GRIP_AT` come from `humanoid.player_frame()`, and `FIT` spreads
the straps so they clear the jacket):

| Node | Origin | Attach |
|---|---|---|
| `tank` | where it sits on the back | `chest` bone (extras `attachBone`) |
| `tank` > `pump_handle` | on the tank's top | follows the tank |
| `tank` > `water_level` | bottom of the white window strip | scale local +Y by the tank's fill (0..1) |
| `hose` | static loop tank -> wand | or hide it and draw a curve from `tank.extras.hoseStart` to `wand.extras.hoseEnd` |
| `wand` | the grip | `hand_R` bone (extras `attachBone`) |
| `wand` > `nozzle` | the nozzle tip (extras `sprayOrigin`) | the stream leaves along the wand's forward (-Z) |

The alt-fire flower hopper is a wave-5 asset on this prop.

**Rust heaps** (`heap-porter.glb`, `heap-trundle.glb`, `heap-mixed.glb`): root `heap` (extras
`heap: porter|trundle|mixed`) > `pile` (the rusted melt shape: `rust_dark`, `rust_orange`,
`rust_stained_ceramic`, with the groceries, paper, foil and tyres keeping their colours; the
face light is a dark `lamp_off`) and `puddle` (a flat irregular puddle at 4 mm,
`puddle_water`; fade or shrink it as it dries). Cartoon, not gore: nothing broken off, no
fluid but water. 2.5k triangles each; Tidy hauls them in wave 3.

**Animals** (two frames each, as one morph target; root extras `animal: true, noTouch:
true`; startle them before the stream arrives):
- `pigeon.glb` (194 tris): frame 0 standing, morph `peck` = head down to the pavement. Bob the
  weight; a flock is an InstancedMesh with `setMorphAt`.
- `dog.glb` (828 tris, 0.48 m at the shoulder): a medium dog with a red collar. Frame 0 one
  stride, morph `stride` the other: ping-pong the weight at about 2 Hz while walking. Node
  `leash` runs from the collar to a hand loop behind and to the dog's left at 0.92 m (extras
  `collar`, `handle`, glTF model frame): keep it for a dog beside its person, or hide it and
  draw a line from the collar to the walker's hand. Root extras `leashed: true`.

## Humanoid line

One parametric body (`lib/humanoid.py`, pure numpy), one rig and one clip library
(`lib/humanoid_clips.py`), built by `models/humanoid.py`, `models/humanoid_impostor.py`:

| Output | What |
|---|---|
| `humanoid-crowd.glb` | crowd meshes `adult_lod0` (2,879 tris), `adult_lod1` (871), `child_lod0`, `child_lod1`, written by `lib/glbwrite.py` in bake order; attributes `POSITION`/`NORMAL` (rest), `_VID` (vertex index), `_SLOT` (tint slot). Child meshes carry extras `child: true, noTouch: true` |
| `humanoid-vat-<model>-lod<n>.bin` | the vertex-animation textures for one model and LOD |
| `humanoid-vat.json` | layout, clip table, shape keys, variants, palettes, impostor |
| `humanoid-impostor.png` | 8 views x 2 poses for people beyond the LOD1 range |
| `player.glb` | the player's on-foot body: the same body line in its default look, founder-default, skinned, with every shape key and clip |
| `tests/assets/fixtures/humanoid-vat-reference.json` | exact skinning of two variants, for the decoder test |

### The body, slots, variants and palettes

The body is generated, not sculpted: torso rings (super-ellipses with belly, bust, hip and
waist terms), a head with nose, ears, eyes and brows, tubes for arms and legs, mitten hands
with a thumb, wool sneakers with a white sole. The topology is the same for every parameter
set, so a body variant is a difference of two builds: a **shape key**. Clothing and hair layers
always exist and sit just inside the body when their key is 0.

Shape keys (`morphs` in the JSON, this order): `build_slim`, `build_broad`, `build_heavy`,
`curvy`, `older` (a slight stoop), `hair_none`, `hair_long`, `hair_bun`, `vest` (fleece
vest), `hoodie` (lowered hood and pocket), `lanyard` (conference lanyard and badge), `skirt`.

Tint slots (`slots`, this order; `_SLOT` per vertex): 0 `skin`, 1 `hair`, 2 `top`,
3 `bottom`, 4 `shoes`, 5 `outer` (vest), 6 `accent` (lanyard), 7 `sole`, 8 `eyes` (fixed),
9 `badge` (fixed). Everyone wears long sleeves and long trousers or tights: it is Fog City.

Variants (`variants`): founder (slim, vest, lanyard), engineer (hoodie, bun), partner (older,
stocky, vest), attendee (long hair, skirt, lanyard), local (heavy build, broad hips), elder
(stoop, thinning hair), runner (athletic), student (slim, hoodie, long hair), and the child
model's two looks (hoodie; long hair), flagged `child: true`. Each has `weights` (shape keys),
a `heightScale` range (apply as the instance's uniform scale) and suggested `outfits` / `hair`.
Builds span torso widths at the waist from 0.26 m (`build_slim`) through 0.30 m (no key) to
0.45 m (`build_heavy`, with a 0.33 m deep belly and the arms held clear of the hips); adult
height scales span 0.88-1.08, so adults stand 1.56-1.92 m (the body is 1.78 m at scale 1),
and children 0.90-1.08 of 1.17 m.

**Skin tone is independent of the variant.** Pick it uniformly from `palette.skinTones` for
every person, whatever their variant, role or outfit; never tie a tone to a build, an age or a
satirised role. (`humanoid-variants.png` spreads the tones across the roles for the same
reason.) Palettes: `palette.skinTones` (6), `palette.hair` (7), `palette.outfits` (14: top,
bottom, shoes, outer, accent, sole), `palette.fixed` (eyes, badge). `paletteTable()` in
`runtime/humanoid-vat.ts` makes one row per (outfit, hair, skin): row = (outfit x hairCount +
hair) x skinCount + skin.

### Rig and clips

20 bones with world-aligned rest frames: `root`, `hips`, `spine`, `chest`, `neck`, `head`,
`shoulder_L/R`, `upper_arm_L/R`, `forearm_L/R`, `hand_L/R`, `thigh_L/R`, `shin_L/R`,
`foot_L/R`. Skin weights are analytic, at most 4 per vertex. Every clip solves the hips so the
feet meet the ground (walk, idle, talk, wet shake), or sits the seat on the bench, or follows
the dive's scripted clearance.

| Clip | Adult frames @ fps | Loop | Notes |
|---|---|---|---|
| `walk` | 20 @ 20 (1.0 s) | yes | `speedMps` 1.34: move the instance at this speed (scale the rate with speed) so the planted foot stays put. Child: 16 @ 20 (0.8 s), 1.01 m/s |
| `idle` | 18 @ 6 (3.0 s) | yes | breathing, weight shift, a look round |
| `dive` | 30 @ 16 (1.8 s) | no | slapstick hop aside to the person's **left** (-X): crouch, dive, land on the side, roll up, brush off. `rootMotion` [-1.25, 0, 0]: the body ends 1.25 m to its left; keep the instance still for the clip, then move it there. Turn the person so their left points away from the car. Adults only |
| `wet_shake` | 33 @ 20 (1.6 s) | no | shoulders up, hands shake the water off, head shake, a sigh. Annoyed, never hurt. Adults only |
| `sit` | 12 @ 6 (2.0 s) | yes | on a seat `seatHeightM` 0.45 high (child 0.30), hips 4 cm behind the origin; benches and the wheelchair |
| `talk` | 24 @ 8 (3.0 s) | yes | gestures, nods, a shrug |

Children have `walk`, `idle`, `sit` and `talk` only: no dive and no wet shake, because water
never reaches a child and they are not slapstick props. The player also has `run` (0.7 s) and
`aim` (2.0 s, both hands on the blaster wand).

### Vertex-animation textures

One `.bin` per model and LOD, three sections back to back (little-endian; byte offsets and
lengths in `models.<model>.lods.<n>` of the JSON):

| Section | Format | Size (texels) | Contents |
|---|---|---|---|
| `position` | RGBA16F (half floats) | `width` x `frames * rowsPerFrame` | xyz = the vertex's position in the glTF model frame at that frame (w = 1) |
| `rotation` | RGBA8 | `width` x `frames * rowsPerFrame` | the vertex's blended bone rotation as a unit quaternion (x, y, z, w), stored as q * 0.5 + 0.5, w >= 0 |
| `morph` | RGBA16F | `width` x `12 * 2 * rowsPerFrame` | per shape key k: row 2k = rest position delta, row 2k+1 = rest normal delta |

Texel of vertex `v` in row `r` (a frame, or 2k + c for morphs):
`x = v % width`, `y = r * rowsPerFrame + floor(v / width)`. Today `width` = the vertex count
(1,670 or 579, all under 2,048) and `rowsPerFrame` = 1. Frames of all clips are stacked in clip
order; the clip table gives `startFrame`, `frameCount`, `fps`, `loop`, `durationS`. Sizes:
adult LOD0 2.9 MB, LOD1 1.0 MB, child LOD0 1.6 MB, LOD1 0.6 MB (serve them compressed).

A variant on top of the bake: `position = vatPosition(frame) + rotate(q(frame), sum_k w_k *
delta_k)` and `normal = rotate(q, normalize(restNormal + sum_k w_k * normalDelta_k))`. Because
skinning is linear, this is exact for a vertex on one bone; measured against exact skinning of
a variant it is within 0.6 mm at the 95th percentile and 11 mm at worst (tested).

### Shader contract (three.js)

`runtime/humanoid-vat-three.ts` is a reference the render track can adopt as is:
`createHumanoidVat(meta, model, lod, bin)` makes the textures (positions, rotations, morphs,
a variant-weight texture, an sRGB palette texture) and a `MeshStandardMaterial` patched with
`onBeforeCompile`; `addVatAttributes(instancedMesh)` and `setVatInstance(mesh, i, {...})` set
the per-instance attributes. One draw call per mesh, any number of people.

| Input | Kind | Meaning |
|---|---|---|
| `_vid`, `_slot` | vertex attributes (float) | vertex index into the textures; tint slot |
| `vatState` | instanced vec4 | clip index (into the model's clip table), clip start time (s), playback rate, unused |
| `vatLook` | instanced vec4 | variant row, palette row, wetness 0..1, unused |
| `vatTime` | uniform float | the current time on the same clock as the start times |
| `vatClips[8]` | uniform vec4 | startFrame, frameCount, fps, loop per clip |
| `vatLayout` | uniform vec4 | width, rowsPerFrame, shape-key count, 0 |

Per vertex: frame = (vatTime - start) x rate x fps, wrapped (loop) or clamped (one-shot);
blend the two neighbouring frames (positions linearly, rotations by normalised lerp with the
sign aligned); add the variant's rotated deltas; the instance matrix then places and scales
it. The fragment stage looks up `palette[palette row][slot]`, darkens wet clothes and hair
(not skin) and lowers their roughness. Give the InstancedMesh's geometry the JSON `bounds`
as its bounding sphere (the dive leaves the origin). The CPU twin of the vertex maths is
`VatData.decode()` in `runtime/humanoid-vat.ts`.

**Shadows.** three.js renders shadow maps with its own depth materials, which know nothing of
the textures, so without help every person casts the shadow of the rest pose (a diving person
would leave a standing shadow behind). `createHumanoidVat` also returns `depthMaterial`
(`MeshDepthMaterial`, directional and spot lights) and `distanceMaterial`
(`MeshDistanceMaterial`, point lights), patched with the same vertex maths (position only,
`VAT_VERTEX_POSITION`) and sharing the uniforms, so `vatTime` moves body and shadow together:

```ts
mesh.castShadow = true;
mesh.customDepthMaterial = vat.depthMaterial;
mesh.customDistanceMaterial = vat.distanceMaterial;
```

Checked in a real browser: three.js 0.186 under SwiftShader (Chromium) drew 48 instances
(every adult clip x every adult variant, mixed palettes) in one draw call with no GL errors,
and LOD1 and the child the same way. With the shadow materials, a diving adult's shadow under a
directional light covered x -2.00 to -0.40 m, where `VatData.decode()` puts the body at -2.00
to -0.40 m (without them: -0.25 to 0.25 m, the rest pose); the point-light shadow, LOD1 sitting
and a child walking matched the same way. These were scratch pages, not committed: the render
track should add an e2e for the crowd and its shadows.

### LODs and the impostor

LOD0 within about 60-80 m, LOD1 to 300 m (both play the same clips), the impostor beyond
(design.md, Performance). The atlas is drawn from the adult body only. **Children beyond
300 m** use the same atlas on a quad scaled by 0.66 (the child is 1.17 m against the adult's
1.78 m; at that distance a child is a few pixels tall and the proportions do not show); the
no-touch flag comes from the sim, not from what is drawn, so a child keeps it at any LOD. `humanoid-impostor.png` is 512 x 256: 8 columns (views 45 degrees
apart) x 2 rows (`idle`, `walk` mid-stride) of 64 x 128 px cells. R = slot x 16 + 8, G =
diffuse shading (sRGB), A = coverage (alpha test). Draw a camera-facing quad `cellSizeM`
(1 x 2 m) with its bottom on the ground; pick the column with `phi = atan2(d.x, -d.z)` for
`d` the person-to-camera direction in the person's glTF frame, `column = round(phi / 45 deg)
mod 8` (`impostorCell()` in the runtime); colour = palette[row][floor(R / 16)] x G.

### The player body (`player.glb`)

The adult body line as a skinned glTF, in the player's default look, founder-default (below). The
scene has two root nodes: `player` (the rig: the bone hierarchy, extras `fcActor`, `slots`,
`morphs`, `clips`, `heightM`, `defaultLook`, `looks`, `walkSpeedMps`, `morphCurves`) and
`player_body` (the skinned mesh). glTF ignores a skinned mesh's own transform and its parents'
(the Khronos validator warns when it is not a root), so the mesh sits beside the rig rather
than under it; every GLB here validates with no warnings (tested). Add the loaded `gltf.scene`
(or a `SkeletonUtils.clone` of it) to the world and move that, not the `player` node alone.

- **Skin and rig:** the 20-bone skin (the crowd's bones, placed for the player's 1.83 m frame).
  `build_player` checks at build time that Blender's armature deform matches the numpy skinning
  the VAT uses (to 0.00 mm, the body in its default look), so the player and the crowd move
  identically.
- **Morph targets (14, names in `extras.targetNames`):** the crowd's twelve in the crowd's
  order and index, then `jacket` and `smile`. The mesh's default weights (glTF `mesh.weights`,
  which three.js loads into `morphTargetInfluences`) are the default look's: `jacket` 1,
  `smile` 1, every other key 0.
- **Materials:** `tint_skin`, `tint_hair`, `tint_top`, `tint_bottom`, `tint_shoes`,
  `tint_outer`, `tint_accent`, `tint_sole`, and the fixed `eyes` (the irises), `badge`,
  `face_white` (whites of the eyes, teeth) and `face_dark` (pupils, lid lines, the mouth). Each
  carries extras `tintSlot`; they are coloured with the default look's palette row, so the GLB
  looks right as loaded. To change a look, set their colours from another row of
  `extras.looks`. No textures, no UVs.
- **`hair_quiff`:** the quiff is its own mesh node, a child of the `head` joint (not skinned: it
  rides the head bone rigidly, checked at build time to 0.000 mm). Its extras `hideWith` lists
  the crowd hair keys that replace it (`hair_none`, `hair_long`, `hair_bun`): hide the node while
  any of them has a weight above 0 (those keys reshape the body's hair cap only).
- **Clips:** glTF animations `walk`, `idle`, `dive`, `wet_shake`, `sit`, `talk`, `run`, `aim` at
  their authored lengths. The animations drive bones only (a glTF weights channel would
  overwrite every morph weight, look included). Talk's mouth is in `extras.morphCurves.talk.smile`
  (`[[seconds, weight], ...]` over the 3 s loop, 0.6-1.0): set the `smile` influence from it
  while `talk` plays; idle holds the default 1. `walkSpeedMps` (1.39) is the walk clip's ground
  speed for this taller body.
- The founder's avatar never gets wet (design.md); `wet_shake` is there for completeness. The
  water blaster attaches to its `chest` and `hand_R` bones.

### founder-default (the player's default look)

founder-default is a stylised likeness of the project owner, made to match the owner's
reference photos by eye. **The photos are kept outside the repository, always** (see Privacy
below). It is built in the humanoid line's style (solid shapes, flat colours, a simple face),
not as a scan or a photoreal face. What makes it recognisable, in order: the hair silhouette,
the colouring, the build, the outfit.

| Part | How | Where |
|---|---|---|
| Height | `FOUNDER_DEFAULT["height_m"]` = **1.83** m to the top of the skull (an estimate; one parameter). `player_frame(height_m)` scales the adult frame by `height_m / 1.765` (1.0368); the quiff rises to 1.878 m | `lib/humanoid.py` |
| Build | athletic, slim to medium, broad shoulders: `girth` 0.97, `limb` 1.05, `shoulders` +0.012, `waist` 0.93, `arm_out` 0.012; a sturdy neck (x1.24 wide, x1.16 deep; its top ring, inside the skull, keeps the crowd's width so the neck enters the head's underside cleanly) and a fuller trapezius; a head 8% larger (its crown kept at the height), so the likeness reads from the head. Round shoulders: the arm leans in toward the neck over the shoulder (`arm_cap_in`, from arm parameter 0.16 up to the cap), so the deltoid rounds off under the shoulder line instead of standing above it | `FOUNDER_DEFAULT["params"]`, `player_frame` |
| Head and face | `_face_point`: the crowd head kept broad through the cheeks (the jaw narrows late), a squarer jaw (`jaw` 1.16 and jaw-corner volume), cheekbones, full cheeks, and cheeks the smile lifts. `_player_face`: almond eyes (whites, a light blue-grey iris, pupil, catch light, a dark upper lid), straight thick dark brows, a straight nose, and the mouth. Feature positions in `FACE`. Ears: small solids (a rim round a shallow bowl, closed against the head), joined to the head at the front edge with the rim standing out up to 1.5 cm behind, so both show beside the face from the front | `lib/humanoid.py` |
| Smile (key `smile`) | 0: a closed smile line. 1: the wide, bright grin of the photos, upper teeth showing (they come forward from about 0.65), the lower lids rise (smiling eyes), the cheeks lift. Default weight 1 | `_player_face` |
| Hair | The hairline, `_hairline_player` (`PLAYER_HAIRLINE`, by the sine of the azimuth, the same both sides): arched across the forehead, high at the centre (about 4.5 cm above the brows: the forehead shows), down to the temples and short sideburns in front of each ear, round the top of the ear, then down behind it and across the nape in a short taper (the back hairline is about 3 cm above the jacket's collar). The body's hair cap (`hair` 0.012) is the short hair of the sides and back: 75% of that at the sides, thinning toward the nape (`_cap_off_player`); 32 columns plus 12 where the hairline turns round the ears; its hairline row tucked 3 mm into the skin (`PLAYER_CAP_ROWS`). `quiff()` (node `hair_quiff`): a solid shell (inner and outer surfaces, closed; no alpha cards), 2,600 triangles, over the top and back of the head. Its front row follows the forehead hairline, so it grows out of the skin and hides the cap's edge; its back rows run down to the nape hairline and tuck into the skin there the same way, so the back of the head is one surface; its side edges sink just under the cap. It lifts off the forehead into one rounded crest, leaning a little forward, 8.9 cm above the hairline and 4.8 cm above the skull (1.878 m), wide across the top (as wide as the face), a little higher on the person's right and falling lower over the left temple; the volume thins over the crown and down the back of the head to nothing at the nape, with no step. Shallow strands (grooves) run back and to the left; they shade the surface and stay out of the silhouette. Matte (`tint_hair` roughness 0.78). Measured against the photos as ratios of the eyes-to-chin distance: hairline 0.54 (photos 0.51-0.57), hair top 1.23 (1.19-1.24) | `lib/humanoid.py` |
| Bomber (key `jacket`) | `_player_jacket`, all on `tint_outer`: a blouson shell over the torso that overhangs a rib hem at the hips (`jacket_z` 0.95-1.00 m, over the jeans), a stand-up rib collar round the neck, open at the throat (1.53-1.59 m), and full sleeves gathered into rib cuffs; the zip on `tint_accent`. At 0 the jacket sinks inside the body (hidden), at 1 it is worn | `lib/humanoid.py` |
| Tee, jeans, sneakers | the tee is the body's `top` slot (its crew neck raised to the base of the neck: `collar_z` 1.555 m) with short sleeves: the arm is `top` down to a hem at arm parameter `tee_sleeve` 0.4 (a little under halfway to the elbow) and bare (`skin`) below it, the wrist tapering into the hand and closed. The bare forearms are athletic (`arm_bare`, up to 13% fuller); the `jacket` key slims them into the bomber's sleeves, which cover the arms in the default look. Straight-leg jeans (`bottom`, 10% fuller from the knee down, breaking over the shoe). Each leg runs on up to the waist as its half of the hips (`leg_hip`: a superellipse like the torso's, the two halves overlapping past the centre line in a shallow fly and seat seam down to the crotch, then parting into the round legs; weighted like the body at the waist), so one surface carries the hips and the body's own hips sit just inside it; close to the body just under the jacket's rib hem, so the hem stands clear. Sneakers with a chunky white sole (`sole` 0.03 m) and black uppers | `player_frame`, `build` |

**Palette rows** (`PLAYER_LOOKS` in `models/humanoid.py`; in the GLB as `player.extras.looks`,
one colour per slot of `extras.slots`, plus the look's morph weights):

| Look | skin | hair | top | bottom | shoes | outer | accent | sole | eyes | face_white | face_dark | morphs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `founder-default` | `#d6907e` | `#2e2219` | `#121214` (black tee) | `#46597a` (faded mid-blue jeans) | `#161618` | `#18181b` (black bomber) | `#3a3b3f` (zip) | `#eeebe4` | `#8fa4b0` | `#f2ede6` | `#2a1d1b` | jacket 1, smile 1 |
| `founder-default-tee` | same | same | `#8f939b` (heather-grey tee) | same | same | (hidden) | (hidden) | same | same | same | same | smile 1 |

The colours were chosen by eye against the photos (and a few plain values sampled from them as
numbers); nothing from a photo's pixels is in any file. `badge` stays the crowd's `#f6f5f0`.
The crowd wears long sleeves (it is Fog City), but the player's tee is short-sleeved, as in the photos.

**Privacy (non-negotiable).** The reference photos never enter the repository: not as files,
not as textures, not as image patches, not as comparison sheets. Nothing in the repository
names the person; code and docs say founder-default and "the project owner's reference photos,
which are kept outside the repo". Comparisons that put a photo beside a render are made and
kept outside the repository. `tests/assets/privacy.test.ts` fails when any `.jpg`, `.jpeg`,
`.heic` or `.heif` file exists in the tree outside `node_modules`, or when any file under
`assets/` or `public/` carries JPEG or HEIF data (a file that starts with a JPEG header, an
embedded JFIF/Exif JPEG, a HEIF/AVIF `ftyp` box, or a GLB that declares a JPEG image). On
wave2/assets no file had such bytes, so its allow-list is empty. It also fails when an image in
`assets/`, `public/models/` or `public/audio/` was not drawn by a script in the repository (a
look-dev render by the script beside it, the impostor atlas by `humanoid_impostor.py`; any other
image must be added to its `GENERATED` list with the script that writes it), so a crop of a photo
re-saved as a PNG cannot slip in.

**Consent and scope.** founder-default was made at the project owner's request, from the owner's
own photos. CLAUDE.md's content rules say never to depict real private people; this consented
self-likeness is an exception that belongs in the decision log of `docs/design.md` (not an Assets
file: requested from the owner), together with the owner's choice of whether founder-default is
every player's default look or only the owner's own, with a neutral default for other players.
The historical source `player.glb` retains it as `defaultLook`; the current runtime loads
`generic-player.glb` instead and excludes the likeness asset from the hosted build.

The crowd is unchanged by all of this: every founder-default branch in `lib/humanoid.py` is
gated on the frame's `player` flag, and the crowd GLB, VAT textures, `humanoid-vat.json`, the
impostor and the reference fixture rebuild byte-identical.

## Sound effects

`assets/audio/generate.py` synthesises `public/audio/{spray,splash,rust-creak,melt-fizz,
moat-jingle}.{ogg,mp3}` and `public/audio/manifest.json`; details in `assets/audio/README.md`.

## Trade-dress checklist

`tests/assets/trade-dress.json` records each robot and vehicle's silhouette and the real
products and film robots it was compared with (design.md asks for this before merge);
`trade-dress.test.ts` fails when a robot or vehicle model has no entry. Every entry waits for
the user's sign-off. The wave-1 robotaxi failed the Meander row (a crossover with a roof
dome); it was remodelled in wave 2 and its entry now records the Meander's silhouette and
comparisons.

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
  distance-weighted skin over the MakeHuman joint centres into the sculpture's stance: the
  real piece stands in Tadasana (mountain pose), arms open at her sides, palms forward, chin
  up. So the script closes the fingers, straightens the wrists and elbows, turns the palms
  forward (the twist angle is solved from the finger joints), opens the arms to about 25
  degrees from the body and lifts the chin; then adds a short bob and voxel-remeshes. From
  that solid: decimated to 2,000 triangles and turned into 7.5 cm rods by a Wireframe
  modifier (`frame`); decimated to 5,200 and textured with a generated diamond chain-link
  pattern, alpha-tested (`shell`); an inner skin inset by up to 22 cm (less where she is
  thin, measured by ray casts, so fingers never turn inside out) with the same pattern,
  emissive lavender for night (`glow`); and the round plinth.

  **Pose (art sign-off pending).** The brief says "a woman with arms raised" and also "the
  real sculpture's look". The real R-Evolution stands "firmly with both feet on the ground,
  eyes closed, arms open at her sides, palms forward" (Burning Man 2015 photo description,
  loupiote.com/photos/21661250215.shtml; Wikipedia: "a woman standing in a tadasana
  pose"); raised arms are Cochrane's earlier *Bliss Dance* and *Truth is Beauty*. The game's
  model follows the real stance (root extras `pose: "tadasana"`). The raised-arms version is
  one switch away and passes the same tests:
  `FC_REVOLUTION_POSE=raised assets/blender/build.sh r_evolution` rebuilds
  `public/models/r-evolution.glb` with both arms lifted overhead in a V (about 30 degrees off
  vertical, palms forward, fingertips at 13.7 m; extras `pose: "raised"`). Large shoulder
  turns need a real skin, so that pose uses a small armature on the MakeHuman joints with
  Blender's automatic (bone heat) weights and dual-quaternion skinning; the girdle takes 22
  degrees of the lift at the clavicle and the arm the rest at the shoulder. Look-dev 04 shows
  both side by side. To test a variant without replacing the game's file:
  `"$BLENDER" -b --factory-startup -noaudio -P assets/blender/models/r_evolution.py -- pose=raised out=assets/blender/.cache/variants/raised`
  then `FC_MODELS_DIR=assets/blender/.cache/variants/raised pnpm vitest run tests/assets -t r-evolution`.
- **Cars** (`lib/vehicle.py`): a lofted, welded body whose sill line rises over each wheel to
  carve round arches, a greenhouse loft with A/B/C pillars, light bars, cladding, arch liners
  and hub-centred wheel nodes. The player car is an original orange hatchback. The Meander
  pod lofts horizontal rings instead (`models/robotaxi.py`): one rounded outline offset
  inward ring by ring, the rings below the belt raised over the wheels for the arches, a
  material per band and column (cladding, paint, glass, the dark cabin behind the door, the
  sensor band), a crowned roof, then ribbons over the outline for the light bars and the
  status line, lathed corner pods, and the door built from the body's own kerb side pushed
  out 8 mm. No real vehicle, badge or livery.
- **Porter, Trundle, bus, van, props**: capsules, lathes, lofts, gridded panels and boxes from
  `lib/fc.py` and `lib/vehicle.py`; the robots' melt keys from `lib/melt.py`.
- **Heaps** (`models/heaps.py`): import the exported robot, apply its `melt` key, swap its
  materials for rust by each face's `_RUST_MASK`, decimate to 2.5k triangles, add a puddle.
- **Humanoid** (`lib/humanoid.py`, `lib/humanoid_clips.py`, `models/humanoid.py`): see
  Humanoid line. The crowd GLB is written directly by `lib/glbwrite.py` (the vertex order is
  the texture order); the player GLB by Blender's exporter.

## Look-dev renders (`lookdev/`)

`01-ferry-revolution-golden-hour.png`, `02-ferry-revolution-night.png`,
`03-street-robots-dusk.png`, and `04-r-evolution-pose-options.png` (for the pose sign-off:
left, the game's model in the real stance; right, the brief's raised arms, built by the
script into `.cache/variants/raised/`): Cycles CPU, 960x540, 64 samples + OpenImageDenoise,
mist pass for fog, bloom at night. Each scene imports the exported GLBs and places the
landmarks from `content/landmarks.json`, so the renders show exactly what the game loads.
The plaza set (`lib/plaza.py`) and the dusk street (in its script) exist only for the
renders; the storefronts carry no names or words (iconography only, blank sign slots).
Renders are deterministic (fixed seed and thread count), and `lookdev.render()` strips the
PNG text chunks where Blender writes the date and render timings, so re-rendering an
unchanged scene leaves the files byte-identical. `03-street-robots-dusk.png` was re-rendered in
wave 2 with the remodelled Porter, Trundle and Meander.

Wave 2, for the art sign-off (1800 x 640, 48 samples + denoise, a neutral studio set, all under
2 MB):

| File | Shows |
|---|---|
| `05-porter-turntable.png` | the Porter front, three-quarter, side, back; then seized (rust 0.35), slumping (0.6), melted (0.9) with the `_RUST_MASK` rust preview, and `heap-porter.glb` |
| `06-trundle-turntable.png` | the Trundle front, three-quarter, side, back, with its lid rolled open; then the melt sequence and `heap-trundle.glb` |
| `07-moat-van-turntable.png` | the van front three-quarter, side, rear three-quarter with the barn doors open |
| `08-prop-lineup.png` | repair kiosk, the player wearing the water blaster, vendor cart, wheelchair; hydrant, drinking fountain, cone, the three heaps, two pigeons (standing, pecking), the leashed dog |
| `09-meander-turntable.png` | the Meander robotaxi: the kerb side from the front three-quarter, the street side broadside (the asymmetry), the kerb side from the rear three-quarter with the sliding door open |
| `humanoid-variants.png` | the 8 adult variants and the 2 child looks in suggested outfits, decoded from the VAT as the crowd shader decodes them |
| `humanoid-turntable.png` | the crowd's founder variant from four sides (VAT), and `player.glb` (founder-default) wearing the blaster, front and back |
| `player-founder-turntable.png` | `player.glb` in founder-default as the game loads it (default morph weights: bomber and smile on) at rest: front, three-quarter, side, back |
| `player-founder-head.png` | founder-default head and shoulders, smiling: front and front three-quarter (1600 x 900, 64 samples, a soft key from the front left) |
| `humanoid-clips.png` | walk, idle, wet shake, talk, sit (on a 0.45 m bench), four dive moments, the child walking (all VAT) |

## Sources and licences

- SF Building Footprints, DataSF `ynuv-fyni` (record committed in `data/`); SF Streets
  `3psu-pn9h` for Market St (used to check the R-Evolution placement). Open data, City and
  County of San Francisco.
- MakeHuman hm08 base mesh, female/proportion targets and joint helpers: CC0 1.0
  (github.com/makehumancommunity/makehuman, LICENSE.md section C). Re-fetch with
  `tools/fetch_sources.py`, regenerate `data/makehuman-female*.{ply,json}` with
  `tools/make_base_female.py`.
- Photographs (SF Arts Commission extension proposal, Wikipedia, a Burning Man 2015 photo
  page at loupiote.com for the pose description) were used as reference only; no imagery is
  in the assets. All textures are generated by the scripts.
- Wave 2 uses no outside data: the humanoid, robots, van, props, heaps and animals are
  generated by the scripts, and the sounds are synthesised (`assets/audio/`).
- founder-default, the player's default look, was matched by eye to the project owner's
  reference photos, which are kept outside the repo; no image data from them is in any file
  (see founder-default, Privacy).

## Palace of Fine Arts

`models/palace_of_fine_arts.py` creates an original open rotunda and curved
colonnades at the existing SF site. The terracotta dome, octagonal arcade,
Corinthian columns and coffers follow the [California Office of Historic
Preservation nomination](https://ohp.parks.ca.gov/pages/1067/files/CHL_San%20Francisco_Palace%20of%20Fine%20Arts.pdf)
and the [SF Recreation and Parks site](https://recpark.sf.gov/Facilities/Facility/Details/Palace-of-Fine-Arts-423).
No third-party model or texture is included. The existing exhibition hall stays.

The 1.33 MB GLB contains 38,608 triangles and eight material primitives. Its 415
structural collision pieces are in `content/palace-of-fine-arts.json`; the loader
uses that packet before indexing the world and includes it in the world identity.
The generator writes the model and this packet together. Do not replace it
with a solid rotunda footprint: people and the camera must pass under its arches.

`build_palace_lagoon.py` traces the existing terrain's low basin into
`content/palace-lagoon.json`. This is a small render-only water surface using the
existing water shader, also shown on the map. It changes no terrain samples or
simulation water rules. Regenerate it only when the source DEM changes.
