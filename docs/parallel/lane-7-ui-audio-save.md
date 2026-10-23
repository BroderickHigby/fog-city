# Lane 7: UI, audio & saves

**Lane id:** `ui-save` · **Roadmap tracks:** UI-Audio, waves 2 to 7, and Save-Profile, waves 3 and 4 · **Branches:** `lane/ui-save/wave<N>`

## Paste-ready prompt
> You are Lane 7, UI, audio & saves, on Fog City (<https://github.com/BroderickHigby/fog-city>).
> It is a browser open-world game of a satirical, near-future San Francisco. Eight lanes are
> building in parallel. You own everything the player touches and hears outside the 3D world,
> plus saves: `src/ui/`, `src/audio/`, `src/input/`, `src/save/`, `tests/ui/` and `tests/save/`.
> Edit nothing else. The 3D renderer and `src/main.ts` belong to Lane R: ask it to mount your
> components.
>
> Read these first, in order: `CLAUDE.md` (the agent rules apply to you whatever model you are),
> `docs/parallel/README.md`, this file `docs/parallel/lane-7-ui-audio-save.md`, the UI-Audio and
> Save-Profile rows of every wave in `docs/roadmap.md`, `docs/design.md` (the HUD, phone,
> FreeTextBox and safety rules), `docs/ai-layer.md` (the FreeTextBox gates), `docs/handoff.md`
> and `docs/parallel/status/*`. Also read today's input code (`src/input/keyboard.ts`,
> `pointer.ts`) and HUD (`src/render/hud.ts`, owned by Lane R).
>
> Your goal: a clean, readable, phone-first game UI with satirical apps. That means the HUD,
> minimap with GPS, the phone (Map, BotBounty, Bot Check and later Ride, Radio, FogCast,
> Messages), touch controls and gamepad, and saves that never lose progress. Test it under
> SwiftShader through `window.__fogcity`.
>
> Start by creating `docs/parallel/status/ui-save.md`. Branch from Lane 2's wave-2 interface
> branch, or from `origin/integrate/wave2` once that interface has merged. Then do the wave-2
> row:
> 1. The HUD (runway, cash, tank, salt, threat).
> 2. The ad-blast overlay.
> 3. The minimap with the GPS line on the road graph.
> 4. The phone shell with Map, BotBounty and Bot Check.
> 5. The vendor screen.
> 6. Aim assist and touch controls for spray, scan, watch, cone and interact.
> 7. The `FreeTextBox` component, the only way typed text enters the game: crisis check, length
>    caps, deny-list gates, and the lint that forbids raw text inputs anywhere else.
> 8. The coworking sign-up form and the `?perf=1` overlay.
>
> Then do Save-Profile in wave 3 and the rest of waves 3 to 7.
>
> Follow the README for branches, commits, pushes, draft PRs into `integrate/wave<N>` and the
> memory rules. UI reads sim state but never mutates it; inputs go through `SimInput`. Push at
> least hourly and keep your status file current. Send the owner screenshots for look and feel.

## What to build, by wave
| Wave | UI-Audio | Save-Profile |
|---|---|---|
| 2 | Everything in the prompt above. Also gamepad support in `src/input/`, which isn't in the roadmap but the game needs it. | none |
| 3 | Phone apps Ride, Radio, FogCast and Messages. The Meander support bot in Ride: a scripted keyword bot behind `FreeTextBox`. The VC stars HUD. Bell duel UI. Scripted interview UI and Office Hours booking. The Daily Standup result grid. Radio ticker with music playback. | `src/save/`: the `SaveStore` interface; private-page storage plus an IndexedDB cache and fallback; progression-only saves stamped with `SIM_VERSION` and the content hash, loaded through `upgradeState`; 3 safehouse slots; autosave; export and import; profile v1. Publishing the playable link is Lane R's job. |
| 4 | Loadout and upgrade screens. Streak call UI. Mom in Messages and the Pivot action. Lobby UI and a generated-name picker. Nameplates. The character customizer (enum lists frozen at wave close). | Profile v2 (customizer, achievements, avatar). Cross-device continuity tests. Private co-op over the page's live messaging. A save-migration test that loads a wave-3 save. |
| 5 | Scoreboards. The Clean Streets HUD. Report, mute and block controls. Age-gate screens. Leaderboards. | none |
| 6 | Typing UI and "typing..." states. The GPU allocation meter. The Royale HUD. | none |
| 7 | The Hide in the Crowd emote wheel and task list. | none |
| 8 | Polish: the finale and Vibes Night screens, with Lane 6. | none |

## Done means
- Your rows' acceptance tests pass. Examples:
  - each `FreeTextBox` fed crisis phrases shows the sincere line, and no parser, comic line or
    network call runs;
  - no raw text input exists outside `FreeTextBox`;
  - a wave-3 save loads in wave 4;
  - saves survive a reload and an export/import round trip.
- All UI is usable with the keyboard, touch and a gamepad, and readable at phone width.
- `pnpm verify` and CI are green.

## Hand-offs
- **In:** HUD fields from Lanes 4 and 5; road-graph GPS data from Lane 1; lobby and leaderboard
  APIs from Lane 6; all UI strings from Lane 8 (no hard-coded copy).
- **Out to Lane R:** mounting points in `src/main.ts` and the HUD layering.
- **Out to Lane 2:** e2e hooks for UI flows.
- **Out to Lane 8:** the string keys you need.
- **Audio:** you own playback in `src/audio/`. The sound files in `public/audio/` come from Lane R
  (Assets), so request them by name.
