> **Design input, not a decision.** Superseded by `docs/ai-layer.md`. Kept for the record.

## The AI layer in one paragraph

Fog City uses Claude in two ways. Most of it happens at build time. Through the Batch API, Claude drafts the bark pools, the fake advertisers, the pivot cards, the pitch-question bank, the diligence-memo phrase bank, the radio ticker and the feed posts. You keep or cut every line. The results ship as committed JSON, and the deterministic sim selects them by id. One full pass costs about $35 on Opus Batch, or $70-105 once you allow for iteration, and needs no server. A short list of runtime moments uses Claude live. Each one is live for a stated reason:
- **[partner-interview] freestyle:** the partner reacts to the exact answer you typed.
- **[ai-02-one-sentence-startup]:** your own idea shows up on a billboard, on a bus, and by name across the game.
- **[explain-to-mom]:** Mom misunderstands *your* words.
- **[customer-discovery]:** a classifier route. Claude decides whether your typed question listens or pitches. The NPC lines stay reviewed text.
- **[ai-08-demo-day]** (multiplayer, later): roasts of kits that other players see.
- **[trust-and-safety]:** checks free text going in and model text coming out.
- **[headshot-booth]** (later): your own avatar comes from an offline run first.

Each live moment has a scripted version that ships first. Players fall back to it whenever live is unavailable. Calls go through a small proxy that holds your own key, and each result enters the sim as a recorded event that carries ids and enums only. A GPU-allocation meter on the phone drains with each live call. When it is empty, the HUD says "Your GPU allocation has been reassigned to a larger startup" [compute-credits], and the free-text boxes become multiple choice.

## Build-time AI (no server, ships as data)

**One shared pipeline**, built first with [ad-inventory]:
- A local script reads `ANTHROPIC_API_KEY` from your shell. It is never run by the test runner.
- Before it submits, it refuses any batch where requests × (counted input × $2/M + max_tokens × $10/M) is above your cap. These are Batch prices.
- Each request sets max_tokens = 4,000 (room for thinking) and effort = medium.
- It writes a keep/cut sheet.
- The committed JSON records the content hash, prompt version, model id and effort.

**Validation (every item):**
- JSON schema, and coverage tests (e.g. every speaker × context × area has at least N lines).
- A deterministic lint for real brands, people, funds and benchmarks, punch-down terms (description fields included), profanity, and font fit (including a max-length `{name}` case). The lint is packaged as a library and reused in the proxy.
- A classifier pass that flags implicit punching down and "fact about a real person or event" before you review it. The default is Opus 5.5 Batch, at $8.40 per pass with 20 drafts per request. Stricter: one draft per request, $64. Haiku Batch: $0.21 grouped or $1.60 per draft. The choice is yours.
- Dedupe by joke shape ("X, but agentic"), not by exact string: ~$5 per pass on Opus Batch ($0.13 on Haiku).
- Presentation text is picked by a keyed hash, never from the sim's RNG stream. The replay header pins the bundle hash.
- **[cofounder] Hallucination Tour:** false facts may only be about objects, infrastructure, geography or invented history. A deny-list covers real people, businesses and named tragedies. Facts stay absurd.
- **[customer-discovery] cast:** persona cards are written in plain English, with no ethnicity or accent. A dialect-spelling lint runs on them. In review, confirm that no character matches a known real regular at that location.

**Standard request profile:** 2.5K input + 1.5K visible + 1.5K thinking (medium effort) = 2.5K × $2/M + 3K × $10/M = **$0.035 on Opus Batch**, or $0.000875 on Haiku Batch (same tokens). The cast deck uses 3K visible tokens: $0.05 / $0.00125. All costs are **per pass**.

