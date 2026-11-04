"""Why a boolean (a cut, a fuse, an intersect or a split) failed, found by looking at its operands.

OCC says only that the operation could not be done (``StdFail_NotDone``, ``BRep_API: command not done``), or hands
build123d a null shape (``Null TopoDS_Shape object``), and neither names an operand. The usual causes can be
tested: an operand that is not a solid, one that is empty or invalid (it fails OCC's own check, or the argument
analyzer finds it crossing itself), tools that only touch the shape along a face (coincident faces, a tool that ends
flush with the face it cuts instead of overshooting it), and shapes that do not meet at all.

The failing call is found in the traceback, by the innermost ``_bool_op`` of a build123d shape (every ``cut``,
``fuse``, ``intersect`` and ``split``, and the operators and builders over them go through it), and its ``args`` and
``tools`` are taken from that frame's locals. Nothing is run again: the operands are only looked at, and what is
told of them is measured (OCC's check, ``BRepExtrema``, ``BRepClass3d_SolidClassifier``, the area two faces share),
never the boolean itself. Like ``diagnose.py`` for a fillet, it runs in the worker that failed, within a budget,
and what it had no time for is said (``complete: false``) and never told as a finding.

The operands are intermediate shapes with no place in the scene: their faces are numbered by their place in the
operand (``base F3``, from 0) and told in the frame they are in, ``local``.
"""

import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

# Seconds a failed build may spend finding out why, within what its timeout leaves (as for a fillet).
BUDGET = 5.0
# No step is started with less time left than this many times the longest step so far.
SLACK = 2.0
# The most operands looked at on each side, and the most points of one sampled against the other.
MOST_OPERANDS = 4
MOST_SAMPLES = 60
# The most pairs of faces compared for sameness of surface.
MOST_FACE_PAIRS = 40_000
# The most coincident faces told.
MOST_COINCIDENT = 12
# Two planes this close (mm) are told as one surface; two of a cylinder or a sphere must agree to SAME.
NEAR = 1e-4
SAME = 1e-7
# Shapes this close (mm) touch.
TOUCH = 1e-7
# Less area than this (mm²) in common is none.
LEAST_AREA = 1e-9
_ON_AXIS = math.cos(math.radians(0.5))
_AXES = "XYZ"

_KINDS = {"cut": "cut", "fuse": "fuse", "common": "intersect", "splitter": "split"}
# What the argument analyzer's statuses are called in a sentence.
_FAULTS = {
    "SelfIntersect": "crosses itself",
    "TooSmallEdge": "has an edge that is too small",
    "NonRecoverableFace": "has a face that cannot be rebuilt",
    "IncompatibilityOfVertex": "has a vertex that does not fit its edges",
    "IncompatibilityOfEdge": "has an edge that does not fit its faces",
    "IncompatibilityOfFace": "has a face that does not fit its edges",
    "OperationAborted": "could not be analyzed",
    "BadType": "is not a shape a boolean takes",
    "SelfInterferingShape": "crosses itself",
}


@dataclass
class BooleanCall:
    """A boolean of build123d: of what it was asked, and with what."""

    operation: str  # cut, fuse, intersect or split
    base: list[Any]  # build123d shapes: those operated on
    tools: list[Any]  # build123d shapes: those brought in


def find_boolean(error: BaseException) -> BooleanCall | None:
    """The boolean of build123d that raised ``error``: the innermost ``_bool_op`` frame of a build123d shape in the
    traceback, or in that of an exception it was raised from or during (a loader wraps what the model raised).
    None when there is none, or its locals are not what such a call holds."""
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


def _call_of(frame: Any) -> BooleanCall | None:
    if frame.f_code.co_name != "_bool_op":
        return None
    from build123d import Shape

    found = frame.f_locals
    if not isinstance(found.get("self"), Shape):
        return None
    base, tools = found.get("args"), found.get("tools")
    if not isinstance(base, (list, tuple)) or not isinstance(tools, (list, tuple)):
        return None
    if not all(isinstance(s, Shape) for s in (*base, *tools)):
        return None
    return BooleanCall(_operation(found.get("operation")), list(base), list(tools))


