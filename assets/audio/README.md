# Fog City sound effects (synthesised)

`generate.py` builds every sound from oscillators, filtered noise and small physical models
(numpy), then encodes it with ffmpeg. Nothing is sampled or recorded, so there is no
licensing question, and the seeds are fixed with ffmpeg in bit-exact mode, so a rebuild writes
byte-identical files. The script pins numpy's BLAS to one thread before importing it: the
jingle's reverb is an `np.convolve`, and multithreaded OpenBLAS made it take minutes on a busy
machine and its rounding depend on the core count. A full run takes about 3 s.

```sh
python3 assets/audio/generate.py              # every sound + public/audio/manifest.json
python3 assets/audio/generate.py splash       # one sound
pnpm vitest run tests/assets/audio.test.ts    # decode, length, level, loop seam, jingle notes
```

`assets/blender/build.sh` runs it too. Needs `python3` with numpy and `ffmpeg` built with
libvorbis and libmp3lame.

## Files and how to play them

Each sound ships twice in `public/audio/`: **`.ogg` (Vorbis, primary)** and `.mp3` (fallback
for a browser without Vorbis). Mono, 44.1 kHz. `public/audio/manifest.json` lists every
sound with its files, length, loop flag and use; the UI-Audio track can load from it.

| Sound | Length | Loop | Plays when |
|---|---|---|---|
| `spray` | 1.00 s | yes | while the blaster fires. Loop the `.ogg`: Vorbis is gapless, so the loop has no gap. An MP3 decodes with encoder delay and padding (about 50 ms of silence), so do not loop the `.mp3` |
| `splash` | 0.70 s | no | a water particle lands on a robot, the pavement or a puddle (rate-limit to a few per second) |
| `rust-creak` | 1.30 s | no | a robot's rust passes 0.5 (it slows), and again at `seized` |
| `melt-fizz` | 2.20 s | no | `slumping` starts; it runs through the slump into the heap |
| `moat-jingle` | 1.70 s | no | a bad robot hums it (tell, subtlety 3); Moat Labs vans and ads |
| `horn` | 0.50 s | yes | every horn blast (H, pad L3 or the touch button; `src/audio/horn.ts`): looped for 0.42 s with a 12 ms attack and 60 ms release, or an octave up for 0.26 s for the pocket air horn on foot, heard from any player within 60 m. Loop the `.ogg` |
| `robotaxi-horn` | 0.62 s | no | a robotaxi honks (agent mode `honk`, a player blocking it): at most once per car per 4 s, distance-attenuated |
| `door-open` | 0.45 s | no | getting into or out of a car (`src/audio/vehicle-sound.ts` doorOneShots) |
| `door-close` | 0.50 s | no | the door shutting, 0.55 to 0.75 s after it opens |
| `impact` | 0.60 s | no | the player's car hitting something (a new `car.hits`): level and pitch follow `impactSpeed`; also a landing after a jump, lower |
| `step-1`…`step-4` | 0.18 s | no | footsteps on foot, cycled without repeats, paced by walk (0.52 s), jog (0.36 s) or sprint (0.28 s) |

## How each one is made

- **spray**: band-passed noise (2.6 kHz) plus a high hiss and a low rumble, droplet patter from
  short resonant blips, and a slow pressure flutter (4 Hz and 9 Hz, periodic in the loop). The
  last 0.2 s is crossfaded (equal power) onto the start, so the wrap is seamless.
- **splash**: a falling-pitch thump, a fast-decaying broadband slap, then 26 droplet "plinks"
  whose pitch rises as each bubble collapses.
- **rust-creak**: stick-slip friction. An irregular pulse train whose rate rises into a squeal
  and falls back to a groan excites four inharmonic metal modes (410, 1135, 2210, 3570 Hz).
- **melt-fizz**: a high hiss that fades, dense random crackle that thins out, and low bubbles
  gliding upward.
- **horn**: two reed-like tones a major third apart (400 and 500 Hz, the usual dual-trumpet car
  horn interval), eight harmonics each with odd ones stronger, soft-clipped and shaped by a fixed
  brassy EQ. Every component completes whole cycles in 0.5 s, so the loop is seamless and a blast of any length has no click.