| Item | What Claude writes | Drafts (overgen) → requests | Opus Batch (Haiku) |
|---|---|---|---|
| [neighbourhood-barks] | 600 drafts per area × 5 areas, ~1,250 kept: "We're not a café, we're a third place for agents." | 3,000 at 30/req → 100 | $3.50 ($0.09) |
| [ad-inventory] + [startup-pool] + [ai-02] fallback kits + name-part pools, **one pool** | ~300 startups and advertisers (copy at 9/7/5 words, state-slot templates), 200 fallback kits, ~600 pre-cleared name parts. Kept names get a public trademark-register lookup (review time, $0) | 600/10 + 300/4 + 1,200/50 → 159 | $5.57 ($0.14) |
| [partner-interview] multiple-choice bank | ~40 questions per archetype, 3-4 tagged answers each | 180 at 7/req → 26 | $0.91 ($0.02) |
| [robotaxi-personality] | 4 personalities × 30 events; reviews that rate *you*, from driving stats only | 460 at 35/req → 14 | $0.49 ($0.01) |
| [vc-attention-pursuit] | ~400 DMs and term-sheet clauses; no romantic or appearance framing | 1,000 at 35/req → 29 | $1.02 ($0.03) |
| [pivot-button] | ~120 cards; the 5th pivot is always "return to the original idea, now with AI." | 360 at 25/req → 15 | $0.53 ($0.01) |
| [cofounder] bank | ~1,500 confidently wrong takes, plus Hallucination Tour facts | 3,200 at 33/req → 97 | $3.40 ($0.09) |
| [hype-cycle-director] deck | Cards built only from staging primitives (M3; hand-write 40-60 first) | 300 at 10/req → 30 | $1.05 ($0.03) |
| [agi-doom-clock], [leaderboard-hill] | ~200 headlines (no quotes from caricatures); SFBench crates | 750 at 35/req → 22 | $0.77 ($0.02) |
| [customer-discovery] cast deck | Locals, hidden problem tags, 5 clue cards each, answer lines per question type | 18 at 1/req → 18 | $0.90 ($0.02) |
| [diligence-memo] phrase bank | ~30 event types × 10 spins ("74 mph in fog" → "strong bias to action"), ~40 openers and closers by verdict | 680 at 35/req → 20 | $0.70 ($0.02) |
| [podcast-radio] ticker | Invented host archetypes (never real podcasters); sponsor reads from the advertiser pool | 720 at 35/req → 21 | $0.74 ($0.02) |
| [thought-leader-feed] bank | ~200 posts keyed to sim events, an invented feed brand, no caricatured authors | 500 at 25/req → 20 | $0.70 ($0.02) |
| [side-gig-missions] | ~40 premises with mission JSON; you keep and rewrite ~10 | 40 at 2/req → 20 | $0.70 ($0.02) |
| [explain-to-mom] scripted bank | Paraphrase templates ("So it's a {noun} that {verb}s...") | 300 at 35/req → 9 | $0.32 ($0.01) |
| Classifier pass (20 per request) and dedupe | 13,600 drafts | 681 + 136 | $13.40 ($0.34) |

**Total: ~$35 per pass on Opus Batch ($21.30 generation + $8.40 classifier + $5 dedupe), and ~$0.87 on Haiku Batch.** Budget 2-3 passes for iteration: $70-105. The real cost is review time, about 3 h per bark drop.

Interview balance tests:
- Every question path ends.
- A fixed list of 1,000 seeds lands a 30-50% pass rate, so the result is the same in CI every run.
- An all-buzzword strategy and an all-honest strategy each give the intended outcome.
- The fallback tree alone can complete the mission.

## Runtime AI (live, needs a small server)

Every route is cold-priced at low effort (see Cost). The proxy holds session state. The client sends only `{sessionId, turn, text}` or `{sessionId, turn, choiceId}`.

**1. Partner interview, freestyle mode [partner-interview]**
- **Mechanic:** after the timed drive to the parody accelerator at 315 Pennsylvania Ave, an invented panel asks 5-8 bank questions: the Metrics One, the Philosopher ("So, {name}: is it a company, or a feature?") and the Vibes Partner. Answer with multiple choice, or type up to 280 characters. The grader returns `{reaction≤200, convictionDelta −2..+2, tags, followUpId, refusal}`.
- **Scoring (computed in the sim):**
  - If `injection_attempt` is present, the delta is −2 and overrides everything ("That's a prompt injection, not a moat.").
  - Else if `honest_unknown` is present, it is +1.
  - Else if confident `buzzword_soup` is present, it is +1.
  - Else it is clamp(modelDelta, −2, 2).
  - Unknown tags are dropped. Total freestyle gain is capped at +5. Every conflicting combination has a unit test.
