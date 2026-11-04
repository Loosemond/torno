"""What is wrong between two parts or with one: the ``check`` query.

``overlap`` and ``clearance`` are of the B-rep: a distance is exact, and a
shared volume as a part's is (``extent``). ``mesh`` is of the
tessellation the part is drawn and exported with, since that is what a slicer
is given: a hole in it is a hole in the print, whatever the solid says.
"""

from typing import Any

import numpy as np

from . import extent, printable, tess, topo
from .measure import volume_doubt
from .queries import QueryError, is_reference, need_layout, need_made, need_part, need_solid, volume_of

KINDS = ("overlap", "clearance", "interference", "mesh", "overhang", "thin", "bed")
# What ``interference`` may take, s, of the 30 a query has; past it the pairs left are told as not measured.
INTERFERENCE_BUDGET = 20.0
# At most so many pairs of each sort are told; the rest are counted.
MAX_PAIRS = 100
# Vertices of the mesh within this of each other are one, mm: the rule slicers and viewers weld by.
WELD = 1e-4
# No more open edges than this are located.
MAX_WHERE = 20
# Less shared volume than this, mm³, is none: parts that touch share what tolerance leaves.
_SHARED = 1e-6
# How the volume two parts share was taken: followed by how far it can be relied on.
_SHARED_HOW = "of what the two share"
# Parts nearer than this, mm, touch.
_TOUCHING = 1e-7


def check(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any] | None) -> dict[str, Any]:
    """Answer ``check``: ``args`` are ``kind``, ``layout``, the part ``a`` and, for two, ``b``.

    - ``overlap``: the ``volume`` the two parts share, mm³, whether it is
      exact (``volumeExact``: as of a part, only of planes and round faces;
      ``how`` says how far any other can be relied on) and its ``bbox``,
      with whether that is exact (``bboxExact``), both null when they share none. Both are solids: a shell or a face has no
      volume to share, and is refused. ``reversed`` names, when there are any, the parts that have a solid turned inside
      out (``extent.Volume.reversed``): what they share is not to be relied on.
    - ``clearance``: the least ``distance`` between the two, mm, and the
      ``points`` of each it is between. Parts that touch are 0 apart. Parts
      that share volume, one inside the other included, are 0 apart and
      ``overlapping``, with both points at the centre of mass of what they
      share, which need not be in it (of a ring through a slab it is in the
      ring's hole): it is the same verdict ``overlap`` gives. Of a part that is not a
      solid the distance is told and ``overlapping`` is null. ``how`` says
      which of these it is. ``reversed`` names, as of ``overlap``, the parts with a solid inside out.
    - ``interference``: every pair of the layout's solid parts, with no ``a`` or ``b``: the pairs that share volume
      (``interfering``, each with ``volume``, ``volumeExact``, ``bbox`` and ``bboxExact`` as ``overlap`` tells them,
      largest first), the pairs that only touch (``touching``) and how many are ``clear``. Pairs whose boxes are apart
      are clear without a cut. The others are cut in the order of how much their boxes overlap, within
      ``INTERFERENCE_BUDGET`` seconds; ``sampling`` says how many were ``measured`` and whether it is ``complete``.
      Parts that are not solids are named in ``notSolid`` and left out; ``reversed`` as of ``overlap``.
      A reference (a bought part, ``loader.Layouts``) is an obstacle: it is taken against the parts, never against another
      reference, and named in ``references``.
    - ``mesh``: whether the mesh of the part is ``watertight``: its vertices
      welded where they are within 0.0001 mm, how many edges are then of one
      triangle only (``openEdges``), the middles of at most twenty of them
      (``where``, spread over all of them, in the frame of the layout) and
      how many ``triangles`` the mesh has.
    - ``overhang``, ``thin`` and ``bed``: will it print (``printable``). The
      first two are of the part ``a`` with ``angle`` (default 45) or ``min``;
      ``bed`` is of the whole layout, with ``size``, and takes no part.

    ``kept`` is the worker's (``queries.run``): what two parts share and the
    edges a mesh leaves open are worked out once.
    """
    kind = args.get("kind")
    if kind not in KINDS:
        raise QueryError(
            "bad_request", f"check needs args.kind, one of {', '.join(KINDS[:-1])} and {KINDS[-1]}"
        )
    layout, a, b = args.get("layout"), args.get("a"), args.get("b")
    held = {} if kept is None else kept
    if kind == "bed":
        if not isinstance(layout, str):
            raise QueryError("bad_request", "check bed needs args.layout, a string")
        return printable.bed(shapes, layout, args.get("size"), held)
    if kind == "interference":
        if not isinstance(layout, str):
            raise QueryError("bad_request", "check interference needs args.layout, a string")
        return _interference(shapes, layout, held)
    if not isinstance(layout, str) or not isinstance(a, str):
        raise QueryError(
            "bad_request", "check needs args.layout and args.a, the name of a part of it, both strings"
        )
    first = need_part(shapes, layout, a)
    if kind == "mesh":
        need_made(held, f"{layout}:{a}", a, "a mesh to print")
        return _mesh(first, f"{layout}:{a}", held)
    if kind == "overhang":
        return printable.overhang(first, a, f"{layout}:{a}", args.get("angle", 45), held)
    if kind == "thin":
        return printable.thin(first, a, f"{layout}:{a}", args.get("min"), held)
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

    # A part with a solid turned inside out is cut by the boolean as no sound one is: said by name, of what the
    # two share and of whether they overlap.
    inside_out = [
        name
        for name, shape in ((a, first), (b, second))
        if topo.solids(shape) and volume_of(shape, f"{layout}:{name}", held).reversed
    ]
    if kind == "overlap":
        need_solid(first, a)
        need_solid(second, b)
        told = {key: shared()[key] for key in ("volume", "volumeExact", "how", "bbox", "bboxExact")}
        return {**told, "reversed": inside_out} if inside_out else told
    not_solid = [name for name, shape in ((a, first), (b, second)) if not topo.solids(shape)]
    told = _clearance(_topods(first), _topods(second), f"{a} and {b}", shared, not_solid)
    return {**told, "reversed": inside_out} if inside_out else told


