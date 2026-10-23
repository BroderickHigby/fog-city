# SF rendering QA

These are screenshots from the real game on `lane/render/wave2`, using Chromium with SwiftShader. They are not concept art and do not establish native GPU frame rates.

- `noon-1080p.png`: 1920 × 1080 noon view of the Ferry Building.
- `avatar-1080p.png`: the generic human and new car in the same 1080p rendering configuration.
- `golden.png`: normal driving view, with scanned asphalt/concrete, the civilian car, shadows, and the high-quality presentation pass.
- `ferry-golden.png`: the Ferry Building and Embarcadero Plaza, viewed from the city side.
- `night.png`: the same Ferry Building view at night.

Reproduce with `tests/e2e/realism.spec.ts`. The test requests `?world=sf&quality=1&shadows=1&tod=golden&radius=350&pr=1`, verifies the surface scans and bounded leaf foliage loaded, captures the views and changes time of day while checking that the paused simulation hash stays identical.

The generic human is shown in `../avatar-human/`. Asset sources and licences are in `assets/imports/`; the packaged build includes `third-party-notices.txt` and surface-source attribution.

The visual direction uses the rendering ideas in [Slop New York](https://github.com/mrdoob/slop-newyork) while retaining Fog City's SF geography and landmarks. A direct reference comparison could not run on this environment's software GPU, so these images are evidence of Fog City only. The remaining city art is procedural; these changes do not make it a photogrammetry recreation.
