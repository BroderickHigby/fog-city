> **Design input, not a decision.** Superseded by `docs/design.md` (2026-10-20 consolidation). Kept for the record of what was considered; its 13 high-severity issues are resolved there.

## The core game: Fog of Hype

In a city where the war is over attention, talent and power outlets, you fight with offer letters, foam, paint and buzzwords, and nobody gets hurt. Every match is the Pausers against the Accelerators [agi-two-years-away], and each win moves the Ferry Building clock one notch toward a midnight where nothing happens.

**Factions.** Each faction has its own announcer. The Pausers' announcer says "The timeline has advanced. Please hydrate." The Accelerators' says "Compute secured. We're so back." A match win moves `agiEta` by 3 in-game months. Faction rep unlocks the cardigan or the vest.

**Modes**

1. **Poach** (Capture the Flag) [capture-the-engineer]
   - **Rules:** Your engineer, Kernel Kev, sits in a Dogpatch garage a block from 315 Pennsylvania. Theirs, Sudo Sam, sits in a Transbay tower lobby. Hold *Make an Offer* for 3 s within 8 m and he gets in your car by choice. A capture counts only while your own engineer is home. A rival who spends 2 s in total within 10 m takes him ("they matched, plus a GPU allowance"). Stop for 15 s and he walks to a cafe; leave him untouched for 30 s and he takes a robotaxi home. The comp ticker reads $400k, then $4M, then $40M, then "board seat and a podcast".
   - **Win:** 3 captures, or the leader at 12 min.
   - **Area:** 3rd St over the Lefty O'Doul Bridge, then King St and the Embarcadero.
   - **Tool:** the Offer.
2. **Curbside Domination** [outlet-domination] + [search-and-park]
   - **Rules:** The three capture points are the last free outlets: (A) an espresso-icon table on Columbus Ave, (B) the Filbert St curb at Washington Square, (C) an extension cord out of a bookshop icon on Grant Ave. Stop in the 5 m zone with your laptop open (hazards on). Capture takes 10 s alone, 7 s with two cars and 5 s with three, and any rival in the zone freezes it. Your battery drains 1%/s and charges only on an outlet your team holds. At 0% you spend 8 s "buying a coffee and asking for the wifi password". Each zone has a generated sign stack. If you hold it during an illegal minute, the parking cart starts a 5 s ticket: drive off or lose the zone. Holding all three triggers Compute Monopoly, which doubles score, and the billboards call you "the infrastructure layer".
   - **Win:** 200 points, or the leader at 10 min.
   - **Area:** North Beach.
   - **Tool:** social tacticals. Waitlist Flashbang: a horn blast that freezes rivals within 8 m for 3 s in awe. Jargon Smoke. NDA Clipboard: a curb cone that makes anyone entering stop 4 s to "sign". Name-Drop.
3. **Agentic Focaccia** (Infected) [buzzword-contagion]
   - **Rules:** One car carries the buzzword. A carrier who stays within 6 m of a survivor for 1 s converts them. Carriers also infect every storefront they pass, and the 30 Stockton infects every stop on its route. Sandwich boards rewrite themselves ("Multimodal Cannoli, now with vision"). Survivors drop 5 "plain words" boards that cut graph edges. The word moves up a ladder every 4 hops: AI, then agentic, then agent-native, then post-agentic. At the top it becomes "made by humans", and for the last 60 s the remaining survivors become carriers.
   - **Win:** Carriers win at 80% of Columbus Ave infected or when every survivor is converted. Survivors win at 6:00.
   - **Area:** Columbus Ave to Chestnut St.
   - **Tool:** the buzzword itself.
4. **Runway Royale** [fog-royale] [runway-health-bar] [turntable-bell-duel]
   - **Rules:** A seeded fog front pours in through the Golden Gate in phases (90 s hold, 60 s close): the Marina, then the Wharf, then North Beach, then the Embarcadero. The final circle lands on a landmark, most often sunny Dogpatch. Your health is runway: you start at 18 months and lose 1 month every 3 s outside the circle. A Calendar Invite tag (hold 2 s on a rival) costs them 3 months ("they poached your lead investor"). Cloud-credit crates give +3 months, and the Bridge Round revives you once at 6 months. At 0 months you go to the Hyde & Beach turntable for a best-of-3 bell duel. The winner redeploys on a cable car running board with 6 months; the loser is acqui-hired and spectates. The FogCast HUD shows 97% confidence of sun the whole time.
   - **Win:** last founder with runway: "Raised a Series A in this market."
   - **Round:** about 14 min.
   - **Area:** the whole waterfront.
   - **Tool:** the Calendar Invite.

