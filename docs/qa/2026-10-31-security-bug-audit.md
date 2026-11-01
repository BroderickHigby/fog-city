# Fog City security and bug audit — October 31, 2026

Scope: source-backed security review of the game and relay, credential search, dependency advisory check, and cloud verification. The user explicitly prohibited launching the game on the local computer. No local game, browser, dev server, build, or test was launched for this work; execution ran in a temporary cloud sandbox.

## Security review

The independent Standard scan reviewed baseline [f1147ea1](https://github.com/BroderickHigby/fog-city/commit/f1147ea1823e2d9221b08a04ef236e269e016911). It fully reviewed 48 source/configuration files and searched repository-wide for credentials. It found no supported embedded credential exposure and two low-severity findings. This is partial source coverage, not proof that the game has no other vulnerabilities. The live deployment and production account settings were not audited.

1. **Low: rejected WebSocket handshakes consume the per-IP socket quota.** [server.ts:217](https://github.com/BroderickHigby/fog-city/blob/f1147ea1823e2d9221b08a04ef236e269e016911/server/net/server.ts#L217) reserves quota before the handshake validates. Failed handshakes do not install the successful-connection cleanup. Repeated malformed upgrades can exhaust the allowance and deny subsequent players behind the same public IP until restart. Remediation: reserve only on successful upgrade, or release on rejected upgrades with idempotent cleanup. Verify malformed requests followed by a valid connection, including shared-NAT clients.
2. **Low: successful rejoins bypass full-state snapshot pacing.** [room.ts:173](https://github.com/BroderickHigby/fog-city/blob/f1147ea1823e2d9221b08a04ef236e269e016911/server/net/room.ts#L173) sends a fresh snapshot on every token-authorized rejoin without the normal resync cooldown. Existing connection/message caps constrain traffic but do not bound snapshot serialization across reconnects. Material CPU impact was not measured, so severity remains low and confidence medium. Remediation: carry a snapshot budget across seat rejoins and test legitimate reconnect recovery as well as repeated reconnects.

The Codex Security scan ID is `22fcac2f-5d9d-45d4-8727-9e562ad11368`. Its sealed report and canonical coverage are stored in the initiating Codex chat's local security workbench. The scan records the original baseline separately from concurrent grass changes. These relay findings are reported, not silently bundled into the terrain patch.

## Gameplay bug found

**Spectators consume public player/bot capacity.** [room.ts:208](https://github.com/BroderickHigby/fog-city/blob/f1147ea1823e2d9221b08a04ef236e269e016911/server/net/room.ts#L208) uses `this.seats.size`, which counts spectators, for public lobby availability, player listing and bot capacity. The join path correctly uses the non-spectator `this.size`. Spectators can therefore make a lobby with free player seats appear full and reduce bot teammates. A separate fix should use the same player-seat count consistently and test spectator joins/leaves without changing actual player capacity.

## Dependency and regression checks

Cloud `pnpm audit --json` on November 1 reported **zero advisory findings across 97 dependencies**, including development dependencies and the pinned integer clipping dependency. This is the package advisory database result, not a claim that the game is vulnerability-free.

The broad cloud unit sweep ran on an earlier grass snapshot while fixes were being developed: **344 files passed / 4 failed; 5,005 tests passed / 8 failed / 1 skipped** in 25 minutes. Five failures were in the superseded terrain implementation; the corrected clipping and asynchronous implementation subsequently passed the focused regressions. That sweep is not an exact-final-head verification.

Three failures concern unchanged simulation code and tests:

- [Marina traffic flow](https://github.com/BroderickHigby/fog-city/blob/f1147ea1823e2d9221b08a04ef236e269e016911/tests/sim/traffic-flow-sf.test.ts#L83): seed 606, wave 4, a robotaxi remained stopped for about 57 seconds against a 45-second limit. The simulation still drove 246–916 metres in each 30-second sample; this is a standstill invariant failure, not complete traffic cessation.
- [Junction deadlock](https://github.com/BroderickHigby/fog-city/blob/f1147ea1823e2d9221b08a04ef236e269e016911/tests/sim/junction-deadlock-sf.test.ts#L41): at the tested real-SF junction, robotaxi 596 stood still for 2,632 ticks, exceeding the 2,400-tick (40-second) limit.
- [Simulation allocation budget](https://github.com/BroderickHigby/fog-city/blob/f1147ea1823e2d9221b08a04ef236e269e016911/tests/sim/perf-budget.test.ts#L121): about 7,675 KiB allocated per tick versus a 4,491 KiB baseline and a 1.3× allowance. It failed again when run without another unit worker. The time-ratio assertion passed; the failing assertion is allocation, so test contention alone does not explain it. Cloud runtime: Node 24.22.1. No baseline was loosened.

The patch has no differences under `src/sim/` or `tests/sim/` relative to the audited baseline. Root causes and baseline reproduction of the two standstill failures remain follow-up work. These are release-verification holds, not silently repaired in the grass patch. Complete `pnpm verify` is therefore not green.

The separate unmodified cloud browser subset finished **15 passed / 2 failed / 8 did not run**. One real-city view missed its 80-second settling deadline. The binary packed build booted and loaded the avatar, but its 180-second test deadline expired while waiting for the surface-texture completion diagnostic. The split/text packed build booted and drove successfully. Baseline reproduction and causes of those browser failures remain unverified. See [the grass verification report](2026-10-31-grass-coverage.md) for scope and rendering evidence.

## Grass defect

Detailed lawn surfaces are limited to 550 m around the camera. The underlying near/far terrain only used four large park districts for green tint, leaving mapped lawns elsewhere gray when detail was absent or outside its radius. A small lawn can also lie entirely between a far terrain triangle's 100 m vertices, so vertex-only tint cannot represent it.

The terrain patch applies the existing pinned DataSF lawn polygons to base terrain as well as detailed grass, preserving mapped holes, road/sidewalk/building exclusions and inland water. It does not refresh geographic data, add an OSM dependency, or change simulation, collision, saves or multiplayer contracts. Exact geometry, cloud performance measurements and validation results accompany the PR.

## Limits

- Static review cannot prove runtime exploitability or frame rate.
- The original scan predates the final grass implementation; its confirmed findings concern unchanged relay code.
- Fresh dependency-advisory results, cloud test outcomes, geometry counts and any incomplete checks must be reported separately from source-review conclusions.
- No production deployment or live multiplayer penetration test was performed.
