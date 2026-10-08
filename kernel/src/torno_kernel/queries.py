"""Exact-geometry queries, answered by the worker that holds the built shapes."""

import re
from typing import Any

from . import topo

_SUBSHAPE = re.compile(r"^(?P<key>.+)/(?P<kind>[FE])(?P<index>\d+)$")


class QueryError(Exception):
    """A query could not be answered. ``kind`` is a protocol error kind."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def run(shapes: dict[str, Any], name: str, args: Any) -> dict[str, Any]:
    """Answer the query ``name`` over the shapes of the last build, by part key."""
    if name != "describe":
        raise QueryError("bad_request", f"unknown query {name!r}; the only query is describe")
    ref = args.get("ref") if isinstance(args, dict) else None
    if not isinstance(ref, str):
        raise QueryError("bad_request", "describe needs args.ref, a string")
    return describe(shapes, ref)


def describe(shapes: dict[str, Any], ref: str) -> dict[str, Any]:
    """Describe a part (``layout:name``), or one of its faces (``/F<i>``) or edges (``/E<i>``).

    Positions and directions are in the object frame.
    """
    if ref in shapes:
        return _describe_part(ref, shapes[ref])
    match = _SUBSHAPE.match(ref)
    key = match["key"] if match else ref
    if key not in shapes:
        raise QueryError("bad_ref", f"no part {key!r}; the parts are {', '.join(shapes)}")
    shape = shapes[key]
    index = int(match["index"])
    if match["kind"] == "F":
        return _describe_face(ref, _pick(topo.faces(shape), index, key, "faces", "F"))
    return _describe_edge(ref, _pick(topo.edges(shape), index, key, "edges", "E"))


def _pick(items: list[Any], index: int, key: str, plural: str, letter: str) -> Any:
    if index >= len(items):
        raise QueryError(
            "bad_ref",
            f"{key} has {len(items)} {plural}, {letter}0 to {letter}{len(items) - 1}; "
            f"there is no {letter}{index}",
        )
    return items[index]


def _describe_part(key: str, shape: Any) -> dict[str, Any]:
    box = shape.bounding_box()
    return {
        "kind": "part",
        "key": key,
        "bbox": {"min": _xyz(box.min), "max": _xyz(box.max)},
        "volume": float(shape.volume),
        "area": float(shape.area),
        "faceCount": len(topo.faces(shape)),
        "edgeCount": len(topo.edges(shape)),
        "valid": bool(shape.is_valid),
    }


def _describe_face(ref: str, topods_face: Any) -> dict[str, Any]:
    from build123d import Face

    face = Face(topods_face)
    # On a curved face this is the point at the middle of its parameter range,
    # which lies on the surface, so the normal there is well defined.
    center = face.center()
    try:
        normal = _xyz(face.normal_at(center))
    except Exception:
        normal = None
    radius = face.radius  # None unless the face is a cylinder or a sphere
    return {
        "kind": "face",
        "ref": ref,
        "type": face.geom_type.name.lower(),
        "area": float(face.area),
        "center": _xyz(center),
        "normal": normal,
        "radius": None if radius is None else float(radius),
    }


def _describe_edge(ref: str, topods_edge: Any) -> dict[str, Any]:
    from build123d import Edge

    edge = Edge(topods_edge)
    try:
        center = _xyz(edge.center())
    except Exception:
        # A degenerate edge, such as a sphere's pole, has no curve: it is a point.
        center = _xyz(edge.vertices()[0].center())
    return {
        "kind": "edge",
        "ref": ref,
        "type": edge.geom_type.name.lower(),
        "length": float(edge.length),
        "center": center,
    }


def _xyz(vector: Any) -> list[float]:
    # Adding 0.0 turns -0.0 into 0.0.
    return [float(vector.X) + 0.0, float(vector.Y) + 0.0, float(vector.Z) + 0.0]