**Streaks** (consecutive scores without being pitched) [hype-streaks]:
- **3, TowerGuide Sweep (replaces UAV)** [coit-tower-recon]: shows rivals on the minimap for 30 s. One marker in five is a seeded hallucination, labelled at 98% confidence.
- **4, Stochastic Parrots (replaces Counter-UAV)** [stochastic-parrots]: the flock squawks your last 12 buzzwords somewhere else, and rival sweeps and associates chase that point for 20 s. Send the same vocabulary twice and they answer "We've seen this deck."
- **5, GPU Allocation Drop (replaces the care package)** [gpu-allocation-drops]: a pallet lands on the nearest pier apron or lot. It takes 3 s to load and holds a random field upgrade. It throttles above 90 C in sun, so take the fog route home.
- **7, Fleet Week Flyover (replaces the airstrike)** [fleet-week-pitch-window]: a 6 s jet pass over 150 m. Rivals under it cannot capture, offer or pitch. HushAI ($20/mo) removes your voice and keeps the jets.
- **9, Ad-130 (replaces the chopper gunner)** [ad-130-impressions-from-above]: 30 s on the blimp camera painting road segments. Rivals on paint are capped at 5 m/s. The crew holds fire within 3 m of any pedestrian: "Good impression."
- **25, AGI Achieved (Allegedly) (replaces the nuke):** the Ferry clock strikes midnight. The city freezes for 3 s with gulls stopped in mid-air, then one robotaxi honks. The match ends in your favour, every billboard reads "AGI is two years away" for a day, and the reset counter goes up by one.

**Loadouts** [founder-loadout] take one vehicle, one tactical, one field upgrade and three perks.
- **Vehicle tuning:** the Pier 70 prompt bench [vibe-code-gunsmith]. "Make it faster" gives +30% speed and −60% brakes. "Review the diff" costs 30 s; "Accept all" is free. Vehicle classes are a two-seater ("we're very selective") or a tech shuttle (4 seats, slow).
- **Field upgrade:** Microclimate-as-a-Service, a 20 s fog sphere that auto-renews monthly [marine-layer-evasion].
- **Perks:**
  - **Stealth Mode** (replaces Ghost): TowerGuide cannot see you.
  - **Do Not Disturb** (replaces Dead Silence) [do-not-disturb-prop-hunt]: no notification ping.
  - **Marine Layer** (replaces Cold-Blooded): attention decays twice as fast in fog.
  - **Default Alive** (replaces Scavenger): +1 month per capture.
  - **Lean** (replaces Lightweight): +8% top speed, −1 seat.

**Progression.** Ranks are funding rounds: Pre-seed (1–10), Seed (11–20), then Series A to D (up to 55). Prestige is the Pivot [pivot-prestige-pass]. Your rank resets, your cosmetics stay, and the grammar renames your startup: "AI agents for dentists" becomes "Dentists for AI agents", then just "Agents". Medals pop up as humblebrag posts [humblebrag-achievements]: "Humbled to announce a 5-capture streak."

**Single-player first.** One rival-founder driving AI on the street graph runs every bot, with at most 3 rivals per side and 7 in Royale (simulated cheaply when off screen). Matches are seeded, so a scripted input log reproduces the same result, and that is the test.

**Multiplayer needs a server for:**
- input relay plus lockstep (the deterministic sim makes this possible) or an authoritative host
- matchmaking and lobbies
- one shared global AGI clock and faction tally
- global leaderboards
- replay validation against cheating

Nothing in single-player needs a server.

## How the open world feeds it

