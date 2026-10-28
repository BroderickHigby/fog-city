# Original industrial Porter update

This is an original update to the existing Fog City robot, authored in the committed
Blender generator. It is not an imported manufacturer model or a claim of affiliation.
The original robot hierarchy, joint pivots, grocery bag, three collapse morphs and rust
mask remain. Powder-coated casing, a chamfered sensor pod, machined collars, service
panel fasteners, actuator rails and sole details replace the earlier decorative head.
The physical simulation body is unchanged. The existing 6,000-triangle runtime budget
remains; the exported mesh and renderer packing are checked by the asset suites.

Exact tool/source/output hashes are in manifest.json. The tool was downloaded from the
official Blender archive and verified against its published SHA256. The DMG and runtime
are local tools outside the repository, never hosted game assets. The export runs with
2 threads and OPENBLAS_NUM_THREADS=1. Run the single model script directly, then heaps.py;
do not run the broad asset build (which also rewrites landmark metadata).

The draft turntable checks standing views and seizure, slump, melt and heap states.
It does not establish native-game visual acceptance, LOD cost or performance.
