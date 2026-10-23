# Re-sync, 23 Oct 2026: stop, fix your reviewed PR, stay in your lane

Every lane session reads this before its next commit. It overrides anything in the lane files
that conflicts with it. The owner (Broderick) issued it.

## What went wrong
In about three hours there were around 50 branches: lanes ran ahead to waves 5–9 (there is no
wave 9). Six or more branches each merged other lanes' work into themselves
(`feature/campaign-hd`, `feature/latest-showcase`, `feature/active-gameplay`,
`lane/render-integration/*`, `lane/render-polish/*`, `lane/harness/*`,
`lane/core/clearance-candidate`, `lane/sim-agents/completion`, …). Each is a different, unreviewed
integration of the same code. Several also edit Lane R's rendering files. **None of the reviewed
lane PRs has had a single fix pushed since its review.**

## The rules from now on
1. **Freeze every off-plan branch.** Don't push to, branch from or merge any branch that isn't
   your own `lane/<lane-id>/wave<N>` branch listed in the table below. The frozen branches stay
   on GitHub, and nothing is deleted. If one of them holds work you want kept, list it under
   "Salvage" in your status file, with commit SHAs.
2. **Fix your reviewed PR first.** Your review is in `docs/parallel/reviews/pr-<N>.md`, below and
   on this branch. It's also posted on the PR on GitHub. Fix every **blocker** and **high**,
   then the **mediums**. Push the fixes to the **same branch the PR is open on**. Don't open a
   new branch to "redo" it. Say in your status file, finding by finding, what you changed or why
   you didn't.
3. **One branch per lane per wave, and no running ahead.** Don't start wave N+1 until your
   wave-N PR has no open blockers or highs. Waves stop at 8.
4. **Lane 2 is the only integrator.** Only Lane 2 merges lane PRs, into `integrate/wave2`, in
   this order: core, content, pipeline, agents, combat, player, online, UI. Nobody else merges
   another lane's branch into theirs. If you need another lane's unmerged work, wait for it to
   land in `integrate/wave2`, then merge `integrate/wave2`.
5. **Rendering belongs to Lane R (the Claude build session).** `src/render/`, `src/main.ts`,
   `src/debug.ts`, `src/io/`, `index.html`, `vite.config.ts`, `scripts/build-web.ts`,
   `public/models/`, `assets/` and `content/landmarks.json` are off limits. Put whatever you need
   drawn or mounted under "Requests for Render-World / Assets" in your status file. The Ferry
   Building showcase line is `feature/ferry-showcase` (PR #3). Don't build on or fork it.
6. **SIM_VERSION is Lane 2's alone.** No other lane edits `src/sim/contract.ts` or bumps the
   version. The chain is: 2 (`integrate/wave1`) → 4 (world surfaces) → 5 (dodge), both landing
   in Lane R's integration → 6 (Lane 2's wave-2 interface, in `integrate/wave2`). Lane 2 publishes
   any 7 in a reviewed PR with a recursive `upgradeState` chain, which is review finding M1.
7. **Keep running `pnpm verify` before every push.** A PR that fails
   `tests/sim/forbidden-apis.test.ts` doesn't get merged.

## Your lane, your PR, your review
| Lane | Branch(es) to work on | PR(s) | Review file | Top priorities |
|---|---|---|---|---|
| 1 Pipeline | `lane/pipeline/wave2` | #8 | `reviews/pr-8.md` | `build-world --check` must be byte-identical; regenerate `gameplay.json` when QA lands |
| 2 Core + integrator | `lane/core/wave2`, then `lane/core/wave4` | #7, #19 | `reviews/pr-7.md`, `reviews/pr-19.md` | M1 (the upgradeState chain); M3 (wire combat into `step()`); a movement-phase hook for agents; Bay polygon; declare `threat.spawn`; retarget #19 at `integrate/wave4` later |
| 3 Agents | `lane/sim-agents/wave2` | #9 | `reviews/pr-9.md` | Admit runtime bodies (children, dogs, seated) into the dodge clearance set **before** registering; drop `Math.hypot` |
| 4 Combat | `lane/sim-combat/wave3` → `wave4` → `wave5` | #13, #14, #15 | `reviews/pr-13.md`, `reviews/pr-14.md`, `reviews/pr-15.md` | Coned robotaxi never released; cones from a moving car; rain cancels phone hacks; per-shot wet rule; rebase after core lands |
| 5 Player | `lane/sim-player/wave2`, then `wave3` | #10, #16 (#21 on hold) | `reviews/pr-10.md`, `reviews/pr-16.md` | Forbidden APIs (blocker); runway target mapping; a real gameplay provider; drop Lane 8's commits from #16; **#17 (`mission-mechanics`) closes as a duplicate** |
| 6 Online | `lane/modes-online/wave4` | #20 | `reviews/pr-20.md` | Snapshots only on mismatch; per-IP caps; exact-count resync test; payouts persist; **#5 (`codex/fog-city-multiplayer`) closes, so port `src/net/lobby.ts` from it** |
| 7 UI/saves | `lane/ui-save/wave2` | #11 | `reviews/pr-11.md` | Map routing freezes the game (heap A*, cached); the no-raw-inputs lint; gamepad menus; deny-listed startup text goes to the fallback kit |
| 8 Content | `lane/content/wave2`, then `wave3` | #12, #18 | `reviews/pr-12.md`, `reviews/pr-18.md` | Merge `integrate/wave2`; step-4 packs; honest review provenance; the owner decides on "Pro Max Ultra" and "Greg" |

## Reading this from a session without GitHub API access
```bash
git fetch origin docs/parallel-resync
git show origin/docs/parallel-resync:docs/parallel/RESYNC.md
git show origin/docs/parallel-resync:docs/parallel/reviews/pr-<N>.md
```
