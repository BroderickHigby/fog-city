# Generic online player asset

`public/models/generic-player.glb` is a game-ready conversion of **Male_Adult_01** from the Microsoft Rocketbox avatar library. It is a generic library character, not a likeness of the game owner.

- Upstream: <https://github.com/microsoft/Microsoft-Rocketbox>
- Pinned source commit: `0943055db6ec570bcef9f2c8b41c9e5467c808f9`
- Original model: `Assets/Avatars/Adults/Male_Adult_01/Export/Male_Adult_01.fbx`
- Textures: the adjacent avatar `Textures/m002_*` files.
- Motions: `m_idle_neutral_01.max.fbx` from `Assets/Animations/all_animations_max_motextr_static`; `m_walk_neutral.max.fbx` and `m_run_neutral.max.fbx` from `Assets/Animations/all_animations_max_motextr_xy`.
- Licence: **MIT, copyright (c) 2020 Microsoft**. The complete notice is in `LICENSE.md`. Upstream README explicitly records the December 2020 switch of the avatar library to MIT. The licence permits use, modification and redistribution with its notice retained.

No account, paid licence or external asset request is needed at game runtime. Textures are embedded in the GLB. The old `player.glb` and its likeness-specific source are not overwritten.

## Rebuild

Run from the repository root (Blender 4.3+ and Python 3):

```sh
python3 assets/imports/rocketbox/fetch.py /tmp/fog-rocketbox
flock /tmp/fog.lock blender -b --python assets/imports/rocketbox/convert.py -- /tmp/fog-rocketbox public/models/generic-player.glb
```

`source-files.json` records SHA-256 values for the immutable input files. Conversion retains the original 7,440 triangles and skinned rig, creates neutral idle/walk/run clips from the matching library skeleton, removes planar root travel so the simulation controls position, orients the character toward glTF -Z and normalizes the feet to the origin. Color textures use JPEG; normal/opacity textures remain PNG. Body and normal images are capped at 1024 pixels; the face color retains 2048 pixels.

## Shared clips for every human on this skeleton (`public/models/anim/`)

`clips.py` bakes clip-only GLBs on the avatar's skeleton (no mesh or textures; three.js binds the tracks to `generic-player.glb`'s bones, or any Rocketbox `Bip01` character's, by name). The reviewed `generic-player.glb` is unchanged. Every source file's SHA-256 and each output's are in `clips.json`. The bake is deterministic.

- **`dodge-clips.glb`** (≈470 KB): getting out of a car's way (`src/render/human-motion.ts` `motionFor`). Rocketbox `m_run_start` → `runStart` (the startled push-off), `m_run_fast_01` → `sprint` (time-scaled to the sim's speed so the feet don't slide), `m_run_stop` → `runStop`, `m_idle_dust_01` → `recover` (brushing off).
- **`crowd-clips.glb`** (≈1.2 MB): varied idles and walks for the crowd (Lane R's skinned crowd picks by agent id): Rocketbox `walkStroll`, `walkSlow`, `walkFast`, `walkCool`, `jog`, `idleBreathe`, `idleTexting`, `idleWaiting`. Long idles are cut to 10 s loops. Each walk's speed (`sourceSpeedMps`) is in `clips.json` and the root's extras.

The Mixamo clips for the same skeleton come from the supplied library through the player's retarget pipeline (`assets/imports/mixamo/build.ts`, #82), not from Blender:
- `node assets/imports/mixamo/build.ts --set dodge` → **`mixamo-dodge.json`**: "Stumble Backwards" (frames 1–20, cut before the fall) → `stumble` (the override's shove) and "Dodging Right" → `flinch` (a sidestep). `player-body.ts` loads it for every human; a crowd character keeps its own hip height (the bank's hip track is the player's).
- `node assets/imports/mixamo/build.ts --set crowd` → **`mixamo-crowd.json`**: `walkCasual` (female locomotion walking), `walkTexting`, `idleHappy`, `idleLookAround`, `idlePhone`, `idleArguing`, `wave`, `clap`.

```sh
python3 assets/imports/rocketbox/fetch.py /tmp/fog-rocketbox --dodge
flock /tmp/fog.lock blender -b --python assets/imports/rocketbox/clips.py -- /tmp/fog-rocketbox public/models/anim/dodge-clips.glb --set dodge
flock /tmp/fog.lock blender -b --python assets/imports/rocketbox/clips.py -- /tmp/fog-rocketbox public/models/anim/crowd-clips.glb --set crowd
node assets/imports/mixamo/build.ts --set dodge
node assets/imports/mixamo/build.ts --set crowd
```
