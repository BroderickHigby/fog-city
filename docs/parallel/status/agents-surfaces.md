# Agent placement on structural surfaces

Grounded runtime actors propose motion on the shared surface under their feet, preserving
deck and tunnel-floor height. Their swept building checks use the actual body height band.
Flying actors continue to use terrain height for their flight target.

Service entry selection now retains the selected road edge's surface height. Van and bus
origins keep that height instead of being flattened to terrain. Full-hull admission checks
use the corresponding vertical band and ignore bodies on separate stacked surfaces.

Mission stage and scene placement keep the authored surface hint or selected road height,
and use height-aware building clearance. Unadmitted and abstract runtime records do not
become phantom service or scene-placement blockers: accepted physical bodies and the
explicit batch reservations supply those obstacles.

This patch depends on the world's `surfaceHeight`, `roadSurfaceHeight`, `circleBlockedBand`
and `segmentBlockedBand` helpers. Core movement must use the same body band when it accepts
and moves the proposed body.

Validation:

- All five initial deck/bore/placement regressions failed before this repair.
- TypeScript passed. Nine focused files passed, 48 tests total, including the six final
  surface-placement cases, runtime, lifecycle, mission/scene staging, service admission,
  physical service integration and the shared band helper.
- Full combined game/browser verification remains the integration owner's check.
