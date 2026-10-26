# Audio stream status

Stream id `audio` (handoff §8). Branch `work/audio/soundtrack-voices`, cut from
`origin/integrate/wave2` at `ff7db5b`. Updated 2026-10-23.

## Summary

| Area | State |
|---|---|
| Soundtrack | **Working.** Five CC0 tracks (OpenGameArt), one per context: driving, on foot, timed mission, combat, menu. Streamed through `<audio>` (never preloaded), crossfaded, each resumes where it left off. Ogg Opus 80 kb/s + MP3 96 kb/s fallback, -18 LUFS. 10 files, 12.8 MB. |
| Effects | **Working**, now including the splash (where a water drop lands, distance-attenuated and panned, at most 4/s) and the Moat Labs jingle (hummed by a nearby bad robot showing the humJingle tell, every 25 s, as `content/bot-tells.json` specifies). Spray, rust-creak and melt-fizz are kept; melt-fizz now starts at the slump and plays once per robot. |
| Mixer and settings | **Working.** Web Audio master, music, effects and voice buses, each with volume and mute; music (-9 dB) and effects (-3 dB) duck under a voice line; at most 8 effect voices (per-sound caps). User-gesture unlock kept. Sliders, mutes and a subtitles toggle in the pause screen and the phone's Settings app, persisted in `localStorage` (`fogcity.audio.v1`). |
| Mission voices | **Pipeline complete; generation held (licence).** Manifest of all 120 mission lines (8,304 characters) with mission, speaker, line id, text, subtitle cues and file. Voice queue with priority, interruption, retry, pause, reset/reload and a subtitle fallback. Every line currently plays as timed subtitles. |
| Static build | **Fixed.** `scripts/build-web.ts` never shipped `public/audio/`, so even the existing effects were silent in the hosted build. It now copies audio as plain `.ogg/.mp3/.json` files. |

## Follow-up: car radio and horns (`work/audio/radio-horn`, stacked on #28)

Owner feedback, relayed by the coordinator: "as soon as you get in a car, there should be music"
and "the horn button doesn't work".

- **Car radio.** In a car the music is a station:
  - Four invented stations (Runway FM 88.5, Series A 101.3, Pivot 94.9 and Burn Rate 107.7) over the CC0 tracks, plus Off.
  - M tunes forward and Shift+M back. A station card shows on getting in or tuning.
  - A station picker is in settings, and the station persists.
  - On foot, the music follows combat, a timed mission step, or the on-foot track.
- **Horns** (synthesized in `assets/audio/generate.py`):
  - One horn path: #31's `hornBlasts(frame, state)` (H, pad L3 or the touch button, any player) feeds `audio.playHorn(blast)`. That plays the synthesized dual-tone sample through the effects bus (volume and mute apply, one unlock): about 0.42 s in a car, or an octave up for the pocket air horn on foot. #31's separate `HornVoice` synth and its second AudioContext are removed.
  - A robotaxi in agent mode `honk` plays an original, polite electronic chirp, distance-attenuated, at most once per car per 4 s.
  - `tests/e2e/player-feel.spec.ts` now checks the director's horn counter instead of counting `OscillatorNode.start` calls, as agreed with the Player-feel stream.

## Music consistency (owner: "the music isn't really consistent"; in #36)

Causes found in the live build (`86dfb90`):
1. Every menu and mission dialog switched to the menu track and back.
2. Combat cut in at once, even in a car, and bounced out about 10 s later.
3. Timed mission steps overrode the driving music.
4. Nothing set a minimum time between switches.
5. The crossfade faded the old stream before the new one had buffered (an audible dip or gap).
6. Nothing recovered a stalled or paused stream.

Fixes:
- Menus duck instead of switching.
- In a car the radio always plays.
- A 6 s minimum dwell, a 2 s settle (combat 0.4 s) and a 12 s combat hold.
- 3 s crossfades that start only once the new stream plays.
- Resume where each track left off.
- A stall watchdog, and the AudioContext resumes when the tab is shown again.

`tests/audio/music-player.test.ts` checks the switch rate and gaps, and catches the old behaviour.

## Follow-up: the player's inner voice (`work/audio/inner-voice`, stacked on the radio PR)

Owner feedback: "the voice should talk just like in GTA … it kind of just tells you what to do".

- `src/audio/inner-voice.ts` builds a finite bank of 171 lines (6,888 characters) from the mission
  data. The lines cover:
  - going to a place, rushed when the timer is 300 s or less;
  - the start place of a mission;
  - reminders while still far away;
  - each objective kind;
  - a refill switching between fresh and salt water (the blaster never runs dry);
  - a fresh "bad" scan ("That bot's acting sketchy.");
  - a win or a retry.
