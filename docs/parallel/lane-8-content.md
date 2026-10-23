# Lane 8: Content & writing

**Lane id:** `content` · **Roadmap track:** Content, waves 2 to 8 · **Branches:** `lane/content/wave<N>`

## Paste-ready prompt
> You are Lane 8, Content & writing, on Fog City (<https://github.com/BroderickHigby/fog-city>).
> It is a browser open-world game of a satirical, near-future San Francisco that punches up at AI
> startups, tech culture and VCs. Eight lanes are building in parallel. You own every word and
> data table the game shows: `content/` (except `landmarks.json`), `src/content/` (the content
> lint, name composer and loaders), the content `schemas/` and `tests/content/`. Edit nothing
> else.
>
> Read these first, in order: `CLAUDE.md` (the agent rules apply to you whatever model you are;
> the **taste and legal rules are non-negotiable**), `docs/parallel/README.md`, this file
> `docs/parallel/lane-8-content.md`, the Content row of every wave in `docs/roadmap.md`,
> `docs/design.md` (tone, characters, missions, the decision log, cleared-name decisions),
> `docs/ai-layer.md` (fixtures and eval cases), `docs/handoff.md` and `docs/parallel/status/*`.
> Look at what's already in `content/`: some wave-2 content was merged earlier from
> `wave2/content`.
>
> Your goal: the game is funny, sharp, fair and legally clean. That means robot barks, bot tells,
> missions 1 to 10, director cards, district packs for every territory step, phone app copy,
> radio, billboards and blimp banners. Every invented proper name is cleared, and the content
> lint catches anything that breaks the rules.
>
> Start by creating `docs/parallel/status/content.md`, and branch from `origin/integrate/wave1`,
> or `integrate/wave2` once it exists. Then do the wave-2 row:
> 1. **Audit first.** Check every wave-1 content, id, mission and asset file for "YC",
>    "Y Combinator", the orange Y mark, real partner names, and Modern Warfare or Call of Duty
>    terms. Rename them to Ramen and invented names, and add those strings to the deny-lists.
> 2. **Name search.** Run a trademark and company-name search with web access for every invented
>    name in use. Record each with its date and source in `content/cleared-names.json`, rename
>    any that fail, and **get the owner's sign-off** before the wave-2 content freeze. Then add
>    the lint rule that rejects any invented proper name missing from that file.
> 3. The rest of the wave-2 row: `bot-tells.json` (at least 24 tells and 6 archetypes, with false
>    tells), `robot-goals.json`, 300 shared barks plus 100 wet barks, bounty templates, district
>    packs for steps 1–3, 40–60 director cards, the missions Hot Desk and Spill, vendor prices,
>    SoMa billboards and bus wraps, the content lint library, the crisis phrases and lines, about
>    200 startup kits, and the name composer with `banned-pairs.json`.
>
> Then do waves 3 to 8.
>
> Follow the README for branches, commits, pushes, draft PRs into `integrate/wave<N>` and the
> memory rules. Every file passes the content lint and its schema. Push at least hourly and keep
> your status file current. The owner judges whether the jokes land: send samples.

## What to build, by wave
Exact deliverables are in the Content row of each wave in `docs/roadmap.md`. Summary:

| Wave | Deliverables (summary) |
|---|---|
| 2 | The audit, the name search with owner sign-off, and the lint rule. Bot tells and archetypes. Robot goals. Barks. Bounty templates. District packs for steps 1–3. Director cards. Missions Hot Desk and Spill. Vendor prices. Billboards and bus wraps. The lint library. Crisis phrases and lines. Startup kits, the name composer and banned pairs. |
| 3 | The scripted interview bank (Metrics One, Philosopher, Vibes Partner), the demo script and Office Hours emails. The tagline bank. VC DMs. Radio ticker v1. FogCast lines. Meander reviews, and the support bot's keyword table and replies. Plain Words boards and ladder. SF-Bench routes and headlines. 150 more people lines. Step-4 packs. Missions 3–4. |
| 4 | `streaks.json`, perks, gadgets, the XP table and upgrade prices. Faction contracts. Doom Clock headlines. Conference Week lines. Pivot cards. Bench prompt cards. The Coit guide (Hallucination Tour) and the cofounder bank. The scripted Mom bank. Streak and announcer lines. Missions 5–7. Humblebrag posts. Name-part lists. Step-5 packs. Customizer enum lists. |
| 5 | Mode text and faction announcer lines. Clean Streets text. The discovery cast deck. The diligence memo bank. The director deck to about 100 cards. Step-6 packs. |
| 6 | Recorded AI fixtures (great answer, buzzword soup, injection, refusal, and each deny-list category). Eval cases. Royale crate and announcer text. Packs for steps 7 and 9a. |
| 7 | Hide in the Crowd tasks. Missions 8 and 9. Step-8 packs. |
| 8 | Template roasts. Mission 10. Step-9b packs. Banner and blimp copy: invented startups from the composer plus AI-ad lines, linted, cleared and font-fitted. |

## Done means
- Your rows' acceptance tests pass. Examples:
  - the content lint fails on fixtures containing "YC", "Y Combinator", "Modern Warfare",
    "Scorestreak", a mode named "Domination", or an uncleared invented name, and passes on the
    audited content;
  - every composed startup or player name passes the lint or is in `banned-pairs.json`;
  - territory coverage text exists for every shipped district.
- No real brands, logos or private people. Public figures appear only as obvious caricature.
  Punch up, never at homelessness, poverty, drug use or crime victims.
- `pnpm verify` and CI are green.

## Hand-offs
- **In:** string and table key requests from every lane, in their status files.
- **Out:** stable keys and schemas. When you rename a key, tell the lanes that use it.
- **Owner:** the name-search sign-off, and samples of jokes and missions to judge.
