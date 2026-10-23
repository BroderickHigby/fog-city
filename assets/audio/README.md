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
| `horn` | 0.50 s | yes | the player's car horn, looped while H (pad L3) is held, with a 12 ms attack and 60 ms release at playback. Loop the `.ogg` |
| `robotaxi-horn` | 0.62 s | no | a robotaxi honks (agent mode `honk`, a player blocking it): at most once per car per 4 s, distance-attenuated |

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
  brassy EQ. Every component completes whole cycles in 0.5 s, so the loop is seamless.
- **robotaxi-horn**: an original, deliberately polite double chirp: two short soft-square tones
  rising a fifth (C6 then G6), each with a tiny pitch blip on its attack. It honks like it is asking
  permission; it copies no real vehicle's horn.
- **moat-jingle**: four FM-bell notes, **A4 D5 E5 B4** (onsets 0, 0.17, 0.34, 0.56 s), the
  last held over a soft B/F# pad and a short room reverb. It ends unresolved on purpose ("Every
  robot. Eventually."). The interval pattern (up a fourth, up a tone, down a fifth) was chosen
  to stay clear of well-known sound marks (the three-note broadcast chime G-E-C, the
  five-note processor "bong" and similar); the user signs it off before release.

The test (`tests/assets/audio.test.ts`) decodes both formats with real Vorbis and MPEG decoders
(`@wasm-audio-decoders/ogg-vorbis`, `mpg123-decoder`; wasm, no network), and checks the length,
peak (audible, not clipped), the spray seam and the jingle's four notes in order.

# Music (CC0, OpenGameArt)

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

## Car radio

In a car the music is the radio (`src/audio/radio.ts`): M tunes to the next station, Shift+M to
the previous one, and there is an Off position; the settings panel has a station picker too. The
station is kept with the audio preferences. A card shows the station when the player gets in or
tunes. Stations are invented (no real call signs) and play the CC0 tracks above:

| Station | Track |
|---|---|
| Runway FM 88.5 (default) | `music/drive` Midnight Cruiser |
| Series A 101.3 | `music/menu` Midnight Drive |
| Pivot 94.9 | `music/foot` Electronic Outlaw |
| Burn Rate 107.7 | `music/mission` Down to Business |
| Radio off | silence |

On foot the music follows the moment again: combat, a timed mission step, or the on-foot track.

# Mission voices (ElevenLabs, held)

`node scripts/audio/generate-voices.ts` writes `public/audio/voice/manifest.json`: every
mission line (step lines, dialogue intros, question prompts and answer replies; 120 lines,
8,304 characters) and every inner-voice line (168, 6,312 characters) with its mission id, step id, line id, speaker, text, subtitle cues and file.
With `--generate` it calls ElevenLabs at build time only (the key stays in the environment and
never reaches the page, `dist/` or a log), caching each line by a hash of its text, voice and
settings, and transcodes to mono Ogg Opus 40 kb/s. Casting is in [`voices.json`](voices.json):
only ElevenLabs premade voices, one distinct voice per recurring speaker; the player is silent.

**The player's inner voice** (`src/audio/inner-voice.ts`), GTA-style. Short asides say what to do
and where ("Okay, I gotta get to the FiDi coworking desk.", "Damn, need water.", "That bot's acting
sketchy."), and react to a win or a retry.
- **A finite bank.** Every line is enumerated from the mission data: each place a goto or start
  step names, times its variants, plus fixed lines per situation. That makes 168 lines and 6,312
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
is not used for the same reason. To voice the game: move the account to any paid tier, then run
`node scripts/audio/generate-voices.ts --generate`. It spends at most 25 % of the remaining
characters or 100,000, whichever is lower, and a rerun never regenerates a cached line.