def _operation(operation: Any) -> str:
    name = type(operation).__name__.removeprefix("BRepAlgoAPI_").removeprefix("BRepAlgo").lower()
    return _KINDS.get(name, "boolean")


def diagnose(
    call: BooleanCall, budget: float = BUDGET, clock: Callable[[], float] = time.monotonic
) -> dict[str, Any]:
    """Why ``call`` fails, within ``budget`` seconds, in the frame of its operands (``local``).

    ``operands``: each, named ``base``, ``base2``, … and ``tool``, ``tool2``, …, with what it is (``type``), whether
    OCC's check finds it ``valid`` and what the argument analyzer finds in it (``faults``), its solids and faces
    and its box. ``pairs``: for each base and tool, how far apart they are (``apart``, mm, ``apartExact: false``),
    whether they touch, how many of the points sampled on each (its vertices and the middles of its edges) lie
    inside the other solid (``inside``), and the faces of the two that are one surface (``coincident``: ``base``
    and ``tool`` faces, the ``kind``, for a plane whether the two face the ``same`` way or ``opposite`` ways, their
    ``gap`` and the ``area`` they share). ``causes``: what that comes to, from the likeliest. ``complete`` says whether
    all of it was done in time.
    """
    started = clock()
    timer = _Timer(clock, started + max(0.0, budget))
    complete = True
    named = _named("base", call.base) + _named("tool", call.tools)
    told: dict[str, Any] = {
        "operation": call.operation,
        "frame": "local",
        "budget": budget,
        "operands": [],
        "pairs": [],
    }
    if len(call.base) > MOST_OPERANDS or len(call.tools) > MOST_OPERANDS:
        complete = False
        told["operandCount"] = {"base": len(call.base), "tools": len(call.tools)}
    shapes = {n: s for n, s in named}
    for name, shape in named:
        facts = timer.step(lambda shape=shape, name=name: _operand(name, shape))
        if facts is None:
            complete = False
            facts = {"name": name, "type": _type(shape)}
        told["operands"].append(facts)
    by_name = {o["name"]: o for o in told["operands"]}
    bases = [n for n, _ in named if n.startswith("base")]
    tools = [n for n, _ in named if n.startswith("tool")]
    # Pairs are looked at only of operands a boolean takes: solids that are there and valid.
    for b in bases:
        for t in tools:
            if not (_workable(by_name[b]) and _workable(by_name[t])):
                continue
            pair = {"base": b, "tool": t}
            if not _fill_pair(pair, shapes[b], shapes[t], timer):
                complete = False
            told["pairs"].append(pair)
    told["causes"] = _causes(call, told)
    told["complete"] = complete and not timer.cut_short
    told["seconds"] = clock() - started
    return told


def _named(prefix: str, shapes: list[Any]) -> list[tuple[str, Any]]:
    return [(prefix if i == 0 else f"{prefix}{i + 1}", s) for i, s in enumerate(shapes[:MOST_OPERANDS])]


class _Timer:
    """Runs steps while time is left: not with less than ``SLACK`` times the longest step so far, as an OCC call cannot
    be stopped. A step that was not started is None, and ``cut_short`` says that one was not."""

    def __init__(self, clock: Callable[[], float], deadline: float) -> None:
        self.clock = clock
        self.deadline = deadline
        self.longest = 0.0
        self.cut_short = False

    def out_of_time(self) -> bool:
        return self.clock() + SLACK * self.longest >= self.deadline

    def step(self, run: Callable[[], Any]) -> Any:
        if self.out_of_time():
            self.cut_short = True
            return None
        started = self.clock()
        try:
            return run()
        except Exception:
            return None
        finally:
            self.longest = max(self.longest, self.clock() - started)


# The operands


def _type(shape: Any) -> str:
    """What an operand is, in a word: ``solid``, ``2 solids``, ``shell``, ``face``, ``wire``, ``edge``, ``vertex``,
    or ``empty``."""
    if shape.wrapped is None or shape.wrapped.IsNull():
        return "empty"
    try:
        solids = len(shape.solids())
        if solids:
            return "solid" if solids == 1 else f"{solids} solids"
        for kind, method in (("shell", "shells"), ("face", "faces"), ("wire", "wires"), ("edge", "edges"), ("vertex", "vertices")):
            if len(getattr(shape, method)()):
                return kind
    except Exception:
        pass
    return "empty"


