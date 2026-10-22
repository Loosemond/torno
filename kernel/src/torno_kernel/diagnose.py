"""Why a fillet or a chamfer failed, found by trying it again in parts.

OCC says only that it could not (``StdFail_NotDone``, ``command not done``), and build123d that the radius may be
too large: neither names an edge. What does is trying: each edge alone at the size asked, then, if every one works
alone, the pairs (those that share a face first), then the largest size that works, bisected to ``STEP``, for the
whole set and for each edge that fails alone. Each try is OCC's own fillet or chamfer of the same shape, thrown
away. Nothing here retries the model.

Two callers. A build that failed inside build123d's ``fillet`` or ``chamfer`` (``from_exception``): the worker
that failed, before it exits, takes the call's ``self``, size and edges from the frame of the traceback, and the
shape filleted is an intermediate one with no place in the scene, so its edges are numbered by their place in the
call (from 0) and their ends are in its own frame, ``local``. And ``try_fillet`` (``queries.py``), on a part of
the last good build in the live worker: edges named by ref, ends in the object frame.

Every try is bounded only by the clock between tries: OCC's cannot be stopped. A diagnosis that ran out of time
says so (``complete: false``) and tells what it found; what it had no time for is not told as a finding.
"""

import math
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from itertools import combinations
from typing import Any

# Seconds a failed build may spend finding out why, within what its timeout leaves.
BUDGET = 5.0
# Seconds of the build's timeout that are left alone: the reply has to be written before it runs out.
MARGIN = 1.0
# How finely the largest size that works is bisected, mm.
STEP = 0.001
# The most edges described in a diagnosis: those of the failures, in the order of the call.
MOST_EDGES_TOLD = 24
# A line this close to an axis runs along it (as `describe` names a direction).
_ON_AXIS = math.cos(math.radians(0.5))
_AXES = "XYZ"
# Curves whose length OCC works out in closed form.
_EXACT_LENGTH = ("line", "circle")


@dataclass
class Call:
    """A fillet or a chamfer: of what, how large, and of which edges."""

    kind: str  # fillet or chamfer
    shape: Any  # the TopoDS_Shape filleted
    size: float  # the radius, or the chamfer's length
    size2: float | None  # the chamfer's other length, if it has one
    face: Any  # the TopoDS_Face a chamfer's length is measured on, if one was named
    edges: list[Any]  # TopoDS_Edge, in the order of the call


def budget_left(deadline: float | None, now: float | None = None) -> float:
    """The seconds a diagnosis may take: ``BUDGET``, or what the build's ``deadline`` (monotonic) leaves less
    ``MARGIN`` when that is less; never below 0."""
    if deadline is None:
        return BUDGET
    left = deadline - (time.monotonic() if now is None else now) - MARGIN
    return max(0.0, min(BUDGET, left))


def find_call(error: BaseException) -> Call | None:
    """The fillet or chamfer of build123d that raised ``error``, from the innermost frame of a ``fillet`` or
    ``chamfer`` method of a build123d shape in its traceback, or in that of an exception it was raised from or
    during (a loader wraps what the model raised). None when there is none, or its locals are not what such a call
    holds."""
    seen: set[int] = set()
    pending: list[BaseException | None] = [error]
    while pending:
        exception = pending.pop(0)
        if exception is None or id(exception) in seen:
            continue
        seen.add(id(exception))
        found = None
        tb = exception.__traceback__
        while tb is not None:
            call = _call_of(tb.tb_frame)
            if call is not None:
                found = call  # the innermost is wanted: the last of them
            tb = tb.tb_next
        if found is not None:
            return found
        pending += [exception.__cause__, exception.__context__]
    return None


def _call_of(frame: Any) -> Call | None:
    name = frame.f_code.co_name
    if name not in ("fillet", "chamfer"):
        return None
    from build123d import Shape

    found = frame.f_locals
    shape = found.get("self")
    if not isinstance(shape, Shape) or shape.wrapped is None:
        return None
    # build123d makes these of the edges first; `edge_list` may be a generator the call has used up.
    native = found.get("native_edges")
    if not isinstance(native, list):
        given = found.get("edge_list")
        native = [getattr(e, "wrapped", None) for e in given] if isinstance(given, (list, tuple)) else None
    if not native or any(e is None for e in native):
        return None
    size = found.get("radius" if name == "fillet" else "length")
    size2 = found.get("length2") if name == "chamfer" else None
    if not _positive(size) or (size2 is not None and size2 != 0 and not _positive(size2)):
        return None
    face = found.get("face") if name == "chamfer" else None
    return Call(name, shape.wrapped, float(size), float(size2) if size2 else None, getattr(face, "wrapped", None), native)


