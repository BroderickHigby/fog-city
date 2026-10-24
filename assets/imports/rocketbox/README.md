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

- **`dodge-clips.glb`** (≈600 KB): getting out of a car's way (`src/render/human-motion.ts` `motionFor`).
  - Rocketbox `m_run_start` → `runStart` (the startled push-off), `m_run_fast_01` → `sprint` (time-scaled to the sim's speed so the feet don't slide), `m_run_stop` → `runStop`, `m_idle_dust_01` → `recover` (brushing off).
  - Mixamo "Stumble Backwards" (frames 1–20, cut before the fall) → `stumble` (the override's shove) and "Dodging Right" → `flinch` (a sidestep).
- **`crowd-clips.glb`** (≈2 MB): varied idles and walks for the crowd (Lane R's skinned crowd picks by agent id).
  - Rocketbox `walkStroll`, `walkSlow`, `walkFast`, `walkCool`, `jog`, `idleBreathe`, `idleTexting`, `idleWaiting`. Long idles are cut to 10 s loops.
  - Mixamo `walkCasual` (female locomotion walking), `walkTexting`, `idleHappy`, `idleLookAround`, `idlePhone`, `idleArguing`, `wave`, `clap`.
  - Each walk's speed (`sourceSpeedMps`) is in `clips.json` and the root's extras.

**Retargeting Mixamo onto the Rocketbox rig** (`retarget_mixamo`):
1. Each mapped bone takes its source bone's world rotation since the source's rest pose. That rotation is expressed in the target's facing (the root's half turn) so a nod stays a nod.
2. A limb (clavicle, arm, forearm, thigh, calf) is first turned from its rest segment onto the source's (the T-pose/A-pose difference). The trunk, head and feet use both rigs' upright rest.
3. The clip is turned to face the way the body moves, as the Rocketbox clips do.
4. The hip height is scaled by the two rigs' hip heights, and planar root travel is removed (the sim moves the body).

```sh
python3 assets/imports/rocketbox/fetch.py /tmp/fog-rocketbox --dodge
# the Mixamo inputs, from the owner's download (paths as in clips.py's lists):
mkdir -p /tmp/fog-mixamo && git archive origin/assets/mixamo-raw assets/mixamo | tar -x -C /tmp/fog-mixamo --strip-components=2
flock /tmp/fog.lock blender -b --python assets/imports/rocketbox/clips.py -- /tmp/fog-rocketbox public/models/anim/dodge-clips.glb /tmp/fog-mixamo --set dodge
flock /tmp/fog.lock blender -b --python assets/imports/rocketbox/clips.py -- /tmp/fog-rocketbox public/models/anim/crowd-clips.glb /tmp/fog-mixamo --set crowd
```
