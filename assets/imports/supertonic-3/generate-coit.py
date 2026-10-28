"""Generate original Coit guide clips offline from the already pinned local cache.
Run with raw/venv/bin/python, under a network-denying OS sandbox; no downloader/API.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
IMPORT = ROOT / "assets/imports/supertonic-3"
PUBLIC = ROOT / "public/audio/coit"
RAW = IMPORT / "raw/generated/coit"
assert not (PUBLIC / "manifest.json").exists(), "Preserve the existing generated Coit manifest"
acquisition = json.loads((IMPORT / "manifest.json").read_text())
for entry in acquisition["files"]:
    path = IMPORT.parent / entry["path"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"], f"Pinned asset differs: {path}"

import numpy as np
import onnxruntime as ort
import soundfile as sf
ort.disable_telemetry_events()
sys.path.insert(0, str(IMPORT / "raw/source/py"))
from helper import TextToSpeech, load_cfgs, load_onnx_all, load_text_processor, load_voice_style

model = IMPORT / "raw/model"
opts = ort.SessionOptions()
opts.intra_op_num_threads = 4
opts.inter_op_num_threads = 1
tts = TextToSpeech(load_cfgs(str(model / "onnx")), load_text_processor(str(model / "onnx")),
                   *load_onnx_all(str(model / "onnx"), opts, ["CPUExecutionProvider"]))
style = load_voice_style([str(model / "voice_styles/M1.json")])
script = json.loads((IMPORT / "coit-script.json").read_text())
PUBLIC.mkdir(parents=True, exist_ok=True)
RAW.mkdir(parents=True, exist_ok=True)
lines = []
for index, line in enumerate(script["lines"]):
    np.random.seed(2026102600 + index)
    waveform, duration = tts(line["text"], "en", style, 8, 1.05)
    samples = waveform[0, :int(duration[0] * tts.sample_rate)]
    assert samples.size and np.isfinite(samples).all(), f"Invalid generated samples: {line['id']}"
    peak = float(np.max(np.abs(samples)))
    gain = min(1.0, .98 / peak) if peak else 1.0
    name = line["id"].replace(":", "-")
    wav = RAW / f"{name}.wav"
    destination = PUBLIC / f"{name}.mp3"
    sf.write(str(wav), samples * gain, tts.sample_rate, subtype="PCM_16")
    subprocess.run(["/usr/local/bin/ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
                    "-af", "loudnorm=I=-18:TP=-1.5:LRA=9", "-ac", "1", "-ar", "44100", "-codec:a", "libmp3lame", "-b:a", "96k", str(destination)], check=True)
    probe = json.loads(subprocess.check_output(["/usr/local/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(destination)]))
    measured = float(probe["format"]["duration"])
    assert 0 < measured < 25, f"Unexpected clip duration: {line['id']}"
    item = {**line, "missionId": "coit-recon", "stepId": "viewer", "kind": "line", "file": f"audio/coit/{destination.name}",
            "durationS": measured, "measured": True, "cues": [{"startS": 0, "endS": measured, "text": line["text"]}],
            "bytes": destination.stat().st_size, "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
            "sourceWavSha256": hashlib.sha256(wav.read_bytes()).hexdigest(), "sourcePeak": peak, "sourceGain": gain}
    item["hash"] = item["sha256"]
    lines.append(item)
    print(json.dumps({"id": item["id"], "durationS": measured, "bytes": item["bytes"], "sha256": item["sha256"]}), flush=True)

manifest = {"version": 1, "status": "generated", "title": script["title"], "disclosure": script["disclosure"],
            "generator": {"engine": "Supertonic 3", "codeRevision": acquisition["code_revision"], "modelRevision": acquisition["model_revision"],
                          "voicePreset": "M1", "voiceLicense": "OpenRAIL-M", "codeLicense": "MIT", "provider": "CPUExecutionProvider", "steps": 8,
                          "speed": 1.05, "threads": {"intraOp": 4, "interOp": 1}, "encoding": "mono44.1kHz96kbpsMP3; loudnormI-18TP-1.5LRA9",
                          "scriptSha256": hashlib.sha256((IMPORT / "coit-script.json").read_bytes()).hexdigest(), "noPaidApi": True},
            "speakers": {"coit-guide": {"name": "AI coin-op guide", "voiced": True, "voiceId": "supertonic3-stock-M1", "voiceName": "Stock M1",
                                           "why": "Original fictional guide; bundled stock preset, no real person portrayed."}}, "lines": lines,
            "review": {"generated": True, "humanListening": False, "browserPlayback": False}}
(PUBLIC / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"manifest": str(PUBLIC / "manifest.json"), "lines": len(lines), "bytes": sum(line["bytes"] for line in lines), "durationS": sum(line["durationS"] for line in lines)}), flush=True)
