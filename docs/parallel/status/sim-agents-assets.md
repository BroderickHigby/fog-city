# Fog City asset audit — 2026-10-23

Scope: asset inventory and source inspection of `/workspace/fog-city-lane3`, current completion worktree. Parsed every committed GLB JSON chunk and embedded PNG header, all public PNG headers, asset contracts/tests and runtime asset selection. No Blender rebuild, visual approval, GPU timing, or new asset tests were run for this audit.

## Finding

A blanket “all assets are HD” claim is not supported. This is a deliberately stylised, mostly untextured PBR game; resolution is not a property of its meshes. Its documented display target is 1080p at 60 fps on a 2022 mid-range laptop (`docs/design.md:1071`, `:1094`). Full visual quality needs close-up and motion review at that target, plus hardware measurements. Raising texture dimensions does not add geometry, articulation, good composition or better art.

## What is actually present

- 22 authored model GLBs and 644 tile GLBs are present. Most use material colours and geometry, not diffuse image textures. The authored player has 7,896 triangles, errand robot 4,948, van 3,904, taxi 4,104, bus 2,956, dog 828, pigeon 194, Ferry Building 31,886 and R-Evolution 32,216. These are intentional style/performance budgets documented in `assets/blender/README.md:59` onward; triangle counts alone do not prove quality.
- Across all GLBs, only two embedded visual PNGs were found: bus livery **1024 × 180**, and R-Evolution’s repeated chain-link alpha mask **256 × 256**. All 644 tile GLBs have no embedded images. The sculpture mask is a repeated procedural pattern (`assets/blender/models/r_evolution.py:262`), so a small bitmap is not by itself a visible defect.
- The external distant-crowd atlas `public/models/humanoid-impostor.png` is **512 × 256**. Vertex-animation `.bin` files are motion data, not art textures; their dimensions must not be counted as HD image assets.
- Runtime buses replace the embedded livery with freshly generated **2048 × 359** pixels, correct panel aspect, mipmaps and sRGB (`src/render/agent-runtime.ts:442`, `:519`). The runtime wrap now uses original vector lettering and a moat/castle mark: “MOAT LABS”, “EVERY ERRAND. AN OPPORTUNITY.”, and “TERMS APPLY”. It is generated at native resolution rather than upscaled from the embedded image. The source and packing preserve the bus panel UVs.
- The 14 committed Blender look-development sheets are **960 × 540** (four older scenes), **1800 × 640/700** (nine turntables/lineups) and **1600 × 900** (one head). These are review artifacts, not game textures. Their automated test requires width >=960, not 1080p visual approval (`tests/assets/lookdev.test.ts:30`).

## Current completeness gaps

1. Nine runtime kinds now use authored models: van, bus, dog, pigeon, taxi, Footman, Trundle, sign-spinner body and mixed heap. The sign-spinner omits the borrowed grocery prop and adds original geometric lettering. Parrot, drone, Patrol, Tidy, associate, Walker and finale retain procedural geometry. The latest pass gives Patrol its treaded wedge/lectern, Tidy a hauling cradle, drone readable Moat signage, and Walker/finale more structural detail. These still need human art approval.
2. Missing/broken authored files degrade to fallbacks by design. The registry never rejects a caller and explains a fallback reason (`src/render/model-registry.ts:75`–`:106`). Legacy agents keep proxy meshes on missing loads (`src/render/agent-layer.ts:454`); runtime kinds keep procedural models (`src/render/agent-runtime.ts:510`). This is good resilience but means “scene boots” does not prove art completeness. Production checks must assert the expected model source for the actor kinds exercised.
3. Far models intentionally use lower detail/proxy geometry. Legacy near detail is capped to nearby actors; far agents use ~70–160-triangle box proxies (`src/render/agent-layer.ts:7`–`:12`). Runtime far models also use simpler procedural geometry, then merge rigid parts (`src/render/agent-runtime.ts:530`). This is appropriate LOD and should be judged at its screen size, not prohibited by an all-HD label.
4. Existing asset tests cover glTF validity, dimensions, named joints, orientation, triangle budgets, alpha/emission conventions, deformation/VAT correctness, privacy and trade dress. They do not establish visual sign-off at 1080p, near-texture legibility, all LOD transitions or performance on physical target hardware.

## Bounded next actions

- Keep the existing untextured PBR style; do not inflate every file or upscale masks/atlases indiscriminately.
- Capture a repeatable **1920 × 1080** art-review set in the running build: close/mid/far distance, noon/golden-hour/night/fog, both sides of the bus, grounded and airborne animals, carried cargo, each advanced robot, and rust/slump/heap transitions. Require no missing expected authored assets, accidental fallback, clipping, floating, visible LOD pop or unreadable intended text.
- Completed in this branch: replace the abstract runtime bus placeholder with original native 2048 × 359 vector artwork, preserving aspect and UVs. The embedded GLB still contains its older 1024 × 180 source panel.
- Prioritise authored near-detail/art review for the new procedural advanced actors and finale before stating production art is complete. Match the current collision dimensions and articulated weak-point joints.
- Validate sculpture-mask edges and distant-crowd silhouettes at actual on-screen size before changing their source resolution. Retain mipmaps and avoid enlarging far-only assets without evidence.
- Retain source-aware browser assertions and the documented draw-call/triangle budgets. Physical-device frame pacing and human art approval remain required even if all structural tests pass.

The inventory was read-only. Subsequent runtime art changes are recorded above. The latest native 1920 × 1080 contact sheet passed in Chromium, with 26 focused render tests passing; `test-results/hd-art-review/runtime-gallery-1080p.png` and `runtime-native-bounds.json` contain the visual review and measured bounds. Shader joint offsets are included when fitting the review camera. Actual draws are one per displayed kind except van, bus and Trundle at two. This is a static review artifact; the broader motion/lighting review and target-hardware measurements remain open.