- **Reaching 7:** you also need a multiple-choice answer, a Mom token or a discovery insight token. A discovery insight also unlocks a strong answer to "Who wants this?".
- **Outcomes:** ≥7 is a term sheet. 4-6 is "we'll follow up", and they never do. Below 4 is a rejection email built from your tags ("Strong energy. Unclear who wants this."). Arriving late starts conviction below zero.
- **Latency (2-6 s):** a partner writes in a notebook, a "typing..." bubble appears, and the interview clock pauses. The proxy holds the reply until the lint and the gates pass. After 12 s wall-clock, the HUD shows "Interesting. Go on." with delta 0, and any late reply is dropped.
- **Events:** `PitchAnswer{turn, choiceId?}`, then `PitchVerdict{turn, tagIds, delta, followUpId, refusal, source}`. The reaction text goes on the presentation track.
- **Caps:** 2 interviews a day (16 API calls). Each turn is idempotent per (sessionId, turn): a resend returns the first verdict, whatever its nonce.
- **Cost:** $0.023-0.033 per answer, **$0.18-0.26 per interview-hour**.

**2. One-Sentence Startup [ai-02-one-sentence-startup]**
- **Mechanic:** at mission start, before the drive timer runs, the cofounder texts "ok what are we building? one sentence". You type up to 140 characters. Generation runs while you drive. Claude returns name-part ids from the pre-cleared pools (the proxy composes the name, so no free-form brand name exists), plus a tagline, nounPhrase, five slides, billboard slots, a wrap line, palette indices and `refusal` (`real_person | private_person | punching_down | off_topic`). Each refusal maps to a keyword-matched fallback kit. The templates still make the TAM bigger than the world economy and leave the Traction chart without a y-axis.
- **Gates:** the output lint (brand and real-person deny-lists on the tagline and the wrap), the echo check, and the output classifier, which always runs on public surfaces.
- **Payoff:** your idea is on the Embarcadero billboard and on a bus before you reach Dogpatch, and the reveal bumps your VC-attention tier.
- **Name threading:** the presentation layer fills `{name}` and `{nounPhrase}` into existing slot templates, at $0. Examples: VC DMs ("just bumping this re: {name}"), barks near the billboard ("Did you see the {name} bus?"), the interview opener, pivot cards ("{name}, but for dogs") and Mom's opener.
- **Latency (5-20 s):** after a 30 s timeout, a keyword-matched fallback kit is chosen outside the sim, and no failure is shown.
- **Event:** `StartupDefined{kitId, refusal, source}`. The text lives on the presentation track only.
- **Caps:** 3 kits a day, plus per-IP limits.
- **Cost:** $0.030-0.040 per kit, ~$0.01 per player-hour averaged.

**3. Explain It to Your Mom [explain-to-mom]**
- **Scripted first:** Mom texts "I saw your bus! what does {name} actually do?" You pick one of 3 phrasings built from your nounPhrase. Mom answers from the template bank, and the word-list counter sets clarity.
- **Live upgrade:** you type up to 280 characters. She returns a paraphrase of up to 160 characters ("So it's a robot that writes emails... and the robot is also an email?") and a model clarity score of 0-3. Final clarity = min(model clarity, 3 − min(buzzwordCount, 3)), and the code counts the buzzwords. Clarity 3 means her book club wants to invest $200, and you get +1 conviction token, granted by the sim at most once per interview attempt. The echo check applies here too.
- **Latency:** "Mom is typing..." runs on a scripted 8-20 s rhythm that only delays presentation. The wall-clock timeout is 20 s, and then she says "ok honey. call me".
- **Event:** `MomVerdict{attemptId, turn, clarity, buzzwordCount, refusal, source}`. Any refusal suppresses the paraphrase.
- **Caps:** one arc per interview attempt, up to 3 explanations (6 calls a day).
- **Cost:** $0.015-0.025 per reply, $0.045-0.075 per arc.

**4. Customer Discovery [customer-discovery]: a classifier route**
- **Scripted first:** three invented locals: a North Beach baker whose bread the fog ruins, a Marina dog walker with 11 dogs on Chestnut St, and a Washington Square chess player. Each answers 6 questions from a menu of ~12 types ("tell me about the last time...", "would you use an AI that..."). Answers are cast-deck lines, and clues come in a fixed order (clue n needs clue n−1).
- **Live upgrade:** you type the question. Claude classifies it into a `questionType` enum, and for the final insight into a `problemTag` enum. The secret is not in the prompt, so the model does not know which tag is correct. The sim maps questions to clues and compares tags, and `insightDelta` is clamped in the sim. The NPC lines are reviewed clue text, chosen by id.
- **Pitching:** "Sure, honey, sounds great", and a "they loved it!" sticker that counts against you.
- **A match** gives you an interview insight token and the bread-box pivot card, which scores above your AI startup.
- **Latency:** busy animations cover the wait. A 12 s timeout records `AIUnavailable` and the sim refunds the question, at most 2 refunds per run.
- **Events:** `DiscoveryVerdict{npcId, turn, questionType, source}` and `InsightVerdict{npcId, problemTag, source}`.
- **Caps:** 1 run a day (23 API calls).
- **Cost:** $0.27-0.40 per run on Opus, $0.007-0.010 on Haiku. It goes first in the opt-in cheaper-model eval, and the model choice is yours.

**5. Demo Day [ai-08-demo-day] (multiplayer)**
- **Mechanic:** the room server makes one call per kit. Each call gets only that kit's already-gated name and tagline: never the raw sentence, display names or usernames. It writes a roast of up to 20 words. A line that mentions any P-id other than its subject is rejected.
- **Vibes Award:** decided by player vote, with a server keyed-hash tie-break, validated against the roster. The model does not pick it.
- **Latency:** the 30-60 s ceremony covers it.
- **Event:** `DemoDayVerdict{roundId, vibesWinnerId, lineIds[], source}`.
- **Fallback:** template roasts, chosen by the room server, never drawn from the sim RNG.
- **Cost:** $0.018-0.026 per kit per round, including the output check.

The [diligence-memo] is now built at build time. The presentation layer composes it by keyed hash from the sim's verdict and its top 2-3 events. It has no route and no `MemoText` event.

## Make your character look like you

**Your avatar (the actual ask):** a local script sends 2-3 of your own photos with your key and writes `appearance.json`. You may also opt into a coarse height and build suggestion. It never commits or keeps the photos. Run it when the M3 customizer's enum lists are frozen, because before then there are no ids to map to. A run costs about $0.04-0.05 (3 photos × $0.012-0.018). Appearance is visual only: colliders and physics capsules are fixed sizes in `src/sim`.

**[headshot-booth], runtime, moved to Later. That is your choice to confirm.** Build it only if other players ask for it. An unnamed booth: "Founder Headshots: free, takes 7% equity".
1. Gate: the server checks the age attestation from invite sign-up and records a server-side "This is me" attestation.
2. Upload: the browser downsamples to 768×768. The proxy reads the header dimensions (≤768×768, ≤1 MB) before a full decode, decodes, and re-encodes the bare pixels to JPEG. That strips EXIF and GPS even from a modified client. Anything else is rejected.
3. The fixed `/appearance` route returns enums only: hairStyle (~40), hairLength, hairColor (palette index), facialHair, eyebrows, glasses, outfitSuggestion and status (`ok | no_single_face | unusable`). There is no age, gender, ethnicity or free-text field.
4. Skin tone and hairTexture stay manual, and face shape is dropped. Body proportions are sliders.
5. The controls animate to the new values, with Undo. Joke lines key only on outfit enums ("Fleece vest detected. Pre-money valuation +$4M."), never on hair, face, glasses or body. A flower hit puts flowers on your own hairstyle. Avatars made from photos can be reported in rooms.
6. **Caps:** 3 photos a day, 10 per lifetime, counted in Compute Credits. Worst case: 1.6K × $4/M + 1,000 × $20/M = $0.026 per photo, $0.26 per lifetime.

**Privacy:** the photo is processed and discarded, in memory only. On every hop, the body buffer is set above 1.1 MB, or the body is streamed to memory, so nginx-style spooling never writes it to a temp file. Body capture is off in platform request logs, APM and crash reporting. Core dumps are off (`ulimit -c 0`), and SDK debug logging is off. A test runs the route and asserts that no new temp files appear and that no body bytes reach the logs. The consent text matches Anthropic's API retention terms and claims no more than that.