- **robotaxi-horn**: an original, deliberately polite double chirp: two short soft-square tones
  rising a fifth (C6 then G6), each with a tiny pitch blip on its attack. It honks like it is asking
  permission; it copies no real vehicle's horn.
- **door-open**: the latch's double click (band-passed noise bursts at 2.4 and 1.7 kHz), then
  a short hinge glide.
- **door-close**: a damped 95 Hz thunk with low body noise and a latch catch on top.
- **impact**: a low 70 Hz body thump, a broadband crunch and three inharmonic metal partials.
- **step-1…4**: a soft heel thud (80 to 110 Hz) and a gritty scuff (band-passed noise),
  with different seeds per variant.
- **The car's live sound** (`src/audio/vehicle-synth.ts`) has no file at all. It is synthesised
  in Web Audio each frame from the car's state:
  - a four-cylinder engine: RPM from speed through five gears (850 rpm idle, 5800 rpm redline, a drop on each upshift). The gearbox remembers its gear (`EngineClock` in `src/audio/vehicle-sound.ts`): a shift needs a margin, so a speed hovering at a shift point does not hunt; each gear is held at least 0.65 s; an upshift cuts the power for about 0.16 s; the throttle rises faster (0.14 s) than it falls (0.32 s). Firing pulses (two per crank turn) and a half-order through a soft clip and a low-pass that opens with RPM and throttle, a body sine, a half-order lope for an uneven idle and a little exhaust breath under throttle;
  - road roar: looped noise through a low-pass that opens with speed, silent in the air;
  - tyre squeal: noise through a narrow 1.9 kHz band-pass, driven by lateral slip, lost grip or hard braking at speed.
- **moat-jingle**: four FM-bell notes, **A4 D5 E5 B4** (onsets 0, 0.17, 0.34, 0.56 s), the
  last held over a soft B/F# pad and a short room reverb. It ends unresolved on purpose ("Every
  robot. Eventually."). The interval pattern (up a fourth, up a tone, down a fifth) was chosen
  to stay clear of well-known sound marks (the three-note broadcast chime G-E-C, the
  five-note processor "bong" and similar); the user signs it off before release.

The test (`tests/assets/audio.test.ts`) decodes both formats with real Vorbis and MPEG decoders
(`@wasm-audio-decoders/ogg-vorbis`, `mpg123-decoder`; wasm, no network), and checks the length,
peak (audible, not clipped), the spray seam and the jingle's four notes in order.

## Procedural effects (no files)

Synthesised live in Web Audio, so there is no licence question and nothing to download. All of them
go through the effects bus.

- **Car** (`src/audio/vehicle-synth.ts`): the engine, road roar and tyre squeal, described above.
- **Robots** (`src/audio/robot-sound.ts`, `synth-sfx.ts`):
  - the nearest three active robots' servo whirr, with a timbre per model, rising with speed;
  - each robot's beep pattern on its own fixed rhythm;
  - the `tryCarDoors` tell's "pairing..." chime (only while that tell shows).

  Nothing reads firmware. A bad robot is audible only through its designed audio tells (this
  chime, and `moat-jingle` for `humJingle`).
- **UI and game** (`synth-sfx.ts`): button clicks, the phone opening, mission start (C-E-G) and
  complete (an arpeggio plus a chord), money in, and the scanner's verdict.
- **City ambience** (`src/audio/ambience.ts`, `ambience-synth.ts`):
  - **Layers:**
    - traffic rumble from vehicles within 90 m;
    - a crowd murmur from people within 30 m, plus a daytime baseline in busy districts;
    - wind, stronger on the waterfront and in fog;
    - rain from the sim's weather, softer under shelter.
  - **Car shell:** inside a car the outside is about 7 dB quieter.
  - **Events:**
    - foghorns across the bay in fog, every 40 to 75 s, louder on the waterfront;
    - gulls on the waterfront by day, every 7 to 22 s.
  - **Districts** come from the `content/districts.json` polygons, and levels change smoothly.

