"""Fog City sound effects, synthesised from scratch -> public/audio/*.ogg (+ .mp3).

    python3 assets/audio/generate.py            # every sound, plus public/audio/manifest.json
    python3 assets/audio/generate.py spray      # one sound

Every sound is built here from oscillators, filtered noise and simple physical models
(numpy only), then encoded with ffmpeg (libvorbis for .ogg, libmp3lame for .mp3). Nothing is
sampled or recorded, so there is no licensing question. Seeds are fixed and ffmpeg runs
bit-exact, so a rebuild writes byte-identical files.

The sounds (see assets/audio/README.md for the design notes):
  spray        1.00 s loop   the blaster's water stream: a hissy jet with droplet patter
  splash       0.70 s        water landing on a robot or the pavement
  rust-creak   1.30 s        stick-slip creak of a rusting joint (seize, slump)
  melt-fizz    2.20 s        fizz, crackle and bubbling while a robot melts into a heap
  moat-jingle  1.70 s        the Moat Labs four-note jingle (A4 D5 E5 B4), a bad-robot tell
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import wave

# One BLAS thread, set before numpy loads. np.convolve (the jingle's reverb) runs one BLAS dot
# product per output sample, and OpenBLAS splits each dot over every core once it is longer
# than about 10k samples: on a busy machine its threads spin waiting for cores, and one
# convolution took minutes instead of 0.4 s. One thread also fixes the summation order, so
# the output no longer depends on the machine's core count.
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, "public", "audio")
SR = 44_100


# ------------------------------------------------------------------------------ helpers


def t_axis(seconds: float) -> np.ndarray:
    return np.arange(int(round(seconds * SR))) / SR


def onepole_lp(x: np.ndarray, cutoff: float) -> np.ndarray:
    """One-pole low-pass (6 dB/oct)."""
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def biquad(x: np.ndarray, kind: str, f0: float, q: float = 0.707) -> np.ndarray:
    """RBJ cookbook biquad (lowpass, highpass, bandpass) on a whole signal."""
    w0 = 2 * np.pi * f0 / SR
    alpha = np.sin(w0) / (2 * q)
    c = np.cos(w0)
    if kind == "lowpass":
        b = [(1 - c) / 2, 1 - c, (1 - c) / 2]
    elif kind == "highpass":
        b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
    elif kind == "bandpass":
        b = [alpha, 0.0, -alpha]
    else:
        raise ValueError(kind)
    a = [1 + alpha, -2 * c, 1 - alpha]
    b0, b1, b2 = (v / a[0] for v in b)
    a1, a2 = a[1] / a[0], a[2] / a[0]
    y = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, v in enumerate(x):
        out = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, v
        y2, y1 = y1, out
        y[i] = out
    return y


def resonator(x: np.ndarray, f0: float, decay_s: float) -> np.ndarray:
    """A two-pole resonator: rings at f0 with a 60 dB decay of decay_s seconds."""
    r = np.exp(-6.9 / (decay_s * SR))
    w = 2 * np.pi * f0 / SR
    a1, a2 = -2 * r * np.cos(w), r * r
    y = np.zeros_like(x)
    y1 = y2 = 0.0
    for i, v in enumerate(x):
        out = v - a1 * y1 - a2 * y2
        y2, y1 = y1, out
        y[i] = out
    return y * (1 - r)


def env_adsr(n: int, a: float, d: float, s: float, r: float) -> np.ndarray:
    """Attack/decay/sustain-level/release envelope over n samples (times in seconds)."""
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    ns = max(n - na - nd - nr, 0)
    e = np.concatenate([
        np.linspace(0, 1, na, endpoint=False),
        np.linspace(1, s, nd, endpoint=False),
        np.full(ns, s),
        np.linspace(s, 0, nr),
    ])
    return np.pad(e, (0, max(n - len(e), 0)))[:n]


def fade(x: np.ndarray, fin: float = 0.004, fout: float = 0.02) -> np.ndarray:
    n_in, n_out = int(fin * SR), int(fout * SR)
    y = x.copy()
    if n_in:
        y[:n_in] *= np.linspace(0, 1, n_in)
    if n_out:
        y[-n_out:] *= np.linspace(1, 0, n_out)
    return y


def normalize(x: np.ndarray, peak_db: float) -> np.ndarray:
    return x / (np.max(np.abs(x)) + 1e-12) * 10 ** (peak_db / 20)


def simple_reverb(x: np.ndarray, seconds: float, mix: float, rng: np.random.Generator) -> np.ndarray:
    """A short exponentially decaying noise tail, convolved (a cheap small-room reverb)."""
    n = int(seconds * SR)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / (n / 6.9))
    ir = onepole_lp(ir, 5000.0)
    ir /= np.sqrt(np.sum(ir**2))
    wet = np.convolve(x, ir)
    dry = np.pad(x, (0, len(wet) - len(x)))
    return (1 - mix) * dry + mix * wet * 0.5


# ---------------------------------------------------------------------------- the sounds


def spray() -> np.ndarray:
    """A water jet: band-passed noise hiss, a low rumble and droplet patter. Seamless loop:
    every component is periodic in the loop length or crossfaded across the seam."""
    rng = np.random.default_rng(101)
    dur = 1.0
    n = int(dur * SR)
    pad = int(0.2 * SR)
    noise = rng.standard_normal(n + pad)
    hiss = biquad(noise, "bandpass", 2600, 0.6) * 0.9 + biquad(noise, "highpass", 6000, 0.7) * 0.25
    rumble = biquad(rng.standard_normal(n + pad), "lowpass", 260, 0.9) * 1.6
    # droplet patter: tiny resonant blips at random times
    pat = np.zeros(n + pad)
    for _ in range(70):
        i = int(rng.integers(0, n + pad - 400))
        pat[i] += rng.uniform(0.4, 1.0) * rng.choice([-1, 1])
    patter = resonator(pat, 1900.0, 0.025) + resonator(pat, 3100.0, 0.02)
    sig = hiss + rumble + patter * 6.0
    # a slow pressure flutter, periodic in the loop (4 cycles per second)
    t = np.arange(n + pad) / SR
    sig *= 1.0 + 0.08 * np.sin(2 * np.pi * 4.0 * t) + 0.04 * np.sin(2 * np.pi * 9.0 * t)
    # loop: crossfade the tail (n..n+pad) onto the head with an equal-power fade
    body = sig[:n].copy()
    k = np.linspace(0, np.pi / 2, pad)
    body[:pad] = sig[:pad] * np.sin(k) + sig[n : n + pad] * np.cos(k)
    return normalize(body, -6.0)


def splash() -> np.ndarray:
    """Impact thump + a broadband slap that decays fast + scattered droplets."""
    rng = np.random.default_rng(202)
    t = t_axis(0.7)
    n = len(t)
    slap = rng.standard_normal(n) * np.exp(-t / 0.045)
    slap = biquad(slap, "bandpass", 1500, 0.5) * 1.2 + biquad(slap, "highpass", 4000) * 0.4
    thump = np.sin(2 * np.pi * (120 * t - 300 * t**2)) * np.exp(-t / 0.05) * 0.9
    drops = np.zeros(n)
    for _ in range(26):
        i = int(rng.integers(int(0.03 * SR), int(0.55 * SR)))
        f = rng.uniform(900, 2600)
        L = int(0.03 * SR)
        tt = np.arange(L) / SR
        # a droplet "plink" rises in pitch as the bubble collapses
        blip = np.sin(2 * np.pi * (f * tt + f * 2.5 * tt**2)) * np.exp(-tt / 0.008)
        end = min(i + L, n)
        drops[i:end] += blip[: end - i] * rng.uniform(0.15, 0.45) * np.exp(-t[i] / 0.25)
    sig = slap + thump + drops
    return fade(normalize(sig, -3.0), 0.0015, 0.08)


def rust_creak() -> np.ndarray:
    """Stick-slip friction: an irregular pulse train whose rate rises and falls, exciting
    inharmonic metal modes (a rusty hinge)."""
    rng = np.random.default_rng(303)
    dur = 1.3
    t = t_axis(dur)
    n = len(t)
    # pulse rate contour (Hz): starts slow, speeds into a squeal, slows to a groan
    rate = 38 + 70 * np.sin(np.pi * np.clip(t / 0.95, 0, 1)) ** 1.5 - 18 * (t > 0.95) * (t - 0.95) / 0.35
    phase = np.cumsum(rate / SR)
    pulses = np.zeros(n)
    k = np.flatnonzero(np.diff(np.floor(phase)) > 0)
    for i in k:
        j = int(i + rng.integers(-40, 40))
        if 0 <= j < n:
            pulses[j] += rng.uniform(0.6, 1.0)
    modes = [(410.0, 0.12, 1.0), (1135.0, 0.08, 0.6), (2210.0, 0.05, 0.35), (3570.0, 0.03, 0.2)]
    sig = sum(g * resonator(pulses, f, d) for f, d, g in modes)
    grit = biquad(rng.standard_normal(n), "bandpass", 3000, 1.2) * 0.003 * (0.3 + rate / 108)
    env = env_adsr(n, 0.02, 0.2, 0.85, 0.25)
    return fade(normalize((sig + grit) * env, -3.0), 0.003, 0.05)


def melt_fizz() -> np.ndarray:
    """Fizzing hiss that fades, dense crackles, and low bubbles gliding up."""
    rng = np.random.default_rng(404)
    dur = 2.2
    t = t_axis(dur)
    n = len(t)
    hiss = biquad(rng.standard_normal(n), "highpass", 3500, 0.7)
    hiss *= np.exp(-t / 1.2) * (1 - np.exp(-t / 0.05))
    crackle = np.zeros(n)
    density = 900 * np.exp(-t / 0.9) + 40
    p = density / SR
    hits = rng.uniform(size=n) < p
    crackle[hits] = rng.uniform(-1, 1, size=int(hits.sum()))
    crackle = biquad(crackle, "highpass", 1800) * 1.4
    bubbles = np.zeros(n)
    for _ in range(18):
        start = rng.uniform(0.05, 1.8)
        L = rng.uniform(0.04, 0.12)
        i0 = int(start * SR)
        tt = np.arange(int(L * SR)) / SR
        f0 = rng.uniform(140, 320)
        b = np.sin(2 * np.pi * (f0 * tt + f0 * 6 * tt**2)) * np.sin(np.pi * tt / L) ** 2
        end = min(i0 + len(b), n)
        bubbles[i0:end] += b[: end - i0] * rng.uniform(0.2, 0.5)
    sig = hiss * 0.5 + crackle * 0.6 + bubbles * 0.7
    return fade(normalize(sig, -3.0), 0.01, 0.3)


JINGLE_NOTES = [("A4", 440.00), ("D5", 587.33), ("E5", 659.26), ("B4", 493.88)]


def moat_jingle() -> np.ndarray:
    """Four bright FM-bell notes, A4 D5 E5 B4, the last one held: upbeat, then left hanging
    (the suspended ending is the joke: "Every robot. Eventually.")."""
    rng = np.random.default_rng(505)
    dur = 1.7
    t = t_axis(dur)
    n = len(t)
    out = np.zeros(n)
    onsets = [0.0, 0.17, 0.34, 0.56]
    lengths = [0.16, 0.16, 0.2, 1.1]
    for (name, f), on, L in zip(JINGLE_NOTES, onsets, lengths):
        i0 = int(on * SR)
        m = int(min(L + 0.35, dur - on) * SR)
        tt = np.arange(m) / SR
        # FM bell: carrier f, modulator 3.5 f with a decaying index
        index = 2.2 * np.exp(-tt / 0.25)
        tone = np.sin(2 * np.pi * f * tt + index * np.sin(2 * np.pi * 3.5 * f * tt))
        tone += 0.35 * np.sin(2 * np.pi * 2 * f * tt) * np.exp(-tt / 0.15)  # a bright octave
        env = np.exp(-tt / (0.45 if L > 0.5 else 0.22)) * (1 - np.exp(-tt / 0.003))
        gate = np.clip((L + 0.3 - tt) / 0.3, 0, 1)
        out[i0 : i0 + m] += tone * env * gate * (1.0 if L < 0.5 else 1.1)
    # a soft synth pad under the held last note (B4 + F#5): the "unresolved" chord
    pad_env = np.clip((t - 0.56) / 0.15, 0, 1) * np.exp(-np.clip(t - 0.56, 0, None) / 0.8)
    pad = (np.sin(2 * np.pi * 246.94 * t) + 0.6 * np.sin(2 * np.pi * 369.99 * t)) * pad_env * 0.18
    sig = simple_reverb(out + pad, 0.5, 0.25, rng)[:n]
    return fade(normalize(sig, -3.0), 0.002, 0.15)


def horn() -> np.ndarray:
    """A car horn held down: two reed-like tones a major third apart (400 and 500 Hz, the
    classic dual-trumpet interval) through a brassy band-pass. Both tones and every harmonic
    complete whole cycles in 0.5 s, so the loop is seamless; the player's horn plays it for as
    long as the button is held, with the attack and release shaped at playback."""
    t = t_axis(0.5)
    sig = np.zeros(len(t))
    for f0, amp in ((400.0, 1.0), (500.0, 0.85)):
        for k in range(1, 9):
            # A clipped-reed spectrum: odd harmonics stronger, falling off with k.
            sig += amp * (1.0 if k % 2 else 0.55) / k**0.9 * np.sin(2 * np.pi * f0 * k * t)
    sig = np.tanh(sig * 0.9)
    # Static (time-invariant) colouring keeps the loop periodic: a fixed EQ via FFT.
    spec = np.fft.rfft(sig)
    freqs = np.fft.rfftfreq(len(sig), 1 / SR)
    shape = np.exp(-((np.log2(np.maximum(freqs, 1) / 1800.0)) ** 2) / 1.6) + 0.25
    sig = np.fft.irfft(spec * shape, len(sig))
    return normalize(sig, -3.0)


def robotaxi_horn() -> np.ndarray:
    """A robotaxi's horn: two short, polite electronic chirps rising a fifth (C6 then G6),
    soft square tones with a quick pitch blip on each attack. Deliberately apologetic: the
    car honks like it is asking permission."""
    t = t_axis(0.62)
    sig = np.zeros(len(t))
    for start, f0 in ((0.0, 1046.5), (0.22, 1568.0)):
        i0 = int(start * SR)
        n = int(0.16 * SR)
        tt = np.arange(n) / SR
        f = f0 * (1 + 0.06 * np.exp(-tt / 0.012))
        phase = 2 * np.pi * np.cumsum(f) / SR
        tone = np.tanh(2.2 * np.sin(phase)) * 0.7 + 0.3 * np.sin(2 * phase)
        env = np.minimum(1, tt / 0.006) * np.exp(-tt / 0.09)
        sig[i0:i0 + n] += tone * env
    sig = biquad(sig, "lowpass", 5000)
    return fade(normalize(sig, -4.0), 0.002, 0.05)


def door_open() -> np.ndarray:
    """A car door opening: the latch's double click, then a short hinge glide."""
    rng = np.random.default_rng(301)
    t = t_axis(0.45)
    n = len(t)
    sig = np.zeros(n)
    for start, f, amp in ((0.0, 2400, 1.0), (0.035, 1700, 0.7)):
        i = int(start * SR)
        L = int(0.025 * SR)
        tt = np.arange(L) / SR
        click = rng.standard_normal(L) * np.exp(-tt / 0.004)
        sig[i:i + L] += biquad(click, "bandpass", f, 2.0) * amp
    glide = biquad(rng.standard_normal(n), "bandpass", 900, 6.0) * np.exp(-((t - 0.2) / 0.09) ** 2) * 0.25
    sig += glide
    return fade(normalize(sig, -6.0), 0.001, 0.05)


