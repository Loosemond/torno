"""The exact outline a plane cuts of each part: the ``section`` query.

Nothing here changes a shape. The outlines come from the B-rep, not from the
mesh, so their areas are exact and their points lie on the part.
"""

import math
from typing import Any

import numpy as np

from . import topo
from .queries import QueryError, as_point, need_layout, need_part

# How far a drawn outline may stray from the true one, mm.
DEFLECTION = 0.05
# No loop is told with more points than this: one that needs more is drawn coarser.
MAX_POINTS = 2000
# Ends of cut edges closer than this are one point, mm.
_JOIN = 1e-6
_ZERO = 1e-12


def section(shapes: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    """Answer ``section``: ``args`` are ``layout``, ``plane`` (``origin`` and ``normal``) and,
    to cut only some, ``parts``, a list of names.

    The reply's ``plane`` carries the unit ``normal`` and the axes the points
    are along: ``x`` is the world axis least along the normal (the first of
    equals), laid into the plane, and ``y`` is ``normal × x``. A point
    ``[u, v]`` is ``origin + u·x + v·y`` in the frame of the layout.

    Each part asked of is listed, in the build's order, with its ``loops``
    (none where the plane misses it). A loop has its ``points``, whether it
    is ``closed`` (then the last point joins the first, which is not told
    twice), its ``area`` and the ``deflection`` it is drawn at. The area is
    that of the true outline: positive for a loop that bounds material, which
    runs counter-clockwise, negative for a hole in it, which runs clockwise,
    and 0 for a loop that is not closed. Closed loops come largest first, open
    ones after them. A part's ``area`` is the sum and ``open`` the number of
    loops that are not closed: a part that is a solid has none.

    ``bounds`` is the box of every point in ``[u, v]``, null when nothing is cut.
    """
    layout, plane, names = args.get("layout"), args.get("plane"), args.get("parts")
    origin = as_point(plane.get("origin")) if isinstance(plane, dict) else None
    normal = as_point(plane.get("normal")) if isinstance(plane, dict) else None
    if not isinstance(layout, str) or origin is None or normal is None:
        raise QueryError(
            "bad_request",
            "section needs args.layout, a string, and args.plane with origin and normal, each "
            "three finite numbers",
        )
    if names is not None and (
        not isinstance(names, list) or not names or not all(isinstance(n, str) for n in names)
    ):
        raise QueryError(
            "bad_request", "args.parts of section, if given, is a list of part names, at least one"
        )
    length = math.sqrt(sum(c * c for c in normal))
    if length < _ZERO:
        raise QueryError("bad_request", "the normal of the section plane has no length")
    need_layout(shapes, layout)
    if names is None:
        names = [key.split(":", 1)[1] for key in shapes if key.startswith(f"{layout}:")]
    frame = _Frame(np.array(origin), np.array(normal) / length)
    parts = []
    for name in dict.fromkeys(names):
        loops = _loops(need_part(shapes, layout, name), frame, f"{layout}:{name}")
        parts.append(
            {
                "part": name,
                "loops": loops,
                "area": sum(loop["area"] for loop in loops),
                "open": sum(1 for loop in loops if not loop["closed"]),
            }
        )
    drawn = [loop["points"] for part in parts for loop in part["loops"]]
    bounds = None
    if drawn:
        every = np.vstack(drawn)
        bounds = {"min": _out(every.min(axis=0)), "max": _out(every.max(axis=0))}
    for part in parts:
        for loop in part["loops"]:
            loop["points"] = [_out(point) for point in loop["points"]]
    return {
        "plane": {
            "origin": origin,
            "normal": _out(frame.normal),
            "x": _out(frame.x),
            "y": _out(frame.y),
        },
        "parts": parts,
        "bounds": bounds,
    }


class _Frame:
    """A plane and the two axes its points are told along."""

    def __init__(self, origin: np.ndarray, normal: np.ndarray) -> None:
        self.origin = origin
        self.normal = normal
        # argmin takes the first of equals: X before Y before Z.
        least = np.eye(3)[int(np.argmin(np.abs(normal)))]
        along = least - (least @ normal) * normal
        self.x = along / np.linalg.norm(along)
        self.y = np.cross(normal, self.x)

    def plane(self) -> Any:
        from OCP.gp import gp_Ax3, gp_Dir, gp_Pln, gp_Pnt

        return gp_Pln(
            gp_Ax3(
                gp_Pnt(*map(float, self.origin)),
                gp_Dir(*map(float, self.normal)),
                gp_Dir(*map(float, self.x)),
            )
        )

    def flat(self, points: np.ndarray) -> np.ndarray:
        """Points of the object as ``[u, v]`` of the plane."""
        return (points - self.origin) @ np.stack([self.x, self.y]).T


def _loops(shape: Any, frame: _Frame, key: str) -> list[dict[str, Any]]:
    """The loops the plane cuts of one part, signed and ordered as ``section`` says."""
    # build123d and OCP come from the user's workspace, so they are imported only when used.
    from build123d import Edge, Wire
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Section

    plane = frame.plane()
    cut = BRepAlgoAPI_Section(getattr(shape, "wrapped", shape), plane, False)
    # The curves as they are, not splines put through them.
    cut.Approximation(False)
    cut.Build()
    if not cut.IsDone():
        raise QueryError("exception", f"the section of {key} could not be computed")
    edges = topo.edges(cut.Shape())
    if not edges:
        return []
    # The cut is loose edges, a few per face crossed: they are joined end to end.
    wires = Wire.combine([Edge(edge) for edge in edges], tol=_JOIN)
    closed, open_ones = [], []
    for wire in wires:
        outline = frame.flat(_polyline(wire.wrapped))
        if len(outline) < 2:
            continue
        if wire.is_closed and len(outline) >= 3:
            if np.linalg.norm(outline[0] - outline[-1]) <= _JOIN:
                outline = outline[:-1]
            closed.append((outline, _area(plane, wire.wrapped, outline)))
        else:
            open_ones.append(outline)
    loops = []
    for outline, area in sorted(closed, key=lambda loop: -loop[1]):
        # A loop inside an odd number of others is the edge of a hole.
        depth = sum(
            1 for other, _ in closed if other is not outline and _inside(outline[0], other)
        )
        hole = depth % 2 == 1
        if (_shoelace(outline) < 0) != hole:
            outline = outline[::-1]
        points, deflection = _within_limit(outline, closed=True)
        loops.append(
            {
                "points": points,
                "closed": True,
                "area": -area if hole else area,
                "deflection": deflection,
            }
        )
    for outline in open_ones:
        points, deflection = _within_limit(outline, closed=False)
        loops.append({"points": points, "closed": False, "area": 0.0, "deflection": deflection})
    return loops


def _polyline(wire: Any) -> np.ndarray:
    """The points a wire is drawn through, in its order, no further than DEFLECTION from it."""
    from ocp_tessellate.ocp_utils import BRep_Tool, BRepAdaptor_Curve, TopAbs_Orientation
    from OCP.BRepTools import BRepTools_WireExplorer
    from OCP.GCPnts import GCPnts_QuasiUniformDeflection

    points: list[tuple[float, float, float]] = []
    walk = BRepTools_WireExplorer(wire)
    while walk.More():
        edge = walk.Current()
        walk.Next()
        if BRep_Tool.Degenerated_s(edge):
            continue
        curve = BRepAdaptor_Curve(edge)
        spread = GCPnts_QuasiUniformDeflection(curve, DEFLECTION)
        if spread.IsDone() and spread.NbPoints() >= 2:
            run = [spread.Value(i) for i in range(1, spread.NbPoints() + 1)]
        else:
            run = [curve.Value(curve.FirstParameter()), curve.Value(curve.LastParameter())]
        if edge.Orientation() == TopAbs_Orientation.TopAbs_REVERSED:
            run.reverse()
        # Each edge starts where the one before ended.
        points.extend((p.X(), p.Y(), p.Z()) for p in (run[1:] if points else run))
    return np.array(points, dtype=np.float64).reshape(-1, 3)


def _area(plane: Any, wire: Any, outline: np.ndarray) -> float:
    """The area a closed wire of the plane bounds: of the wire itself, not of its polygon."""
    from ocp_tessellate.ocp_utils import BRepBuilderAPI_MakeFace, BRepGProp, GProp_GProps

    try:
        face = BRepBuilderAPI_MakeFace(plane, wire, True)
        if face.IsDone():
            measured = GProp_GProps()
            BRepGProp.SurfaceProperties_s(face.Face(), measured)
            if math.isfinite(measured.Mass()) and measured.Mass() != 0:
                return abs(float(measured.Mass()))
    except Exception:
        pass
    # A wire no face can be made of: the polygon is the best there is.
    return abs(_shoelace(outline))


def _shoelace(outline: np.ndarray) -> float:
    """The signed area of a polygon: positive when it runs counter-clockwise."""
    u, v = outline[:, 0], outline[:, 1]
    return float(u @ np.roll(v, -1) - v @ np.roll(u, -1)) / 2


def _inside(point: np.ndarray, outline: np.ndarray) -> bool:
    """Whether a point is inside a polygon: a ray from it crosses the edge an odd number of times."""
    u, v = outline[:, 0], outline[:, 1]
    next_u, next_v = np.roll(u, -1), np.roll(v, -1)
    straddles = (v > point[1]) != (next_v > point[1])
    with np.errstate(divide="ignore", invalid="ignore"):
        crossing = u + (point[1] - v) * (next_u - u) / (next_v - v)
    return int(np.count_nonzero(straddles & (point[0] < crossing))) % 2 == 1


def _within_limit(outline: np.ndarray, closed: bool) -> tuple[np.ndarray, float]:
    """The outline in at most MAX_POINTS points, and how far it may now stray from the true one."""
    points, deflection = outline, DEFLECTION
    ring = np.vstack([outline, outline[:1]]) if closed else outline
    while len(points) > MAX_POINTS:
        deflection *= 2
        # The outline is already DEFLECTION off: what is dropped may add the rest.
        points = _thinned(ring, deflection - DEFLECTION)
        if closed:
            points = points[:-1]
    return points, deflection


def _thinned(points: np.ndarray, tolerance: float) -> np.ndarray:
    """The polyline through fewer of its points, none of those dropped further than
    ``tolerance`` from it (Ramer-Douglas-Peucker). The ends are kept."""
    keep = np.zeros(len(points), dtype=bool)
    keep[0] = keep[-1] = True
    spans = [(0, len(points) - 1)]
    while spans:
        first, last = spans.pop()
        if last <= first + 1:
            continue
        along = points[last] - points[first]
        between = points[first + 1 : last] - points[first]
        length = float(np.linalg.norm(along))
        if length < _ZERO:
            # A ring: its ends are one point, and the furthest from it is kept.
            off = np.linalg.norm(between, axis=1)
        else:
            off = np.abs(along[0] * between[:, 1] - along[1] * between[:, 0]) / length
        furthest = int(np.argmax(off))
        if off[furthest] > tolerance:
            middle = first + 1 + furthest
            keep[middle] = True
            spans += [(first, middle), (middle, last)]
    return points[keep]


def _out(vector: np.ndarray) -> list[float]:
    # Adding 0.0 turns -0.0 into 0.0.
    return [float(c) + 0.0 for c in vector]
