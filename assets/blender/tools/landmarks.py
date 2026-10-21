#!/usr/bin/env python3
"""Write content/landmarks.json (schemas/landmarks.schema.json). Plain Python, no network.

Ferry Building: placed at the clock tower (the model origin), heading = its front facade's
compass bearing, both derived from the SF footprint by lib/ferry_frame.py. It replaces the
pipeline's generated footprint (sf16_bldgid 201006.0000058) and the pipeline's synthetic
"-tower" record for it. collider = that footprint in model-local metres [x, z] (glTF frame:
x right, z toward the back), simplified.

R-Evolution (Marco Cochrane, 45 ft): stood in Embarcadero Plaza from April 2025, on the axis
of Market Street at its foot, facing up Market with its back to the Ferry Building
(photographs in the SF Arts Commission's R-Evolution extension proposal, Feb 2026).
Position: Wikipedia's coordinate 37.794742, -122.394502, which sits 3.7 m from the DataSF
street centreline of Market St and 36 m north-east of the Steuart St intersection. Heading:
Market St's bearing toward the south-west, 225.3 degrees (DataSF streets 3psu-pn9h, segment
Steuart-Spear). The brief's approximate 37.7953, -122.3958 is ~120 m away inside the plaza's
lawn, so the cross-checked coordinate is used instead.

The interim landmarks (Sutro Tower, the two bridges, the pyramid tower at 600 Montgomery,
Coit Tower, City Hall, the Palace of Fine Arts, Grace Cathedral, the Dragon Gate and the Sutro
Baths ruins) are placed from data/landmark-sites.json (tools/landmark-sites.ts): the same
origin, heading and replaced records the model scripts were built on.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))

import ferry_frame  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
OUT = os.path.join(REPO, "content", "landmarks.json")

REV_LAT = 37.794742
REV_LON = -122.394502
REV_HEADING = 225.3
REV_PLINTH_R = 3.6  # metres; must match models/r_evolution.py
SITES = os.path.join(os.path.dirname(HERE), "data", "landmark-sites.json")

# Interim landmarks: site id -> (model file, source note). Each id is the pipeline probe's
# where one exists (tests/pipeline/sf-world.test.ts: such an entry replaces exactly the
# probe's records). No brand names in ids or files: the pyramid is "600-montgomery".
INTERIM = [
    ("sutro-tower", "sutro-tower.glb", "Interim proxy: three-legged lattice, published dimensions (297.8 m). Centre and leg bearings from the LiDAR crossarm footprints; replaces the probe's six records and draws each where the sim has it."),
    ("golden-gate-bridge", "golden-gate-bridge.glb", "Interim far-visible silhouette: towers, deck, main cables. Axis from the Hwy 101 road end through the published centre; origin = south tower at sea level. Pre-release legal checklist (design.md)."),
    ("bay-bridge-west", "bay-bridge-west.glb", "Interim far-visible silhouette of the west span: four towers, centre anchorage, double deck, cables. Axis = I-80 edge c14248000; piers where the DEM marks them; origin = mid eastern main span at sea level."),
    ("600-montgomery", "600-montgomery.glb", "Interim shape: tapered four-sided tower with wings and spire (260 m), no window grid. Pre-release legal checklist (design.md)."),
    ("coit-tower", "coit-tower.glb", "Interim shape: 64 m fluted column with its arcade and crown on the base building record."),
    ("city-hall", "city-hall.glb", "Interim shape: the block (record footprint) with pilasters, colonnaded drum, dome and lantern (93 m)."),
    ("palace-of-fine-arts", "palace-of-fine-arts.glb", "Interim shape: the rotunda's eight piers, arches (closed by shadow: the record is solid in the sim), drum and dome (49 m)."),
    ("grace-cathedral", "grace-cathedral.glb", "Interim shape: nave and transept roofs on the record footprint, twin towers, rose window, fleche over the crossing (70 m)."),
    ("dragon-gate", "dragon-gate.glb", "Prop: the gate across Grant Ave just north of Bush St, portals facing south, spanning the building faces. Blank plaque, no characters."),
    ("sutro-baths", "sutro-baths.glb", "Interim shape: the ruined pool walls and standing water on the DEM's basin shelf at Lands End."),
]


def simplify(ring: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Douglas-Peucker on a closed ring, keeping the two farthest-apart vertices."""

    def dp(pts):
        if len(pts) < 3:
            return pts
        (ax, az), (bx, bz) = pts[0], pts[-1]
        dx, dz = bx - ax, bz - az
        L = math.hypot(dx, dz) or 1e-9
        best, idx = -1.0, 0
        for i in range(1, len(pts) - 1):
            px, pz = pts[i]
            d = abs(dx * (az - pz) - dz * (ax - px)) / L
            if d > best:
                best, idx = d, i
        if best <= tol:
            return [pts[0], pts[-1]]
        return dp(pts[: idx + 1])[:-1] + dp(pts[idx:])

    n = len(ring)
    i0 = 0
    i1 = max(range(n), key=lambda i: math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]))
    a = dp(ring[i0 : i1 + 1])
    b = dp(ring[i1:] + [ring[0]])
    return a[:-1] + b[:-1]