## Architecture rules

- **Proxy:**
  - One fixed endpoint per feature.
  - Prompts are built from server-side templates.
  - The proxy keeps state per sessionId: the transcript, question id, NPC id, turn and attempt.
  - The client sends `{sessionId, turn, text}` or `{sessionId, turn, choiceId}`. The schema is closed (`additionalProperties:false`). Any extra field, string state or history supplied by the client gets a 400, and no model call is made. A test proves this.
- **Key:** your personal Anthropic key is a proxy secret. It never reaches the browser or CI, and no company key is ever used. Set a spend limit on your Anthropic Console account.
- **Sim boundary:**
  - `src/sim` never calls the API or reads model text.
  - Sim event types allow ids, enums and ints only, with no string fields. A lint on `src/sim` checks this, and a text-perturbation state-hash test checks every feature that carries text.
  - Display text is on a presentation track keyed by eventId. Replays and the room server send it only to the owning client, except shared billboards and Demo Day lines.
  - Fallback keyword matching runs outside the sim and records only a kitId. Timeouts and fallbacks are events (`AIUnavailable{feature, reason}`).
- **One outcome per turn:**
  - Each (feature, sessionId, turn) resolves once: the first terminal event wins, and later replies are dropped and never shown.
  - In single-player, the client recorder decides. In rooms, the room server decides and sets the apply tick to server tick + input delay.
  - Timeouts are wall-clock, outside the sim, and always recorded (refunds included).
  - The sim asserts at most one terminal event per turn. A test feeds both orders.
- **Tests never reach the API:**
  - The global setup deletes `ANTHROPIC_API_KEY` and blocks api.anthropic.com (nock `disableNetConnect` or an undici MockAgent), and fails the test on any attempt.
  - The client is built by an injectable factory that throws in test mode unless it receives the fixture replayer.
  - The eval script needs `--live` and sits outside the test glob.
- **Fixtures:**
  - Recorded cases: great answer, buzzword soup, off-topic, injection, tag breakout, classifier-directed injection, punching down, timeout, refusal, and one per deny-list category (real person, partner catchphrase, brand, punch-down, slur, PII). Each must yield the scripted outcome.
  - A contract test checks that fixtures validate against the proxy's schemas, and consistency fixtures check the delta bands.
  - The opt-in eval replays 20-100 cases per model, adversarial cases included, and records the pass result next to the prompt version and model id.
  - The proxy refuses to load a (route, model, promptVersion) that has no recorded pass.
- **Caching:** costs are priced cold, because a 2-3K prefix may sit below the minimum cacheable length. Padding a byte-stable prefix above that length would cut the interview to $0.014-0.024 per answer, with a 1.25x write on the first call.
- **Structured outputs:** bounded integers, enums and short strings only. Per-request ids are validated on the server.
- **Refusals:** `off_topic`: the partner checks his phone, and the turn scores 0. `real_person`: "I'm a composite." `punching_down`: the scene ends on a scripted line. Any schema error, gate hit or missing verdict fails closed to the scripted path with `source=fallback`.

## Cost

Opus 5.5 is the default on every route. Switching a route to a cheaper model is your decision, and **it changes safety behaviour as well as cost**, so the eval's adversarial results sit beside these numbers. All runtime figures are cold calls at low effort. The Sonnet and Haiku columns assume the same tokens, thinking included. Without thinking, output would fall by 60-85% and they would cost less again.