def door_close() -> np.ndarray:
    """A car door shutting: a damped low thunk with a latch catch on top."""
    rng = np.random.default_rng(302)
    t = t_axis(0.5)
    thunk = np.sin(2 * np.pi * (95 * t - 40 * t**2)) * np.exp(-t / 0.07)
    body = biquad(rng.standard_normal(len(t)), "lowpass", 400) * np.exp(-t / 0.05) * 0.8
    latch = biquad(rng.standard_normal(len(t)), "bandpass", 2600, 3.0) * np.exp(-np.maximum(t - 0.012, 0) / 0.006) * (t >= 0.012) * 0.6
    return fade(normalize(thunk + body + latch, -3.0), 0.0005, 0.08)


def impact() -> np.ndarray:
    """A car bumping into something solid: a low body thump with a short metal clank."""
    rng = np.random.default_rng(303)
    t = t_axis(0.6)
    thump = np.sin(2 * np.pi * (70 * t - 30 * t**2)) * np.exp(-t / 0.09)
    crunch = biquad(rng.standard_normal(len(t)), "bandpass", 1200, 0.8) * np.exp(-t / 0.035) * 0.9
    clank = np.zeros(len(t))
    for f, d in ((523.0, 0.25), (1311.0, 0.15), (2207.0, 0.08)):
        clank += np.sin(2 * np.pi * f * t) * np.exp(-t / d) * 0.18
    return fade(normalize(thump + crunch + clank, -2.0), 0.0005, 0.1)


