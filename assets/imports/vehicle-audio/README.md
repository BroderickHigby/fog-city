# Recorded vehicle audio candidates

These four files are public Freesound HQ MP3 previews downloaded from the exact preview URLs exposed by the authors' official sound pages. They are lossy previews, not the original WAV/AIFF recordings. No account, API key or download-login endpoint was used.

All four official pages identify the recordings as CC0 1.0 and expressly allow modification and commercial redistribution. Credits are retained for provenance. Source HTML and the CC0 legal text are cached under `raw/`; `manifest.json` records exact acquisition URLs, hashes, authors and codec metadata. `SHA256SUMS` covers every acquired raw file.

| Candidate | Author | License | Downloaded representation |
|---|---|---|---|
| [Elantra Engine Idle and Rev](https://freesound.org/people/microman502/sounds/865228/) | microman502 | CC0 1.0 | 44100 Hz, 1 channel(s), 34.606 seconds MP3 preview |
| [Acceleration Sweep - 4062.wav](https://freesound.org/people/Chippy569/sounds/162499/) | Chippy569 | CC0 1.0 | 48000 Hz, 2 channel(s), 4.265 seconds MP3 preview |
| [Inside Car Noise While Driving](https://freesound.org/people/jackthemurray/sounds/439311/) | jackthemurray | CC0 1.0 | 48000 Hz, 2 channel(s), 52.277 seconds MP3 preview |
| [Tires Squeaking.aif](https://freesound.org/people/RutgerMuller/sounds/104026/) | RutgerMuller | CC0 1.0 | 48000 Hz, 2 channel(s), 2.000 seconds MP3 preview |

The `raw/` directory is gitignored. Nothing has been copied into the runtime audio library, transcoded, loop-edited, normalized or listened to. Media metadata was inspected with ffprobe only.

Before use: audition for speech/music or other unwanted sounds; choose useful steady engine/load regions; author and inspect loop seams; compare road-noise and braking levels in the actual mix; map sounds to appropriate vehicle families; encode shipping formats and update the runtime source/license manifest. A single stationary idle/rev and a short dyno sweep do not establish a complete set of recorded RPM/load loops.

The original Freesound downloads require login. Acquiring originals is a separate step; do not label these files as lossless or original-quality recordings. No new permission is needed to modify or redistribute the CC0 previews, but their suitability and quality remain unapproved.

## Prepared runtime candidates

`prepare.py` now produces five short recorded layers (idle, higher steady engine region, road/cabin, braking and acceleration) in Ogg Opus plus MP3 fallback. The installed ffmpeg lacks libvorbis; libopus is available. Every process uses one codec/filter thread. It verifies input preview hashes, filters unwanted extremes, crossfades loop tails into their starts, normalizes PCM RMS with a peak ceiling, then records exact output hashes and trim parameters in `prepared-manifest.json`. No oscillators/noise are generated.

Ten runtime files total 532,422 bytes. Loop PCM boundary jumps measured about -59 to -70 dBFS, with -20 dBFS PCM RMS; these measurements do not establish human or browser acceptance. The runtime manifest deliberately says `candidate`, `qualityApproved:false`: it plays for review but makes no listening claim. Encoded Ogg Opus and MP3 native browser loop regions still need acceptance, along with engine character, interior road/engine bleed, incidental speech/music, mix level and brake retrigger behavior. The two engine regions come from one recorded car and are shared explicitly across civilian profiles; there are not five recorded engines. Electric robotaxis receive only the road/cabin layer; any unwanted mechanical bleed must be assessed by listening.

The original `SHA256SUMS` remains the acquisition snapshot. New processed cache files are covered by the prepared output manifest; they have not silently been added to that earlier source inventory. No original Freesound WAV/AIFF was acquired, and lossy preview derivatives must not be described as original/lossless quality.