| Route (tokens per call: input / visible + thinking; max_tokens) | Opus per call | Opus per unit | Sonnet | Haiku |
|---|---|---|---|---|
| Interview: 3.5K / 150 + 300-800; 1,500 | $0.023-0.033 | $0.18-0.26 per interview (8 answers) | $0.09-0.13 | $0.005-0.007 |
| ai-02: 4K / 400 + 300-800; 2,000 | $0.030-0.040 | per kit; ~$0.01/h averaged | $0.015-0.020 | ~$0.001 |
| Mom: 1.9K / 80 + 300-800; 1,500 | $0.015-0.025 | $0.045-0.075 per arc | $0.023-0.038 | ~$0.001-0.002 |
| Discovery: 2K / 40 + 200-500; 800 | $0.013-0.019 | $0.27-0.40 per run (21 calls) | $0.14-0.20 | $0.007-0.010 |
| Trust & Safety: 1.1-1.5K / 30 + 200-400; 600 | $0.009-0.014 | ~$0.11-0.16 per typical hour | $0.06-0.08 | ~$0.003-0.004 |
| Demo Day: roast plus output check, per kit | $0.018-0.026 | per kit per round | $0.009-0.013 | ~$0.0006 |
| Headshot (Later): 1.6K incl. ~786 image tokens / 80 + 200-500; 1,000 | $0.012-0.018 | per photo | $0.006-0.009 | ~$0.0004 |
| Compute Credits | $0 | | | |

**Per-account worst case, from the route caps** (calls × (input × $4/M + max_tokens × $20/M)):

| Route | Calls/day | Worst per call | Per day |
|---|---|---|---|
| Interview | 16 | $0.044 | $0.70 |
| Mom | 6 | $0.038 | $0.23 |
| ai-02 | 3 | $0.056 | $0.17 |
| Discovery (21 + 2 refunds) | 23 | $0.024 | $0.55 |
| Trust & Safety (Option B) | 48 | $0.018 | $0.86 |
| **Sum** | | | **$2.51** (Option A: $1.70) |

**The Compute Credits per-account cap, $1.00 a day, is the enforced worst case.** The worst-case reservation guarantees it holds. $1.00 buys 2-3 typical live hours. Per-account caps may add up to more than the global cap; the global cap is a separate fuse.

**Example: 100 players × 5 h = 500 player-hours a month (16.7 a day).** A typical hour is one interview, one Mom arc, ai-02 averaged, and Trust & Safety on every free-text call (~11 calls).

| | Rate | Per month |
|---|---|---|
| Opus, typical, Trust & Safety Option B | $0.35-0.50/h | **$175-250** |
| Opus, typical, Option A | $0.24-0.35/h | $120-175 |
| Opus, heavy typical (+1 discovery run, +21 Trust & Safety calls) | $0.81-1.18/h | $405-590 uncapped |
| Sonnet, typical, B | $0.17-0.25/h | $87-126 |
| Haiku, typical, B | $0.009-0.013/h | **$4.30-6.30** |
| Cap-bound worst case | $1.00 per account per day | global cap binds |

**Global cap:** expected daily player-hours × the typical rate. For this example that is 16.7 × $0.35-0.50 = $5.80-8.40 a day, so set **$10 a day** (at most ~$310 a month) and accept that it trips first on peak days. In a heavy month, 16.7 h costs $13.50-19.70 a day. The cap then trips after 8.5-12.3 player-hours, and 26-49% of those hours fall back to the scripted versions.

**Trust & Safety, your call:**
- **Option A:** the model classifier runs only on public surfaces (billboards, bus wraps, Demo Day). The private routes rely on the deterministic gates, their own `refusal` field and the output lint. Saves $0.11-0.16/h ($55-80 a month here).
- **Option B, the default:** the classifier runs everywhere. It is defence in depth, because a separate classifier is harder for the same injected text to subvert.
- The eval runs the injection and punch-down fixtures through both, so you decide from results.

## Safety and abuse

- **Order of gates [trust-and-safety]:**
  1. A deterministic self-harm and crisis pattern check runs before the budget check, any classifier or any comic fallback, in the proxy and in the client. A match always shows a sincere, non-comic line with resources.
  2. Length caps and look-alike Unicode normalisation.
  3. Delimiter and tag-like sequences are escaped. Player text goes in as a JSON-encoded string field marked untrusted.
  4. Emails, phones and addresses are removed. Deny-lists run.
  5. **Echo check:** any output that contains a capitalised input token not found in the common-word dictionary or the game lexicon is rejected. This covers ai-02 and Mom.
  6. Generation.
  7. The output lint library runs on every model string.
  8. One Trust & Safety call classifies the input and the output together: enum schema, the same untrusted framing, fail closed on a malformed verdict or a timeout.