def _interference(shapes: dict[str, Any], layout: str, held: dict[Any, Any]) -> dict[str, Any]:
    """Which parts of ``layout`` share volume, which only touch, and how many pairs are clear."""
    import time

    from OCP.BRepBndLib import BRepBndLib
    from OCP.Bnd import Bnd_Box

    need_layout(shapes, layout)
    prefix = f"{layout}:"
    names = [k[len(prefix) :] for k in shapes if k.startswith(prefix)]
    solid = [n for n in names if topo.solids(shapes[prefix + n])]
    not_solid = [n for n in names if n not in solid]
    inside_out = [n for n in solid if volume_of(shapes[prefix + n], prefix + n, held).reversed]
    boxes = {}
    for n in solid:
        box = Bnd_Box()
        BRepBndLib.Add_s(_topods(shapes[prefix + n]), box, False)
        boxes[n] = box

    def reach(box: Any) -> tuple[list[float], list[float]]:
        low, high = box.CornerMin(), box.CornerMax()
        return [low.X(), low.Y(), low.Z()], [high.X(), high.Y(), high.Z()]

    # Two bought parts are not the model's to judge: a reference is an obstacle for the parts, not for another.
    bought = {n for n in solid if is_reference(held, prefix + n)}
    total = len(solid) * (len(solid) - 1) // 2 - len(bought) * (len(bought) - 1) // 2
    near = []  # (overlap of the boxes, a, b) for the pairs whose boxes are not apart
    for i, a in enumerate(solid):
        for b in solid[i + 1 :]:
            if (a in bought and b in bought) or boxes[a].IsVoid() or boxes[b].IsVoid() or boxes[a].IsOut(boxes[b]):
                continue
            (l1, h1), (l2, h2) = reach(boxes[a]), reach(boxes[b])
            size = 1.0
            for k in range(3):
                size *= max(0.0, min(h1[k], h2[k]) - max(l1[k], l2[k]))
            near.append((size, a, b))
    near.sort(key=lambda t: -t[0])
    started = time.monotonic()
    interfering, touching, measured = [], [], 0
    for _, a, b in near:
        if time.monotonic() - started > INTERFERENCE_BUDGET:
            break
        one, other = _topods(shapes[prefix + a]), _topods(shapes[prefix + b])
        pair = ("shared", layout, *sorted((a, b)))
        if pair not in held:
            held[pair] = _shared(one, other, f"{a} and {b}")
        both = held[pair]
        measured += 1
        if both["volume"] >= _SHARED:
            interfering.append({"a": a, "b": b, **{k: both[k] for k in ("volume", "volumeExact", "bbox", "bboxExact")}})
        elif _touches(one, other):
            touching.append({"a": a, "b": b})
    interfering.sort(key=lambda t: -t["volume"])
    unmeasured = len(near) - measured
    told: dict[str, Any] = {
        "layout": layout,
        "parts": len(solid),
        "pairs": total,
        "interfering": interfering[:MAX_PAIRS],
        "touching": touching[:MAX_PAIRS],
        "clear": total - len(interfering) - len(touching) - unmeasured,
        "sampling": {"measured": measured, "of": len(near), "complete": unmeasured == 0},
    }
    if len(interfering) > MAX_PAIRS or len(touching) > MAX_PAIRS:
        told["listCut"] = True
    if not_solid:
        told["notSolid"] = not_solid
    if inside_out:
        told["reversed"] = inside_out
    if bought:
        told["references"] = sorted(bought)
    return told


