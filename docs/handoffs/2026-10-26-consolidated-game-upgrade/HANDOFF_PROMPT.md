# Fog City: consolidated implementation handoff

Use this prompt as the working request for the coding agent on the next computer.
Continue the existing `codex/consolidated-game-upgrade` branch and its draft PR.
This handoff is the documentation seed for that one eventual consolidated PR;
do not open a second PR just to start implementation.
Prepared 26 October 2026. This is a verified starting snapshot, not a claim that
all requested features are finished. Refresh GitHub state before acting.

## Your assignment

Continue building Fog City, a San Francisco driving/exploration/robot-combat game.
Implement the remaining work below, test the actual game locally, and consolidate
the result into **one final pull request to main**. Recover the intended work from
the old draft PRs where useful; recreate it when a clean implementation against
current main is safer. Do not merge the old stacks blindly or replace the whole
game with Slop New York. Preserve San Francisco, the existing authored human
characters, saves, and the functioning gameplay.

The owner authorized implementation, local testing, eventual PR consolidation
and production delivery. Their latest workflow preference is local-first: do
not push every iteration or create a PR for every feature. Keep local commits,
then publish one reviewed integration when ready. Hosted GitHub Actions are
excluded at the owner's request; do not rerun them or change billing/settings.
Use `[skip ci]` on the eventual commits. Local validation is still required.

## Verified starting point

- Repository: https://github.com/BroderickHigby/fog-city
- Latest main verified for this handoff:
  `66b1e6f51fd1799612d6319980fca7f2241b17a9`.
- Latest completed change: https://github.com/BroderickHigby/fog-city/pull/106
  (compact icon HUD, optional status/mission details, touch-layout fixes).
- Production: https://fog-city-five.vercel.app/
- Production deployment for that main commit:
  https://vercel.com/daringly-ai/fog-city/8b1EQGP3wRJpd9QuM3jAvKFnuMER
- Current contracts: **SIM_VERSION 20**, **NET_VERSION 7**. Re-read the code;
  do not reuse version numbers from old draft branches or historical handoffs.
- Runtime: Node >=22.18, pnpm 9.12.0; Three.js pinned at 0.186.1.
- The last static build was 192 files / 174.9 MB. Host limits remain 450 files,
  240 MB total and 15 MB per file. These are packaging limits, not RAM budgets.
- Last HUD verification: typecheck, 79 UI unit tests, 2 UI-copy tests,
  21 browser tests, native WebGPU UI checks, and public release-byte checks.
  **This was not a new whole-game full verification or performance acceptance.**
- The inherited sustained-performance/allocation and **1 GB capacity hold is
  still open**. Passing with a 1.5 GB test browser did not clear it.

The source machine has a clean main checkout at
`/Users/broderickhigby/fog-city`. Its separate renderer worktree and local preview
are machine-specific; do not assume their paths, running processes, credentials,
temporary reports or browser tabs exist on this computer. This bundle contains
the portable PR snapshot, but no game assets, tokens or running environment.

The bundle also includes the owner's original screenshots. Read
`BUG_EXAMPLES.md` and open `GALLERY.html` before reproducing visual bugs.
Each caption distinguishes a reported defect from a reference image or an
already-addressed regression case. The files in `images/` are original,
full-resolution copies; `IMAGE_MANIFEST.json` records provenance and hashes.

## Start on this computer

1. Inspect any existing checkout and its worktree/branch ownership. Preserve
   unrelated work. If needed, make a fresh clone of the named consolidation branch.
2. Fetch current main, compare it with the handoff commit, and account for later
   changes before editing. Refresh the 16-PR inventory in this bundle.
3. Read `CLAUDE.md`, applicable `AGENTS.md`, `docs/design.md`, `docs/roadmap.md`,
   `docs/qa/targeted-slop-methods.md`, and the relevant current QA reports.
   Match the visual cases in `BUG_EXAMPLES.md` to your baseline and final QA.
   `docs/FOG_CITY_HANDOFF.md` and `docs/handoff.md` contain historical states;
   their old SIM versions, paths and release claims are not the current baseline.
4. Install the pinned dependencies, start the SF game, and record a baseline on
   the actual machine. Identify the browser/GPU/RAM and use one QA browser.

Example for a NEW checkout; on an existing checkout, fetch and switch to this
remote branch without discarding local work:

