# Fog City security and bug audit — October 31, 2026

Scope: source-backed security review of the game and relay, credential search, dependency advisory check, and cloud verification. The user explicitly prohibited launching the game on the local computer. No local game, browser, dev server, build, or test was launched for this work; execution ran in a temporary cloud sandbox.

## Security review

The independent Standard scan reviewed baseline [f1147ea1](https://github.com/BroderickHigby/fog-city/commit/f1147ea1823e2d9221b08a04ef236e269e016911). It fully reviewed 48 source/configuration files and searched repository-wide for credentials. It found no supported embedded credential exposure and two low-severity findings. This is partial source coverage, not proof that the game has no other vulnerabilities. The live deployment and production account settings were not audited.

1. **Low: rejected WebSocket handshakes consume the per-IP socket quota.** `server/net/server.ts:217–218` reserves quota before the handshake validates. Failed handshakes do not install the successful-connection cleanup. Repeated malformed upgrades can exhaust the allowance and deny subsequent players behind the same public IP until restart. Remediation: reserve only on successful upgrade, or release on rejected upgrades with idempotent cleanup. Verify malformed requests followed by a valid connection, including shared-NAT clients.
2. **Low: successful rejoins bypass full-state snapshot pacing.** `server/net/room.ts:173` sends a fresh snapshot on every token-authorized rejoin without the normal resync cooldown. Existing connection/message caps constrain traffic but do not bound snapshot serialization across reconnects. Material CPU impact was not measured, so severity remains low and confidence medium. Remediation: carry a snapshot budget across seat rejoins and test legitimate reconnect recovery as well as repeated reconnects.

The Codex Security scan ID is `22fcac2f-5d9d-45d4-8727-9e562ad11368`. Its sealed report and canonical coverage are stored in the initiating Codex chat's local security workbench. The scan records the original baseline separately from concurrent grass changes. These relay findings are reported, not silently bundled into the terrain patch.

## Gameplay bug found

**Spectators consume public player/bot capacity.** `server/net/room.ts:208,221–222` uses `this.seats.size`, which counts spectators, for public lobby availability, player listing and bot capacity. The join path correctly uses the non-spectator `this.size`. Spectators can therefore make a lobby with free player seats appear full and reduce bot teammates. A separate fix should use the same player-seat count consistently and test spectator joins/leaves without changing actual player capacity.

## Grass defect

Detailed lawn surfaces are limited to 550 m around the camera. The underlying near/far terrain only used four large park districts for green tint, leaving mapped lawns elsewhere gray when detail was absent or outside its radius. A small lawn can also lie entirely between a far terrain triangle's 100 m vertices, so vertex-only tint cannot represent it.

The terrain patch applies the existing pinned DataSF lawn polygons to base terrain as well as detailed grass, preserving mapped holes, road/sidewalk/building exclusions and inland water. It does not refresh geographic data, add an OSM dependency, or change simulation, collision, saves or multiplayer contracts. Exact geometry, cloud performance measurements and validation results accompany the PR.

## Limits

- Static review cannot prove runtime exploitability or frame rate.
- The original scan predates the final grass implementation; its confirmed findings concern unchanged relay code.
- Fresh dependency-advisory results, cloud test outcomes, geometry counts and any incomplete checks must be reported separately from source-review conclusions.
- No production deployment or live multiplayer penetration test was performed.