- **Runway is the currency** [runway-health-bar]. Side activities pay runway, and burn line items cost it (a $7.50 pour-over on Columbus, a desk in a Dogpatch loft). The HUD reads "Revenue: $40 (ARR run-rate: $480!)". Runway buys bench cards, perks and tacticals.
- **VC attention.** In free roam, associates chase you. At five stars plus contact you go to the bell duel. Win and you drop to 2 stars; lose and you are Funded (prices +30%, a visible burn meter). Fog sheds stars. Inside a match the meter flips: stars mean term sheets.
- **Stats carry over.** GPUs from free-roam drops add a Poach offer card ("2.3 GPUs per researcher"). Each poached engineer opens a perk slot, up to 3.
- **Unlocks.** Each area's mode unlocks when its faction contracts are done, and those contracts move the same Ferry clock that matches do.
- **Fog Front.** The Fog Front open-world event runs the Royale circle with a Warmth meter and $64 fleeces at the Wharf, so free roam is Royale practice.

## Side activities

1. **Faction contracts** [agi-two-years-away]. Carry an open letter from the Ferry Building to Washington Square without going over 12 mph, or rush compute from Dogpatch with no brakes ("decel-coded"). Mechanic: one fail condition per mission. S, M0.
2. **SF-Bench** [sf-bench]. Six time trials, with a held-out route each week. If your held-out time is more than 25% slower, a contamination headline goes up on the 101 billboards. Mechanic: seeded route perturbation. S, M1.
3. **Backseat Prompt Rally** [backseat-prompt-rally]. "Ignore previous instructions" works once per ride. Mechanic: phrase-to-command lookup table. M, M1.
4. **Coit Tower Recon** [coit-tower-recon]. A quarter buys 30 s in the viewer. Flag a hallucination within 5 s ("You're absolutely right!"). Mechanic: seeded labels. M, M1.
5. **Fleet Week Pitch Window** [fleet-week-pitch-window]. Fit your talking points between jet passes ("Was that revenue or reverence?"). Mechanic: overlap scheduler. S, M2.
6. **Search & Park** [search-and-park]. The YC drive's last leg: decode five-sign stacks, and on grades over 3% curb your wheels. Mechanic: a pure legality rule. M, M2.
7. **Mother Dough Exfil** [mother-dough-exfil]. Carry a 170-year-old starter to a $18-toast startup, which adds $1 per minute late. Mechanic: rise and slosh meters. M, M3.
8. **Term Sheet Jumps** [crest-jump-term-sheet-cam]. Crest jumps found in the USGS data and graded Pre-seed to Series D. Mechanic: an offline crest detector. M, M3.
9. **4 a.m. Robotaxi Choir** [robotaxi-honk-choir]. Over three nights, cone robotaxis into a melody. Mechanic: an onset matcher. The user tunes the pitches by ear. M, M3.
10. **WeFloat** [wefloat-sea-lion-domination]. Bank ARR on the K-Dock floats before the sea lions take them all. You can never touch a sea lion. Mechanic: a haul-out schedule. M, M3.
11. **Human in the Loop** [human-in-the-loop-gripman]. Override the autonomous cable car at the California St let-go point. Mechanic: a grip state machine. M, Later (needs Nob Hill).

## Ambient comedy

- **Billboards:** asterisk stacks ("#1 on SF-Bench* *public split, best of 64"). For a day after each reset, every board reads "AGI is two years away" and quotes an invented lab spokesperson ("Seventeenth time's the charm").
- **Robotaxis:** an invented operator and livery. Every Tuesday at noon they pull over for the siren test ("emergency detected") and associates ask if it means a down round [public-events-calendar]. Land near one and it files an incident report.
- **Fog:** FogCast never drops below 95% confidence, and FogCast Pro ($30/mo) is just as wrong. The radio pins "the coldest winter I ever spent" on a different wrong person every time.
- **Radio:** the podcast host calls market corrections like sport and announces your rank-ups.
- **Barks:**
  - Immune delis: "We had AI in 1971. His name was Al. He made the coffee."
  - Associates: "Love the team. What's the TAM?"
- **Phone:** Autosummarized mission briefs get the order slightly wrong [autosummarized-phone].
- **Visual tells:** Muni wraps take on the current hype word. Upstairs monitor glow above North Beach bars lights in the colour of the faction that holds the block.

## Roadmap

- **M0 (downtown drivable):**
  - Ferry clock bound to `agiEta`
  - speed-cap and no-brake fail conditions, with 4 faction contracts (S)
  - SF-Bench Embarcadero Sprint (S)
  - the invented robotaxi brand and the Tuesday siren rule (S)
  - billboard reset pool (S)
