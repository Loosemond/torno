"""Exact-geometry queries, answered by the worker that holds the built shapes."""

import math
import re
from typing import Any

from . import topo
from .describe import descriptor

_SUBSHAPE = re.compile(r"^(?P<key>.+)/(?P<kind>[FE])(?P<index>\d+)$")
# No part has a face or an edge of a million: a longer number is not one, and
# one of thousands of digits is more than int() takes.
_INDEX_DIGITS = 6


class QueryError(Exception):
    """A query could not be answered. ``kind`` is a protocol error kind."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def run(
    shapes: dict[str, Any], name: str, args: Any, kept: dict[Any, Any] | None = None
) -> dict[str, Any]:
    """Answer the query ``name`` over the shapes of the last build, by part key.

    ``kept`` is where what was worked out of a part is kept from one query to
    the next: a worker hands in the same dict for as long as it lives, which
    is as long as its shapes are the ones asked about. ``nearest`` keeps a
    part's surface under its key; the others keep theirs under a pair
    ``(what, key)``.
    """
    # It builds on what is below, so it is imported once that is defined.
    from . import measure

    if not isinstance(args, dict):
        args = {}
    if name == "measure":
        return measure.measure(shapes, args, kept)
    if name == "describe":
        ref = args.get("ref")
        if not isinstance(ref, str):
            raise QueryError("bad_request", "describe needs args.ref, a string")
        return describe(shapes, ref)
    if name == "nearest":
        layout, anchors = args.get("layout"), args.get("anchors")
        if not isinstance(layout, str) or not isinstance(anchors, list):
            raise QueryError(
                "bad_request", "nearest needs args.layout, a string, and args.anchors, a list"
            )
        return {"anchors": nearest(shapes, layout, anchors, kept)}
    raise QueryError(
        "bad_request",
        f"unknown query {name!r}; the queries are describe, nearest and measure",
    )


def describe(shapes: dict[str, Any], ref: str) -> dict[str, Any]:
    """Describe a part (``layout:name``), or one of its faces (``/F<i>``) or edges (``/E<i>``).

    Positions and directions are in the object frame. ``descriptor`` says the
    same in one line.
    """
    key, kind, shape = resolve(shapes, ref)
    if kind == "part":
        return _describe_part(key, shape)
    if kind == "face":
        return _describe_face(ref, shape)
    return _describe_edge(ref, shape)


def resolve(shapes: dict[str, Any], ref: str) -> tuple[str, str, Any]:
    """What ``ref`` names: its part's key, ``part``, ``face`` or ``edge``, and the shape.

    A part is the shape the model made; a face or an edge is the ``TopoDS``
    one of that index in the kernel's order (``topo``). Anything else is a
    ``bad_ref`` that names what there is.
    """
    if ref in shapes:
        return ref, "part", shapes[ref]
    match = _SUBSHAPE.match(ref)
    key = match["key"] if match else ref
    if key not in shapes:
        raise QueryError("bad_ref", f"no part {key!r}; the parts are {', '.join(shapes)}")
    shape = shapes[key]
    index = _index(match)
    if match["kind"] == "F":
        return key, "face", _pick(topo.faces(shape), index, key, "faces", "F")
    return key, "edge", _pick(topo.edges(shape), index, key, "edges", "E")


def need_layout(shapes: dict[str, Any], layout: str) -> None:
    """Refuse a layout the build does not have, naming those it has."""
    if not any(key.startswith(f"{layout}:") for key in shapes):
        layouts = list(dict.fromkeys(key.split(":", 1)[0] for key in shapes))
        raise QueryError("bad_ref", f"no layout {layout!r}; the layouts are {', '.join(layouts)}")


def need_part(shapes: dict[str, Any], layout: str, part: str) -> Any:
    """The shape of ``part`` in ``layout``, or a ``bad_ref`` naming the layout's parts."""
    need_layout(shapes, layout)
    key = f"{layout}:{part}"
    if key not in shapes:
        names = [k.split(":", 1)[1] for k in shapes if k.startswith(f"{layout}:")]
        raise QueryError("bad_ref", f"no part {part!r} in {layout}; its parts are {', '.join(names)}")
    return shapes[key]


def as_point(value: Any) -> list[float] | None:
    """Three finite numbers as floats, or None for anything else."""
    if isinstance(value, list) and len(value) == 3 and all(_is_coordinate(c) for c in value):
        return [float(c) for c in value]
    return None


