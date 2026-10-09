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
    area = area_of(v, t)
    if not area > 0:
        raise ValueError("a scan with no area: every triangle of it is a point or a line")
    low, high = v.min(axis=0), v.max(axis=0)
    head = _HEAD.pack(MAGIC, VERSION, 0 if c is None else 1, len(v), len(t), *map(float, low), *map(float, high))
    _replaced(path, [head, v.tobytes(), b"" if c is None else c.tobytes(), t.tobytes()])
    box = {"min": [float(x) for x in low], "max": [float(x) for x in high]}
    return {"vertices": len(v), "triangles": len(t), "bbox": box, "area": area}


def _replaced(path: str | Path, parts: list[bytes]) -> None:
    """Write a file through a temporary one beside it: a reader sees the old file or the new one, whole."""
    temp = Path(f"{path}.{os.getpid()}.tmp")
    try:
        with open(temp, "wb") as out:
            for part in parts:
                out.write(part)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def read_bin(path: str | Path) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """The vertices (V, 3), the triangles (T, 3) and the colours (V, 4) or None of a ``mesh.bin``.

    A file whose bytes are not a mesh is a ``ValueError``: one of another
    length than its header says, one with a triangle that names no vertex,
    one with a vertex that is no number. What is returned can be indexed
    without looking again.
    """
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
    if count == 0 or faces == 0:
        raise ValueError(f"{path} has no vertices or no triangles")
    if int(triangles.max()) >= count:
        raise ValueError(f"in {path} a triangle names vertex {int(triangles.max())}, and there are {count}")
    if not np.isfinite(vertices).all():
        raise ValueError(f"in {path} a vertex is not finite")
    return vertices, triangles, colours


def write_mask(path: str | Path, bits: np.ndarray) -> None:
    """Write which triangles a region has: one bit each, bit ``i & 7`` of byte ``i >> 3``. Whole, or not at all."""
    bits = np.asarray(bits, dtype=bool).reshape(-1)
    _replaced(path, [_MASK_HEAD.pack(MASK_MAGIC, VERSION, len(bits)), np.packbits(bits, bitorder="little").tobytes()])


def read_mask(path: str | Path, triangles: int) -> np.ndarray:
    """The triangles of a region, as one bool each, for a mesh of ``triangles`` triangles."""
    raw = Path(path).read_bytes()
    if raw[:8] != MASK_MAGIC[: len(raw)] or not raw:
        raise ValueError(f"{path} is not a region torno wrote")
    if len(raw) < _MASK_HEAD.size:
        raise ValueError(f"{path} is truncated: {len(raw)} bytes, fewer than its header has")
    _, version, count = _MASK_HEAD.unpack_from(raw)
    if version != VERSION:
        raise ValueError(f"{path} is of version {version}; this torno reads version {VERSION}")
    if count != triangles:
        raise ValueError(f"{path} is of a mesh of {count} triangles, not {triangles}")
    expected = _MASK_HEAD.size + (count + 7) // 8
    if len(raw) != expected:
        raise ValueError(f"{path} {'is truncated' if len(raw) < expected else 'is too long'}: {len(raw)} bytes, and its header says {expected}")
    return np.unpackbits(np.frombuffer(raw, np.uint8, offset=_MASK_HEAD.size), bitorder="little")[:count].astype(bool)