- **Injection:** the server holds state, closed schemas, the sim-computed deltas, the +5 cap and the fixed −2, so injection cannot win the interview. Discovery's secret never enters a prompt. Each Demo Day kit gets its own call.
- **Chatbot abuse:** 280-character inputs, 8 turns, idempotent turns and daily caps leave little chatbot value. Off-topic requests get "I have to go, pickleball."
- **Cost:**
  - Compute Credits reserves (input including image tokens) × $4/M × (1.25 on a cache write, 2 on a 1-hour cache write) + max_tokens × $20/M, and settles from the usage block.
  - Caps count API calls, not questions. A call that times out is aborted and settled at the reserved amount unless late usage arrives.
  - When credits run out, the free-text boxes are hidden and only multiple choice is offered.
  - Requests carry nonces, and sign-in is invite-only.
  - The phone meter makes the budget visible. In-game fundraising gives flavour only ("Your seed round bought you priority access to the waitlist") and never raises the real caps.
- **Real people:** archetypes only. The deny-lists cover real partner and investor names and catchphrases, at build time and at runtime. Every text uses the parody accelerator name. Robotaxis use an invented brand and silhouette.
- **Punching down:** every prompt states the punch-up rule. No bark speaker or subject is unhoused. Customer menus list businesses and professions only.
- **Logs:** counters, flags and a salted hash only, never text or photos.
- **Multiplayer:** report and hide controls for kits and photo avatars, mute and block, and an age policy before rooms open to strangers.

## Roadmap

- **M0, downtown drivable:** the test-network guard. The build pipeline via [ad-inventory] and the merged pool, name-part pools included. Downtown barks [neighbourhood-barks], [robotaxi-personality], [agi-doom-clock], VC tiers 1-3 [vc-attention-pursuit], and a conventional director with a hand-written deck. No server.
- **M1, more neighbourhoods:** one bark batch per area; [leaderboard-hill]; the [cofounder] bank and Hallucination Tour; VC tiers 4-5; the mission validator and completability bot; [side-gig-missions] drafting; the [podcast-radio] ticker; [thought-leader-feed]; the [diligence-memo] bank; a draft of the discovery cast deck.
- **M2, YC pitch and VC attention:**
  1. The scripted interview, with balance tests.
  2. [pivot-button].
  3. Scripted [explain-to-mom].
  4. The proxy, the output lint library, [compute-credits] with its meter, [trust-and-safety], and the adversarial eval.
  5. Freestyle [partner-interview].
  6. [ai-02-one-sentence-startup] with name threading.
  7. Live Mom.
- **M3, art pass and customizer:** the manual customizer, and your offline avatar run once its enums freeze. Scripted [customer-discovery], then the live classifier. The Claude-written [hype-cycle-director] deck.
- **Later, multiplayer:** [ai-08-demo-day], room budgets, report and hide controls, an age policy, and the runtime [headshot-booth] if players ask for it.

## Cut, and why

**Blocked:** none.

**Cut or deferred:**
- **[investor-coffee-circuit]:** deferred. The model would set `softCircle`, and keeping a secret while hinting is a weak LLM skill. Revisit with `softCircle` derived in the sim, the way discovery now works.
- **[robotaxi-support], live variant:** a capable model would understand you, which kills the joke. Ship the scripted keyword bot.
- **[cofounder], runtime mode:** the bank is about 90% as funny.
- **[thought-leader-feed], option B (live vision captions):** adds a screenshot-privacy surface and the nude-sculpture risk. Option A ships as a build-time bank.
- **[runway-dda], AI analyst:** adaptive difficulty is conventional sim code, and a spreadsheet does the analyst's job.
- **[diligence-memo], live memo and the launch post and press article voices:** a bank filled from enums is as funny, and three write-ups an hour cause reading fatigue.
- **[partner-interview] closing-notes call:** a template built from the tags is about as good.
- **[ad-inventory] vision QA pass:** duplicates the font-fit test.
- **Runtime billboard generation:** cut on design grounds. ai-02 already puts your own idea on a billboard, and the pool covers the rest.
- **Lower-ranked ideas:** [ai-03-copycat-rivals], [showrunner-callbacks], [rival-founder-texts] and [panel-moderator], all scored below 5.2. **[podcast-radio] is restored** as a text ticker. Audio is optional later, either recorded by you or through a TTS provider you choose.