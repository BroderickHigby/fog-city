# Archived Supertonic 3 local preparation

This is a local, gitignored preparation cache. No downloaded code has been executed, no packages installed, no model loaded and no speech generated or listened to.

- Official code archive: https://github.com/supertone-oss-archive/supertonic
- Immutable code revision: `1e9799e964ea4c0dad7cde993b65c3c813a7b373`
- Official model archive: https://huggingface.co/supertone-oss-archive/supertonic-3
- Immutable model revision: `aafc6e32416a594460b32413efc49d7fe4ce6d46`
- `manifest.json` records exact acquisition URLs, SHA-256 hashes and sizes, plus upstream Git blob or LFS hashes and their verification status.
- `SHA256SUMS` covers all files under `raw/`, including source/model API snapshots. Source files match upstream Git blobs; all four ONNX payloads match upstream LFS SHA-256 values. No third-party reference audio or demonstration voices were downloaded.

The preserved local inference source is `raw/source/py/example_onnx.py` and `helper.py`. Its CLI and CPU ONNX-loading path were read as text. The original `py/assets` symlink has not been materialized: use explicit model and voice paths. `config.json` is only a Hugging Face counting stub; the real inference configuration is `raw/model/onnx/tts.json`.

## Rights and limits

The source code is MIT (copyright 2025 Supertone Inc.; exact text in `raw/source/LICENSE`). The accompanying model and bundled M1-M5/F1-F5 voice presets are published under BigScience OpenRAIL-M (`raw/model/LICENSE`). Section 2 grants royalty-free use/distribution subject to its terms; section 6 disclaims licensor rights in generated output while retaining the license's use restrictions. Attachment A(e) requires an express intelligible disclosure that generated content is machine generated; A(g) prohibits nonconsensual impersonation. For this game, use an original fictional script with a bundled stock preset and include a clear generated-narration credit. Model/source redistribution has additional notice/license obligations. This cache does not grant rights to clone other voices, and no custom Voice Builder voice was purchased or downloaded.

The project was archived on 2026-09-09; upstream says development/support and hosted services have ended. This cache uses immutable preserved assets, not a service or subscription. No credentials, account, paid API or hosted inference was used.

## Original opening generation, 26 October 2026

The upstream project requires Python >=3.10 and recommends Python 3.11 in its archive setup. This machine's default Python is 3.9. Use an isolated supported interpreter and dependencies after the active heavy QA process ends. Preserve the upstream lock/source; do not modify this reference code silently. Requirements are in `raw/source/py/requirements.txt` and `uv.lock`.

From the repository root, with the isolated environment already prepared, an example local command is:

```sh
python assets/imports/supertonic-3/raw/source/py/example_onnx.py \
  --onnx-dir assets/imports/supertonic-3/raw/model/onnx \
  --voice-style assets/imports/supertonic-3/raw/model/voice_styles/M1.json \
  --text "An original fictional opening script goes here." \
  --lang en --n-test 1 \
  --save-dir assets/imports/supertonic-3/raw/generated
```

The example above documents the upstream CLI. The project adapter `generate-opening.py` has now executed the six original segments in `opening-script.json` using the same local source/model/stock preset, with four intra-op threads, one inter-op thread and fixed per-segment seeds. Upstream code/model bytes remain untouched. Default execution is CPU; upstream GPU mode raises `NotImplementedError`. The helper uses default ONNX session thread settings, so schedule generation separately from heavy tests. The source includes no demonstrated runtime network behavior guarantee until exercised in an isolated run. Keep all generated drafts local until pronunciation, pacing, clipping, volume and subtitle timing have been reviewed.

Runtime output is six mono MP3 files under `public/audio/opening/`, about60 seconds /724,690 bytes. Its manifest records measured durations, runtime SHA-256, source WAV SHA-256, voice/model/code revisions and encoding. WAV intermediates remain ignored under `raw/generated/opening/`. The original script, generated-narration disclosure and stock M1 preset do not portray a real person. Playback and human listening acceptance remain separate from successful generation.
