# Pedestrian crowd assets

`public/models/crowd/*.glb` are twelve adult characters from the Microsoft Rocketbox avatar library: six women and six men, chosen for variety of clothing, build and age. The renderer draws the nearest pedestrians with them (`src/render/crowd-humans.ts`). They are generic library characters, not likenesses of real people. Children are not in the crowd.

- **Upstream:** <https://github.com/microsoft/Microsoft-Rocketbox>
- **Pinned source commit:** `0943055db6ec570bcef9f2c8b41c9e5467c808f9`, the same commit as the player avatar (`assets/imports/rocketbox/`).
- **Characters:** `Assets/Avatars/Adults/<name>/Export/<name>.fbx`, listed in `crowd.json`. Their textures are the adjacent `Textures/*.tga`, which `fetch.py` reads from the FBX itself.
- **Motions, per gender:**
  - idle: `Assets/Animations/all_animations_max_motextr_static/{f,m}_idle_neutral_01.max.fbx`, trimmed to 5 s;
  - walk: `Assets/Animations/all_animations_max_motextr_xy/{f,m}_walk_neutral.max.fbx`;
  - run: `Assets/Animations/all_animations_max_motextr_xy/{f,m}_run_neutral.max.fbx`.
- **Licence:** MIT, copyright (c) 2020 Microsoft (`LICENSE.md`; the upstream README records the December 2020 switch of the avatar library to MIT). Use, modification and redistribution are permitted with the notice retained. The notice is embedded in each GLB's `asset.copyright` and listed in the build's `third-party-notices.txt`.
- **Inputs:** `source-files.json` records the SHA-256 of every input file.

## Rebuild

From the repository root (Blender 4.5 LTS, Python 3):

```sh
python3 assets/imports/rocketbox-crowd/fetch.py /tmp/fog-crowd
for c in $(python3 -c "import json;[print(x['name']+':'+x['gender']) for x in json.load(open('assets/imports/rocketbox-crowd/crowd.json'))['characters']]"); do
  flock /tmp/fog.lock "$BLENDER" -b --python assets/imports/rocketbox-crowd/convert.py -- /tmp/fog-crowd "${c%%:*}" "${c##*:}" "public/models/crowd/${c%%:*}.glb"
done
```

The conversion is the player's (`assets/imports/rocketbox/convert.py`):
- the original 7,000–7,500-triangle skinned mesh and its rig;
- idle/walk/run clips retargeted from the matching library skeleton, with planar root travel removed so the sim controls position;
- the character facing glTF -Z, with its feet at the origin.

Crowd textures are capped at 512 pixels (colour as JPEG, normals and hair opacity as PNG), because pedestrians are seen from metres away.

| File | Size |
|---|---|
| `Female_Adult_01.glb` | 2.04 MB |
| `Female_Adult_03.glb` | 2.23 MB |
| `Female_Adult_05.glb` | 2.02 MB |
| `Female_Adult_07.glb` | 2.01 MB |
| `Female_Adult_09.glb` | 2.07 MB |
| `Female_Adult_11.glb` | 2.06 MB |
| `Male_Adult_02.glb` | 1.86 MB |
| `Male_Adult_04.glb` | 1.98 MB |
| `Male_Adult_06.glb` | 2.03 MB |
| `Male_Adult_08.glb` | 1.85 MB |
| `Male_Adult_10.glb` | 1.82 MB |
| `Male_Adult_12.glb` | 1.45 MB |