def _workable(operand: dict[str, Any]) -> bool:
    return operand.get("solids", 0) > 0 and operand.get("valid", False)


def _operand(name: str, shape: Any) -> dict[str, Any]:
    facts: dict[str, Any] = {"name": name, "type": _type(shape)}
    if facts["type"] == "empty":
        return facts
    from OCP.BRepCheck import BRepCheck_Analyzer

    facts["valid"] = bool(BRepCheck_Analyzer(shape.wrapped).IsValid())
    faults = _faults(shape)
    if faults:
        facts["faults"] = faults
    facts["solids"] = len(shape.solids())
    facts["faces"] = len(shape.faces())
    try:
        box = shape.bounding_box()
        facts["box"] = {
            "min": [float(box.min.X), float(box.min.Y), float(box.min.Z)],
            "max": [float(box.max.X), float(box.max.Y), float(box.max.Z)],
        }
    except Exception:
        pass
    return facts


def _faults(shape: Any) -> list[str]:
    """What the argument analyzer finds wrong in one shape, as phrases (the same fault told once)."""
    from OCP.BOPAlgo import BOPAlgo_ArgumentAnalyzer

    analyzer = BOPAlgo_ArgumentAnalyzer()
    analyzer.SetShape1(shape.wrapped)
    analyzer.SelfInterMode = True
    analyzer.SmallEdgeMode = True
    analyzer.RebuildFaceMode = True
    analyzer.MergeVertexMode = False
    analyzer.MergeEdgeMode = False
    analyzer.TangentMode = False
    analyzer.ContinuityMode = False
    analyzer.CurveOnSurfaceMode = False
    analyzer.Perform()
    said: list[str] = []
    if analyzer.HasFaulty():
        for result in analyzer.GetCheckResult():
            status = str(result.GetCheckStatus()).rsplit("_", 1)[-1]
            phrase = _FAULTS.get(status, status)
            if phrase not in said:
                said.append(phrase)
    return said


# The pairs


def _fill_pair(pair: dict[str, Any], base: Any, tool: Any, timer: _Timer) -> bool:
    """Tell how a base and a tool meet; whether every part of it was done in time."""
    done = True
    apart = timer.step(lambda: _apart(base, tool))
    if apart is None:
        done = False
    else:
        pair["apart"], pair["apartExact"] = apart, False
        pair["touching"] = apart <= TOUCH
    inside = timer.step(lambda: _inside(base, tool))
    if inside is None:
        done = False
    else:
        pair["inside"] = inside
    # A tool wholly inside the base is as far from its faces as the walls are thick: only shapes with nothing of one
    # inside the other and further apart than a face is from its neighbour in the same plane cannot share a surface.
    nested = inside is None or inside["tool"] > 0 or inside["base"] > 0
    if apart is not None and apart > NEAR and not nested:
        return done
    coincident = timer.step(lambda: _coincident(base, tool, timer))
    if coincident is None:
        done = False
    else:
        pair["coincident"] = coincident["told"]
        if coincident["more"]:
            pair["coincidentCount"] = coincident["count"]
        if not coincident["complete"]:
            done = False
    return done


def _apart(base: Any, tool: Any) -> float | None:
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    extrema = BRepExtrema_DistShapeShape(base.wrapped, tool.wrapped)
    return float(extrema.Value()) if extrema.IsDone() else None


def _samples(shape: Any) -> list[Any]:
    """Points on a shape: its vertices and the middles of its edges."""
    points = []
    for vertex in shape.vertices():
        points.append(vertex.center())
    for edge in shape.edges():
        points.append(edge.position_at(0.5))
    return points[:MOST_SAMPLES]


