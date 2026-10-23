"""CC0 material scans for the high graphics tier -> public/models/textures/<set>_{albedo,normal,orm}.webp

Downloads each set's 1K maps from Poly Haven (CC0: https://polyhaven.com/license) into a scratch
directory outside the repository, re-encodes them as WebP (the privacy test bans JPEG bytes in
public/; WebP keeps them small) and records the source, author, real-world size and licence in
public/models/textures/textures.json, the asset manifest for every texture the game ships.

  python3 assets/textures/fetch_cc0.py                 # every set in SETS
  python3 assets/textures/fetch_cc0.py asphalt         # one set
  FC_CC0_CACHE=/tmp/cc0 python3 assets/textures/fetch_cc0.py   # where the downloads go (default: ~/.cache/fog-city/cc0, outside the checkout: the privacy test bans JPEG files anywhere in it)

Only materials (asphalt, concrete, stone, grass): never photos of people or of real San
Francisco facades. The generated sets (generate.py) stay as the fallback for anything not here.
"""

import io
import json
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "textures")
CACHE = os.environ.get("FC_CC0_CACHE", os.path.join(os.path.expanduser("~"), ".cache", "fog-city", "cc0"))
RES = "1k"
SIZE = 1024

# Game set name -> Poly Haven asset id. Each set's real size comes from the asset's dimensions.
SETS = {
    "asphalt": "asphalt_02",
    "concrete": "concrete_pavement",
    "pavers": "concrete_pavers_02",
    "sandstone": "white_sandstone_blocks_02",
    "grass": "leafy_grass",
}


def get(url: str) -> bytes:
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, url.rsplit("/", 1)[-1])
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={"User-Agent": "fog-city-asset-fetch/1"})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, "wb") as f:
            f.write(r.read())
    with open(path, "rb") as f:
        return f.read()


def api(path: str) -> dict:
    req = urllib.request.Request(f"https://api.polyhaven.com/{path}", headers={"User-Agent": "fog-city-asset-fetch/1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def load(url: str, mode: str) -> Image.Image:
    im = Image.open(io.BytesIO(get(url)))
    im = im.convert(mode)
    if im.size != (SIZE, SIZE):
        im = im.resize((SIZE, SIZE), Image.LANCZOS)
    return im


def fetch(name: str, asset: str) -> dict:
    info = api(f"info/{asset}")
    files = api(f"files/{asset}")
    pick = lambda key: files[key][RES]["jpg"]["url"]  # noqa: E731
    albedo = load(pick("Diffuse"), "RGB")
    normal = load(pick("nor_gl"), "RGB")  # OpenGL convention (+Y up), as detail.ts expects
    orm = load(pick("arm"), "RGB")  # Poly Haven's ARM packing is glTF's ORM: R AO, G roughness, B metalness
    os.makedirs(OUT, exist_ok=True)
    albedo.save(os.path.join(OUT, f"{name}_albedo.webp"), quality=90, method=6)
    normal.save(os.path.join(OUT, f"{name}_normal.webp"), quality=94, method=6)
    orm.save(os.path.join(OUT, f"{name}_orm.webp"), quality=90, method=6)
    a = np.asarray(albedo, dtype=np.float64) / 255.0
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    mean = [round(float(v), 5) for v in lin.reshape(-1, 3).mean(0)]
    dims = info.get("dimensions") or [2000, 2000]
    size_m = round(max(dims) / 1000.0, 3)
    authors = ", ".join(info.get("authors", {}).keys())
    print(f"[fc] wrote textures/{name} from Poly Haven {asset} ({size_m} m per repeat, by {authors})")
    return {
        "sizeM": size_m,
        "meanLinear": mean,
        "albedo": f"{name}_albedo.webp",
        "normal": f"{name}_normal.webp",
        "orm": f"{name}_orm.webp",
        "source": f"https://polyhaven.com/a/{asset}",
        "author": authors,
        "licence": "CC0 1.0 (https://polyhaven.com/license)",
        "adaptation": f"{RES} JPEG maps (Diffuse, nor_gl, arm) re-encoded as {SIZE} px WebP by assets/textures/fetch_cc0.py",
    }


if __name__ == "__main__":
    names = sys.argv[1:] or list(SETS)
    path = os.path.join(OUT, "textures.json")
    manifest = json.load(open(path)) if os.path.exists(path) else {"version": 1, "textures": {}}
    for n in names:
        manifest["textures"][n] = fetch(n, SETS[n])
    manifest["textures"] = dict(sorted(manifest["textures"].items()))
    with open(path, "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
