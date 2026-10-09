"""Tessellate a loaded scene into the Scene JSON and its binary blob."""

import hashlib
from typing import Any

import numpy as np

from . import arrange, extent

DEVIATION = 0.1
ANGULAR_TOLERANCE = 0.2
# The layout whose parts are spread out when they overlap (see arrange.spread).
ARRANGED_LAYOUT = "print"

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
    layouts: dict[str, dict[str, Any]], model: str, kept: dict[Any, Any] | None = None
) -> tuple[dict[str, Any], bytes, dict[str, Any]]:
    """Tessellate every part of every layout.

    Returns the Scene dict (without ``seconds`` and ``output``), the blob its
    buffers point into, and the shapes by part key, in the object frame, for
    queries. Into ``kept``, when one is given, goes what was worked out of
    each part that a query would otherwise work out again (``queries.run``):
    its ``volume``, whether it is ``valid`` and the ``deflection`` it was
    drawn with, each under ``(what, key)``.

    Parts of the print layout that overlap are first moved apart along X. The
    shape itself is moved, so the mesh, the bounding box and the shape kept for
    queries all agree; the part says how far in ``arranged``.
    """
    blob = bytearray()
    parts = []
    shapes = {}
    for layout, named in layouts.items():
        moves: dict[str, list[float]] = {}
        if layout == ARRANGED_LAYOUT:
            named, moves = arrange.spread(named)
        # One layout at a time, so a name may repeat across layouts.
        for name, shape, mesh, loc, cache_id, drawn_at in _tessellate(named):
            key = f"{layout}:{name}"
            shapes[key] = shape
            part = _part(key, name, layout, shape, mesh, loc, cache_id, blob)
            if kept is not None:
                kept["volume", key] = part["volume"]
                kept["valid", key] = part["valid"]
                kept["deflection", key] = drawn_at
            if name in moves:
                part["arranged"] = moves[name]
            parts.append(part)
    scene = {"model": model, "layouts": list(layouts), "parts": parts}
    return scene, bytes(blob), shapes


def mesh_of(shape: Any) -> tuple[np.ndarray, np.ndarray]:
    """The mesh one part is drawn with: its vertices in the object frame, and its triangles.

    The same tessellation as the scene's, at the same tolerances, so what is
    found of it is true of what is shown and exported. ocp-tessellate keeps
    the mesh of a shape it has meshed, so asking again costs little.
    """
    [(_, _, mesh, loc, _, _)] = _tessellate({"part": shape})
    vertices = np.asarray(mesh["vertices"]).reshape(-1, 3)
    triangles = np.asarray(mesh["triangles"]).reshape(-1, 3)
    return _posed(vertices, [float(x) for x in loc[0]], [float(x) for x in loc[1]]), triangles


def mesh_faces(shape: Any) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """As ``mesh_of``, with how many of the triangles each face has, in the order of the faces."""
    [(_, _, mesh, loc, _, _)] = _tessellate({"part": shape})
    vertices = np.asarray(mesh["vertices"]).reshape(-1, 3)
    triangles = np.asarray(mesh["triangles"]).reshape(-1, 3)
    per_face = np.asarray(mesh["triangles_per_face"], dtype=np.int64).reshape(-1)
    return _posed(vertices, [float(x) for x in loc[0]], [float(x) for x in loc[1]]), triangles, per_face


def deflection(shape: Any) -> float:
    """How far, in mm, the mesh a part is drawn with may be from its faces.

    Asked of ocp-tessellate itself, of the box it meshes the part by: the
    part's own, before it is posed, so a part turned in its layout is drawn
    as finely as one that is not. 0 for a part with no extent.

    That box is not the same once the part carries a mesh: what a build drew
    a part with is what ``build_scene`` kept of it, not what this says after.
    """
    from ocp_tessellate.convert import to_ocpgroup

    _, instances = to_ocpgroup(shape, names=["part"])
    return _quality(instances[0]["obj"]) if instances else 0.0


def _quality(instance: Any) -> float:
    """The deflection ocp-tessellate meshes one of its instances at, mm."""
    from ocp_tessellate.ocp_utils import bounding_box
    from ocp_tessellate.tessellator import compute_quality

    try:
        box = bounding_box(instance, loc=None, optimal=False)
        return float(compute_quality(box, deviation=DEVIATION))
    except ValueError:
        # A box with a side of no length has no logarithm to round it by.
        return 0.0


def _tessellate(named: dict[str, Any]) -> list[tuple[str, Any, dict, Any, str | None, float]]:
    """Mesh one layout: (name, shape, mesh arrays, loc, cache id, deflection) per part."""
    # ocp-tessellate needs OCP from the user's workspace, so it is imported only here.
    from ocp_tessellate.convert import tessellate_group, to_ocpgroup

    names = list(named)
    group, instances = to_ocpgroup(*named.values(), names=names)
    # Before they are meshed, as ocp-tessellate works it out itself. A part's
    # ref numbers its instance here: ocp-tessellate renumbers them only when it
    # drops one whose mesh is empty, and then a part is missing and this fails below.
    drawn_at = [_quality(instance["obj"]) for instance in instances]
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
            drawn_at[node["shape"]["ref"]],
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
        "volume": extent.volume(shape),
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
    points = _posed(vertices.reshape(-1, 3), t, q)
    return {"min": points.min(axis=0).tolist(), "max": points.max(axis=0).tolist()}


def _posed(points: np.ndarray, t: list[float], q: list[float]) -> np.ndarray:
    """Part-local points after the pose, in the object frame."""
    return points.astype(np.float64) @ _rotation(q).T + np.array(t)


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