def _count_inside(solid: Any, points: list[Any]) -> int:
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN

    classifiers = [BRepClass3d_SolidClassifier(s.wrapped) for s in solid.solids()[:MOST_OPERANDS * 2]]
    count = 0
    for point in points:
        for classifier in classifiers:
            classifier.Perform(gp_Pnt(point.X, point.Y, point.Z), TOUCH)
            if classifier.State() == TopAbs_IN:
                count += 1
                break
    return count


def _inside(base: Any, tool: Any) -> dict[str, int]:
    """How many of the points sampled on the tool lie inside the base, and on the base inside the tool, of how many
    taken of each. A point on a face is not inside."""
    on_tool, on_base = _samples(tool), _samples(base)
    return {
        "tool": _count_inside(base, on_tool),
        "base": _count_inside(tool, on_base),
        "sampledOnTool": len(on_tool),
        "sampledOnBase": len(on_base),
    }


def _surface(face: Any) -> dict[str, Any] | None:
    """A face that is a plane, a cylinder or a sphere, as what makes two of them one surface; None of any other."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane, GeomAbs_Sphere

    surface = BRepAdaptor_Surface(face.wrapped)
    kind = surface.GetType()
    if kind == GeomAbs_Plane:
        normal = face.normal_at()
        center = face.center()
        return {
            "kind": "plane",
            "n": (normal.X, normal.Y, normal.Z),
            "c": (center.X, center.Y, center.Z),
        }
    if kind == GeomAbs_Cylinder:
        cylinder = surface.Cylinder()
        axis = cylinder.Axis()
        return {
            "kind": "cylinder",
            "radius": cylinder.Radius(),
            "p": (axis.Location().X(), axis.Location().Y(), axis.Location().Z()),
            "d": (axis.Direction().X(), axis.Direction().Y(), axis.Direction().Z()),
        }
    if kind == GeomAbs_Sphere:
        sphere = surface.Sphere()
        c = sphere.Location()
        return {"kind": "sphere", "radius": sphere.Radius(), "p": (c.X(), c.Y(), c.Z())}
    return None


def _dot(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def _sub(a: tuple[float, ...], b: tuple[float, ...]) -> tuple[float, ...]:
    return tuple(x - y for x, y in zip(a, b, strict=True))


def _same_surface(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any] | None:
    """What two faces' surfaces share, or None when they are not one: planes within ``NEAR`` (``gap``, and ``facing``
    ``same`` or ``opposite``), cylinders and spheres of the same radius on the same axis or about the same centre
    within ``SAME``."""
    if a["kind"] != b["kind"]:
        return None
    if a["kind"] == "plane":
        parallel = _dot(a["n"], b["n"])
        if abs(parallel) < 1 - 1e-9:
            return None
        gap = abs(_dot(a["n"], _sub(b["c"], a["c"])))
        if gap > NEAR:
            return None
        return {"kind": "plane", "facing": "same" if parallel > 0 else "opposite", "gap": gap}
    if abs(a["radius"] - b["radius"]) > SAME:
        return None
    if a["kind"] == "sphere":
        off = math.dist(a["p"], b["p"])
        return {"kind": "sphere", "gap": off} if off <= SAME else None
    if abs(_dot(a["d"], b["d"])) < 1 - 1e-12:
        return None
    between = _sub(b["p"], a["p"])
    along = _dot(between, a["d"])
    off = math.sqrt(max(0.0, _dot(between, between) - along * along))
    return {"kind": "cylinder", "gap": off} if off <= SAME else None


def _overlap(face_a: Any, face_b: Any, shared: dict[str, Any], a: dict[str, Any]) -> float | None:
    """The area two faces of one surface have in common, mm²: None when it could not be worked out. A plane the
    other is a ``gap`` off is laid on it first."""
    from build123d import Location, Vector
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    other = face_b
    if shared["kind"] == "plane" and shared["gap"] > 0:
        b_center = face_b.center()
        offset = _dot(a["n"], _sub((b_center.X, b_center.Y, b_center.Z), a["c"]))
        other = face_b.moved(Location(Vector(-a["n"][0] * offset, -a["n"][1] * offset, -a["n"][2] * offset)))
    common = BRepAlgoAPI_Common(face_a.wrapped, other.wrapped)
    if not common.IsDone():
        return None
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(common.Shape(), props)
    return float(props.Mass())


def _coincident(base: Any, tool: Any, timer: _Timer) -> dict[str, Any]:
    """The faces of the base and the tool that are one surface and share area: the first ``MOST_COINCIDENT``, the
    planes before the rest; ``count`` says how many there are. ``complete`` is false when time or the face pairs
    allowed ran out."""
    base_faces, tool_faces = list(base.faces()), list(tool.faces())
    base_info = [(f, _surface(f)) for f in base_faces]
    tool_info = [(f, _surface(f)) for f in tool_faces]
    boxes_b = [f.bounding_box() for f in base_faces]
    boxes_t = [f.bounding_box() for f in tool_faces]
    found: list[dict[str, Any]] = []
    complete = True
    compared = 0
    for i, (face_a, surface_a) in enumerate(base_info):
        if surface_a is None:
            continue
        for j, (face_b, surface_b) in enumerate(tool_info):
            if surface_b is None:
                continue
            compared += 1
            if compared > MOST_FACE_PAIRS or timer.out_of_time():
                complete = False
                break
            shared = _same_surface(surface_a, surface_b)
            if shared is None or not _boxes_meet(boxes_b[i], boxes_t[j]):
                continue
            try:
                area = _overlap(face_a, face_b, shared, surface_a)
            except Exception:
                area = None
            if area is not None and area <= LEAST_AREA:
                continue
            item: dict[str, Any] = {"base": f"F{i}", "tool": f"F{j}", **shared}
            if shared["kind"] == "plane":
                item["normal"] = [c + 0.0 for c in surface_a["n"]]
                item["center"] = [c + 0.0 for c in surface_a["c"]]
            if area is not None:
                item["area"] = area
                item["areaExact"] = shared["kind"] in ("plane", "cylinder")
            found.append(item)
        else:
            continue
        break
    found.sort(key=lambda item: item["kind"] != "plane")
    return {"told": found[:MOST_COINCIDENT], "count": len(found), "more": len(found) > MOST_COINCIDENT, "complete": complete}


def _boxes_meet(a: Any, b: Any) -> bool:
    for lo_a, hi_a, lo_b, hi_b in (
        (a.min.X, a.max.X, b.min.X, b.max.X),
        (a.min.Y, a.max.Y, b.min.Y, b.max.Y),
        (a.min.Z, a.max.Z, b.min.Z, b.max.Z),
    ):
        if hi_a < lo_b - NEAR or hi_b < lo_a - NEAR:
            return False
    return True


# What it comes to


def _causes(call: BooleanCall, told: dict[str, Any]) -> list[str]:
    """The causes the findings point to, the likeliest first.

    ``empty-operand``, ``not-solid`` (an operand a boolean cannot take: a face, a wire, an edge), ``invalid-operand``,
    ``flush`` (a tool face one surface with a face of the base, facing the same way: a tool that ends where the
    shape does instead of overshooting it), ``coincident`` (faces that lie on each other, facing opposite ways or
    curved), ``apart`` (they do not meet), ``touching`` (they meet and none of the sampled points of either lies
    inside the other)."""
    causes: list[str] = []

    def add(cause: str) -> None:
        if cause not in causes:
            causes.append(cause)

    for operand in told["operands"]:
        if operand["type"] == "empty":
            add("empty-operand")
        elif "solids" not in operand:
            continue  # not looked at: there was no time
        elif operand["solids"] == 0:
            add("not-solid")
        elif not operand.get("valid", True) or operand.get("faults"):
            add("invalid-operand")
    for pair in told["pairs"]:
        coincident = pair.get("coincident", [])
        if any(c["kind"] == "plane" and c["facing"] == "same" for c in coincident):
            add("flush")
        if any(not (c["kind"] == "plane" and c["facing"] == "same") for c in coincident):
            add("coincident")
        inside = pair.get("inside")
        if pair.get("apart", 0) > NEAR and inside and inside["tool"] == 0 and inside["base"] == 0:
            add("apart")
        if pair.get("touching") and inside and inside["tool"] == 0 and inside["base"] == 0 and "flush" not in causes:
            add("touching")
    return causes
