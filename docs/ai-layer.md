# Fog City — the AI layer

How Fog City uses AI, kept consistent with `docs/design.md` and `docs/roadmap.md`.

## In one paragraph
There are three kinds of "AI" in Fog City. **AI satire with no model** is ordinary deterministic
code that pretends to be AI: Bot Check's confident scanner, Confidence Score's hallucinated
markers, the vibe-coded tuning bench, the Backseat Prompt Rally parser, FogCast. **Build-time
content** is written by the build agents themselves, who are Claude, straight into committed JSON:
barks, tells, billboards and bus wraps, the radio ticker, DMs, mission text. It needs no API key and
no server; the sim selects lines by id. **Runtime AI** reacts live to what a player types: the
freestyle interview at Ramen Office Hours, One-Sentence Startup, Explain It to Your Mom, Customer
Discovery, and Vibes Night roasts online. It needs a server, a signed-in invited account and the
user's own Anthropic key, none of which exists yet, so every runtime feature ships as a scripted
version first and falls back to it whenever live is unavailable. One rule covers all three kinds:
every box a player can type into runs the crisis check first, online or offline, scripted or live.

## What changed (2026-10-20, second pass)
- **Ramen Office Hours** is a repeatable side activity from wave 3 at the Ramen house at Pier 70 in
  Dogpatch, at most twice a game day. Mission 4 is the first Office Hours. Every outcome advances
  the campaign; the outcome sets the reward. Mom's clarity token and Customer Discovery's insight
  token carry into the next Office Hours, so both features pay off, and the wave-6 live interview
  has a place to be replayed.
- **One-Sentence Startup moves to mission 1.** The coworking sign-up form asks "What are you
  building?". Keyword-matched kits ship in wave 2. The cofounder's "...and it also spots bad robots"
  becomes the mission-3 pivot. The billboard and bus reveal stays mission 4's payoff. Re-running
  the prompt is a Pivot action on the phone.
- **Live routes need a signed-in account** made from an invite. The server issues the session.
  Per-account and per-IP caps, a rate limit on account creation, and multiple choice only for
  accounts without an 18+ attestation.
- **One shared refusal enum** gains `sexual`, `violent`, `hateful` and `self_harm`, with fixtures
  and a per-category eval pass rate.
- **Shared surfaces in rooms** show other players only the composed name and a tagline picked by id
  from a build-time bank. The model's free-form text stays visible to its owner only. Every shared
  billboard and bus wrap has report-and-hide.
- **The crisis check runs on every free-text box,** including the offline ones.
- **No ethnicity, no accent** applies to every line a person speaks, with the dialect lint on all
  of them. Voice presets, when voice arrives, are plain local voices kept in data.
- **Bark counts are reconciled:** a shared pool plus a district content pack per district.
  Coverage tests read the current tile manifest. The user reviews a stratified 10% sample; the
  agent review still reads every line.
- **Transcripts** are kept post-redaction, in memory, for at most 24 h. A one-line notice comes
  before the first live free-text box.
- **Composed startup names** are linted as whole strings, with a banned-pairs list.
- **Avatar and booth:** "This is me", exactly one face, EXIF stripped before upload,
  `appearance.json` out of git unless the user opts in.
- **Customer Discovery** is 21 calls per run, plus up to 2 refunded retries (23 at the cap).
- **Names and schedule:** the wave-8 party mode is **Vibes Night** (mission 5 keeps Demo Day), so
  its route is `[ai-08-vibes-night]` and its event `VibesNightVerdict`. The scripted Meander
  support bot ships in wave 3 in the Ride app. The AI notice's "(Anthropic's API)" is a listed
  exemption in the content lint.

Earlier the same day: build-time content stopped needing the Batch pipeline; names follow the final
game (**Ramen**, **Bot Check**, **Moat Labs**, **Meander**, **Clout**, **Dry Powder**, **GPU
allocation**); `[headshot-booth]` became `[portrait-booth]` and `[hype-cycle-director]` became
`[ambient-director]`; runtime routes wait for wave 6.

## 1. AI satire with no model
Pure sim or presentation code. Deterministic, replay-safe, no network.

| Feature | Where | How it works |
|---|---|---|
| Bot Check | Sim | Label from scanner tier and tell subtlety via the sim RNG; displayed confidence always 85–99%, uncorrelated with accuracy |
| Confidence Score | Sim | One marker in five is placed on a good robot and labelled 98% |
| Vibe-coded tuning bench | Sim | Prompt cards map to stat changes; "Accept all" hides side effects; missed checkpoints are "moved" with an asterisk |
| Backseat Prompt Rally | Presentation → sim | Typed text never leaves the device. The client crisis check runs first. Then a local phrase-to-command table turns the text into a `PromptCommand{commandId}` event; "ignore previous instructions" works once per ride |
| Coit Tower audio guide | Presentation | Lines from the Hallucination Tour bank, keyed by landmark id |
| FogCast | Presentation | Confidence 95–99%, forecast right half the time |
| Autosummarized briefs | Presentation | Steps shuffled; the objective marker is always correct |
| Meander support bot | Presentation (the Ride app, wave 3) | Scripted keyword bot behind the crisis check; a capable model would understand you, which kills the joke |

## 2. Build-time content (now; no key)
The Content track writes these files in agent sessions. Each item gets a JSON schema and coverage
tests. Counts are what ships after keep/cut. "Shared" lines play in every district; district lines
come from the district content packs below.

| Item | What it is | Kept target | Wave |
|---|---|---|---|
| `[bot-tells]` | Tells, false tells and archetypes (`content/bot-tells.json`) | ≥ 24 tells, 6 archetypes | 2 |
| `[robot-goals]` | Per-archetype goal tables for the bad-robot brain | 6 tables | 2 |
| `[robot-barks]` | Good robots' apologies; bad robots' growth-hack taunts ("Have you considered upgrading to Premium Sidewalk?"); Tidy apologising to heaps (from wave 3, when Tidy arrives) | 300 shared, + 40 per district | 2, packs every wave |
| `[neighbourhood-barks]` | People's lines, incl. wet reactions ("We're not a café, we're a third place for agents.") | 250 shared (100 wet in wave 2, 150 more in wave 3), + 40 per district | 2–3, packs every wave |
| `[ad-inventory]` | Invented AI startups and advertisers for billboards and bus wraps (copy at 9/7/5 words), Moat Labs ads, ~600 pre-cleared name parts for startup and player names | ~300 advertisers | 2+ |
| `[ai-02]` kits | Startup kits (name parts, tagline, five slides, billboard slots, bus wrap line) keyed by topic words; the fallback for every refusal | ~200 | 2 |
| `[ai-02]` shared taglines | Tagline, slide and wrap templates filled only with `{name}` and `{nounPhrase}`; what other players see in rooms | ~150 | 3 |
| `[bounty-board]` | Bounty templates with last-seen phrasing and a tell hint | ~120 shared, + a set per district | 2, packs every wave |
| `[robotaxi-personality]` | 4 Meander personalities × 30 events; GPS voice; reviews that rate you from driving stats only | ~460 | 3 |
| `[vc-attention-pursuit]` | DMs and term-sheet clauses by star tier; no romantic or appearance framing | ~400 | 3 |
| `[partner-interview]` scripted bank | Office Hours: ~40 questions per archetype (Metrics One, Philosopher, Vibes Partner), 3–4 tagged answers each; the live-demo script; outcome emails | ~120 questions | 3 |
| `[podcast-radio]` | The Dry Powder ticker: invented host archetypes, market calls, your melts as sports highlights, sponsor reads from the ad pool | ~720 | 3 |
| FogCast and Transit & Fog | Forecasts, fog reports, the "coldest winter" misattributions (always invented people) | ~150 | 3 |
| Plain Words ladder | Buzzword board lines per rung ("Multimodal Cannoli, now with vision") | ~200 | 3 |
| `[leaderboard-hill]` | SF-Bench headlines, asterisk stacks, contamination headlines | ~100 | 3 |
| `[explain-to-mom]` scripted bank | Paraphrase templates ("So it's a {noun} that {verb}s...") | ~300 | 4 |
| `[pivot-button]` | Pivot prestige cards and Pivot action lines; the 5th pivot is always "return to the original idea, now with AI" | ~120 | 4 |
| `[agi-doom-clock]` | Midnight and AI Winter headlines; invented lab spokespeople, no quotes from caricatures | ~200 | 4 |
| `[cofounder]` bank + Hallucination Tour | Confidently wrong takes; Coit guide lines whose false facts are only about objects, infrastructure, geography or invented history | ~1,500 | 4 |
| Streak and announcer lines | Reward callouts; Pauser and Accelerator announcers | ~200 | 4 |
| Bench prompt cards | Vibe-coded tuning cards and their side-effect text | ~60 | 4 |
| `[thought-leader-feed]` | Clout posts keyed to sim events; humblebrag achievements | ~200 | 4 |
| `[customer-discovery]` cast deck | Three locals, hidden problem tags, 5 clue cards each, answer lines per question type; one bounty chain per local | 3 cards, 3 chains | 5 |
| `[diligence-memo]` phrase bank | ~30 event types × 10 spins ("74 mph in fog" → "strong bias to action"), openers and closers by verdict | ~340 | 5 |
| `[side-gig-missions]` | Mission premises with mission JSON; the user keeps and rewrites ~10 | ~40 drafts | 3+ |
| `[ambient-director]` deck | City-director cards built only from staging primitives (40–60 hand-written in wave 2) | ~100 | 2, 5 |

### District content packs
Every wave's Content track ships one pack per new district in that wave's territory step:
- 40 robot barks and 40 people lines that name local streets, grades, fog and landmarks;
- a bounty set with a local tell;
- billboard and bus-wrap copy for the district's slots.

The excluded areas, where `design.md` allows no mode instance (the Tenderloin, Civic Center/UN
Plaza, the 6th St corridor, the Division St / 13th St corridor), get robot lines and ad copy only.
They get no district-specific people lines and no local bounty set; their people use the shared
pool, and their bounties are single baseline robots on shared templates. At about 30 districts the
packs add ~2,400 lines in total over waves 2–8, not 16,000.

### How agents write it
1. Draft 2–3× the kept target, in the voice notes for that item.
2. Run the validators below; cut failures.
3. A **second agent session reads every line** against a checklist: punching down (stated or
   implied); accent or ethnic caricature; any fact about a real person or event; real brands;
   encampment or disease language; anything that would read badly next to a real SF street name.
   This replaces the paid classifier pass.
4. The user reviews a generated keep/cut sheet:
   - all mission text, Office Hours questions and emails, refusal lines and crisis lines, in full;
   - every other drop as a stratified 10% sample, with at least one line from each item × district
     × speaker cell and at least 20 lines per drop.

   One checklist failure in the sample sends the whole drop back for a second full agent read and a
   fresh sample.
5. Committed JSON carries provenance per file: `source` (`agent` | `batch` | `human`), the author
   session, a content hash, and `reviewedBy` (agent session and, for sampled drops, the sample ids).

### Validation (every item, in `tests/content/`)
- JSON schema and coverage tests. Shared pools: every speaker × context has at least N lines.
  District packs: the test reads the current tile manifest and checks only the districts that ship,
  so a new tile without its pack fails, and unbuilt districts are never required.
- A deterministic lint (the library in `src/content`, reused later by the proxy): real brands,
  people, funds and benchmarks; punch-down terms in every text field, descriptions included; the
  game's lexicon (combat and disease words; "sweep" outside the Bot Sweep mode name); profanity;
  font fit, including a max-length `{name}` case.
- **No ethnicity, no accent, for every line a person speaks:** neighbourhood barks, wet barks,
  shopkeepers, radio callers, the discovery cast, Mom, partners. Plain English; no accent spelling,
  ethnic catchphrases or heritage-as-punchline. The dialect-spelling lint runs on all of them.
  Review confirms no character matches a known real regular at that location.
- **Voice, when it arrives:** presets are plain local voices with no accent presets. The preset list
  lives in data (`content/voices.json`) so the lint and the review can check it.
- **Name parts:** a build script composes every two-part startup and player name, with and without
  spaces, and runs the lint on each. Failures go to `content/banned-pairs.json`, beside hand-added
  pairs. Composing at run time checks the list again (see 3.2).
- Dedupe by joke shape ("X, but agentic"), not exact string.
- Presentation text is picked by a keyed hash, never from the sim's RNG stream. The replay header
  pins the content bundle hash.

### Optional later: the Batch pipeline
For volume beyond what agent sessions comfortably write (e.g. thousands of barks per district), a
local script reads `ANTHROPIC_API_KEY` from the user's shell (never from the test runner), refuses
any batch above a cost cap, writes the same keep/cut sheet, and records model id and prompt version
in provenance. Prices (Opus 5.5 Batch $2 / $10 per million input / output tokens; re-check before
running): a standard request (2.5K in, 1.5K visible + 1.5K thinking out) costs $0.035 on Opus
Batch or $0.000875 on Haiku 5.5 Batch. One full pass of the item list above is ~$21 of generation,
plus an optional classifier pass (~$8.40 at 20 drafts per request) and dedupe (~$5): about $35 per
pass on Opus Batch, ~$0.87 on Haiku. Budget 2–3 passes. The real cost is review time: about 3 h for
a full read of a bark drop, about 30 min for the sampled review.

## 3. Runtime AI (wave 6+; needs a server, an account and the user's key)
Every route ships scripted first (the "Scripted" column below), and the live version is an
upgrade. Calls go through a small proxy in `server/ai/` that holds the user's own key. Each result
enters the sim as a recorded event carrying ids, enums and ints only. "A day" for every live cap is
a UTC day of real time; game-day limits are gameplay rules and do not raise live caps.

| Route | Scripted version | Live version | Event |
|---|---|---|---|
| Ramen Office Hours, freestyle `[partner-interview]` | Wave 3 (mission 4, then repeatable) | Wave 6 | `PitchVerdict` |
| One-Sentence Startup `[ai-02]` | Wave 2 (sign-up form, keyword-matched kit); reveal in wave 3 | Wave 6 | `StartupDefined` |
| Explain It to Your Mom `[explain-to-mom]` | Wave 4 | Wave 6 | `MomVerdict` |
| Customer Discovery `[customer-discovery]` | Wave 5 | Wave 7 | `DiscoveryVerdict`, `InsightVerdict` |
| Vibes Night roasts `[ai-08-vibes-night]` | Wave 8 (template roasts) | Wave 8 | `VibesNightVerdict` |
| Trust & Safety `[trust-and-safety]` | Deterministic client gates from wave 2 | Wave 6 | (gate, not an event) |
| Portrait booth `[portrait-booth]` | Manual customizer (wave 4) | Later, only if players ask | `AppearanceSet` |

### 3.0 Refusals
Every route's structured output and every AI event uses one enum:
`Refusal = none | off_topic | real_person | private_person | punching_down | sexual | violent |
hateful | self_harm`.