def _touches(one: Any, other: Any) -> bool:
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    extrema = BRepExtrema_DistShapeShape(one, other)
    return bool(extrema.IsDone() and extrema.NbSolution() >= 1 and extrema.Value() <= _TOUCHING)


def _topods(shape: Any) -> Any:
    return getattr(shape, "wrapped", shape)


# Overlap


def _shared(one: Any, other: Any, names: str) -> dict[str, Any]:
    """What two solids share: its ``volume``, its ``bbox`` and its centre, ``at``."""
    nothing = {"volume": 0.0, "volumeExact": True, "how": _SHARED_HOW, "bbox": None, "bboxExact": None, "at": None}
    if _boxes_apart(one, other):
        return nothing
    common = _common(one, other)
    if not common.IsDone():
        raise QueryError("exception", f"what {names} share could not be computed")
    # As a part's volume: exact only of planes and round faces, never integrated for minutes.
    volume, centre = extent.volume_and_centre(common.Shape())
    told = {"volume": volume.value, "volumeExact": volume.exact, "how": _SHARED_HOW + volume_doubt(volume)}
    if volume.value < _SHARED:
        return {**nothing, **told}
    low, high = extent.box(common.Shape())
    return {
        **told,
        "bbox": {"min": low, "max": high},
        # As a part's: its own only of planes and cylinders that end in lines and circles.
        "bboxExact": extent.boxed_exactly(common.Shape()),
        "at": _xyz(centre),
    }


def _boxes_apart(one: Any, other: Any) -> bool:
    """Whether boxes that hold the two parts are apart: then the parts are, and nothing is cut."""
    from OCP.BRepBndLib import BRepBndLib
    from OCP.Bnd import Bnd_Box

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
    are welded first (``welded``). A mesh is drawn face by face, so its faces
    share no vertex until then; and a triangle that welding leaves with two
    corners in one place has no area and no edges.
    """
    vertices = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    triangles = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    if len(vertices) == 0 or len(triangles) == 0:
        return 0, np.empty((0, 3))
    _, first, one = np.unique(welded(vertices), return_index=True, return_inverse=True)
    corners = one.reshape(-1)[triangles]
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    corners = corners[(a != b) & (b != c) & (c != a)]
    sides = np.sort(np.concatenate([corners[:, [0, 1]], corners[:, [1, 2]], corners[:, [2, 0]]]), axis=1)
    edges, uses = np.unique(sides, axis=0, return_counts=True)
    open_ones = edges[uses == 1]
    points = vertices[first]
    return len(open_ones), (points[open_ones[:, 0]] + points[open_ones[:, 1]]) / 2


def welded(vertices: np.ndarray) -> np.ndarray:
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
