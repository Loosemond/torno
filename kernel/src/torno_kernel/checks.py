"""What is wrong between two parts or with one: the ``check`` query.

``overlap`` and ``clearance`` are of the B-rep, exact. ``mesh`` is of the
tessellation the part is drawn and exported with, since that is what a slicer
is given: a hole in it is a hole in the print, whatever the solid says.
"""

from typing import Any

import numpy as np

from . import tess, topo
from .queries import QueryError, need_part

KINDS = ("overlap", "clearance", "mesh")
# Vertices of the mesh closer than this are one, mm: the rule slicers and viewers weld by.
WELD = 1e-4
# No more open edges than this are located.
MAX_WHERE = 20
# Less shared volume than this, mm³, is none: parts that touch share what tolerance leaves.
_SHARED = 1e-6
# Parts nearer than this, mm, touch.
_TOUCHING = 1e-7


def check(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any] | None) -> dict[str, Any]:
    """Answer ``check``: ``args`` are ``kind``, ``layout``, the part ``a`` and, for two, ``b``.

    - ``overlap``: the ``volume`` the two parts share, mm³, and its ``bbox``,
      null when they share none.
    - ``clearance``: the least ``distance`` between the two, mm, and the
      ``points`` of each it is between. Parts that touch are 0 apart; so are
      parts that share volume, one inside the other included, and those say
      ``overlapping``.
    - ``mesh``: whether the mesh of the part is ``watertight``: its vertices
      welded where they are within 0.0001 mm, how many edges are then of one
      triangle only (``openEdges``), the middles of at most twenty of them
      (``where``, spread over all of them, in the frame of the layout) and
      how many ``triangles`` the mesh has.

    ``kept`` is the worker's (``queries.run``): what two parts share and the
    edges a mesh leaves open are worked out once.
    """
    kind = args.get("kind")
    if kind not in KINDS:
        raise QueryError(
            "bad_request", f"check needs args.kind, one of {', '.join(KINDS[:-1])} and {KINDS[-1]}"
        )
    layout, a, b = args.get("layout"), args.get("a"), args.get("b")
    if not isinstance(layout, str) or not isinstance(a, str):
        raise QueryError(
            "bad_request", "check needs args.layout and args.a, the name of a part of it, both strings"
        )
    held = {} if kept is None else kept
    first = need_part(shapes, layout, a)
    if kind == "mesh":
        return _mesh(first, f"{layout}:{a}", held)
    if not isinstance(b, str):
        raise QueryError("bad_request", f"check {kind} needs args.b, the name of the other part")
    second = need_part(shapes, layout, b)
    if a == b:
        raise QueryError("bad_request", f"check {kind} is of two parts: a and b are both {a!r}")

    def shared() -> dict[str, Any]:
        # What two parts share is the same whichever is named first.
        pair = ("shared", layout, *sorted((a, b)))
        if pair not in held:
            held[pair] = _shared(_topods(first), _topods(second), f"{a} and {b}")
        return held[pair]

    if kind == "overlap":
        return dict(shared())
    return _clearance(_topods(first), _topods(second), f"{a} and {b}", shared)


def _topods(shape: Any) -> Any:
    return getattr(shape, "wrapped", shape)


# Overlap


def _shared(one: Any, other: Any, names: str) -> dict[str, Any]:
    from ocp_tessellate.ocp_utils import Bnd_Box, BRepBndLib, BRepGProp, GProp_GProps

    if _boxes_apart(one, other):
        return {"volume": 0.0, "bbox": None}
    common = _common(one, other)
    if not common.IsDone():
        raise QueryError("exception", f"what {names} share could not be computed")
    measured = GProp_GProps()
    BRepGProp.VolumeProperties_s(common.Shape(), measured)
    volume = abs(float(measured.Mass()))
    if volume < _SHARED:
        return {"volume": volume, "bbox": None}
    box = Bnd_Box()
    # Of the geometry itself: not of a mesh, and not widened by the shape's tolerance.
    BRepBndLib.AddOptimal_s(common.Shape(), box, False, False)
    return {
        "volume": volume,
        "bbox": {"min": _xyz(box.CornerMin()), "max": _xyz(box.CornerMax())},
    }


def _boxes_apart(one: Any, other: Any) -> bool:
    """Whether boxes that hold the two parts are apart: then the parts are, and nothing is cut."""
    from ocp_tessellate.ocp_utils import Bnd_Box, BRepBndLib

    boxes = []
    for shape in (one, other):
        box = Bnd_Box()
        # Of the geometry, which the box may exceed but never falls short of: a
        # box of the mesh could, on a curved face.
        BRepBndLib.Add_s(shape, box, False)
        boxes.append(box)
    return boxes[0].IsVoid() or boxes[1].IsVoid() or boxes[0].IsOut(boxes[1])


