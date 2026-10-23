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
- **moat-jingle**: four FM-bell notes, **A4 D5 E5 B4** (onsets 0, 0.17, 0.34, 0.56 s), the
  last held over a soft B/F# pad and a short room reverb. It ends unresolved on purpose ("Every
  robot. Eventually."). The interval pattern (up a fourth, up a tone, down a fifth) was chosen
  to stay clear of well-known sound marks (the three-note broadcast chime G-E-C, the
  five-note processor "bong" and similar); the user signs it off before release.

The test (`tests/assets/audio.test.ts`) decodes both formats with real Vorbis and MPEG decoders
(`@wasm-audio-decoders/ogg-vorbis`, `mpg123-decoder`; wasm, no network), and checks the length,
peak (audible, not clipped), the spray seam and the jingle's four notes in order.
