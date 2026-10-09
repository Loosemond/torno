"""``mesh.bin`` and ``.mask``: what a scan is on the disk. numpy only.

A ``mesh.bin`` is 64 bytes of header, the vertices (float32 x y z, mm, Z up, in
the scan's own frame), when the scan has colours one RGBA byte quad a vertex,
and the triangles (uint32, three vertex numbers each). Little-endian. The
import process writes it; the build worker, main and the window read it.
"""

import os
import struct
from pathlib import Path
from typing import Any

import numpy as np

MAGIC = b"TORNOSCN"
MASK_MAGIC = b"TORNOMSK"
VERSION = 1
HEADER = 64
_HEAD = struct.Struct("<8sIIII6f16x")
_MASK_HEAD = struct.Struct("<8sII")


def area_of(vertices: np.ndarray, triangles: np.ndarray) -> float:
    """The area of a mesh, mm²."""
    corners = np.asarray(vertices, dtype=np.float64)[np.asarray(triangles, dtype=np.int64)]
    return float(np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]), axis=1).sum() / 2)


def write_bin(path: str | Path, vertices: np.ndarray, triangles: np.ndarray, colours: np.ndarray | None = None) -> dict[str, Any]:
    """Write a mesh as ``mesh.bin`` and say what was written. Readers see the old file or the new one."""
    v = np.ascontiguousarray(vertices, dtype="<f4").reshape(-1, 3)
    t = np.ascontiguousarray(triangles, dtype="<u4").reshape(-1, 3)
    if len(v) == 0 or len(t) == 0:
        raise ValueError("a scan needs vertices and triangles")
    if int(t.max()) >= len(v):
        raise ValueError(f"a triangle names vertex {int(t.max())}, and there are {len(v)}")
    if not np.isfinite(v).all():
        raise ValueError("a vertex is not finite")
    c = None if colours is None else np.ascontiguousarray(colours, dtype=np.uint8).reshape(-1, 4)
    if c is not None and len(c) != len(v):
        raise ValueError(f"{len(c)} colours for {len(v)} vertices")
    low, high = v.min(axis=0), v.max(axis=0)
    temp = Path(f"{path}.{os.getpid()}.tmp")
    try:
        with open(temp, "wb") as out:
            out.write(_HEAD.pack(MAGIC, VERSION, 0 if c is None else 1, len(v), len(t), *map(float, low), *map(float, high)))
            out.write(v.tobytes())
            if c is not None:
                out.write(c.tobytes())
            out.write(t.tobytes())
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)
    box = {"min": [float(x) for x in low], "max": [float(x) for x in high]}
    return {"vertices": len(v), "triangles": len(t), "bbox": box, "area": area_of(v, t)}


def read_bin(path: str | Path) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """The vertices (V, 3), the triangles (T, 3) and the colours (V, 4) or None of a ``mesh.bin``."""
    raw = Path(path).read_bytes()
    if len(raw) < HEADER or raw[:8] != MAGIC:
        raise ValueError(f"{path} is not a scan torno wrote")
    _, version, flags, count, faces, *_ = _HEAD.unpack_from(raw)
    if version != VERSION:
        raise ValueError(f"{path} is of version {version}; this torno reads version {VERSION}")
    coloured = bool(flags & 1)
    expected = HEADER + 12 * count + (4 * count if coloured else 0) + 12 * faces
    if len(raw) != expected:
        raise ValueError(f"{path} has {len(raw)} bytes, and its header says {expected}")
    vertices = np.frombuffer(raw, "<f4", 3 * count, HEADER).reshape(-1, 3)
    at = HEADER + 12 * count
    colours = np.frombuffer(raw, np.uint8, 4 * count, at).reshape(-1, 4) if coloured else None
    triangles = np.frombuffer(raw, "<u4", 3 * faces, at + (4 * count if coloured else 0)).reshape(-1, 3)
    return vertices, triangles, colours


def write_mask(path: str | Path, bits: np.ndarray) -> None:
    """Write which triangles a region has: one bit each, bit ``i & 7`` of byte ``i >> 3``."""
    bits = np.asarray(bits, dtype=bool).reshape(-1)
    Path(path).write_bytes(_MASK_HEAD.pack(MASK_MAGIC, VERSION, len(bits)) + np.packbits(bits, bitorder="little").tobytes())


def read_mask(path: str | Path, triangles: int) -> np.ndarray:
    """The triangles of a region, as one bool each, for a mesh of ``triangles`` triangles."""
    raw = Path(path).read_bytes()
    if len(raw) < _MASK_HEAD.size or raw[:8] != MASK_MAGIC:
        raise ValueError(f"{path} is not a region torno wrote")
    _, version, count = _MASK_HEAD.unpack_from(raw)
    if version != VERSION:
        raise ValueError(f"{path} is of version {version}; this torno reads version {VERSION}")
    if count != triangles or len(raw) != _MASK_HEAD.size + (count + 7) // 8:
        raise ValueError(f"{path} is of a mesh of {count} triangles, not {triangles}")
    return np.unpackbits(np.frombuffer(raw, np.uint8, offset=_MASK_HEAD.size), bitorder="little")[:count].astype(bool)
