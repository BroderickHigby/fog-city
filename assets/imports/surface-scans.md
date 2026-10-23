# Scanned road and paving surfaces

The six 1024 × 1024 WebP maps in `public/textures/surfaces/` were copied byte-for-byte
from `feature/latest-showcase` commit recorded in `sources.json`. They are material
scans, not images of people or San Francisco buildings.

| Surface | Source and author | Licence | World repeat |
| --- | --- | --- | --- |
| Asphalt | [asphalt_02](https://polyhaven.com/a/asphalt_02), Rob Tuytel | [CC0 1.0](https://polyhaven.com/license) | 3 m |
| Concrete pavement | [concrete_pavement](https://polyhaven.com/a/concrete_pavement), Charlotte Baglioni | [CC0 1.0](https://polyhaven.com/license) | 1.8 m |

The original import downloaded Poly Haven's 1K `Diffuse`, `nor_gl`, and `arm` JPEG
maps, converted them to RGB and re-encoded as 1024px WebP (quality 90 for albedo/ORM,
94 for normal). No JPEGs or external runtime requests are needed. Per-file provenance,
source links, real-world scale and measured linear albedo means are in
`public/textures/surfaces/sources.json`.

`src/render/surface-textures.ts` samples albedo in sRGB and normal/ORM as linear data.
ORM channels are red = ambient occlusion, green = roughness, blue = metalness;
the normal map uses the OpenGL +Y convention. World X/Z coordinates supply UVs in
metres, independent of absent ground UVs or normalized road ribbon UVs. Repeating
mipmapped textures use at most 8× anisotropy. All maps are bounded to 1024px (about
32 MiB of RGBA GPU storage including mipmaps), shared across the four materials.

Albedo is divided by its source mean so the existing SF surface palette and distant
geometry remain consistent. A brightness/chroma/slope mask preserves road paint,
coloured park/soil surfaces, steep terrain and seabed. Pavers are deliberately not
included: canonical terrain currently has no plaza semantic mask, so applying pavers
to all neutral ground would misrepresent most streets.

## Integration

Call once after `createSharedMaterials()`:

```ts
const surfaces = loadSurfaceTextures(materials, path => assets.bytes(path), {
  anisotropy: renderer.capabilities.getMaxAnisotropy(),
});
```

Loading is optional and does not block the scene. `surfaces.ready` resolves to
`{ loaded, failed, disposed }`, enabling an explicit QA assertion that both named
surfaces loaded. Call `surfaces.dispose()` before disposing shared materials. It
restores prior shader callbacks and cache keys, frees owned textures and bitmap
images, and prevents late loads from changing disposed materials. Any failed set
leaves its original procedural material intact.

Production `scripts/build-web.ts` must pack the six WebPs into the asset index with
logical paths `textures/surfaces/<name>.webp`. Use the existing binary `single()`
helper; it produces the compressed/base64 payloads consumed by `Assets.bytes`.
Copy `sources.json` as a normal JSON file for attribution. Packed builds request
encoded text payloads; loose development requests the source WebPs through the
same bytes provider.