- **M1 (North Beach, Embarcadero north, Marina; storefronts; buses):**
  - contagion sim and immune flags, first as solo Spread and Contain missions (M)
  - all six SF-Bench routes (S)
  - Backseat Prompt Rally (M)
  - Coit Recon (M)
  - sandwich-board grammar (S)
  - Muni hype wraps (S)
- **M2 (YC pitch mission and VC attention):**
  - runway ledger (M)
  - bell duel as the five-star bust (M)
  - fog moved into a pure sim module, plus the perception model (M; Royale needs this too)
  - Stochastic Parrots (M)
  - Fleet Week Pitch Window (S)
  - Search & Park leg (M)
  - rival-founder driving AI (M), which unlocks **Poach** and **Curbside Domination** against bots
- **M3 (art pass, customizer):**
  - loadouts and the Pier 70 bench (M)
  - the streak ladder and the midnight sequence (M)
  - faction cosmetics (S)
  - **Agentic Focaccia** as a mode (S, built on the M1 sim)
  - Fog Front event (M)
  - Mother Dough, Term Sheet Jumps, Robotaxi Choir, WeFloat (M each)
- **Later:**
  - 8-founder Runway Royale, then 24 (L)
  - multiplayer server (L)
  - on-foot Office Hours Hardpoint, Prop Hunt [do-not-disturb-prop-hunt] and All Fleeced Up [all-fleeced-up], once an on-foot controller exists
  - Incumbent Juggernaut on scooters [the-incumbent-juggernaut]
  - Foil Integrity e-bike [foil-integrity-burrito-run]
  - gripman, after Nob Hill is built

## Cut, and why

- Disqualified: none.
- [the-roll-up]: Katamari physics on steep terrain cannot be tuned without play-testing.
- [palace-photo-confirmed]: needs concurrent organic wedding NPCs, which is the most expensive asset class.
- [allow-once-agent-survival]: reading walls of text under a timer; indoor, so it barely uses the city.
- [pivot-race]: four vehicle modes; its pivot grammar lives on in Prestige.
- [shuttle-stop-hardpoint]: a weak joke, and the real shuttle fight sits too close to evictions.
- [salmon-run-infected]: L-cost runner crowds; Agentic Focaccia covers Infected.
- [same-model-gunfight]: overlaps Poach and Domination, and lower scored.
- [search-and-launch]: Search & Park covers Search & Destroy.
- [card-confirmed-mixer]: Kill Confirmed without a strong SF anchor.
- [literal-elevator-pitch]: low score; the YC Q&A already owns pitching.
- [fund-one-endgame]: inverts the VC meter before the meter is proven.
- [ghost-founders]: SF-Bench local ghosts are enough for now.
- [ratio-duel]: social combat on foot, which needs the on-foot controller.
- [photo-op-mode]: cosmetic only; it can return with the art pass.
- [founder-mode-hardcore]: a difficulty toggle, not content.
- [desk-domination]: interior Domination; Curbside does it outdoors.
- [final-cringecam]: replay system deferred until the Jumps need it.
- [daily-pivot]: absorbed by Pivot Prestige.
- [fully-autonomous-barista]: an indoor bespoke venue.
- [the-offsite-island-extraction]: L, off-map.
- [cofounder-spec-ops]: needs local co-op input.
- [growth-hack-the-wharf]: covered by Ad-130.
- [valuation-leaderboards]: needs a server.
- [buzzword-bingo]: passive, and Agentic Focaccia does buzzwords better.
- [founder-studio]: lowest score, menu work.

## Taste rules

1. The hype is the target. Delis, gripmen, couriers, couples and residents are the straight men.
2. Nothing touches a person or animal. Splats land on cars, billboards and road, and a no-target flag is enforced by test.
3. Invent every brand, lab, fund and robotaxi operator. The only real figure allowed is an obvious caricature of the YC partner.
4. Mock the Pausers and the Accelerators equally. AGI jokes are about hype, never apocalypse.
5. Never say Gulag, nuke, kill or strike in game: it is the bell duel, AGI Achieved (Allegedly), "impressions".
6. Every joke rides on a number or a rule (97% confidence, 12 mph, "board seat and a podcast"), so a test can check it.
7. If a gag works in any city, attach it to a real SF street, a real grade or the real fog.