# Combined behavior transition — 25 October 2026

Local candidate from release tranche `4145a41a142c19c3382fd9d8d9db28674dac4691` combines:
- [#59](https://github.com/BroderickHigby/fog-city/pull/59): live forced-update conversion budget.
- [#85](https://github.com/BroderickHigby/fog-city/pull/85): robot density and incidents, repaired head `583d6f46e9069742fc5db649c0a720c5982473fa`.
- [#61](https://github.com/BroderickHigby/fog-city/pull/61): natural human dodge and renderer motion.

The last released simulation is 13. These three unreleased branches all used 14; this candidate treats their combination as one deliberate 13→14 release transition. This does not certify compatibility with private intermediate branch-version-14 saves. Version 9 remains reserved. All earlier released fixtures remain unchanged.

The combined migration uses the dodge conversion: ongoing human/player hops are flattened and gain velocity/top-speed fields. City-life optional runtime fields are initialized by their reducer; no existing fields are discarded. Live conversion preserves the saved `baseBadCount` field but budgets against currently active natural bad robots.

The original composed-v14 branch receipts are retained as `composed-v14-conversion.json`, `composed-v14-citylife.json` and `composed-v14-dodge.json`. `composed-v14.json` is re-recorded from the combined source because deliberate density, incident, conversion and dodge changes affect the state hashes. It is not evidence that old branch14 behavior was unchanged.

Preview wave4 keeps the staged mission fog exemption and facing introduced by Demo Day; the live conversion budget now applies at every wave, as #59 requests. Released default stays wave3.

Validation is pending the focused combined test receipt and independent final-head review. This document does not claim production deployment or a full `pnpm verify` pass.