def footstep(seed: int) -> np.ndarray:
    """One shoe on pavement: a soft heel thud and a gritty scuff, varied by the seed."""
    rng = np.random.default_rng(400 + seed)
    t = t_axis(0.18)
    heel = np.sin(2 * np.pi * rng.uniform(80, 110) * t) * np.exp(-t / 0.018)
    scuff = biquad(rng.standard_normal(len(t)), "bandpass", rng.uniform(1800, 3200), 1.2) * np.exp(-np.maximum(t - 0.01, 0) / rng.uniform(0.025, 0.045)) * (t >= 0.01) * 0.55
    return fade(normalize(heel + scuff, -4.0), 0.0005, 0.03)


SOUNDS = {
    "spray": (spray, True, "Blaster stream loop: play while firing; loops seamlessly (use the .ogg for gapless looping)."),
    "splash": (splash, False, "Water lands on a robot or the pavement."),
    "rust-creak": (rust_creak, False, "A joint rusting solid: rust past 0.5, seize and slump."),
    "melt-fizz": (melt_fizz, False, "A robot melting into a rust heap (slumping -> heap)."),
    "moat-jingle": (moat_jingle, False, "Moat Labs four-note jingle (A4 D5 E5 B4): bad robots hum it (tell, subtlety 3)."),
    "horn": (horn, True, "The player's car horn: loop while the horn button is held (use the .ogg for gapless looping)."),
    "robotaxi-horn": (robotaxi_horn, False, "A robotaxi's polite double chirp when it honks (agent mode honk)."),
    "door-open": (door_open, False, "A car door opening (getting in or out)."),
    "door-close": (door_close, False, "A car door shutting."),
    "impact": (impact, False, "The player's car hitting something solid; level and pitch follow the impact speed."),
    "step-1": (lambda: footstep(1), False, "Footstep on pavement, variant 1 of 4."),
    "step-2": (lambda: footstep(2), False, "Footstep on pavement, variant 2 of 4."),
    "step-3": (lambda: footstep(3), False, "Footstep on pavement, variant 3 of 4."),
    "step-4": (lambda: footstep(4), False, "Footstep on pavement, variant 4 of 4."),
}


