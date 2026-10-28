# Physical test premise corrections

The untouched `origin/main` control at66b1e6 reproduced the four near-threshold launch/travel failures in `/tmp/fog-city-main-physical-control.log`. Their safety assertions were already passing; the exposure durations predated the current v19 tyre/launch response.

- SF spawn: drive4seconds instead of3. Preserve distance strictly greater than20m and zero hits.
- Robot knockdown: drive300ticks instead of240. Preserve no dives, at least two knockdowns, and carz strictly less than-30m.
- Fast F exit: launch150ticks instead of120. Preserve speed strictly greater than10m/s, actual pending braking, exit in fewer than90ticks, zero stopped speed, and nearby on-foot exit.
- Walker pass: drive420ticks instead of360. Preserve zero slowing/contact/hits, exactly one near miss, at least0.75m clearance, and the full original distance beyond the walker.
- The original v12 inside-corner stopped-yaw reproduction explicitly uses SIM12. Its greater-than3 stopped-turning ticks and no-contact checks remain. The immediately following current-version speed/turn-distance matrix remains unchanged.
- Palace point probe enumerates the rotunda's two records. The authored composite replaces six existing hull records. The narrow Palace assertion requires all six plus coverage of the two probe records; every replacement ID must still exist. Other point probes still require exact equality. The existing model/mask tests cover the separate exhibition hall's retention.

Exact source diff: `physical-premise-changes.patch`. The four selected small-world tests passed in2.53seconds (4passed,66not selected). The two SF pipeline checks still need their focused city-load run. No simulation, source physics, distance/speed/clearance threshold, golden, or performance baseline was changed for these premise corrections.
