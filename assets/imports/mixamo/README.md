# Supplied Mixamo character library

Imported from the owner's `characters.zip` on 2026-10-23. `source-files.json`
records the archive SHA-256 and the original path, byte count and SHA-256 of
all 172 FBX files. Only FBX files were imported; unrelated documents, ads,
images, audio and video in the archive were excluded. No attached document
was treated as a development instruction.

The complete source library lives in `assets/mixamo/`, outside the web root.
It includes a Y Bot model, locomotion, gestures, dance and other animation
packs. Some supplied motions depict weapons or injury. Those are source
material only and are not connected to Fog City's nonviolent gameplay.

## In the game

Four supplied clips are retargeted to the existing generic Rocketbox player:

| Source | Runtime motion | Used when |
| --- | --- | --- |
| Breathing Idle.fbx | idle | stationary |
| Walking.fbx | walk | walking |
| Jogging.fbx | jog | ordinary 3 m/s movement |
| Running.fbx | run | Shift sprint at 7 m/s |

Existing player geometry, textures and crowd models are preserved. The Y Bot
and the remaining source motions are available for future work; they are not
additional selectable characters or gameplay actions in this change.

Rebuild with Node >=22.18 after installing the repository dependencies:

```sh
node assets/imports/mixamo/build.ts
```

This writes `public/models/mixamo-motion.json` (about 1 MB before packing).
The build packs it through the same byte-provider used for models. Only the
four retargeted clips ship to browsers, not the raw FBX files. The converter
aligns the source T-pose and target A-pose in world space, transfers bone
rotations, removes horizontal root motion and preserves vertical hip motion.
Each player retains an independent mixer and skeleton. Missing or unsupported
motion banks fall back to the model's original baked animations.

The retargeted clips are calibrated to `generic-player.glb`; they are not
applied to the different crowd rigs. No simulation, replay or save schema
changes are required.

## Source terms

The files are supplied Mixamo assets. Adobe's [Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)
permits use of Mixamo characters and animations in games. Adobe's
[licensing FAQ](https://community.adobe.com/questions-696/mixamo-faq-licensing-royalties-ownership-eula-and-tos-589400?lang=en)
distinguishes incorporation in a project from distribution of raw source
assets. Keep the FBX library in the private development repository; do not
publish it as a standalone asset download.
