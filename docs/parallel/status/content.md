# Lane 8: Content and writing

## Now
Auditing the published wave-2 catalog and extending it through the later campaign waves on `lane/content/wave2`, based on core interface `9a6a107`.

## Done
- Created an isolated worktree at `/workspace/fog-city-content`; the existing prototype is preserved.
- Confirmed the approved names list is signed off on 2026-10-20. Existing approved names will be reused, not sent for duplicate approval.
- Confirmed the base already contains 300 robot barks, 100 wet barks, 66 tells, ten archetypes, 60 director cards, startup kits and the first two campaign missions.
- Identified vendor quantities that disagree with the design and combat model: tank tiers must be 12/16 L and the flow upgrade 1.2 L/s.

## Next
Correct vendor quantities, publish typed UI copy, and provide authored campaign/progression/app/mode catalogs with schema, lint and reachability checks.

## Blocked on
No immediate implementation blocker. Any genuinely new proper name remains subject to its own clearance; approved names and generic labels are sufficient for this work.

## Requests for other lanes
- Lane 5: consume the existing Mission schema and stable mission/item IDs. Send any additional objective facts before adding a competing content format.
- Lane 7: consume `UI_COPY` and `uiText` from the content layer; crisis handling continues to use the existing content crisis module.
- Lane 2: shared simulation contracts remain yours. Content records stay plain authored data and do not mutate simulation state.

## For the owner
New content will remain a reviewable draft. The existing name approval is retained; no hosting, paid service or additional licence is required.

## Wave-2 checkpoint
- Published static `MISSIONS`, `CAMPAIGN_MISSIONS`, `ACTIVITIES`, `SAFEHOUSES`, `MODE_INSTANCES`, `VENDOR` and `DIRECTOR_CARDS` from `src/content/catalog.ts` for browser and sim consumers.
- Published `UI_COPY` and `uiText` with all requested wave-2 keys and later app/save/mode labels. Interpolated copy is plain text; missing keys/parameters fail loudly during authoring.
- Corrected tank tiers to 12/16 L and flow tier to 1.2 L/s, preserving item IDs and prices.
- Validation: TypeScript passed; 130 scoped content/schema/provenance/taste/vendor tests passed. Full integration verification belongs to the integration lane.

## Draft pull request
Title: Publish content catalogs, UI copy and corrected vendor upgrades
Base: integrate/wave2
Body:
Static content exports let the mission, economy and UI systems consume the existing authored catalogs without browser or filesystem dependencies. The UI catalog supplies stable text keys and checked interpolation. Tank upgrades now match the 8 → 12 → 16 L design; the flow upgrade is 1.2 L/s, with stable prices and IDs.

Validation: TypeScript and 130 scoped content/schema/provenance/taste/vendor tests passed. Existing approved names were reused. Later campaign and activity content follows on stacked lane branches.

## Campaign and gameplay checkpoint (waves 3–8)
Authored all ten campaign chapters and published them through `MISSIONS`; `MISSION_FACTS` lists the 22 authoritative event names still being connected by Lane 5, and `MISSION_OBJECTIVES` provides stable presentation keys. Mission 4 has six graded multiple-choice questions and three paid success outcomes; actual timed challenges elsewhere retain retries. Every graph/actor/waypoint passed the direct content checks, including all waypoints on the 583 committed tiles.

Published `PROGRESSION`, `STREAKS`, `LOADOUTS`, `ACTIVITY_DEFINITIONS`, `MODE_RULES` and `WRITING` in `src/content/gameplay.ts`. Activities contain ordered routes, timers, authoritative facts, payouts in cents and cooldowns. Mode rules cover the five published instance polygons, Bot Sweep, Clean Streets, Hide in the Crowd, five-phase Fog Royale, and Vibes Night's separate simulation score and player vote.

Added 30 offline AI fixtures and server-template text. Adversarial inputs are exempt only at `cases.*.input`; expected replies still pass the full content lint. Crisis presentation uses the existing shared detector and resource bank. No API call or credentials are involved. Scripted fixture records are explicitly labelled scripted, not claimed as model evaluation results.

Review: Lane 1 independently read all 180 initial UI strings and eight new mission drafts. No taste checklist issue was found; its two integration concerns were addressed in copy (explicit scan instruction and neutral disconnection text). Review is pending for the expanded dialogue/activity/mode banks. Runtime completion producers and closed-loop mission drivers remain Lane 5 work and are not claimed complete here.

Validation at checkpoint: direct mission graph, actor and tile coverage checks pass. TypeScript and focused Vitest validation are queued under the shared lock; fixes are being completed before integration is declared ready. Later district packs and 150 additional people lines remain in progress.

Draft PR title: Author campaign chapters and publish gameplay content contracts
Draft PR base: integrate/wave3
Draft PR body:
Adds the authored mission spine through the finale, typed static catalogs for activities, progression, loadouts, streaks and mode rules, and offline dialogue/AI fixtures. Mission event names are explicit integration contracts; gameplay owners must produce them from measured state. The content never accepts arbitrary completion commands or model text as simulation authority. Existing approved names are reused. Pending full content validation and later district-pack completion are tracked above.