- Variants rotate least-recently-used, and each situation has a cooldown, with a 6 s gap between
  asides. It speaks at the lowest priority, behind the cofounder's lines.
- The player is cast as Chris, a premade voice distinct from the cofounder.
- Subtitles only until the ElevenLabs tier allows generation. The manifest already lists every
  line: 291 in total, 15,192 characters.

## PRs (drafts; GitHub Actions billing-blocked again since ~03:12 UTC 2026-10-24: local evidence on each)

| PR | Branch | Contents | Stacked on |
|---|---|---|---|
| #28 | soundtrack-voices | Soundtrack, voice pipeline, mixer, settings, static build audio | merged (batch #42) |
| #36 | radio-horn | Car radio, one horn path, music consistency fix | folded into release #67 (closed) |
| #37 | inner-voice | GTA-style inner voice, `FOGCITY_ELEVENLABS_API_KEY` | folded into release #67 (closed) |
| #63 | credits | Credits panel (OSM/ODbL, DataSF, CC0 music, Rocketbox, Lucide, Poly Haven) | merged |
| #65 | sfx-vehicles | Live car engine, road and tyres; impacts; doors; footsteps | #37 |
| #69 | sfx-robots-ui | Robot servos, beeps and audio tells; UI and mission cues; firmware-leak fix | #65 |
| #70 | sfx-ambience | City ambience: traffic, crowd, wind, rain, foghorns, gulls | #69 |
| #73 | sfx-impacts | Collision sounds from `ext.impacts.events` (Impacts #50/#57/#62): crunch, clank, thud, scrape, hydrant hiss | #70 |

Open follow-ups:
- Footstep surfaces: wait for World detail's land-cover lookup (#54).
- Voices: generation is held until an ElevenLabs key on a paid tier is provided.

## ElevenLabs: why voices are held

`GET /v1/user/subscription` on 2026-10-23 (only tier and counts logged): **tier free**, 5,975 of
10,000 characters used. ElevenLabs' help centre says the free plan has **no commercial licence**
and may not be used for any commercial purpose (attribution does not cure it); every paid plan
includes one. Following the stream brief ("if the tier doesn't allow commercial use, stop voice
generation and report it"), `scripts/audio/generate-voices.ts --generate` checked the tier and
stopped. Nothing was generated and no characters were spent. ElevenLabs Music was not used for the
same reason; the soundtrack is CC0 instead. The free tier's remaining budget (25 % of 4,025 =
1,006 characters) could not have covered the 8,304 characters anyway.

**Owner action to voice the game:** move the ElevenLabs account to any paid tier, then run
`node scripts/audio/generate-voices.ts --generate` with `ELEVENLABS_API_KEY` set (Doppler
`daringly`). It spends at most min(25 % of remaining, 100,000) characters, caches by
sha256(text, voice, settings), transcodes to mono Ogg Opus 40 kb/s (about 120 files, roughly
1.5 MB), and rewrites the manifest with measured durations. Commit `public/audio/voice/`.

Casting (`assets/audio/voices.json`, premade ElevenLabs voices only): cofounder Laura, dispatcher
River, desk host Jessica, Slotsworth Daniel, the Philosopher Bill, the Metrics One Adam, the Vibes
Partner Charlie, Front Desk Matilda; the player is silent. `ELEVENLABS_VOICE_ID` is set in the
environment but is not in the account's voice list and its identity is unverified (it could be a
personal clone, and the likeness request was dropped), so it is not cast.

## Hook-ups outside this stream's directories

Listed in the PR body too:

- `src/main.ts` (Lane R): the old `GameAudio` construction is replaced by
  `createGameAudioDirector({host:container,missions:MISSIONS})`, created just before `mountGameUI`.
  `audioSettings:doc=>audio.mountSettings(doc)` is passed to `mountGameUI`; `audio.restore(curr)` is
  called after a save restore; `audio.answered(questionId,choiceId)` is called in the dialogue answer
  callback; and the per-frame `audio.update(...)` call is updated. The unlock listeners are unchanged.
- `scripts/build-web.ts` (Lane R): copy `public/audio/**/*.{ogg,mp3,json}` into the build, allow
  `audio/` in the out-directory safety check, and add a music line to `third-party-notices.txt`.
- `src/ui/mount.ts` and `src/ui/types.ts`: an optional `audioSettings` mount option, rendered in the
  pause screen and the Settings phone app. Everything else is new files (`src/ui/audio-settings.ts`,
  `src/ui/subtitles.ts`).
