#!/usr/bin/env python3
"""Re-fetch the outside data the asset build depends on. Needs the network; the build does not.

  python3 assets/blender/tools/fetch_sources.py            # footprint + MakeHuman sources

1. SF Building Footprints (data.sf.gov dataset ynuv-fyni): the Ferry Building record,
   written to assets/blender/data/ferry-building-footprint.json (committed). The tower
   origin and heading in content/landmarks.json are derived from it (lib/ferry_frame.py).
2. MakeHuman (CC0 1.0) base mesh hm08 and the female/proportion targets used for the
   R-Evolution figure, cached in assets/blender/.cache/makehuman/ (gitignored). Run
   tools/make_base_female.py afterwards to regenerate data/makehuman-female.ply.
"""

from __future__ import annotations

import datetime
import json
import os
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BLENDER_DIR = os.path.dirname(HERE)
DATA = os.path.join(BLENDER_DIR, "data")
CACHE = os.path.join(BLENDER_DIR, ".cache")

FOOTPRINTS = "https://data.sf.gov/resource/ynuv-fyni.json"
# Box around the Ferry Building clock tower (37.7955, -122.3937).
BOX = (37.7975, -122.3960, 37.7935, -122.3915)
FERRY_ID = "201006.0000058"  # the only footprint in the box with a ~71 m lidar peak

MH = "https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data"
MH_FILES = [
    "3dobjs/base.obj",
    "targets/macrodetails/african-female-young.target",
    "targets/macrodetails/asian-female-young.target",
    "targets/macrodetails/caucasian-female-young.target",
    "targets/macrodetails/universal-female-young-maxmuscle-averageweight.target",
    "targets/macrodetails/proportions/female-young-averagemuscle-averageweight-idealproportions.target",
    "targets/macrodetails/height/female-young-averagemuscle-averageweight-maxheight.target",
    "targets/breast/female-young-averagemuscle-averageweight-maxcup-averagefirmness.target",
]


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "fog-city-assets/1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def fetch_footprint() -> None:
    where = "within_box(shape,%f,%f,%f,%f)" % BOX
    url = FOOTPRINTS + "?" + urllib.parse.urlencode({"$where": where, "$limit": "100"})
    rows = json.loads(get(url))
    ferry = [r for r in rows if r.get("sf16_bldgid") == FERRY_ID]
    if len(ferry) != 1:
        raise SystemExit(f"expected one footprint {FERRY_ID}, got {len(ferry)} of {len(rows)} rows")
    out = {
        "source": "SF Building Footprints (DataSF ynuv-fyni), https://data.sf.gov/d/ynuv-fyni",
        "query": url,
        "fetched": datetime.date.today().isoformat(),
        "note": "The Ferry Building record. Other footprints in the box are separate structures "
        "(ferry piers, plaza kiosks) and stay generated.",
        "neighbours": sorted(
            [{"sf16_bldgid": r["sf16_bldgid"], "peak_1st_m": float(r["peak_1st_m"])} for r in rows if r is not ferry[0]],
            key=lambda r: r["sf16_bldgid"],
        ),
        "record": ferry[0],
    }
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, "ferry-building-footprint.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, sort_keys=True)
        f.write("\n")
    print("wrote", os.path.relpath(path))


def fetch_makehuman() -> None:
    for rel in MH_FILES:
        dest = os.path.join(CACHE, "makehuman", rel)
        if os.path.exists(dest):
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        data = get(f"{MH}/{rel}")
        with open(dest, "wb") as f:
            f.write(data)
        print("cached", rel, len(data), "bytes")


if __name__ == "__main__":
    fetch_footprint()
    fetch_makehuman()
