# Material textures (high graphics tier)

Tiling PBR sets the high tier maps onto roads, sidewalks, plazas, lawns and the landmark models
(`src/render/detail.ts`, `src/render/showcase.ts`). Each set is three 1024 px WebP maps in
`public/models/textures/`: `<set>_albedo` (sRGB), `<set>_normal` (OpenGL, +Y up) and `<set>_orm`
(R occlusion, G roughness, B metalness). The paint set's `orm` R channel is paint coverage (wear) instead.
`public/models/textures/textures.json` is the manifest: real-world size per repeat, mean colour,
source, author, licence and how each map was adapted. The static build packs the folder (`scripts/build-web.ts`).

| Set | Source | Licence | Script |
|---|---|---|---|
| asphalt | Poly Haven `asphalt_02` (Rob Tuytel) | CC0 1.0 | `fetch_cc0.py` |
| concrete | Poly Haven `concrete_pavement` (Charlotte Baglioni) | CC0 1.0 | `fetch_cc0.py` |
| pavers | Poly Haven `concrete_pavers_02` (Amal Kumar) | CC0 1.0 | `fetch_cc0.py` |
| sandstone | Poly Haven `white_sandstone_blocks_02` (Rob Tuytel) | CC0 1.0 | `fetch_cc0.py` |
| grass | Poly Haven `leafy_grass` (Charlotte Baglioni) | CC0 1.0 | `fetch_cc0.py` |
| paint | procedural (seeded noise) | project-owned | `generate.py` |

Rules:
- Material scans only: never photographs of people or of real San Francisco facades.
- CC0 only, and only from the hosts the privacy test allows (`tests/assets/privacy.test.ts`: Poly Haven, ambientCG).
  Each scan is logged in `textures.json` with its URL and licence. A scan missing from the manifest fails the test.
- No JPEG in the repository. Downloads land in `~/.cache/fog-city/cc0`, outside the checkout, and only WebP is committed.
- `generate.py` keeps procedural fallbacks for every set (`python3 assets/textures/generate.py asphalt`
  regenerates one over its scan).

Rebuild: `python3 assets/textures/fetch_cc0.py` (network: api.polyhaven.com, dl.polyhaven.org), then
`python3 assets/textures/generate.py` (paint).