- `.gitignore`: `assets/audio/.cache/` (the music source download cache).

No contract or `SIM_VERSION` change. Audio only reads sim state after each step (mission progress,
combat events and projectiles, runtime actors), and nothing flows back.

## Tests

- `tests/audio/*.test.ts` (unit, in `pnpm test`):
  - voice queue: priority, interruption, retry, timeout, stall, pause, reset, staleness, overflow and the text fallback;
  - mission voice on the real missions: entry, pass-through steps, prompts and replies, retry, reload, completion, and the stale-text guard;
  - prefs, bus gains and ducking, the music context hysteresis, and effect cues;
  - provenance: CC0 records and README per file, Ogg Opus headers and length, the MP3 decode and level, the manifest in sync with content and casting, hash naming, the hold recorded, and the budget and tier gates;
  - secrets: the key pattern, `xi-api-key`, the API host and the live key value in the checkout and in a real static build.
- `tests/audio/audio.spec.ts` (browser, `pnpm exec playwright test --config tests/audio/browser.config.ts`). In SF with real keyboard and pointer input, it checks:
  - subtitles before any gesture;
  - unlock on Escape, and the menu track streaming;
  - slider, mute and subtitle settings applying live and persisting across a reload;
  - driving to the Ferry Building plaza to advance Hot Desk;
  - a voiced line (routed test tone) ducking the music;
  - a missing voice file retrying and then showing its text with subtitles off;
  - spraying on foot giving combat music and the spray loop.

  It passed locally (1.2 min). CI runs only `tests/e2e` (Harness), so this spec is not yet in CI; Harness may want to add it.

## Needs

- Owner: a paid ElevenLabs tier if voiced dialogue is wanted (see above).
- Lane R: review the `main.ts` and `build-web.ts` hook-ups.
- Harness: optionally run `tests/audio/browser.config.ts` in CI.

## SFX 4: collision sounds (`work/audio/sfx-impacts`, stacked on #70)

Built against the Impacts stream's published shape (`ext.impacts.events`, last 24, durable `id`;
`kind` car-car / car-taxi / taxi-car / taxi-taxi / car-robot / taxi-robot / robot-robot / car-prop;
`dv`; `fell` / `disabled` on robots, `broke` on props). Read defensively: silent until #50 lands.

- `src/audio/impact-sound.ts` (pure): dedupe by id, nothing replays at load or restore; tier by
  `dv` (bump < 3, crunch 3-8, smash > 8); timbre from the surface after the dash (metal, robot,
  wood for `prop:tree:*`, post otherwise); same pair again within 0.5 s scrapes; heard within 90 m,
  at most 3 per frame (the player's own first); a hydrant heard breaking hisses while
  `ext.impacts.props` holds it.
- `src/audio/impact-synth.ts`: procedural (thump, panel noise, glass pings on a smash; robot
  clank, fall clatter, power-down; wood crack and splinters; ringing pole; scrape; hiss).
- The car's generic hit one-shot stands down when the player's own car is in an impact event.
- Evidence: unit `tests/audio/impact-sound.test.ts` (8); browser: every variant rendered through
  an OfflineAudioContext is audible and bounded. In a scratch merge with #62, Impacts' own
  `tests/e2e/impacts.spec.ts` crash played `impact-metal`, `impact-scrape`, `impact-wood` and the
  robotaxi horn (all 3 tests green).

## After release #67 (`integrate/wave2` @ `59e5a7b`, 2026-10-24)

- #36 and #37 shipped inside #67. One horn path survived (`HornVoice` gone; `main.ts` calls
  `audio.playHorn`). #67 also improved the robotaxi honk cooldown and added `tests/audio/director.test.ts`.
- #67 added robotaxi rides (`player.ride`, mode `vehicle`, own car parked). Fixed in #65: the engine
  follows the ridden taxi from the back seat, and the parked car's hits no longer play. Fixed in #73:
  the ridden taxi is the player's own body for collision sounds.
- #65, #69, #70 and #73 have `59e5a7b` merged in. Typecheck and vitest are green on each;
  `player-feel.spec.ts` (horn) passes.
- **Blocker outside audio:** `tests/audio/audio.spec.ts` "real controls…" fails on the bare
  `59e5a7b` base too. The sim runs at 3.0 ticks/s under SwiftShader, against 16.3 before #67;
  frames are GPU-bound, with shader programs being recompiled during play (`getProgramInfoLog`,
  935 ms per 8 s). Reported to the coordinator for Lane R. The spec is unchanged.