```sh
git clone --branch codex/consolidated-game-upgrade https://github.com/BroderickHigby/fog-city.git
cd fog-city
git fetch origin
git status
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://127.0.0.1:5173/?world=sf`. A fresh clone requires the operator's
normal GitHub access; do not obtain secrets from chat or copy credential files.
Do not stop an unrelated server to reclaim a port; pick an unused port instead.

## Priority 1: integrate intended PR work without regressing main

The snapshot contains **16 open PRs, all drafts**. `PR_INVENTORY.md` provides
their exact heads/bases and `PR_INVENTORY.json` retains the source descriptions,
check results and hold comments. Seven were mergeable against their own old
bases, not necessarily against main. CodeRabbit's green status on these drafts
is accompanied by comments saying it did not review them.

Build a per-PR disposition ledger: already present in main, port selected work,
reimplement missing behavior, or retain a specific unresolved hold. Record the
replacement files/tests and eventual consolidated PR link. A non-ancestor head
does not prove that its work is absent; parts were squashed or manually ported.

- Missions: PRs 74, 76, 77, 78, 79, 80. Finish the real-control mission flow,
  side activities, Plain Words, repeatable Office Hours, legal parking, and
  Coit Recon. Latest evidence still has a collapsed spinner blocking Plain
  Words board02 and incomplete Coit viewer/audio scope. Complete all twenty
  distinct boards through actual controls; do not inject completion events.
- Core/player/combat: PRs 14, 15, 16, 19, 21, 25. Some work was forward-ported;
  complete the missing intended progression/rewards/behavior against the new
  contracts, preserving canonical migrations and prior replay fixtures.
- World/render: PRs 1, 3, 30. Current main supersedes some old visual work, but
  historical structural-world failures remain: props/buildings blocking real
  routes, crest launches, and incomplete Bay Bridge span/support proof. Repair
  physical producers and retain negative tests; do not loosen assertions to
  accept defective geometry.
- Landcover: PR54 has an unresolved OSM/ODbL policy hold. Do not silently import
  its data. Current DataSF/USGS/NPS-based fixes can continue independently. Name
  the exact decision needed if the consolidated design truly depends on it.

## Priority 2: reliable movement, performance and obvious robot combat

First run a reproducible drive/walk/fight route. Check start/save/reload and entry
into cars on real road surfaces; cars must not spawn in water, overlap/absorb
one another or get permanently stuck. Check player/crowd feet, forward-facing
running, tile transitions, hills, traffic signals, road-free trees and pavement-
free grass. Existing fixes/tests are the baseline, not features to rewrite.

Make bad robots unambiguous at practical gameplay distance: a strong hostile
silhouette/indicator, icon or outline, readable attack wind-up, map cue and
optional audio cue. Use shape/text as well as color. Target indicators must track
real current hostility and disappear on neutralization; benign robots must not
look like valid targets. Preserve aim-only reticles; do not put the old dot over
the player while simply running. Verify the complete spot/fight/rust/collapse/
reward loop, hostile retaliation and wrong-target behavior using real controls.

The owner's new request for obvious enemies supersedes the older design rule
that good and bad units should look identical. Update the design record rather
than leaving contradictory requirements. Preserve the protections for people,
children, animals and mobility-aid users; robot combat remains stylized rusting
and disabling, not harm to people.

Before adding more high-detail assets, record matched before/after frame timing,
GPU/renderer, resolution, render calls, triangles, loaded actors/tiles, JS heap,
backing allocations and repeated-route growth. Keep those accounting categories
separate. Test the relevant low-memory case; do not call a short paused view or
software-renderer FPS a sustained hardware performance pass.

## Priority 3: varied vehicles and realistic recorded driving audio

Current main already has twelve paint palettes and patterned artwork. Civilian
cars still reuse one fastback body. Add genuinely different sedan, hatchback,
SUV, pickup and van families using suitable free/licensed game assets, with
varied colors and liveries that affect paint rather than glass/lights/tyres.

Audit the existing asset library before sourcing more. Adobe/Mixamo currently
provides human animation assets, not a vehicle library. Retain the authored
Rocketbox humans and retargeted animation pipeline. Candidate external assets
need exact source URL, author, license/redistribution terms and hashes. Keep raw
downloads/import tooling in `assets/imports/`; put only optimized runtime outputs
under `public/`. Do not add raw source libraries to the static build.

