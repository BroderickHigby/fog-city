# Open Fog City PR inventory

Captured 2026-10-26T20:51:22.894Z. Refresh before acting.

**Inventory only: not merge approval or a full patch-equivalence review.** All 16 are drafts. CodeRabbit success does not mean they were reviewed; its comments say draft review was skipped.

| PR | Title | Head | Declared base | Mergeable against that base |
|---|---|---|---|---|
| [#80](https://github.com/BroderickHigby/fog-city/pull/80) | Missions: Coit Tower Recon signal producer at the design's wave four (stacked) | [28ad9723](https://github.com/BroderickHigby/fog-city/commit/28ad972331ebadf7812cbe48d7282e8fd0075163) | integrate/wave2 | No |
| [#79](https://github.com/BroderickHigby/fog-city/pull/79) | Missions: Search & Park legal-stop activity (stacked) | [0f508533](https://github.com/BroderickHigby/fog-city/commit/0f50853360543c0254cac6d1a2e7d0c2ecd6b5b6) | integrate/wave2 | No |
| [#78](https://github.com/BroderickHigby/fog-city/pull/78) | Missions: Ramen Office Hours as a real repeatable activity; remove the ramen-house marker (stacked) | [0985ce02](https://github.com/BroderickHigby/fog-city/commit/0985ce02205e95a5c6c00ef01fa8539733017d94) | integrate/wave2 | No |
| [#77](https://github.com/BroderickHigby/fog-city/pull/77) | Missions: Plain Words on Columbus Ave: boards, washing, spinners (stacked) | [6038c4fc](https://github.com/BroderickHigby/fog-city/commit/6038c4fc46b777cc0a459fde9b66468b986b9675) | integrate/wave2 | No |
| [#76](https://github.com/BroderickHigby/fog-city/pull/76) | Missions: start side activities from the HUD; sprint and hill-delivery stops on real streets (stacked on #74) | [c5c421f3](https://github.com/BroderickHigby/fog-city/commit/c5c421f3ba46f46da9da95e7032aaa684cf82a1c) | integrate/wave2 | No |
| [#74](https://github.com/BroderickHigby/fog-city/pull/74) | Missions: Launch Day real-SF browser playthrough, two-player session, curbside save spawn | [f8b744a9](https://github.com/BroderickHigby/fog-city/commit/f8b744a9d2ebb8ba0b1b45ac6eeb3de2a4d4414c) | integrate/wave2 | Yes |
| [#54](https://github.com/BroderickHigby/fog-city/pull/54) | World detail: lawns, fences and piers (needs OSM/ODbL sign-off) | [50d77eb3](https://github.com/BroderickHigby/fog-city/commit/50d77eb3e984e5384d2bcc6668a87791615285dd) | integrate/wave2 | No |
| [#30](https://github.com/BroderickHigby/fog-city/pull/30) | World (a): structural world import as SIM_VERSION 14, source snapshot and reproducibility | [8691dd9e](https://github.com/BroderickHigby/fog-city/commit/8691dd9e4e8d820fde17540e440eb40c215081a6) | integrate/wave2 | No |
| [#25](https://github.com/BroderickHigby/fog-city/pull/25) | Lane 5 (player): wave 4 (stacked on wave 3) | [70089fc6](https://github.com/BroderickHigby/fog-city/commit/70089fc67ef874559e094f39177a2eb69f4f0891) | lane/sim-player/wave3 | Yes |
| [#21](https://github.com/BroderickHigby/fog-city/pull/21) | Sim-Player: bank streak rewards and validate wave-4 mission progression | [ee7b65e0](https://github.com/BroderickHigby/fog-city/commit/ee7b65e0f4fcee95a335f233cd9b8ccc4cd10d65) | lane/sim-player/wave4 | Yes |
| [#19](https://github.com/BroderickHigby/fog-city/pull/19) | Lane 2 (core): wave 4 (stacked on wave 2) | [4ffe076a](https://github.com/BroderickHigby/fog-city/commit/4ffe076a76edb362e5e634f63bab54159e2e92b7) | integrate/wave2 | No |
| [#16](https://github.com/BroderickHigby/fog-city/pull/16) | Lane 5 (sim-player): wave 3 (stacked on wave 2) | [59fbfe0a](https://github.com/BroderickHigby/fog-city/commit/59fbfe0a1fcd4382dcca12ee8455a798d85cd89d) | integrate/wave2 | No |
| [#15](https://github.com/BroderickHigby/fog-city/pull/15) | Lane 4 (sim-combat): wave 5 (stacked on wave 4) | [d8e6911a](https://github.com/BroderickHigby/fog-city/commit/d8e6911aade718ab7bae0b4bd08c108ee2b490eb) | lane/sim-combat/wave4 | Yes |
| [#14](https://github.com/BroderickHigby/fog-city/pull/14) | Lane 4 (sim-combat): wave 4 (stacked on wave 3) | [d4b411f7](https://github.com/BroderickHigby/fog-city/commit/d4b411f7aeb4ea7dbd84f2904250d1ea29f5cbad) | lane/sim-combat/wave3 | Yes |
| [#3](https://github.com/BroderickHigby/fog-city/pull/3) | Ferry Building showcase: high graphics tier, PBR streets, plaza, F-line and palms (WIP) | [451f4dc7](https://github.com/BroderickHigby/fog-city/commit/451f4dc7beba9b81420bfb4f8b7a33ee2754dec0) | integrate/wave1 | Yes |
| [#1](https://github.com/BroderickHigby/fog-city/pull/1) | Wave 1 integrated with early wave 2: the whole city, traffic and robots, the player's look, and a hostable build | [3da4fb46](https://github.com/BroderickHigby/fog-city/commit/3da4fb46ad1bd7719df29ea7f969671737dad7bd) | main | Yes |

## Work groups and recorded holds

### mission-stack

Relevant authored mission/activity work; latest comments keep the stack out of production.

- Real-controls twenty-distinct-board Plain Words completion absent: collapsed spinner blocks board02 after two normal attempts and one escalation.
- Coit viewer/audio/full authored scope incomplete.
- Do not merge stale stack directly; forward-port selected work to current main and re-verify.

[Source comment](https://github.com/BroderickHigby/fog-city/pull/77#issuecomment-6405942100)

### legacy-gameplay

Relevant older-wave core/combat/player progression; a partial compatible forward-port exists separately, not complete release proof.

- Finish authored scope and canonical save migration.
- Independent current-head Standards/Spec review and full behavior/browser verification required.
- Original draft PRs remain open and should not overwrite the current SIM_VERSION.

[Source comment](https://github.com/BroderickHigby/fog-city/pull/21#issuecomment-6405944500)

### structural-world

Historical city/render integration is partly superseded by the current release, but this complete structural stack remains explicitly held.

- Actual controller/placement holds against props/buildings, crest launch, and an unmodelled long Bay Bridge span.
- Two repairs plus escalation failed to establish endpoint/negative-fixture proof; no further blind retry at the same physical head.
- Keep strict physical assertions; no blanket shoreline appearance waiver.

[Source comment](https://github.com/BroderickHigby/fog-city/pull/30#issuecomment-6405941168)

### osm-landcover

OSM/ODbL landcover source branch is separate from the currently released non-OSM fixes.

- Latest comment explicitly retains unanswered owner ODbL policy decision.
- Current DataSF/USGS/NPS-only work has no broad dependency on this hold.

[Source comment](https://github.com/BroderickHigby/fog-city/pull/54#issuecomment-6405945068)

## Limits

- GitHub mergeable is relative to each declared base, mostly legacy integration/lane branches, not current main.
- CodeRabbit success statuses are paired with bot comments saying draft PRs were not reviewed; they are not review approval.
- Checks/annotations are historical at exact current PR heads. Billing annotations confirm those jobs did not start; account billing state itself was not queried.
- No full per-file patch-equivalence audit, no fresh tests or browser verification, no check reruns or repository/provider mutations.
- Review threads and reviews were not comprehensively audited because this is inventory only; independent reviews are required before any eventual consolidated PR merge.
- Inherited sustained-performance/allocation and 1 GB capacity hold remains open.