def _common(one: Any, other: Any) -> Any:
    """The boolean intersection of two shapes, built once, on every core where OCP lets it be."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common

    try:
        # The name OCP 8 gives the list; before it was TopTools_ListOfShape.
        from OCP.collections import List_TopoDS_Shape as shape_list
    except ImportError:
        try:
            from OCP.TopTools import TopTools_ListOfShape as shape_list
        except ImportError:
            # Given both shapes at once it is built at once, on one core.
            return BRepAlgoAPI_Common(one, other)
    common = BRepAlgoAPI_Common()
    arguments, tools = shape_list(), shape_list()
    arguments.Append(one)
    tools.Append(other)
    common.SetArguments(arguments)
    common.SetTools(tools)
    common.SetRunParallel(True)
    common.Build()
    return common


# Clearance


def _clearance(one: Any, other: Any, names: str, shared: Any) -> dict[str, Any]:
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    extrema = BRepExtrema_DistShapeShape(one, other)
    if not extrema.IsDone() or extrema.NbSolution() < 1:
        raise QueryError("exception", f"no distance between {names} could be computed")
    points = [_xyz(extrema.PointOnShape1(1)), _xyz(extrema.PointOnShape2(1))]
    if extrema.Value() > _TOUCHING:
        # Their surfaces are apart: either the parts are, or one is wholly inside the other.
        within = _point_within(one, other) or _point_within(other, one)
        if within is None:
            return {"distance": float(extrema.Value()), "points": points, "overlapping": False}
        return {"distance": 0.0, "points": [within, within], "overlapping": True}
    # Their surfaces meet: only what they share tells touching from overlapping.
    return {"distance": 0.0, "points": points, "overlapping": shared()["volume"] >= _SHARED}


def _point_within(solid: Any, other: Any) -> list[float] | None:
    """A vertex of ``other``, if it is inside ``solid``: of two parts whose surfaces
    nowhere meet, one such point says the whole of ``other`` is."""
    from ocp_tessellate.ocp_utils import BRep_Tool
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_State

    corners = topo.vertices(other)
    # Only a solid has an inside: a shell that is open holds nothing.
    if not corners or not topo.solids(solid):
        return None
    corner = BRep_Tool.Pnt_s(corners[0])
    try:
        state = BRepClass3d_SolidClassifier(solid, corner, _TOUCHING).State()
    except Exception:
        return None
    return _xyz(corner) if state == TopAbs_State.TopAbs_IN else None


# Mesh


def _mesh(shape: Any, key: str, kept: dict[Any, Any]) -> dict[str, Any]:
    held = ("mesh", key)
    if held not in kept:
        vertices, triangles = tess.mesh_of(shape)
        count, middles = open_edges(vertices, triangles)
        # Spread over all of them: the first twenty would all be in one corner.
        some = np.linspace(0, count - 1, min(count, MAX_WHERE)).astype(int)
        kept[held] = {
            "watertight": count == 0 and len(triangles) > 0,
            "openEdges": count,
            "where": [[float(c) + 0.0 for c in middle] for middle in middles[some]],
            "triangles": len(triangles),
        }
    return dict(kept[held])


def open_edges(vertices: np.ndarray, triangles: np.ndarray) -> tuple[int, np.ndarray]:
    """How many edges of a mesh are of one triangle only, and the middle of each.

    ``vertices`` are N × 3, ``triangles`` M × 3 indices into them. Vertices
    are welded first: those that round to the same point of a grid of WELD
    are one. A mesh is drawn face by face, so its faces share no vertex until
    then; and a triangle that welding leaves with two corners in one place
    has no area and no edges.
    """
    vertices = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    triangles = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    if len(vertices) == 0 or len(triangles) == 0:
        return 0, np.empty((0, 3))
    cells = np.rint(vertices / WELD).astype(np.int64)
    _, first, welded = np.unique(cells, axis=0, return_index=True, return_inverse=True)
    corners = welded.reshape(-1)[triangles]
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    corners = corners[(a != b) & (b != c) & (c != a)]
    sides = np.sort(np.concatenate([corners[:, [0, 1]], corners[:, [1, 2]], corners[:, [2, 0]]]), axis=1)
    edges, uses = np.unique(sides, axis=0, return_counts=True)
    open_ones = edges[uses == 1]
    points = vertices[first]
    return len(open_ones), (points[open_ones[:, 0]] + points[open_ones[:, 1]]) / 2


def _xyz(point: Any) -> list[float]:
    # Adding 0.0 turns -0.0 into 0.0.
    return [point.X() + 0.0, point.Y() + 0.0, point.Z() + 0.0]