def nearest(
    shapes: dict[str, Any],
    layout: str,
    anchors: list[Any],
    kept: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """For each anchor, the point of its part's surface nearest to it in ``layout``.

    An anchor is ``{"part": name, "point": [x, y, z]}``, in the object frame of
    that layout. The answer names the face the nearest point is on (without the
    layout: ``lid/F12``), with the point, the face's outward normal there, the
    distance between the two in mm, and the face's descriptor (null for a
    face that cannot be described). Where the nearest point is on an edge or a
    corner, the face is the adjacent one of lowest index. A part the layout
    does not have is ``found: false``. A part it has, of which nothing can be
    said for this point, is ``found: true`` with ``error``, a sentence, and
    nothing else: one such anchor does not fail the others.

    ``support`` says what the nearest point lies on: ``face``, ``edge`` or
    ``vertex``. On an edge, which is where two faces or more meet (a seam,
    where a face meets itself, counts as its face), ``edgeUnder`` is the edge
    (``lid/E40``), ``edgeUnderDescriptor`` what it is (null when it cannot be
    described) and ``between`` the faces that meet there, lowest first.

    An anchor may also name an edge of its part (``"edge": "lid/E3"``), as one
    that was put on an edge does. Its answer then says whether the part has
    that edge (``edgeFound``) and, when it has, how far the anchor's point is
    from it (``edgeDistance``, mm), what it is (``edgeDescriptor``) and the
    faces that meet at it (``edgeBetween``). Edges are numbered anew by every
    build: the distance is what tells whether the number still means the edge
    the anchor was put on.

    ``kept`` holds what was worked out of each part asked about (``run``).
    """
    need_layout(shapes, layout)
    wanted = [_anchor(anchor) for anchor in anchors]
    # A part is asked about once per mark on it, and again after every build
    # of another object, every mark added: taking it apart is done once.
    surfaces: dict[str, Any] = {} if kept is None else kept
    found = []
    for part, point, edge in wanted:
        key = f"{layout}:{part}"
        if key not in shapes:
            found.append({"part": part, "found": False})
            continue
        if key not in surfaces:
            surfaces[key] = _Surface(shapes[key])
        try:
            answer = {"part": part, "found": True, **surfaces[key].nearest(part, key, point)}
        except QueryError as e:
            # Of this point nothing can be said; the other anchors are answered all the same.
            found.append({"part": part, "found": True, "error": e.message})
            continue
        if edge is not None:
            answer.update(surfaces[key].edge(part, key, edge, point))
        found.append(answer)
    return found


def _anchor(anchor: Any) -> tuple[str, list[float], str | None]:
    part = anchor.get("part") if isinstance(anchor, dict) else None
    point = anchor.get("point") if isinstance(anchor, dict) else None
    edge = anchor.get("edge") if isinstance(anchor, dict) else None
    if (
        not isinstance(part, str)
        or not isinstance(point, list)
        or len(point) != 3
        or not all(_is_coordinate(c) for c in point)
        or not (edge is None or isinstance(edge, str))
    ):
        raise QueryError(
            "bad_request",
            "each anchor of nearest needs part, a string, and point, three finite numbers; "
            "edge, if it names one, is a string",
        )
    return part, [float(c) for c in point], edge


def _is_coordinate(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


class _Surface:
    """A part's faces, and which of them meet at each of its edges and corners."""

    def __init__(self, shape: Any) -> None:
        # OCP comes from the user's workspace, so it is imported only when used.
        # ocp_tessellate's shims paper over the names OCP 8 changed.
        from ocp_tessellate.ocp_utils import (
            TopAbs_EDGE,
            TopAbs_FACE,
            TopAbs_VERTEX,
            TopExp,
            TopTools_IndexedMapOfShape,
        )

        self._shape = getattr(shape, "wrapped", shape)
        self._faces = topo.faces(shape)
        # The same map topo.faces walks, so an index here is an index there.
        self._index = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(self._shape, TopAbs_FACE, self._index)
        self._kinds = {"edge": TopAbs_EDGE, "vertex": TopAbs_VERTEX}
        self._around: dict[str, Any] = {}  # faces around each edge, and each vertex, once asked
        self._descriptors: dict[int, str | None] = {}
        self._extrema: Any = None  # holds the part taken apart and boxed, once asked
        self._edges: list[Any] | None = None  # in the kernel's order, once an anchor names one
        self._edge_index: Any = None  # the map topo.edges walks, once a point is on an edge
        self._edge_descriptors: dict[int, str | None] = {}

    def nearest(self, part: str, key: str, point: list[float]) -> dict[str, Any]:
        from build123d import Face, Vector
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape
        from OCP.gp import gp_Pnt

        if self._extrema is None:
            # The part is the first shape, loaded once: taking it apart and
            # boxing its faces is most of the work, and is the same for every
            # point asked about.
            self._extrema = BRepExtrema_DistShapeShape()
            self._extrema.LoadS1(self._shape)
        extrema = self._extrema
        extrema.LoadS2(BRepBuilderAPI_MakeVertex(gp_Pnt(*point)).Vertex())
        if not extrema.Perform() or extrema.NbSolution() < 1:
            raise QueryError("exception", f"no nearest point on {key} could be computed")
        # Several points may be equally near (the middle of a slot): the one on
        # the face of lowest index is taken, so the answer does not change
        # from one build to the next.
        index, on = min(
            (self._face_under(key, extrema.SupportTypeShape1(i), extrema.SupportOnShape1(i)), i)
            for i in range(1, extrema.NbSolution() + 1)
        )
        at = extrema.PointOnShape1(on)
        at = Vector(at.X(), at.Y(), at.Z())
        try:
            normal = _xyz(Face(self._faces[index]).normal_at(at))
        except Exception:
            normal = None
        return {
            "point": _xyz(at),
            "normal": normal,
            "ref": f"{part}/F{index}",
            "distance": float(extrema.Value()),
            "descriptor": self._descriptor(key, index),
            **self._support(part, key, extrema.SupportTypeShape1(on), extrema.SupportOnShape1(on)),
        }

    def _support(self, part: str, key: str, support_type: Any, support: Any) -> dict[str, Any]:
        """What a nearest point lies on, and of an edge which it is and the faces that meet there."""
        from OCP.BRepExtrema import BRepExtrema_SupportType

        if support_type == BRepExtrema_SupportType.BRepExtrema_IsInFace:
            return {"support": "face"}
        if support_type != BRepExtrema_SupportType.BRepExtrema_IsOnEdge:
            return {"support": "vertex"}
        between = self._between(part, support)
        index = self._edge_number(support)
        # A seam has one face on both sides; an edge the map does not have is not named.
        if len(between) < 2 or index is None:
            return {"support": "face"}
        return {
            "support": "edge",
            "edgeUnder": f"{part}/E{index}",
            "edgeUnderDescriptor": self._edge_descriptor(key, index, support),
            "between": between,
        }

    def _between(self, part: str, edge: Any) -> list[str]:
        """The faces that meet at an edge, as refs, lowest first, each once."""
        around = self._faces_around("edge")
        faces = around.FindFromKey(edge) if around.Contains(edge) else []
        numbers = sorted({self._index.FindIndex(face) for face in faces} - {0})
        return [f"{part}/F{number - 1}" for number in numbers]

    def _edge_number(self, edge: Any) -> int | None:
        """The index of an edge in the kernel's order, or None for one the part does not have."""
        from ocp_tessellate.ocp_utils import TopAbs_EDGE, TopExp, TopTools_IndexedMapOfShape

        if self._edge_index is None:
            # The same map topo.edges walks, so an index here is an index there.
            self._edge_index = TopTools_IndexedMapOfShape()
            TopExp.MapShapes_s(self._shape, TopAbs_EDGE, self._edge_index)
        number = self._edge_index.FindIndex(edge)
        return number - 1 if number >= 1 else None

    def _edge_descriptor(self, key: str, index: int, edge: Any) -> str | None:
        """The descriptor of an edge, or None for one that cannot be described."""
        if index not in self._edge_descriptors:
            try:
                described = _describe_edge(f"{key}/E{index}", edge)["descriptor"]
            except Exception:
                described = None
            self._edge_descriptors[index] = described
        return self._edge_descriptors[index]

    def edge(self, part: str, key: str, ref: str, point: list[float]) -> dict[str, Any]:
        """How far ``point`` is from the edge ``ref`` (``part/E<i>``) names, if the part has it."""
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape
        from OCP.gp import gp_Pnt

        match = _SUBSHAPE.match(ref)
        if not match or match["key"] != part or match["kind"] != "E":
            return {"edgeFound": False}
        if self._edges is None:
            self._edges = topo.edges(self._shape)
        index = _index(match)
        if index >= len(self._edges):
            return {"edgeFound": False}
        edge = self._edges[index]
        try:
            vertex = BRepBuilderAPI_MakeVertex(gp_Pnt(*point)).Vertex()
            extrema = BRepExtrema_DistShapeShape(vertex, edge)
            measured = extrema.IsDone() and extrema.NbSolution() >= 1
        except Exception:
            measured = False
        if not measured:
            # An edge with no curve, such as a sphere's pole: nothing can be said to be on it.
            return {"edgeFound": False}
        return {
            "edgeFound": True,
            "edgeDistance": float(extrema.Value()),
            "edgeDescriptor": self._edge_descriptor(key, index, edge),
            "edgeBetween": self._between(part, edge),
        }

    def _descriptor(self, key: str, index: int) -> str | None:
        """The descriptor of a face, or None for one that cannot be described."""
        if index not in self._descriptors:
            try:
                described = _describe_face(f"{key}/F{index}", self._faces[index])["descriptor"]
            except Exception:
                # One odd face is not a reason to say nothing of the other anchors.
                described = None
            self._descriptors[index] = described
        return self._descriptors[index]

    def _face_under(self, key: str, support_type: Any, support: Any) -> int:
        """The index of the face a nearest point is on: of the lowest, on an edge or a corner."""
        from OCP.BRepExtrema import BRepExtrema_SupportType

        if support_type == BRepExtrema_SupportType.BRepExtrema_IsInFace:
            numbers = [self._index.FindIndex(support)]
        else:
            on_edge = support_type == BRepExtrema_SupportType.BRepExtrema_IsOnEdge
            around = self._faces_around("edge" if on_edge else "vertex")
            # Nothing around it when the edge or the corner is of no face: a wire in the part.
            faces = around.FindFromKey(support) if around.Contains(support) else []
            numbers = [self._index.FindIndex(face) for face in faces]
        # FindIndex answers 0 for a shape the map does not have: taken as an
        # index that would be -1, the last face.
        if not numbers or min(numbers) < 1:
            raise QueryError(
                "exception",
                f"the point of {key} nearest to the anchor is on none of its faces",
            )
        return min(numbers) - 1

    def _faces_around(self, kind: str) -> Any:
        from ocp_tessellate.ocp_utils import (
            TopAbs_FACE,
            TopExp,
            TopTools_IndexedDataMapOfShapeListOfShape,
        )

        if kind not in self._around:
            self._around[kind] = TopTools_IndexedDataMapOfShapeListOfShape()
            TopExp.MapShapesAndAncestors_s(
                self._shape, self._kinds[kind], TopAbs_FACE, self._around[kind]
            )
        return self._around[kind]


def _index(match: re.Match[str]) -> int:
    """The number a ref ends in; one too long to be the number of anything is past every list."""
    digits = match["index"]
    return int(digits) if len(digits) <= _INDEX_DIGITS else 10**_INDEX_DIGITS


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
    facts = {
        "kind": "part",
        "key": key,
        "bbox": {"min": _xyz(box.min), "max": _xyz(box.max)},
        "volume": float(shape.volume),
        "area": float(shape.area),
        "faceCount": len(topo.faces(shape)),
        "edgeCount": len(topo.edges(shape)),
        "valid": bool(shape.is_valid),
    }
    return {**facts, "descriptor": descriptor("part", facts)}


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
    try:
        # None unless the face is a surface of revolution; the descriptor wants a cylinder's.
        axis = face.axis_of_rotation
        axis = None if axis is None else _xyz(axis.direction)
    except Exception:
        axis = None
    facts = {
        "kind": "face",
        "ref": ref,
        "type": face.geom_type.name.lower(),
        "area": float(face.area),
        "center": _xyz(center),
        "normal": normal,
        "radius": None if radius is None else float(radius),
    }
    return {**facts, "descriptor": descriptor("face", {**facts, "axis": axis})}


def _describe_edge(ref: str, topods_edge: Any) -> dict[str, Any]:
    from build123d import Edge

    edge = Edge(topods_edge)
    try:
        center = _xyz(edge.center())
    except Exception:
        # A degenerate edge, such as a sphere's pole, has no curve: it is a point.
        center = _xyz(edge.vertices()[0].center())
    try:
        radius = float(edge.radius)  # of a circle; anything else has none
    except Exception:
        radius = None
    facts = {
        "kind": "edge",
        "ref": ref,
        "type": edge.geom_type.name.lower(),
        "length": float(edge.length),
        "center": center,
    }
    return {**facts, "descriptor": descriptor("edge", {**facts, "radius": radius})}


def _xyz(vector: Any) -> list[float]:
    # Adding 0.0 turns -0.0 into 0.0.
    return [float(vector.X) + 0.0, float(vector.Y) + 0.0, float(vector.Z) + 0.0]