Use an explicit vehicle registry for model, dimensions, wheels, paint slots,
audio profile and LOD. Normalize axes, scale, wheels and road contact. All bodies
must obey the existing traffic, collision, takeover and safe-spawn rules. Keep
civilian passing roughly every thirty simulation seconds without forcing unsafe
spawns through blocked streets. Preserve `H` robotaxi takeover.

The current engine sound is still oscillator/noise synthesis. Replace the
obtrusive high-frequency whine with licensed recordings: convincing idle,
acceleration/load, coasting, road/tyre and braking layers. Blend loops smoothly
by speed/load; distinguish conventional engines and EVs where appropriate.
Avoid excessive pitch shifting, clicks, doubled loops and huge preloads.
Preserve mute, volume, user-gesture unlock, pause, visibility, transitions into
and out of cars, and cleanup. Actually listen to the result at idle, low speed,
full speed, braking, stopping and changing cars; tests of file existence are not
audio acceptance.

## Priority 4: a playable timed taxi mode

Build the requested Crazy Taxi-style mode, provisionally **Crazy Uber**. Treat
the title as configurable. Use Fog City's SF world and existing characters.
Expose it through the Controls/mode area with clear start/exit/retry actions.

Implement a deterministic session loop: locate a waiting passenger, stop safely,
pick them up, show their destination and remaining time, route across town,
drop them off, calculate fare/time bonus, and offer the next passenger. Handle
timeout, cancellation, invalid pickup, blocked routes, retry and mode exit.
Rewards must be once-only and campaign saves must survive entering/leaving the
mode. Include multiple district routes and themed shifts such as daylight,
night and fog/rain using the existing environment systems. Use original/licensed
presentation and music rather than copying another game's soundtrack or assets.

Existing timed activities, manual taxi control and isolated mode sessions can
be reused; a passenger pickup/dropoff/scoring mode does not yet exist. Test one
successful fare, one timeout and a retry end-to-end through normal controls.

## Priority 5: realistic phone and actual graphics settings

The current phone is a large generic modal app grid. Map/BotBounty/Bot Check/
Bank/Settings have implementation; several other icons are disabled/placeholders.
Create a convincing phone shell, coherent app icons, status bar, home/back
navigation and responsive app screens. Keep the surrounding city visible where
appropriate. Make available apps work and make unavailable features clear;
do not dress up empty screens as completed features. Preserve all existing
input blocking, accessibility names, focus restoration and map interactions.

Add **Settings → Graphics → Auto / Low / Standard / High**, with brief tradeoffs
and persistent choice. Reuse `src/render/gfx.ts`; these tiers currently exist only
as startup URL settings. Define URL override precedence. Apply safely without
losing progress or duplicating renderer resources. Auto may adapt to performance;
manual choices should stay selected. Preserve graphics-loss recovery and report
any safety fallback clearly. Verify each setting visually, after reload, and on
a constrained device/profile. Do not increase quality budgets as a substitute
for fixing performance.

## Priority 6: recognizable SF landmarks and realistic robot assets

The dedicated landmark catalog currently includes Palace of Fine Arts, Ferry
Building and R-evolution. Preserve and visually verify them. Add dedicated,
accurately placed Coit Tower, Salesforce Tower and Transamerica Pyramid models
first. Create a coverage checklist for the other major SF sights (Golden Gate
and Bay bridges, City Hall, Painted Ladies, Lombard Street, Twin Peaks, Alcatraz
and other supported-world landmarks) and complete the intended coverage.

Check location, orientation, scale, skyline silhouette, foundation height,
collision and near/far consistency. Add map labels/destinations and reachable
viewpoints. Existing street and massing data must not bury or duplicate models.
The owner now explicitly wants recognizable names and accurate logos where they
belong. Reconcile old no-brand/name-substitution rules with that newer direction;
record sources and asset rights, and do not invent affiliations or place random
logos around the city.

Improve robot assets toward believable industrial humanoids and delivery robots
using Figure/Tesla/iRobot as visual references. Favor well-made original or
properly licensed models. Keep existing human characters. Preserve robot identity,
collision dimensions, named joints, materials/rust masks, attack tells, collapse
states and inexpensive LODs. A high-poly replacement that breaks performance or
never visibly falls over is not finished.

