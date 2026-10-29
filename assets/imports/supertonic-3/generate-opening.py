"""Offline original opening using pinned, local Supertonic 3 stock M1 assets.
No downloader, paid API, reference recording or runtime dependency is used.
Run from repository root with the isolated import venv. Generated WAVs stay raw.
"""
from pathlib import Path
import json
import sys
import hashlib
import numpy as np
import onnxruntime as ort
import soundfile as sf

ROOT = Path(__file__).resolve().parents[3]
IMPORT = ROOT / "assets/imports/supertonic-3"
sys.path.insert(0, str(IMPORT / "raw/source/py"))
from helper import TextToSpeech, load_cfgs, load_onnx_all, load_text_processor, load_voice_style

model = IMPORT / "raw/model"
opts = ort.SessionOptions()
opts.intra_op_num_threads = 4
opts.inter_op_num_threads = 1
tts = TextToSpeech(load_cfgs(str(model / "onnx")), load_text_processor(str(model / "onnx")),
                   *load_onnx_all(str(model / "onnx"), opts, ["CPUExecutionProvider"]))
style = load_voice_style([str(model / "voice_styles/M1.json")])
script = json.loads((Path(__file__).parent / "opening-script.json").read_text())
out = IMPORT / "raw/generated/opening"
out.mkdir(parents=True, exist_ok=True)
for index, line in enumerate(script["lines"]):
    np.random.seed(20261026 + index)
    waveform, duration = tts(line["text"], "en", style, 8, 1.05)
    destination = out / (line["id"] + ".wav")
    sf.write(str(destination), waveform[0, :int(duration[0] * tts.sample_rate)], tts.sample_rate, subtype="PCM_16")
    print(json.dumps({"id": line["id"], "durationS": float(duration[0]), "sampleRate": tts.sample_rate,
                      "bytes": destination.stat().st_size, "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}), flush=True)