# Music (CC0 from OpenGameArt, and original radio tracks)

`node scripts/audio/build-music.ts` builds `public/audio/music/` from the sources in
[`music-sources.json`](music-sources.json): it downloads each source once into
`assets/audio/.cache/` (gitignored), refuses a file whose SHA-256 differs from the one recorded,
normalises loudness (two-pass EBU R128 `loudnorm`, linear, to -18 LUFS, -1.5 dBTP) and encodes
**Ogg Opus 80 kb/s (primary)** and **MP3 96 kb/s (fallback)**, stereo 48 kHz, bit-exact (a rebuild
is byte-identical). `--offline` uses only the cache. `public/audio/music/manifest.json` lists each
track with its context, credit and sizes; the page streams the one it needs through an `<audio>`
element (nothing is preloaded) and crossfades on a context change (`src/audio/music.ts`).

**Licence policy: CC0 only.** Every track below is released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) on its OpenGameArt page, checked
on 2026-10-23. Nothing that merely says "free" or "royalty-free" is used, and a derivative of
another author's track (for example "Fast fight / battle music (looped)") was passed over.
CC0 needs no attribution; the credits ship anyway (settings panel "Now playing", the build's
`third-party-notices.txt` and the manifest).

| File | Context | Title | Author | Source page | Licence | Length | Source SHA-256 |
|---|---|---|---|---|---|---|---|
| `music/drive.ogg` + `.mp3` | driving | Midnight Cruiser | Zane Little Music (https://opengameart.org/users/zane-little-music) | https://opengameart.org/content/midnight-cruiser | CC0 1.0 | 144.4 s | `be0285ba239d…` |
| `music/foot.ogg` + `.mp3` | foot | Electronic Outlaw | Zane Little Music (https://opengameart.org/users/zane-little-music) | https://opengameart.org/content/electronic-outlaw | CC0 1.0 | 173.6 s | `798e3878aa34…` |
| `music/mission.ogg` + `.mp3` | mission | Down to Business | Zane Little Music (https://opengameart.org/users/zane-little-music) | https://opengameart.org/content/down-to-business-day-25 | CC0 1.0 | 45.3 s | `3bb3f317fe8b…` |
| `music/combat.ogg` + `.mp3` | combat | Invincibility [Loop] | Zane Little Music (https://opengameart.org/users/zane-little-music) | https://opengameart.org/content/invincibility-loop | CC0 1.0 | 25.6 s | `16f55af96284…` |
| `music/menu.ogg` + `.mp3` | menu | Midnight Drive | congusbongus (https://opengameart.org/users/congusbongus) | https://opengameart.org/content/midnight-drive | CC0 1.0 | 203.6 s | `0cec2b4468bd…` |

Total: 10 files, about 12.8 MB (well inside the build's 15 MB per file, 240 MB and 450 files).

## Original radio tracks (generated in code)

Six more tracks play only on the car radio. They are original work: every note is written in
[`scripts/audio/compose-radio.ts`](../../scripts/audio/compose-radio.ts) and every sound is an
oscillator, a filter or seeded noise in
[`scripts/audio/radio-synth.ts`](../../scripts/audio/radio-synth.ts). No sample, recording,
cover or quotation of anyone else's music is used, so there is no third-party licence. They are
listed in `music-sources.json` with `"origin": "generated"` and licence "Original work".

`node scripts/audio/build-music.ts radio-boom-bap radio-trap radio-bounce radio-dance-pop radio-synth-pop radio-nu-disco`
renders each loop (deterministic, seeded; about 5 s each), then normalises and encodes it exactly
like the recorded tracks (-18 LUFS, -1.5 dBTP, Ogg Opus 80 kb/s and MP3 96 kb/s). For a generated
loop the build refuses a loudness that would need loudnorm's dynamic mode, since a riding gain
would break the loop seam. `node scripts/audio/compose-radio.ts --out DIR` writes the raw loops
as WAV for listening.

Each track is one seamless loop of whole bars: reverb, delay and note tails past the loop end are
added back onto its start, and the sidechain and tape wow are periodic in the loop.

| File | Genre | Style | Title | Tempo, key | Length | Ogg + MP3 |
|---|---|---|---|---|---|---|
| `music/radio-boom-bap.ogg` + `.mp3` | hip-hop | boom-bap | Seed Round Cypher | 90 BPM, A minor | 42.7 s | 1.01 MB |
| `music/radio-trap.ogg` + `.mp3` | hip-hop | trap | Down Round Drip | 140 BPM, C minor | 41.1 s | 1.10 MB |
| `music/radio-bounce.ogg` + `.mp3` | hip-hop | West Coast bounce | Outer Sunset Bounce | 96 BPM, F minor | 40.0 s | 0.93 MB |
| `music/radio-dance-pop.ogg` + `.mp3` | pop | four-on-the-floor dance-pop | Up and to the Right | 122 BPM, F major | 47.2 s | 1.15 MB |
| `music/radio-synth-pop.ogg` + `.mp3` | pop | half-time synth-pop | Demo Day Heart | 100 BPM, D major | 48.0 s | 1.18 MB |
| `music/radio-nu-disco.ogg` + `.mp3` | pop | nu-disco pop | Lock-Up Period | 116 BPM, E minor | 49.7 s | 1.15 MB |

Together 12 files, 6.51 MB. With them the music and voice files total about 19.8 MB of the
20 MB audio budget in `tests/audio/provenance.test.ts`, so the next audio addition needs a
budget decision. A player downloads only the station they tune to (one Opus file, 0.44 to
0.60 MB), streamed after the game is running, never preloaded.

## Car radio

In a car the music is the radio (`src/audio/radio.ts`): M tunes to the next station, Shift+M to
the previous one, and there is an Off position; the settings panel has a station picker too. The
station is kept with the audio preferences. A card shows the station when the player gets in or
tunes. Stations are invented (no real call signs) and play the tracks above:

| Station | Track |
|---|---|
| Runway FM 88.5 (default) | `music/drive` Midnight Cruiser |
| Series A 101.3 | `music/menu` Midnight Drive |
| Pivot 94.9 | `music/foot` Electronic Outlaw |
| Burn Rate 107.7 | `music/mission` Down to Business |
| Cap Table 97.1 | `music/radio-boom-bap` Seed Round Cypher (boom-bap) |
| Down Round 103.9 | `music/radio-trap` Down Round Drip (trap) |
| Fog Bank 100.7 | `music/radio-bounce` Outer Sunset Bounce (West Coast bounce) |
| Unicorn 99.5 | `music/radio-dance-pop` Up and to the Right (dance-pop) |
| Hockey Stick 92.3 | `music/radio-synth-pop` Demo Day Heart (synth-pop) |
| Lock-Up 105.5 | `music/radio-nu-disco` Lock-Up Period (nu-disco) |
| Radio off | silence |

On foot the music follows the moment again: combat, a timed mission step, or the on-foot track.

### Keeping the music consistent (`src/audio/music.ts`)

- **Menus never switch the track.** The pause screen, the phone, the vendor and mission dialogs
  duck the music by about 8 dB, and it comes back up when they close. On the first build,
  every auto-opening mission dialog cut to the menu track and straight back.
- **At most one switch per 6 s** (`MIN_DWELL_MS`).
  - A wanted change must settle for 2 s first (combat: 0.4 s).
  - Combat music holds 12 s after the last spray or fight event.
  - In a car the radio plays, whatever happens outside.
- **No gap on a switch.** The new deck starts streaming while the old one plays on at full; the
  3 s equal-sum crossfade begins only once the new stream is actually playing (or after 4 s).
  A switch that arrives while the last one is still buffering reuses the buffering deck, and
  never touches the one being heard.
- **Each track resumes where it left off.** A watchdog restarts a stream the browser paused or
  stalled, and the audio context resumes when the tab is shown again.
- **One loudness** for every track: -18 LUFS, -1.5 dBTP (two-pass `loudnorm`), and every track
  loops.

`tests/audio/music-player.test.ts` drives the real tracker and player under a fake clock, with
streams that take up to 2.5 s to start. Over 10 minutes of random context flips every ~300 ms (5
seeds), it asserts at least 6 s between switches and no drop below half level longer than 150 ms.
It fails on the first build's crossfade (a 920 ms gap).

# Mission voices (ElevenLabs, held)

`node scripts/audio/generate-voices.ts` writes `public/audio/voice/manifest.json`: every
mission line (step lines, dialogue intros, question prompts and answer replies; 120 lines,
8,304 characters) and every inner-voice line (171, 6,888 characters) with its mission id, step id, line id, speaker, text, subtitle cues and file.
With `--generate` it calls ElevenLabs at build time only (the key stays in the environment and
never reaches the page, `dist/` or a log), caching each line by a hash of its text, voice and
settings, and transcodes to mono Ogg Opus 40 kb/s. Casting is in [`voices.json`](voices.json):
only ElevenLabs premade voices, one distinct voice per recurring speaker; the player is silent.

**The player's inner voice** (`src/audio/inner-voice.ts`), GTA-style. Short asides say what to do
and where ("Okay, I gotta get to the FiDi coworking desk.", "Salt water. Great for rust, rough on the nozzle.", "That bot's
acting sketchy."), and react to a win or a retry.
- **A finite bank.** Every line is enumerated from the mission data: each place a goto or start
  step names, times its variants, plus fixed lines per situation. That makes 171 lines and 6,888
  characters, so the whole bank can be voiced ahead of time. The manifest lists them after the
  mission lines.
- **No frequent repeats.** Variants rotate least-recently-used, each situation has a cooldown, and
  there is a 6 s gap between asides.
- **Priority.** It speaks at the lowest priority, so the cofounder's and other characters' lines
  interrupt it.
- **Casting.** The player's voice is Chris (a premade voice), distinct from the cofounder's.

**Account check, 2026-10-23** (`GET /v1/user/subscription`; tier and counts only):
tier: free, 5,975 of 10,000 characters used.

**Commercial-use basis.** ElevenLabs' help centre ("Can I publish the content I generate on the
platform?", <https://help.elevenlabs.io/hc/en-us/articles/13313564601361>) says the free plan
includes **no commercial licence** and may not be used for any commercial purpose (attribution
does not change that), while every paid plan includes a commercial licence (Beta services
excepted). A distributed game cannot rely on free-tier output, so **voice generation is held**:
the script checks the tier first and stops on `free` (or any tier it does not know). Every line
plays as timed subtitles meanwhile, through the same queue a voiced line uses. ElevenLabs Music
is not used for the same reason. To voice the game, use a key from an account on a paid tier (see "Generating the voices" below). It spends at most 25 % of the remaining
characters or 100,000, whichever is lower, and a rerun never regenerates a cached line.

## Generating the voices

The script reads the key from **`FOGCITY_ELEVENLABS_API_KEY` first**, then `ELEVENLABS_API_KEY`
(the first one set wins). Use the game-specific variable for a key meant just for Fog City, so
nobody has to change the shared `daringly` production secret in Doppler. The key in the cloud
sessions' environment (`ELEVENLABS_API_KEY`) belongs to a separate free account, so its run stops at
the licence check.

From a checkout, with the paid account's key (for example from `daringly.env.local`):

```sh
export FOGCITY_ELEVENLABS_API_KEY=…            # the paid account's key; never commit it
node scripts/audio/generate-voices.ts --generate --dry-run   # optional: check the tier and the plan
node scripts/audio/generate-voices.ts --generate
git add public/audio/voice/ assets/audio/voices.json
git commit -m "Audio: generated mission and inner voices"
```

It logs which variable the key came from (never the value), the tier and character counts, and
each line it generates. It refuses a tier without a commercial licence, spends at most 25 % of the
remaining characters or 100,000, and never regenerates a cached line. All 291 lines are about
15,200 characters. Needs Node 22.18+, pnpm dependencies installed and ffmpeg with libopus.