def dials(heading: float) -> str:
    """Where each model-frame dial faces once placed: 'N 233.8 (SW), E 323.8 (NW), ...'."""
    names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    out = []
    for face, turn in (("N", 0.0), ("E", 90.0), ("S", 180.0), ("W", 270.0)):
        b = round((heading + turn) % 360.0, 1)
        out.append(f"{face} {b} ({names[int((b + 22.5) // 45) % 8]})")
    return ", ".join(out)


def r2(v: float) -> float:
    return round(v, 2)


def main() -> None:
    f = ferry_frame.frame()
    ring = simplify(f["model_ring"], 0.75)
    plinth = [
        [r2(REV_PLINTH_R * math.cos(2 * math.pi * k / 12)), r2(REV_PLINTH_R * math.sin(2 * math.pi * k / 12))]
        for k in range(12)
    ]
    doc = {
        "version": 1,
        "landmarks": [
            {
                "id": "ferry-building",
                "model": "models/ferry-building.glb",
                "lat": round(f["tower_lat"], 7),
                "lon": round(f["tower_lon"], 7),
                "headingDeg": round(f["heading_deg"], 2),
                "scale": 1,
                "replacesBuildingIds": [f["bldg_id"], f["bldg_id"] + "-tower"],
                "collider": [[r2(x), r2(z)] for x, z in ring],
                "source": "Origin = clock tower centre; footprint and heading from DataSF building "
                "footprints (ynuv-fyni) sf16_bldgid " + f["bldg_id"] + ". Clock nodes clock_*_N/E/S/W name "
                "MODEL-frame dials (N = front, -Z), not compass points; placed here they face " + dials(f["heading_deg"])
                + ". See assets/blender/README.md.",
            },
            {
                "id": "r-evolution",
                "model": "models/r-evolution.glb",
                "lat": REV_LAT,
                "lon": REV_LON,
                "headingDeg": REV_HEADING,
                "scale": 1,
                "collider": plinth,
                "source": "Embarcadero Plaza on the Market St axis, facing up Market (Wikipedia coordinate "
                "cross-checked against DataSF street centrelines). See assets/blender/README.md.",
            },
        ],
    }
    with open(SITES, encoding="utf-8") as fh:
        sites = {x["id"]: x for x in json.load(fh)["sites"]}
    for sid, model, note in INTERIM:
        st = sites[sid]
        entry = {
            "id": sid,
            "model": "models/" + model,
            "lat": st["lat"],
            "lon": st["lon"],
            "headingDeg": st["headingDeg"],
            "scale": 1,
        }
        if st["replacesBuildingIds"]:
            entry["replacesBuildingIds"] = st["replacesBuildingIds"]
        entry["source"] = note + " Site: assets/blender/data/landmark-sites.json; see assets/blender/README.md."
        doc["landmarks"].append(entry)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    text = json.dumps(doc, indent=2)
    # one [x, z] pair per line
    text = re.sub(r"\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]", r"[\1, \2]", text)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(text + "\n")
    print(f"[fc] wrote {os.path.relpath(OUT, REPO)}: ferry heading {doc['landmarks'][0]['headingDeg']}, "
          f"{len(ring)}-point collider, {len(doc['landmarks'])} landmarks")


if __name__ == "__main__":
    main()
