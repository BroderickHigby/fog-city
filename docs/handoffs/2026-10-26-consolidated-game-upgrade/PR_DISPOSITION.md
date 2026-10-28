# Legacy PR disposition

Read-only source audit against fetched `origin/main` **66b1e6f51fd1799612d6319980fca7f2241b17a9** on 26 October 2026.
The 16 exact heads in PR_INVENTORY.md still match the live open drafts. Integration remains [PR107](https://github.com/BroderickHigby/fog-city/pull/107).
None of these heads is an ancestor of main; the decisions below use actual source, not that fact.
This table is a scope/replacement map, not permission to close drafts or a runtime acceptance result.

| PR | Disposition | Current source / replacement | Outstanding acceptance or hold |
| --- | --- | --- | --- |
| #1 | Much of scope present/superseded; retain world hold | Current `src/sim/game-systems.ts`, `src/render/scene.ts`, `scripts/build-web.ts`, SF tile packs and authored humans | Strict route, hill, bridge and continuity proof; do not reintroduce old world wholesale |
| #3 | Preserve current renderer; recover individual assets | `gfx.ts`, `gpu-engine.ts`, `node-materials.ts`, `surface-textures.ts`, current street layers supersede old showcase | Review historical landmark generators/rights; Coit, 415 Mission/Salesforce and 600 Montgomery/Transamerica models are available in its history |
| #14 | Selected wave-4 port pending | Main lacks combat `devices.ts`, `pause.ts` and their tests | Integrate gadgets, gear and streak effects through modern protected-body/projectile rules |
| #15 | Selected flower projectile port pending | Main lacks `combat/flowers.ts`; current mode `flowerTarget` shortcut is not the slow physical lob | Flight, cooldown, protected NPC exclusion, once-only scoring and engine parity |
| #16 | Wave-3 work partly present; preserve modern observations/parking | `missions/observed.ts`, `parking-world.ts`, mechanics runtime and wave-3 tests | Review remaining settlements/cable-car mechanics and run campaign controls |
| #19 | Reimplement pause hook after #14 | Main `step.ts` lacks `combat.pauseUntil` freeze | Membership/tick progression, movement/agent/system freeze, timer semantics and historical replay |
| #21 | Selected progression recovery pending | Canonical progression/rank rules, `doom-clock.ts`, perks and settlements absent; current raw-point streak spending differs | Threshold-banked rewards, one-time adoption, ownership/rank gates, single Doom Clock and physical mission acceptance |
| #25 | Integrate foundations together with #21 | Match isolation, faction delivery, wide nozzle/microclimate and Default Alive bounty changes absent | Preserve existing `save/progression.ts` optional settlement/Doom persistence; persistence alone does not prove execution |
| #30 | Retain structural hold; recover strict audit harness first | Structural producer modules and `tests/golden/world` harness are absent | Reproduce strict physical gates on current main; source regeneration and Bay Bridge support/deck proof remain open |
| #54 | Excluded: OSM/ODbL policy hold | No OSM-derived source or outputs imported | Owner's unresolved derivative-database policy decision; independent DataSF/USGS/NPS work continues |
| #74 | Save-spawn fix present; recover actual-control harness | Preserve modern `save/restore-spawn.ts` and main integration; long driver/test source recovered locally | Current-head Launch Day/Demo'd Correctly, save/reload and two-player execution |
| #76 | Selected port in local implementation | New `ui/activities.ts`, shared eligibility, waiting-campaign coexistence and corrected checkpoints | Compact/mobile HUD integration and real-control time-trial/delivery completions |
| #77 | Selected port plus repairs in local implementation | New `activities/plain-words.ts`, water traces, scene requests, distinct qualification, collapsed projectile silhouette, original instanced board layer | Twenty distinct boards and four actual rusted spinners through controls, board02 negative case, final packed browser replay |
| #78 | Selected port plus repairs in local implementation | Office Hours mission, booking-specific rewards, pending-campaign replacement, absolute-day booking cap | Phone booking, complete interview/demo twice, failure/retry and campaign continuation |
| #79 | Selected producer port in local implementation | Shared `advanceParking`, activity bays, current accepted car hulls and destination | Visible bays/signs and ordinary-control legal parking completion; illegal/moving/spoof/reward negatives |
| #80 | Relay utility recovered; full activity held | `activities/recon.ts` is relay scanning only; remains outside released wave-three catalog | Quarter-operated viewer, 30-second window, built-sector yaw limits/fidelity anchor, behavioral tag, audio/hallucination loop |

## Compatibility decisions in this tranche

- The new behavior uses SIM21 with an additive SIM20 migration; old fixture bytes remain intact.
- Earlier activity reductions retain the previous director/start rules through `activities/legacy-system.ts`.
- Current bell-duel seed, measured facts, accepted taxi pose, takeover facts, incident matching/weights and SIM17 pacing survive the selected port.
- Office Hours replaces only an unengaged campaign start trigger. Completed mission IDs and rewarded IDs survive; the campaign can resume after the side interview.
- A distinct board can qualify once. Rewashing/rebranding cannot inflate the twenty-board goal.
- Collapsed robot projectile height follows authoritative collapse height; low streams still hit heaps and protected subjects retain interception geometry.
- No old PR has been merged, closed or marked superseded by this local work.
