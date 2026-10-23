"""A minimal, deterministic glTF 2.0 binary (GLB) writer for meshes whose vertex order matters.

The Blender exporter is free to split and reorder vertices; the crowd meshes are indexed by
vertex number into the vertex-animation textures, so they are written here directly, in
exactly the order the bake used. numpy only (runs in Blender or plain Python).
"""

from __future__ import annotations

import json
import struct

import numpy as np

FLOAT, USHORT, UINT, UBYTE = 5126, 5123, 5125, 5121
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963
_TYPES = {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}


class GlbWriter:
    def __init__(self) -> None:
        self.bin = bytearray()
        self.gltf: dict = {
            "asset": {"version": "2.0", "generator": "Fog City assets/blender/lib/glbwrite.py"},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "meshes": [],
            "materials": [],
            "accessors": [],
            "bufferViews": [],
            "buffers": [],
        }

    def _view(self, data: bytes, target: int | None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        view = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        self.bin += data
        self.gltf["bufferViews"].append(view)
        return len(self.gltf["bufferViews"]) - 1

    def accessor(self, arr: np.ndarray, component: int, target: int | None, minmax: bool = False,
                 normalized: bool = False) -> int:
        a = np.ascontiguousarray(arr)
        n = a.shape[0]
        width = 1 if a.ndim == 1 else a.shape[1]
        dtype = {FLOAT: "<f4", USHORT: "<u2", UINT: "<u4", UBYTE: "u1"}[component]
        data = a.astype(dtype).tobytes()
        acc = {"bufferView": self._view(data, target), "componentType": component, "count": int(n), "type": _TYPES[width]}
        if normalized:
            acc["normalized"] = True
        if minmax:
            m = a.reshape(n, width).astype(np.float64)
            acc["min"] = [float(np.float32(v)) for v in m.min(axis=0)]
            acc["max"] = [float(np.float32(v)) for v in m.max(axis=0)]
        self.gltf["accessors"].append(acc)
        return len(self.gltf["accessors"]) - 1

    def material(self, name: str, color=(1.0, 1.0, 1.0, 1.0), rough: float = 0.8, metal: float = 0.0,
                 double_sided: bool = False, extras: dict | None = None) -> int:
        m = {"name": name, "pbrMetallicRoughness": {"baseColorFactor": list(color), "metallicFactor": metal, "roughnessFactor": rough}}
        if double_sided:
            m["doubleSided"] = True
        if extras:
            m["extras"] = extras
        self.gltf["materials"].append(m)
        return len(self.gltf["materials"]) - 1

    def mesh(self, name: str, positions: np.ndarray, normals: np.ndarray, indices: np.ndarray,
             material: int, extra_attributes: dict | None = None, extras: dict | None = None) -> int:
        attrs = {
            "POSITION": self.accessor(positions.astype(np.float32), FLOAT, ARRAY_BUFFER, minmax=True),
            "NORMAL": self.accessor(normals.astype(np.float32), FLOAT, ARRAY_BUFFER),
        }
        for k, (arr, comp, norm) in (extra_attributes or {}).items():
            attrs[k] = self.accessor(arr, comp, ARRAY_BUFFER, normalized=norm)
        comp = USHORT if positions.shape[0] < 65536 else UINT
        prim = {"attributes": attrs, "indices": self.accessor(indices.reshape(-1), comp, ELEMENT_ARRAY_BUFFER), "material": material, "mode": 4}
        m = {"name": name, "primitives": [prim]}
        if extras:
            m["extras"] = extras
        self.gltf["meshes"].append(m)
        return len(self.gltf["meshes"]) - 1

    def node(self, name: str, mesh: int | None = None, children: list[int] | None = None,
             translation=None, extras: dict | None = None, root: bool = False) -> int:
        n: dict = {"name": name}
        if mesh is not None:
            n["mesh"] = mesh
        if children:
            n["children"] = children
        if translation is not None:
            n["translation"] = [float(v) for v in translation]
        if extras:
            n["extras"] = extras
        self.gltf["nodes"].append(n)
        idx = len(self.gltf["nodes"]) - 1
        if root:
            self.gltf["scenes"][0]["nodes"].append(idx)
        return idx

    def write(self, path: str) -> None:
        while len(self.bin) % 4:
            self.bin.append(0)
        self.gltf["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
        while len(js) % 4:
            js += b" "
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack("<II", len(self.bin), 0x004E4942))
            f.write(bytes(self.bin))


def to_gltf(v: np.ndarray) -> np.ndarray:
    """Blender (x, y fwd, z up) -> glTF (x, y up, z back): (x, z, -y)."""
    v = np.asarray(v, dtype=np.float64)
    out = np.empty_like(v)
    out[..., 0] = v[..., 0]
    out[..., 1] = v[..., 2]
    out[..., 2] = -v[..., 1]
    return out


def quat_to_gltf(q: np.ndarray) -> np.ndarray:
    """A rotation quaternion (x, y, z, w) in Blender's frame, expressed in glTF's frame."""
    q = np.asarray(q, dtype=np.float64)
    out = np.empty_like(q)
    out[..., 0] = q[..., 0]
    out[..., 1] = q[..., 2]
    out[..., 2] = -q[..., 1]
    out[..., 3] = q[..., 3]
    return out
