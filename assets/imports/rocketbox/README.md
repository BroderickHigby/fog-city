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

## Dodge clips (`public/models/generic-player-dodge.glb`)

When a car comes at a player on foot, the body plays these clips (`src/render/player-body.ts` `motionFor`): `runStart` (a startled push-off), then `run` or `sprint` at the sim's speed (time-scaled to the clip's own speed so the feet don't slide), `flinch` for a short sidestep, `stumble` for the clearance override's shove, and `recover` (brushing off) once clear. The file holds only the avatar's skeleton and the clips (612 KB), so the reviewed `generic-player.glb` stays unchanged. three.js binds the tracks by bone name.

- Rocketbox (MIT, the same pinned commit): `m_run_fast_01`, `m_run_start`, `m_run_stop`, `m_idle_dust_01`, baked exactly as `convert.py` bakes idle/walk/run.
- Mixamo (Adobe): `Stumble Backwards` (frames 1-20, cut before the fall) and `Dodging Right`, from the owner's download on branch `assets/mixamo-raw` (`4fa39e3`). They are retargeted onto the Rocketbox rig by bone direction: limbs are turned from T-pose to the rig's rest along their joint-to-joint segments, the trunk, head and feet are taken as both rigs' upright rest, and the hip height is scaled. Mixamo's terms allow use in games; the raw FBX files are not redistributed by the build.
- `dodge-clips.json` records every source file's SHA-256 and the output's.

```sh
python3 assets/imports/rocketbox/fetch.py /tmp/fog-rocketbox --dodge
git show 'origin/assets/mixamo-raw:assets/mixamo/Stumble Backwards.fbx' > '/tmp/fog-mixamo/Stumble Backwards.fbx'
git show 'origin/assets/mixamo-raw:assets/mixamo/Dodging Right.fbx' > '/tmp/fog-mixamo/Dodging Right.fbx'
flock /tmp/fog.lock blender -b --python assets/imports/rocketbox/clips.py -- /tmp/fog-rocketbox public/models/generic-player-dodge.glb /tmp/fog-mixamo
```