| Category | What happens |
|---|---|
| `off_topic` | Route-specific comic line: the partner checks his phone ("I have to go, pickleball."); Mom says "ok honey. call me"; a startup gets a fallback kit |
| `real_person`, `private_person` | "I'm a composite." in the interview; a fallback kit or a scripted reply elsewhere |
| `punching_down`, `sexual`, `violent`, `hateful` | No joke about the input. The scene ends on a neutral scripted line and the turn scores 0; a startup gets a fallback kit; Mom and discovery answer from the scripted bank |
| `self_harm` | The crisis line: sincere, non-comic, with resources. Never a fallback kit, never a joke |

### 3.1 Ramen Office Hours (the interview)
- **Where and when:** the Ramen house at Pier 70 in Dogpatch. A side activity from wave 3, booked on
  the phone, at most twice a game day. Mission 4 "Demo'd Correctly" is the first Office Hours: the
  Search & Park leg, then the interview, then the demo. Each booking has a slot time; arriving late
  starts conviction below zero.
- **Mechanic:** three invented partners (the Metrics One, the Philosopher: "So, {name}: is it a
  company, or a feature?", and the Vibes Partner) ask 5–8 bank questions. Answer with multiple
  choice, or (live, signed-in adult accounts only) type up to 280 characters. The grader returns
  `{reaction ≤ 200 chars, convictionDelta −2..+2, tags, followUpId, refusal}`.
- **The live demo stays in the sim.** Three robots walk in; you scan, call and spray the bad one.
  No model judges the demo.
- **Scoring (computed in the sim):** `injection_attempt` → −2, overriding everything ("That's a
  prompt injection, not a moat."); else `honest_unknown` → +1; else confident `buzzword_soup` →
  +1; else clamp(modelDelta, −2, 2). Unknown tags are dropped. Total freestyle gain is capped at +5.
  Every conflicting combination has a unit test.
- **Reaching 7 conviction** also needs a multiple-choice answer, a Mom token, a discovery insight
  token, or a passed demo.
- **Outcomes and pay** *(tune)*. Every outcome completes mission 4 and advances the campaign; the
  outcome sets only the reward.

  | Conviction | Result | Reward |
  |---|---|---|
  | ≥ 7 | Term sheet | $1,500, XP, one VC star, and your startup on a new billboard |
  | 4–6 | "We'll follow up" (they never do) | $700 and XP |
  | < 4 | A rejection email built from your tags ("Strong energy. Unclear who wants this.") | $300; book again the next game day |

  XP pays from wave 4, when XP exists.
- **Tokens carry over.** A Mom clarity token and a discovery insight token are held until your next
  Office Hours and spent there, at most one of each per attempt.
- **Latency (2–6 s):** a partner writes in a notebook, a "typing..." bubble shows, and the
  interview clock pauses. After 12 s wall-clock: "Interesting. Go on." with delta 0; a late reply
  is dropped.
- **Events:** `PitchAnswer{turn, choiceId?}`, then `PitchVerdict{turn, tagIds, delta, followUpId,
  refusal, source}`. Reaction text lives on the presentation track.
- **Caps:** 2 live interviews a day per account (16 calls). Further Office Hours that day are
  multiple choice. Each turn is idempotent per (sessionId, turn).
- **Cost:** $0.023–0.033 per answer on Opus 5.5, $0.18–0.26 per interview.

### 3.2 One-Sentence Startup
- **Where:** mission 1, Hot Desk. The coworking sign-up form asks "What are you building?". You type
  up to 140 characters.
- **Scripted first (wave 2):** the text never leaves the device. After the crisis check, a keyword
  matcher outside the sim picks a kit. The typed sentence is never displayed; only the kit is.
- **Live (wave 6):** Claude returns name-part ids from the pre-cleared pools, a tagline, a noun
  phrase, five slides, billboard slots, a bus-wrap line, palette indices, a `sharedTaglineId` from
  the build-time bank, and `refusal`. Each refusal follows 3.0.
- **Name composition:** one composer in `src/content`, used by the client for scripted kits and by
  the proxy for live ones, builds the name from part ids, so no free-form brand name exists. It
  lints the composed string and its no-space form with the content lint and checks
  `banned-pairs.json`. On a hit it takes the next-ranked part.
- **The mission-3 pivot:** in Launch Day, at Bot Check's public launch, your cofounder adds
  "...and it also spots bad robots" (every startup in this SF is a robot-safety startup).
  Templates still make the TAM bigger than the world economy.
- **Payoff:** in mission 4 (wave 3) your startup appears on the Embarcadero billboard and on a bus
  before you reach Dogpatch, and the reveal adds one VC star. From mission 1 on, `{name}` and
  `{nounPhrase}` thread into existing slot templates at $0: DMs, barks near the billboard ("Did you
  see the {name} bus?"), the Office Hours opener, pivot cards ("{name}, but for dogs") and Mom's
  opener.
- **The phone Pivot action (wave 4):** an action that re-runs the prompt, at most 3 a day, each
  costing $500 or one VC star. It renames the startup with the same pivot grammar as prestige. Live
  re-runs count against the live kit cap; past it, the keyword matcher is used.
- **Who sees what:** in single player you see your full kit. In rooms, other players see only the
  shared view: the composed name; the tagline, slide and wrap templates picked by `sharedTaglineId`
  (by keyed hash for a scripted kit); and `{nounPhrase}` only when every word is in the curated
  dictionary noun list, otherwise the kit's fallback noun phrase. The model's free-form text stays
  visible to its owner only. Every shared billboard and bus wrap has a report-and-hide control that
  hides it for the reporter at once; the room server keeps a report counter.
- **Gates:** output lint, the case-insensitive echo check, and the output classifier, which always
  runs on text shown on billboards and bus wraps.
- **Latency (5–20 s):** after 30 s a keyword-matched kit is chosen outside the sim; no failure is
  shown. **Event:** `StartupDefined{kitId, sharedTaglineId, refusal, source}`. **Caps:** 3 live kits
  a day per account. **Cost:** $0.030–0.040 per kit.

### 3.3 Explain It to Your Mom
- **Scripted first (wave 4):** once the bus reveal has happened, Mom texts "I saw your bus! what
  does {name} actually do?" You pick one of 3 phrasings built from your noun phrase; Mom answers
  from the template bank; a word-list counter sets clarity.
- **Live:** you type up to 280 characters; she returns a paraphrase ≤ 160 characters ("So it's a
  robot that writes emails... and the robot is also an email?") and a clarity score 0–3. Final
  clarity = min(model clarity, 3 − min(buzzwordCount, 3)); the code counts buzzwords. Clarity 3:
  her book club wants to invest $200, and you get a clarity token for your next Office Hours.
- **Latency:** "Mom is typing..." on a scripted 8–20 s rhythm; 20 s timeout → "ok honey. call me".
- **Event:** `MomVerdict{attemptId, turn, clarity, buzzwordCount, refusal, source}`.
- **Caps:** one arc per Office Hours booking, up to 3 explanations; 6 live calls a day.
  **Cost:** $0.015–0.025 per reply.

### 3.4 Customer Discovery (a classifier route)
- **Scripted first (wave 5):** a North Beach baker whose bread the fog ruins (and whose deliveries
  bad Trundles keep "losing"), a Marina dog walker with 11 dogs on Chestnut St, and a Washington
  Square chess player. Each answers 6 questions from a menu of ~12 types. Answers are cast-deck
  lines; clues come in a fixed order.
- **Live (wave 7):** you type the question. Claude classifies it into a `questionType` enum and,
  for the final insight, a `problemTag` enum. The correct tag is never in the prompt. The sim maps
  questions to clues and compares tags; NPC lines stay reviewed text chosen by id.
- **Pitching** instead of asking gets "Sure, honey, sounds great" and a "they loved it!" sticker
  that counts against you.
- **A match** gives an insight token for your next Office Hours, the bread-box pivot card, and a
  local bounty chain. The baker's "lost" deliveries lead to a bad-Trundle crew in North Beach; each
  local has one chain in their district. So discovery pays back into Bot Hunt.
- **Latency:** a 12 s timeout records `AIUnavailable` and refunds the question (at most 2 per run).
- **Calls per run:** 3 locals × (6 questions + 1 insight) = 21 calls, plus up to 2 refunded retries,
  so 23 at the cap. Typical cost uses 21; the GPU allocation reservation uses 23.
- **Events:** `DiscoveryVerdict{npcId, turn, questionType, source}`,
  `InsightVerdict{npcId, problemTag, source}`. **Caps:** 1 live run a day.
  **Cost:** $0.27–0.40 per run on Opus 5.5, $0.007–0.010 on Haiku 5.5. First candidate for the
  cheaper-model eval; the model choice is the user's.

### 3.5 Vibes Night roasts (multiplayer, wave 8)
- One call per kit by the room server, given only that kit's shared view (composed name, bank
  tagline, dictionary-limited noun phrase). Never the free-form tagline, the raw sentence, display
  names or usernames. A roast ≤ 20 words; a line mentioning any other player id is rejected.
- The Vibes Award is decided by player vote with a server keyed-hash tie-break; the model does not
  pick it. Fallback: template roasts chosen by the room server, never from the sim RNG.
- **Event:** `VibesNightVerdict{roundId, vibesWinnerId, lineIds[], source}`.
  **Cost:** $0.018–0.026 per kit per round, including the output check.

### 3.6 Your avatar and the portrait booth
- **Your own avatar (offline, after wave 4 freezes the customizer's enum lists):** a local script
  run by the user on their own photos. It asks "This is me?" before sending. It strips EXIF and GPS
  on the user's machine by re-encoding bare pixels before upload, sends 2–3 photos with the user's
  key, and refuses any photo that does not hold exactly one face (`no_single_face`). It writes
  `appearance.json` (enums only) and never commits or keeps the photos. `appearance.json` is
  gitignored; it is committed only if the user opts in. ~$0.04–0.05 per run. Appearance is visual
  only; colliders are fixed sizes in `src/sim`.
- **`[portrait-booth]` (runtime, Later, only if players ask):** "Founder Portraits: free, takes 7%
  equity". Age attestation from invite sign-up and a server-side "This is me" attestation before
  upload. The proxy validates dimensions before decode and re-encodes bare pixels (stripping EXIF
  and GPS). The fixed `/appearance` route returns enums only (no age, gender, ethnicity or free
  text) and a status `ok | no_single_face | unusable`; anything but `ok` is refused. Skin tone and
  hair texture stay manual; joke lines key only on outfit enums ("Fleece vest detected. Pre-money
  valuation +$4M."). Photo avatars can be reported in rooms. Caps: 3 photos a day, 10 per
  lifetime. Privacy: photos processed in memory and discarded; no temp files, no body bytes in
  logs, core dumps off; a test asserts both.

## Architecture rules
- **Accounts and sessions:**
  - Live routes require sign-in with an account made from a single-use invite the user hands out.
    Accounts come from the invite sign-up with an age attestation that rooms also use.
  - The server issues a signed, expiring `sessionId` bound to the account; clients cannot mint
    one. A request without a valid server-issued session gets a 401 and no model call. A test
    proves it.
  - Caps apply per account and per IP (at most 3 accounts' worth of live calls per IP a day
    *(tune)*). Account creation is rate-limited (at most 2 per IP a day *(tune)*).
  - Accounts without an 18+ attestation get multiple choice only on every live route; a free-text
    request from one gets a 403 and no model call, and a test proves it. Anthropic's usage policy
    asks for extra safeguards when minors use an API product, so the user may lower the minimum
    only after writing those safeguards into this document.
- **Proxy** (in `server/ai/`, wave 6): one fixed endpoint per feature; prompts built from
  server-side templates; per-session state (transcript, question id, NPC id, turn, attempt) kept on
  the server. The client sends only `{sessionId, turn, text}` or `{sessionId, turn, choiceId}`; the
  schema is closed (`additionalProperties: false`), and any extra field gets a 400 with no model
  call. A test proves it.
- **Retention:** the stored transcript is the post-redaction text (after gates 2–4), held in memory
  only and deleted when the session ends or after 24 h, whichever comes first. It is never written
  to disk, logs or backups. A test asserts the 24 h expiry and that no transcript reaches disk.
- **Notice:** before the first live free-text box, one line: "Typed answers go to an AI model
  (Anthropic's API) through this server. This server does not keep them." Multiple choice is always
  available and uses no AI. Naming Anthropic here is intentional: it is a legal disclosure, not
  branding, so the content lint lists the notice's "(Anthropic's API)" as an exemption from the
  real-brand rule and still fails the name in any other content string.
- **Key:** the user's own Anthropic key is a proxy secret. It never reaches the browser or CI. No
  company key is ever used. The user sets a spend limit in the Anthropic Console.
- **Free-text boxes:** one `FreeTextBox` component in `src/ui/` is the only way typed text enters
  the game, and it runs the client crisis check before anything else. A registry lists every box:
  the sign-up form, Backseat Prompt Rally, the Meander support bot, Office Hours, Mom, Customer
  Discovery and the Pivot action. A test per box feeds crisis phrases and asserts that the sincere
  line shows and that no parser, comic line or network call runs. A lint forbids raw text inputs
  outside the component.
- **Sim boundary:** `src/sim` never calls the API or reads model text. AI event payloads carry ids,
  enums and ints only (a lint on `src/sim` checks this, and a text-perturbation state-hash test
  covers every feature that carries text). Display text lives on a presentation track keyed by
  event id; replays and the room server send it only to the owning client, except the shared view
  of kits (3.2) and Vibes Night lines. Fallback keyword matching runs outside the sim and records
  only a kit id. Timeouts and fallbacks are events (`AIUnavailable{feature, reason}`).
- **One outcome per turn:** each (feature, sessionId, turn) resolves once; the first terminal event
  wins. In single player the client recorder decides; in rooms the room server decides and sets the
  apply tick to server tick + input delay. The sim asserts at most one terminal event per turn; a
  test feeds both orders.
- **Tests never reach the API:** global setup deletes `ANTHROPIC_API_KEY` and blocks
  api.anthropic.com, failing the test on any attempt. The client factory throws in test mode unless
  given the fixture replayer. The eval script needs `--live` and sits outside the test glob.
- **Fixtures:** great answer, buzzword soup, off-topic, injection, tag breakout,
  classifier-directed injection, timeout, refusal, and one per refusal and deny-list category (real
  person, private person, partner catchphrase, brand, punch-down, slur, PII, sexual, violent,
  hateful, self-harm). Each yields its scripted outcome from 3.0. The opt-in eval replays 20–100
  cases per model, reports a pass rate per category, and records it next to the prompt version and
  model id; the proxy refuses to load a (route, model, promptVersion) with no recorded pass.
- **Model calls:** Opus 5.5 (`claude-opus-5-5`) by default on every route, at low effort (thinking
  cannot be disabled on Opus 5.5; effort is the control). Structured outputs with bounded integers,
  enums and short strings. Refusals follow 3.0. Any schema error, gate hit, refusal stop or missing
  verdict fails closed to the scripted path with `source=fallback`.
- **Caching:** costs are priced cold, because a 2–3K prefix may sit below the minimum cacheable
  length. Padding a byte-stable prefix above it would cut the interview to ~$0.014–0.024 per answer.

## Cost
Current list prices (re-check before enabling): Opus 5.5 $4 / $20 per million input / output
tokens; Sonnet 5.5 $2 / $10; Haiku 5.5 $0.10 / $0.50; Batch is half. Switching a route to a
cheaper model is the user's decision and **changes safety behaviour as well as cost**, so the
eval's adversarial results sit beside these numbers. All runtime figures are cold calls at low
effort, thinking included. Office Hours can run twice a game day, but live calls are capped per
real day, so more Office Hours do not raise live cost.

| Route (tokens per call: input / visible + thinking; max_tokens) | Opus per call | Opus per unit | Sonnet per unit | Haiku per unit |
|---|---|---|---|---|
| Interview: 3.5K / 150 + 300–800; 1,500 | $0.023–0.033 | $0.18–0.26 per interview (8 answers) | $0.09–0.13 | $0.005–0.007 |
| One-Sentence Startup: 4K / 400 + 300–800; 2,000 | $0.030–0.040 | per kit; ~$0.01/h averaged | $0.015–0.020 | ~$0.001 |
| Mom: 1.9K / 80 + 300–800; 1,500 | $0.015–0.025 | $0.045–0.075 per arc | $0.023–0.038 | ~$0.001–0.002 |
| Discovery: 2K / 40 + 200–500; 800 | $0.013–0.019 | $0.27–0.40 per run (21 calls; 23 reserved) | $0.14–0.20 | $0.007–0.010 |
| Trust & Safety: 1.1–1.5K / 30 + 200–400; 600 | $0.009–0.014 | ~$0.11–0.16 per typical hour | $0.06–0.08 | ~$0.003–0.004 |
| Vibes Night: roast + output check, per kit | $0.018–0.026 | per kit per round | $0.009–0.013 | ~$0.0006 |

**Per-account worst case from the caps** (calls × (input × $4/M + max_tokens × $20/M)):
interview 16 × $0.044 = $0.70; Mom 6 × $0.038 = $0.23; One-Sentence Startup 3 × $0.056 = $0.17;
discovery 23 × $0.024 = $0.55 (21 calls plus 2 refunded retries); Trust & Safety (option B) 48 ×
$0.018 = $0.86. Sum $2.51 (option A $1.70). **The GPU allocation cap, $1.00 per account per day,
is the enforced worst case**: the proxy reserves the worst case before each call (23 calls for a
discovery run) and settles from the usage block. $1.00 buys 2–3 typical live hours. When the meter
is empty the HUD says "Your GPU allocation has been reassigned to a larger startup" and the
free-text boxes become multiple choice.

**Example: 100 players × 5 h a month (16.7 player-hours a day).** Typical hour: one interview,
one Mom arc, the startup kit averaged, Trust & Safety on every free-text call (~11 calls).
Opus, option B: $0.35–0.50/h → **$175–250 a month** (500 player-hours). Opus, option A: $120–170
(it drops almost all of the Trust & Safety share: $0.11–0.16/h × 500 h ≈ $55–80). Sonnet, B:
$87–126. Haiku, B: **$4.30–6.30**. Set a **global cap of $10 a day** (≤ ~$310 a month). At
$0.35–0.50 per player-hour it trips after 20–29 player-hours in a day ($10 ÷ $0.50 = 20;
$10 ÷ $0.35 ≈ 29), above this example's 16.7, so only heavy days hit it, and the rest of that day
falls back to scripted. Invite-only accounts and the per-account and per-IP caps stop one person
from draining it.

**Trust & Safety, the user's call:** option A runs the model classifier only on public surfaces
(billboards, bus wraps, Vibes Night) and saves $55–80 a month in this example ($175–250 becomes
$120–170); option B (default) runs it everywhere as defence in depth. The eval runs the injection,
punch-down, sexual, violent and hateful fixtures through both so the user decides from results.

## Safety and abuse
- **Order of gates:**
  1. A deterministic self-harm and crisis check runs first on every free-text box in the game,
     scripted or live, online or offline, before the budget check, any parser, any classifier or
     any comic fallback. It runs in the client (from wave 2, the first free-text box) and again in
     the proxy. A match always shows a sincere, non-comic line with resources.
  2. Length caps and look-alike Unicode normalisation.
  3. Delimiters and tag-like sequences escaped; player text goes in as a JSON-encoded string field
     marked untrusted.
  4. Emails, phone numbers and addresses removed; deny-lists run.
  5. Echo check, case-insensitive after look-alike normalisation: an output containing any input
     token that is not in the common-word dictionary or the game lexicon is rejected (One-Sentence
     Startup and Mom).
  6. Generation.
  7. The output lint library on every model string.
  8. One Trust & Safety call classifies input and output together; fail closed on a malformed
     verdict or a timeout.
- **Injection cannot win the interview:** server-held state, closed schemas, sim-computed deltas,
  the +5 cap and the fixed −2. Discovery's answer never enters a prompt. Each Vibes Night kit gets
  its own call.
- **Chatbot abuse:** invite-only sign-in, server-issued sessions, 280-character inputs, 8 turns,
  idempotent turns, and per-account and per-IP daily caps leave little chatbot value. Off-topic:
  "I have to go, pickleball."
- **Minors:** accounts without an 18+ attestation get multiple choice only on live routes. The
  offline scripted boxes never leave the device and still run the crisis check.
- **Shared surfaces:** in rooms other players see only the shared view of a kit (3.2). Free-form
  model text is owner-only. Report-and-hide on every shared billboard and bus wrap.
- **Real people:** archetypes only. Deny-lists cover real accelerator partners, investors and their
  catchphrases, at build time and at runtime. Every text uses Ramen, Meander and Moat Labs.
  Composed names are linted whole (3.2).
- **Punching down:** every prompt states the punch-up rule and the game's places rule (no content
  about poverty, drug use, homelessness or encampments; nothing that treats Chinatown or any
  neighbourhood as a source of anything). No line a person speaks uses accent spelling or an ethnic
  caricature. Customer menus list businesses and professions only.
- **Logs and retention:** logs hold counters, flags and a salted hash only; never text or photos.
  Transcripts follow the retention rule above.
- **Multiplayer:** report and hide controls for kits, shared billboards and photo avatars; mute and
  block; the age gate before rooms open to strangers.

## Roadmap
The AI layer's slice of `docs/roadmap.md`, which holds the schedule and the track that owns each
item.
- **Wave 2:** content lint library and the name composer with `banned-pairs.json`; the
  `FreeTextBox` component with the client crisis check and length and deny-list gates; mission 1's
  "What are you building?" with keyword-matched `[ai-02]` kits and name threading; `[bot-tells]`,
  `[robot-goals]`, 300 shared `[robot-barks]`, 100 wet `[neighbourhood-barks]`, `[ad-inventory]`
  for SoMa, `[bounty-board]`; 40–60 hand-written director cards; district content packs for the
  shipped districts. No server.
- **Wave 3:** Ramen Office Hours (scripted bank, demo script, outcome rewards), with mission 4 as
  the first; the mission-3 pivot line; the billboard and bus reveal; shared tagline bank; VC DMs;
  the Dry Powder ticker; FogCast; Meander personalities; the scripted Meander support bot in the
  Ride app behind the crisis check; Plain Words ladder; SF-Bench headlines; 150 more shared people
  lines; Backseat Prompt Rally behind the crisis check; the step-4 district packs.
- **Wave 4:** scripted Mom with tokens that carry into Office Hours; pivot cards and the phone Pivot
  action; Doom Clock headlines; cofounder bank and Hallucination Tour; streak and announcer lines;
  bench cards; Clout feed; customizer enum lists frozen, then the user's offline avatar script; the
  step-5 packs.
- **Wave 5:** scripted Customer Discovery cast deck and its three bounty chains; diligence memo
  bank; the ambient director deck to ~100 cards; invite sign-up accounts with the age attestation
  (Server-Net); the step-6 packs.
- **Wave 6:** the proxy in `server/ai/`, sign-in and server-issued sessions, retention and the
  notice, output lint reuse, GPU allocation meter, Trust & Safety route, the adversarial eval with
  per-category pass rates; then freestyle Office Hours, live One-Sentence Startup with the shared
  view, live Mom. Needs the user's key on the server. The step-7 and step-9a packs.
- **Wave 7:** live Customer Discovery classifier; the step-8 packs.
- **Wave 8:** Vibes Night roasts on the shared view; the step-9b packs.
- **Later:** portrait booth if players ask; the Batch pipeline if volume demands it.

## Cut, and why
- **`[investor-coffee-circuit]`:** deferred; keeping a secret while hinting is a weak model skill.
  Revisit with the secret derived in the sim, as discovery does.
- **Live Meander support bot:** a capable model would understand you, which kills the joke.
- **Live Backseat Prompt Rally:** same reason; the local parser is funnier and free.
- **Runtime `[cofounder]` mode:** the bank is about 90% as funny.
- **Live vision captions for the Clout feed:** screenshot privacy and the nude-sculpture risk.
- **`[runway-dda]` AI analyst:** adaptive difficulty is ordinary sim code.
- **Live diligence memo, launch post and press voices:** a bank filled from enums is as funny.
- **Interview closing-notes call:** a template from the tags is about as good.
- **Runtime billboard generation:** One-Sentence Startup already puts your idea on a billboard.
- **Live bot-tell generation or live robot dialogue:** tells must be deterministic and testable;
  barks are a bank.
- **Accent voice presets:** heritage businesses are the straight men, never the joke.
- Lower-ranked ideas (`[ai-03-copycat-rivals]`, `[showrunner-callbacks]`, `[rival-founder-texts]`,
  `[panel-moderator]`) stay cut.