## Priority 7: voiced story and feature-ready architecture

Create a concise, voiced opening that explains the SF setting, the player,
Moat Labs' corrupted update, helpful versus hostile robots, the water blaster,
and what the player can do next. Make it skippable/replayable with synchronized
subtitles and an independent voice volume. Reuse the existing narration queue,
priorities and music ducking. The current manifest has 291 text entries and
**zero recorded audio files**; a manifest entry is not delivered narration.
Resolve the recorded licensing hold with actual available licensed/consented
voice assets or an appropriate permitted voice service. Do not impersonate a
real person, buy a subscription, or claim a missing audio asset plays. Handle
slow/missing audio and autoplay restrictions without blocking gameplay.

Refactor incrementally around these features: separate phone screens/controllers
from general modals, expose a graphics preference/controller boundary, centralize
vehicle model/audio metadata, and isolate the taxi-mode state machine. Review
`src/main.ts`, `src/render/scene.ts`, `src/render/agent-layer.ts` and lifecycle
ownership before splitting responsibilities. Keep the deterministic simulation
free of DOM, Three.js, network, wall clocks and nondeterministic randomness.
Any change to simulated behavior or state shape needs the next unused version,
canonical migration and historical replay coverage. Avoid a wholesale engine
rewrite or a broad reformat that conceals feature changes.

Add a concise contributor guide explaining how to add a vehicle, landmark,
mode, phone app and sound, including registration, asset budgets and validation.
Borrow the useful Slop New York methods rather than its city or all its code:
https://github.com/mrdoob/slop-newyork/
Existing targeted reuse and measurements are in
`assets/imports/slop-new-york/README.md` and
`docs/qa/targeted-slop-methods.md`. Do not claim performance parity without a
comparable measurement.

## Implementation, testing and final delivery

- Make a task ledger with priority, owner, status, acceptance evidence and source
  PR replacement mapping. Read-only audits/assets/audio/UI/mode work can run in
  parallel with separate ownership. Serialize heavy builds, Blender imports and
  browser QA. Limit workers to available RAM; one browser is the default.
- Record a baseline before changing behavior. Use focused unit tests for real
  rules, local browser tests for interactions, and a static SF build. Run broad
  local validation once the integrated scope is stable, under a measured memory
  budget. Do not run full suites concurrently or quietly raise the 1 GB target.
- Representative commands, adapt their worker flags to the installed tools:

  ```sh
  pnpm typecheck
  pnpm exec vitest run --maxWorkers=1
  pnpm exec playwright test --workers=1
  pnpm build -- --out test-results/consolidated-release --no-sourcemap
  pnpm exec vite preview --outDir test-results/consolidated-release --host 127.0.0.1 --port 4371 --strictPort
  ```

- Browser QA must use the final served artifact. Exercise actual walk/drive,
  takeover, combat, phone/map/settings, all graphics tiers, taxi fares, narration,
  save/reload, missions and landmark routes. Include desktop and narrow/touch
  layouts, WebGPU and the supported fallback. Capture before/after images and
  audio proof; keep errors, hashes and resource data. Do not forge mission
  completion or substitute a screenshot for runtime validation.
- Require independent Standards and Spec reviews using the project's
  `pr-review-orchestrator` workflow. Re-check the live PR's exact head SHA,
  unresolved threads and actual required checks before merge. CI exclusion is
  explicit; never describe skipped/billing-blocked checks as passed.
- When the whole integration is ready, push the completed work to this branch
  and mark its existing draft PR ready for review against main. Include the old-PR disposition ledger and precise test/hold status.
  Keep the already-authorized main/production delivery within the reviewed scope;
  stop only for a concrete unresolved requirement, conflict, or genuine external
  approval. Do not erase an unresolved hold by renaming it complete.
- After merge, verify deployment for the exact main SHA and check the public game
  at https://fog-city-five.vercel.app/. A local preview or READY deployment alone
  does not prove the user's requested features are present. Close superseded
  draft PRs only with clear links to the landed replacement and preserved scope.

Start by reporting the actual checkout/main/PR state and the ordered work plan,
then implement. Do not stop after producing another plan or merely say that the
features are supported by data already on disk.
