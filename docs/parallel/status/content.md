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

## Integrated authored campaign catalog

Content catalog from PR #18 is integrated for the wave-3 mission runtime. Later-wave entries remain gated by their declared wave. Review provenance is pending independent signoff.