# ------------------------------------------------------------------------------- output


def write_wav(path: str, x: np.ndarray) -> None:
    pcm = np.clip(np.round(x * 32767), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def encode(wav: str, out: str, codec: str) -> None:
    args = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", wav, "-map_metadata", "-1",
            "-fflags", "+bitexact", "-flags:a", "+bitexact", "-ac", "1"]
    if codec == "ogg":
        args += ["-c:a", "libvorbis", "-q:a", "3", out]
    else:
        args += ["-c:a", "libmp3lame", "-b:a", "64k", "-id3v2_version", "0", "-write_xing", "0", out]
    subprocess.run(args, check=True)


def main() -> None:
    names = sys.argv[1:] or list(SOUNDS)
    os.makedirs(OUT, exist_ok=True)
    manifest_path = os.path.join(OUT, "manifest.json")
    manifest = {"version": 1, "sampleRate": SR, "sounds": {}}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    with tempfile.TemporaryDirectory() as tmp:
        for name in names:
            if name not in SOUNDS:
                raise SystemExit(f"unknown sound {name!r}; choose from {', '.join(SOUNDS)}")
            fn, loop, use = SOUNDS[name]
            x = fn()
            if not np.all(np.isfinite(x)):
                raise SystemExit(f"{name}: non-finite samples")
            wav = os.path.join(tmp, f"{name}.wav")
            write_wav(wav, x)
            files = {}
            for codec in ("ogg", "mp3"):
                out = os.path.join(OUT, f"{name}.{codec}")
                encode(wav, out, codec)
                files[codec] = f"audio/{name}.{codec}"
                print(f"[audio] wrote public/audio/{name}.{codec}: {len(x) / SR:.2f} s, {os.path.getsize(out) // 1024} KiB")
            entry = {"files": files, "durationS": round(len(x) / SR, 3), "loop": loop, "use": use}
            if name == "moat-jingle":
                entry["notes"] = [n for n, _ in JINGLE_NOTES]
            manifest["sounds"][name] = entry
    manifest["sounds"] = dict(sorted(manifest["sounds"].items()))
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
