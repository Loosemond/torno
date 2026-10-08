"""Tessellate a loaded scene into the Scene JSON and its binary blob."""

import hashlib
from typing import Any

import numpy as np

DEVIATION = 0.1
ANGULAR_TOLERANCE = 0.2

# Scene mesh key → (ocp-tessellate key, little-endian dtype in the blob).
_BUFFERS = {
    "vertices": ("vertices", "<f4"),
    "normals": ("normals", "<f4"),
    "triangles": ("triangles", "<u4"),
    "edges": ("edges", "<f4"),
    "trianglesPerFace": ("triangles_per_face", "<u4"),
    "segmentsPerEdge": ("segments_per_edge", "<u4"),
    "faceTypes": ("face_types", "<u4"),
    "edgeTypes": ("edge_types", "<u4"),
}


def build_scene(
    layouts: dict[str, dict[str, Any]], model: str
) -> tuple[dict[str, Any], bytes, dict[str, Any]]:
    """Tessellate every part of every layout.

    Returns the Scene dict (without ``seconds`` and ``output``), the blob its
    buffers point into, and the shapes by part key, in the object frame, for
    queries.
    """
    blob = bytearray()
    parts = []
    shapes = {}
    for layout, named in layouts.items():
        # One layout at a time, so a name may repeat across layouts.
        for name, shape, mesh, loc, cache_id in _tessellate(named):
            key = f"{layout}:{name}"
            shapes[key] = shape
            parts.append(_part(key, name, layout, shape, mesh, loc, cache_id, blob))
    scene = {"model": model, "layouts": list(layouts), "parts": parts}
    return scene, bytes(blob), shapes


def _tessellate(named: dict[str, Any]) -> list[tuple[str, Any, dict, Any, str | None]]:
    """Mesh one layout: (name, shape, mesh arrays, loc, cache id) per part."""
    # ocp-tessellate needs OCP from the user's workspace, so it is imported only here.
    from ocp_tessellate.convert import tessellate_group, to_ocpgroup

    names = list(named)
    group, instances = to_ocpgroup(*named.values(), names=names)
    meshed, tree, mapping = tessellate_group(
        group,
        instances,
        kwargs={"deviation": DEVIATION, "angular_tolerance": ANGULAR_TOLERANCE},
    )
    nodes = tree["parts"]
    if len(nodes) != len(names) or any("shape" not in node for node in nodes):
        raise ValueError(
            f"expected one solid shape per part for {', '.join(names)}; "
            "a part that is not a single shape cannot be shown"
        )
    return [
        (
            name,
            named[name],
            meshed[node["shape"]["ref"]],
            node["loc"],
            mapped.get("shape", {}).get("cache_id"),
        )
        for name, node, mapped in zip(names, nodes, mapping["parts"], strict=True)
    ]


def _part(
    key: str,
    name: str,
    layout: str,
    shape: Any,
    mesh: dict[str, np.ndarray],
    loc: Any,
    cache_id: str | None,
    blob: bytearray,
) -> dict[str, Any]:
    t = [float(x) for x in loc[0]]
    q = [float(x) for x in loc[1]]
    arrays = {
        scene_key: np.ascontiguousarray(mesh[source]).astype(dtype, copy=False).ravel()
        for scene_key, (source, dtype) in _BUFFERS.items()
    }
    vertices = arrays["vertices"]
    return {
        "key": key,
        "name": name,
        "layout": layout,
        "loc": {"t": t, "q": q},
        "bbox": _bbox(vertices, t, q),
        "volume": float(shape.volume),
        "faceCount": len(arrays["trianglesPerFace"]),
        "edgeCount": len(arrays["segmentsPerEdge"]),
        "triangleCount": len(arrays["triangles"]) // 3,
        "valid": bool(shape.is_valid),
        "hash": cache_id or hashlib.sha256(vertices.tobytes()).hexdigest(),
        "mesh": {scene_key: _append(blob, array) for scene_key, array in arrays.items()},
    }


def _append(blob: bytearray, array: np.ndarray) -> dict[str, int]:
    """Add an array to the blob on a 4-byte boundary and return its Buf."""
    blob.extend(b"\0" * (-len(blob) % 4))
    data = array.tobytes()
    buf = {"offset": len(blob), "length": len(data)}
    blob.extend(data)
    return buf


def _bbox(vertices: np.ndarray, t: list[float], q: list[float]) -> dict[str, list[float]]:
    """Bounding box of part-local vertices after the pose, in the object frame."""
    points = vertices.reshape(-1, 3).astype(np.float64) @ _rotation(q).T + np.array(t)
    return {"min": points.min(axis=0).tolist(), "max": points.max(axis=0).tolist()}


def _rotation(q: list[float]) -> np.ndarray:
    """Rotation matrix of a unit quaternion given as xyzw."""
    x, y, z, w = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )
