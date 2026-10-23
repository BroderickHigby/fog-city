# Generic civilian fastback

An original unbranded 4.30 m four-door car for Fog City. The player-car registry now uses this model. Earlier source assets remain available; the generated file is `public/models/civilian-car.glb`.

The model uses the repository's mesh/export helpers and a more densely sampled rounded body/greenhouse, manufactured edge radii, wheel openings and liner lips, side mirrors, bonnet and door seams and handles, wipers, separate running lamps and simple grille brightwork. Wheels keep the `wheel_FL/FR/RL/RR` contract and spin about X. The recolourable material is `paint`; lights use `light_headlight`, `light_taillight`.

Units are metres, glTF up is +Y, front is -Z and the tires rest at ground height. Wheel radius is 0.34 m and axle separation is 2.66 m. Body width is 1.86 m; mirrors extend beyond this. The original model and generator are available under `LICENSE.txt` (MIT).

Rebuild from the repository root:

```sh
flock /tmp/fog.lock blender -b --python assets/imports/civilian-car/generate.py -- --preview
```

The script and station coordinates are original. Its station-based vehicle construction was informed by [Slop New York](https://github.com/mrdoob/slop-newyork), inspected at commit `039a32796faf6ff914a07946b3d3d058d291e251`, MIT © 2026 Mr.doob. The reference notice is retained in `REFERENCE-LICENSE.txt`. No branded car, real registration plate, texture, NYC geographic data or external model is included.
