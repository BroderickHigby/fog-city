# Local validation evidence

These are local checks of [source67c422ab](https://github.com/BroderickHigby/fog-city/commit/67c422abeab63f0e29bfe67e31780b48cc9b5195), followed by documentation-only changes. See the [QA record](https://github.com/BroderickHigby/fog-city/blob/codex/slop-city-render/docs/qa/slop-renderer.md) for commands, scope and open limits. CI was not run.

- [Recorded ordinary fight inputs](robot-fight-v17.json): fresh SF seed1/wave3/p1, SIM17, paused tick0/hash75b959f3;4362 frames finish12a94c7b. Default browser boot already queues the tick1 HotDesk command; use browser.eventsForDefaultBoot rather than injecting it twice. Read the source fingerprint before replaying.
- [Rendered fight and actual advert dismissal](robot-fight-browser.json): reduced node-WebGL software probe. Actual water, rust, seizure and heap are visible; real button closure is a separate4363rd frame. No state/look overrides.
- [Graphics recovery](graphics-recovery.json): legacy restore and intentional node-to-legacy save/reload, not a physical Metal reset.
- [Real H/W/F taxi input](robotaxi.json): actual native ANGLE Metal /Apple M4 context, same taxi/parked car, zero contacts/errors.
- [Complete unit result](unit-suite.json):3995 passed/one skipped/one allocation failure. The unchanged allocation guard and broader performance hold remain open.
- [Packed artifact checks](packed-build.json):190 files,176.7MB, complete MIT notice,187 unchanged runtime/index files, actual WebGPU and legacy pack/collider loading.

[Native golden view](native-golden.png) uses the high-quality WebGPU path. [Rust](robot-rust.png) and [heap](robot-heap.png) images use480×300 software drawing buffers in960×600 CSS to verify mechanics. These selected paused milestones do not establish continuous animation timing, hardware FPS parity, physical resident memory or a full-city soak. The raw native travel report's failed strict plateau criterion is preserved in the QA record.
