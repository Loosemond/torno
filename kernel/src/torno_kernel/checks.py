"""What is wrong between two parts or with one: the ``check`` query.

``overlap`` and ``clearance`` are of the B-rep, exact. ``mesh`` is of the
tessellation the part is drawn and exported with, since that is what a slicer
is given: a hole in it is a hole in the print, whatever the solid says.
"""

from typing import Any

import numpy as np

from . import extent, tess, topo
from .queries import QueryError, need_part, need_solid

KINDS = ("overlap", "clearance", "mesh")
# Vertices of the mesh within this of each other are one, mm: the rule slicers and viewers weld by.
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
      null when they share none. Both are solids: a shell or a face has no
      volume to share, and is refused.
    - ``clearance``: the least ``distance`` between the two, mm, and the
      ``points`` of each it is between. Parts that touch are 0 apart. Parts
      that share volume, one inside the other included, are 0 apart and
      ``overlapping``, with both points at the centre of mass of what they
      share, which need not be in it (of a ring through a slab it is in the
      ring's hole): it is the same verdict ``overlap`` gives. Of a part that is not a
      solid the distance is told and ``overlapping`` is null. ``how`` says
      which of these it is.
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
        need_solid(first, a)
        need_solid(second, b)
        return {"volume": shared()["volume"], "bbox": shared()["bbox"]}
    not_solid = [name for name, shape in ((a, first), (b, second)) if not topo.solids(shape)]
    return _clearance(_topods(first), _topods(second), f"{a} and {b}", shared, not_solid)


def _topods(shape: Any) -> Any:
    return getattr(shape, "wrapped", shape)


# Overlap


def _shared(one: Any, other: Any, names: str) -> dict[str, Any]:
    """What two solids share: its ``volume``, its ``bbox`` and its centre, ``at``."""
    from ocp_tessellate.ocp_utils import Bnd_Box, BRepBndLib

    if _boxes_apart(one, other):
        return {"volume": 0.0, "bbox": None, "at": None}
    common = _common(one, other)
    if not common.IsDone():
        raise QueryError("exception", f"what {names} share could not be computed")
    volume, centre = extent.volume_and_centre(common.Shape())
    if volume < _SHARED:
        return {"volume": volume, "bbox": None, "at": None}
    box = Bnd_Box()
    # Of the geometry itself: not of a mesh, and not widened by the shape's tolerance.
    BRepBndLib.AddOptimal_s(common.Shape(), box, False, False)
    return {
        "volume": volume,
        "bbox": {"min": _xyz(box.CornerMin()), "max": _xyz(box.CornerMax())},
        "at": _xyz(centre),
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


def _clearance(
    one: Any, other: Any, names: str, shared: Any, not_solid: list[str]
) -> dict[str, Any]:
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    extrema = BRepExtrema_DistShapeShape(one, other)
    if not extrema.IsDone() or extrema.NbSolution() < 1:
        raise QueryError("exception", f"no distance between {names} could be computed")
    between = {
        "distance": float(extrema.Value()) if extrema.Value() > _TOUCHING else 0.0,
        "points": [_xyz(extrema.PointOnShape1(1)), _xyz(extrema.PointOnShape2(1))],
    }
    if not_solid:
        # A shell or a face has no inside: how far apart is all that can be said.
        lacking = "is not a solid" if len(not_solid) == 1 else "are not solids"
        how = f"minimum; {' and '.join(not_solid)} {lacking}, so whether the parts overlap is not told"
        return {**between, "overlapping": None, "how": how}
    # The distance is between surfaces, and is not 0 of a part inside another:
    # what the two share says whether they overlap, as it does for ``overlap``.
    both = shared()
    if both["volume"] >= _SHARED:
        return {
            "distance": 0.0,
            "points": [both["at"], both["at"]],
            "overlapping": True,
            "how": "the parts overlap; the points are the centre of what they share",
        }
    return {**between, "overlapping": False, "how": "minimum"}


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
    are welded first (``_welded``). A mesh is drawn face by face, so its faces
    share no vertex until then; and a triangle that welding leaves with two
    corners in one place has no area and no edges.
    """
    vertices = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    triangles = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    if len(vertices) == 0 or len(triangles) == 0:
        return 0, np.empty((0, 3))
    _, first, welded = np.unique(_welded(vertices), return_index=True, return_inverse=True)
    corners = welded.reshape(-1)[triangles]
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    corners = corners[(a != b) & (b != c) & (c != a)]
    sides = np.sort(np.concatenate([corners[:, [0, 1]], corners[:, [1, 2]], corners[:, [2, 0]]]), axis=1)
    edges, uses = np.unique(sides, axis=0, return_counts=True)
    open_ones = edges[uses == 1]
    points = vertices[first]
    return len(open_ones), (points[open_ones[:, 0]] + points[open_ones[:, 1]]) / 2


def _welded(vertices: np.ndarray) -> np.ndarray:
    """For each vertex a number, the same for vertices that are one.

    Two vertices within WELD of each other are always one. They are found by
    the cell each falls in, of a grid of 2 × WELD; one grid alone would part
    two that lie either side of one of its lines, so eight are used, each
    half a cell from the others along some of the axes: two vertices within
    WELD share a cell of at least one of them. Vertices are one when any grid
    says so, and through others when each is one with the next. None further
    apart than 2 × WELD along an axis are joined otherwise.
    """
    cell = 2 * WELD
    groupings = []
    for shift in np.ndindex(2, 2, 2):
        cells = np.floor(vertices / cell + np.array(shift) / 2).astype(np.int64)
        groupings.append(_numbered(cells))
    labels = groupings[0]
    while True:
        before = labels
        for group in groupings:
            # Every vertex takes the least number in its cell.
            least = np.full(int(group.max()) + 1, len(vertices), dtype=np.int64)
            np.minimum.at(least, group, labels)
            labels = least[group]
        if np.array_equal(labels, before):
            return labels


def _numbered(cells: np.ndarray) -> np.ndarray:
    """A number for each row of N × 3 integers, the same for rows that are equal."""
    cells = cells - cells.min(axis=0)
    spans = [int(span) + 1 for span in cells.max(axis=0)]
    if spans[0] * spans[1] * spans[2] < 2**62:
        # One number says the three: sorting numbers is much quicker than sorting rows.
        packed = (cells[:, 0] * spans[1] + cells[:, 1]) * spans[2] + cells[:, 2]
        return np.unique(packed, return_inverse=True)[1].reshape(-1)
    return np.unique(cells, axis=0, return_inverse=True)[1].reshape(-1)


def _xyz(point: Any) -> list[float]:
    # Adding 0.0 turns -0.0 into 0.0.
    return [point.X() + 0.0, point.Y() + 0.0, point.Z() + 0.0]