def _positive(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def from_exception(error: BaseException, budget: float = BUDGET) -> dict[str, Any] | None:
    """The diagnosis of the fillet or chamfer that raised ``error``, in the frame of the shape filleted
    (``local``), or None when it was raised by none. It never raises: a diagnosis that fails is none."""
    try:
        call = find_call(error)
        return None if call is None else diagnose(call, budget)
    except Exception:
        return None


def diagnose(
    call: Call,
    budget: float = BUDGET,
    names: Sequence[str] | None = None,
    frame: str = "local",
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Why ``call`` fails, within ``budget`` seconds.

    ``alone``: how many edges were tried alone at the size asked, and which failed (their numbers, the place in
    the call from 0). ``pairs``, when every edge worked alone: how many pairs were tried of how many planned (those
    that share a face; all of them when none of those fails), and those that failed, each with whether its edges
    share a face and how far apart they are (``apart``, mm, exact between two lines). ``together``: the largest
    size that works for them all (``worksUpTo``, null when none down to ``STEP``) and the least that was seen to
    fail (``failsAt``). ``edges``: the edges of the failures (at most ``MOST_EDGES_TOLD``), each described, and of
    one that fails alone its own largest size and its shortest neighbour. With ``names`` the edges are named by
    them (refs) in ``ref``. ``complete`` says whether all of it was done in time.
    """
    trier = _Trier(call, clock() + max(0.0, budget), clock)
    count = len(call.edges)
    told: dict[str, Any] = {
        "operation": call.kind,
        "size": call.size,
        **({"size2": call.size2} if call.size2 is not None else {}),
        "frame": frame,
        "edgeCount": count,
        "step": STEP,
        "budget": budget,
    }
    started = clock()
    # 1. Each edge alone.
    alone: list[int] = []
    tried = 0
    if count > 1:
        for i in range(count):
            if trier.out_of_time():
                break
            tried += 1
            if not trier.works([i], call.size):
                alone.append(i)
    told["alone"] = {"tried": tried, "failing": alone}
    alone_done = count <= 1 or tried == count
    # 2. If each works alone, the pairs: those that share a face, and, if none of them fails, the others. They
    # are given half of what is left, so that the size that works is still found.
    pairs_done = True
    if count > 1 and alone_done and not alone:
        pairs_done = _pairs(trier, told, clock, (trier.deadline - clock()) / 2)
    # 3. The largest size that works, for them all and for each that fails alone.
    together = _bisect(trier, list(range(count)), call.size)
    if together is not None:
        told["together"] = together
    edges_told = _involved(told, count)
    bisected_alone = {i: _bisect(trier, [i], call.size) for i in alone[:MOST_EDGES_TOLD]}
    told["edges"] = [
        {
            **trier.describe(i, names),
            **(_alone_facts(trier, i, bisected_alone[i]) if i in bisected_alone else {}),
        }
        for i in edges_told
    ]
    told["complete"] = (
        alone_done
        and pairs_done
        and together is not None
        and together.get("complete", True)
        and all(b is not None and b.get("complete", True) for b in bisected_alone.values())
    )
    told["seconds"] = clock() - started
    return told if names is None else _named(told, names)


def _named(told: dict[str, Any], names: Sequence[str]) -> dict[str, Any]:
    """The diagnosis with every edge named by its name (a ref) in place of its number."""
    told["alone"]["failing"] = [names[i] for i in told["alone"]["failing"]]
    for pair in told.get("pairs", {}).get("failing", []):
        pair["edges"] = [names[i] for i in pair["edges"]]
    for edge in told["edges"]:
        del edge["index"]
    return told


def trial(
    shape: Any, kind: str, edges: list[Any], size: float, names: Sequence[str], budget: float
) -> dict[str, Any]:
    """Whether a fillet (or a chamfer) of ``size`` of these edges of ``shape`` works, and when it does not, why
    (``diagnose``, edges named by ``names``, in the object frame). The result is thrown away."""
    call = Call(kind, shape, size, None, None, edges)
    started = time.monotonic()
    if _Trier(call, started + budget, time.monotonic).works(list(range(len(edges))), size):
        return {"operation": kind, "size": size, "edgeCount": len(edges), "works": True, "frame": "object"}
    spent = time.monotonic() - started
    return {"works": False, **diagnose(call, max(0.0, budget - spent), names, "object")}


def _pairs(trier: "_Trier", told: dict[str, Any], clock: Callable[[], float], share: float) -> bool:
    """Try the pairs of edges, those that share a face first, within ``share`` seconds; whether all were tried."""
    until = clock() + share
    count = len(trier.call.edges)
    every = list(combinations(range(count), 2))
    adjacent = [p for p in every if trier.adjacent(*p)]
    others = [p for p in every if p not in set(adjacent)]
    failing: list[dict[str, Any]] = []
    tried = 0
    planned = len(adjacent)
    complete = True
    for group in (adjacent, others):
        if group is others:
            # Pairs that share no face are tried only when none that shares one fails.
            if failing:
                break
            planned += len(others)
        for i, j in group:
            if trier.out_of_time() or clock() > until:
                complete = False
                break
            tried += 1
            if not trier.works([i, j], trier.call.size):
                failing.append({"edges": [i, j], "adjacent": group is adjacent, **trier.apart(i, j)})
        if not complete:
            break
    told["pairs"] = {"tried": tried, "planned": planned, "failing": failing}
    return complete


def _bisect(trier: "_Trier", indexes: list[int], size: float) -> dict[str, Any] | None:
    """The largest size on the grid of ``STEP`` under ``size`` (which fails) that works for these edges, and the
    least seen to fail. ``complete: false`` when time ran out on the way; None when there was no time to start."""
    if trier.out_of_time():
        return None
    low, high = 0, math.ceil(size / STEP - 1e-9)
    works: float | None = None
    fails = size
    while high - low > 1:
        if trier.out_of_time():
            return {"worksUpTo": works, "failsAt": fails, "complete": False}
        middle = (low + high) // 2
        value = round(middle * STEP, 9)
        if trier.works(indexes, value):
            low, works = middle, value
        else:
            high, fails = middle, value
    return {"worksUpTo": works, "failsAt": fails}


def _involved(told: dict[str, Any], count: int) -> list[int]:
    """The edges of the failures, in the order of the call, at most ``MOST_EDGES_TOLD``."""
    involved = set(told["alone"]["failing"])
    for pair in told.get("pairs", {}).get("failing", []):
        involved.update(pair["edges"])
    if count == 1:
        involved.add(0)
    return sorted(involved)[:MOST_EDGES_TOLD]


def _alone_facts(trier: "_Trier", index: int, bisected: dict[str, Any] | None) -> dict[str, Any]:
    facts: dict[str, Any] = {}
    if bisected is not None:
        facts.update(bisected)
    shortest = trier.shortest_neighbour(index)
    if shortest is not None:
        facts["shortestNeighbour"] = shortest
    return facts


class _Trier:
    """Tries a call's fillet or chamfer of some of its edges at a size, and says what its edges are."""

    def __init__(self, call: Call, deadline: float, clock: Callable[[], float]) -> None:
        from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_VERTEX

        from .ocp import TopExp, TopTools_IndexedDataMapOfShapeListOfShape

        self.call = call
        self.deadline = deadline
        self._clock = clock
        self._faces = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(call.shape, TopAbs_EDGE, TopAbs_FACE, self._faces)
        self._vertex_edges = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(call.shape, TopAbs_VERTEX, TopAbs_EDGE, self._vertex_edges)
        self._face_sets: dict[int, list[Any]] = {}

    def out_of_time(self) -> bool:
        return self._clock() >= self.deadline

    def works(self, indexes: list[int], size: float) -> bool:
        """Whether OCC makes a valid shape of the fillet or chamfer of these edges at ``size``."""
        from OCP.BRepCheck import BRepCheck_Analyzer
        from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer, BRepFilletAPI_MakeFillet

        from .ocp import TopoDS

        call = self.call
        try:
            if call.kind == "fillet":
                builder = BRepFilletAPI_MakeFillet(call.shape)
                for i in indexes:
                    builder.Add(size, call.edges[i])
            else:
                builder = BRepFilletAPI_MakeChamfer(call.shape)
                # An uneven chamfer keeps its proportions as its length is tried smaller.
                other = size if call.size2 is None else call.size2 * size / call.size
                for i in indexes:
                    face = call.face if call.face is not None else self.faces(i)[0]
                    builder.Add(size, other, call.edges[i], TopoDS.Face(face))
            builder.Build()
            if not builder.IsDone():
                return False
            made = builder.Shape()
            return not made.IsNull() and BRepCheck_Analyzer(made).IsValid()
        except Exception:
            return False

    def faces(self, index: int) -> list[Any]:
        """The faces of the shape that have the edge."""
        if index not in self._face_sets:
            edge = self.call.edges[index]
            self._face_sets[index] = list(self._faces.FindFromKey(edge)) if self._faces.Contains(edge) else []
        return self._face_sets[index]

    def adjacent(self, i: int, j: int) -> bool:
        """Whether the two edges share a face."""
        return any(a.IsSame(b) for a in self.faces(i) for b in self.faces(j))

    def apart(self, i: int, j: int) -> dict[str, Any]:
        """How far apart two edges are, mm, and whether that is exact (between two lines)."""
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape

        try:
            extrema = BRepExtrema_DistShapeShape(self.call.edges[i], self.call.edges[j])
            if not extrema.IsDone():
                return {}
            exact = _curve(self.call.edges[i]) == "line" and _curve(self.call.edges[j]) == "line"
            return {"apart": float(extrema.Value()), "apartExact": exact}
        except Exception:
            return {}

    def shortest_neighbour(self, index: int) -> float | None:
        """The length of the shortest other edge that meets this one at a corner, mm."""
        from .ocp import TopExp, downcast

        edge = self.call.edges[index]
        lengths = []
        for vertex in (TopExp.FirstVertex_s(edge), TopExp.LastVertex_s(edge)):
            if vertex.IsNull() or not self._vertex_edges.Contains(vertex):
                continue
            for other in self._vertex_edges.FindFromKey(vertex):
                if not other.IsSame(edge):
                    length = _length(downcast(other))
                    if length is not None and length > 0:
                        lengths.append(length)
        return min(lengths) if lengths else None

    def describe(self, index: int, names: Sequence[str] | None) -> dict[str, Any]:
        """An edge: its number (or ref), curve, length, direction, ends, and what faces meet at it."""
        from build123d import Edge, Face

        edge = Edge(self.call.edges[index])
        curve = _curve(self.call.edges[index])
        facts: dict[str, Any] = {"index": index}
        if names is not None:
            facts["ref"] = names[index]
        facts["type"] = curve
        length = _length(self.call.edges[index])
        if length is not None:
            facts["length"] = length
            facts["lengthExact"] = curve in _EXACT_LENGTH
        start, end = ends(self.call.edges[index])
        if start is not None:
            facts["start"], facts["end"] = start, end
        if curve == "line" and start is not None and end is not None:
            facts.update(_direction(start, end))
        if curve == "circle":
            try:
                facts["radius"] = float(edge.radius)
            except Exception:
                pass
        between = []
        for face in self.faces(index):
            try:
                between.append(Face(face).geom_type.name.lower())
            except Exception:
                between.append("face")
        facts["between"] = between
        return facts


def _curve(edge: Any) -> str:
    from build123d import Edge

    try:
        return Edge(edge).geom_type.name.lower()
    except Exception:
        return "edge"


def _length(edge: Any) -> float | None:
    from build123d import Edge

    try:
        return float(Edge(edge).length)
    except Exception:
        return None


def _direction(start: list[float], end: list[float]) -> dict[str, Any]:
    """Of a line: the axis it runs along (``along``), else its direction (``direction``, a unit vector)."""
    d = [b - a for a, b in zip(start, end, strict=True)]
    length = math.sqrt(sum(c * c for c in d))
    if length == 0:
        return {}
    unit = [c / length + 0.0 for c in d]
    for axis, c in enumerate(unit):
        if abs(c) >= _ON_AXIS:
            return {"along": _AXES[axis]}
    return {"direction": unit}


def ends(edge: Any) -> tuple[list[float] | None, list[float] | None]:
    """The points of an edge's two vertices, as OCC holds them (the same whoever asks): None of an edge without."""
    from OCP.BRep import BRep_Tool

    from .ocp import TopExp

    try:
        first, last = TopExp.FirstVertex_s(edge), TopExp.LastVertex_s(edge)
        if first.IsNull() or last.IsNull():
            return None, None
        return _xyz(BRep_Tool.Pnt_s(first)), _xyz(BRep_Tool.Pnt_s(last))
    except Exception:
        return None, None


def _xyz(point: Any) -> list[float]:
    # Adding 0.0 turns -0.0 into 0.0.
    return [float(point.X()) + 0.0, float(point.Y()) + 0.0, float(point.Z()) + 0.0]
