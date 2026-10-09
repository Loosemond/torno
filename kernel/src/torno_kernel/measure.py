"""Exact measurements of the built shapes: the ``measure`` query.

Every reply says ``how`` the value was taken and whether it is ``exact``.
Lengths are millimetres, angles degrees; points and directions are in the
frame of the layout the targets are in.
"""

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import topo
from .describe import number
from .queries import QueryError, as_point, need_layout, resolve

KINDS = ("distance", "angle", "radius", "diameter", "thickness", "bbox", "volume", "area", "mass")
# The kinds that are taken between two targets.
_BETWEEN = ("distance", "angle")
_TARGET = "a target: ref, a string, or layout, a string, with point, three finite numbers, or all three"
# Planes, axes and lines closer to parallel than this are parallel.
_PARALLEL = math.sin(math.radians(0.01))
# A wall thinner than this is the face the ray starts on.
_OWN_FACE = 1e-6
# How far a ray is followed, mm.
_REACH = 1e7
PLA = 1.24  # g/cm³
_ZERO = 1e-12


@dataclass
class _Target:
    """One end of a measurement: a part, a face, an edge or a point."""

    name: str  # "a" or "b", for messages
    layout: str
    kind: str  # "part", "face", "edge" or "point"
    ref: str | None = None
    key: str | None = None  # of the part, for all but a point
    shape: Any = None  # the part as the model made it, or the TopoDS face or edge
    part: Any = None  # the part the face or the edge is of, as the model made it
    point: np.ndarray | None = None

    @property
    def what(self) -> str:
        """What the target is, to end a refusal with."""
        if self.kind == "point":
            return f"{self.name} is a point"
        if self.kind == "part":
            return f"{self.ref} is a part"
        return f"{self.ref} is a {_type(self)} {self.kind}"


def measure(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any] | None) -> dict[str, Any]:
    """Answer ``measure``: ``args`` are ``kind``, the target ``a`` and, for some, ``b`` or ``density``.

    A target is ``{"ref": "assembly:lid/F12"}``, a point of a layout
    (``{"layout": "assembly", "point": [x, y, z]}``), or a ref with a point:
    then it is the feature the ref names, and the point says where on it the
    measurement is taken or drawn.

    - ``distance``: between two parallel planar faces, the distance between
      their planes; between two cylinders or circles of parallel axes, between
      the axes; from a point to a planar face, to its plane; between two
      points; of anything else the minimum.
    - ``angle``: between the outward normals of two planar faces (0 for faces
      that look the same way, 180 for opposite ones), between two straight
      edges or between a straight edge and a planar face (both 0 to 90: a
      line has no sense).
    - ``radius``, ``diameter``: of a cylindrical, spherical or toroidal face
      (of a torus its tube, with ``major``) or of a circular edge.
    - ``thickness``: from a point of a face along its inward normal to where
      the same part ends.
    - ``bbox`` of a part, a face or an edge; ``volume`` and ``mass`` of a
      part; ``area`` of a part or a face.

    ``kept`` is the worker's (``queries.run``).
    """
    kind = args.get("kind")
    if kind not in KINDS:
        raise QueryError(
            "bad_request",
            f"measure needs args.kind, one of {', '.join(KINDS[:-1])} and {KINDS[-1]}",
        )
    a = _target(shapes, kind, "a", args.get("a"))
    if kind in _BETWEEN:
        b = _target(shapes, kind, "b", args.get("b"))
        if a.layout != b.layout:
            raise QueryError(
                "bad_request",
                f"a is in {a.layout} and b in {b.layout}: both ends of a measurement are in one layout",
            )
        result = _distance(a, b) if kind == "distance" else _angle(a, b)
    elif kind in ("radius", "diameter"):
        result = _radius(kind, a)
    elif kind == "thickness":
        result = _thickness(a, {} if kept is None else kept)
    elif kind == "bbox":
        result = _bbox(a)
    elif kind == "mass":
        result = _mass(a, args.get("density", PLA), "density" not in args)
    else:
        result = _extent(kind, a)
    points = result.pop("points", None)
    if points is not None:
        result["points"] = [_out(p) for p in points]
    return {"kind": kind, **result}


def _target(shapes: dict[str, Any], kind: str, name: str, value: Any) -> _Target:
    refusal = QueryError("bad_request", f"measure {kind} needs args.{name}, {_TARGET}")
    if not isinstance(value, dict):
        raise refusal
    ref, layout = value.get("ref"), value.get("layout")
    point = as_point(value["point"]) if "point" in value else None
    if "point" in value and point is None:
        raise refusal
    if not (ref is None or isinstance(ref, str)) or not (layout is None or isinstance(layout, str)):
        raise refusal
    at = None if point is None else np.array(point)
    if ref is None:
        if layout is None or at is None:
            raise refusal
        need_layout(shapes, layout)
        return _Target(name, layout, "point", point=at)
    key, what, shape = resolve(shapes, ref)
    of_ref = key.split(":", 1)[0]
    if layout is not None and layout != of_ref:
        raise QueryError(
            "bad_request", f"{name} names the layout {layout} and a ref of another, {ref}"
        )
    return _Target(name, of_ref, what, ref=ref, key=key, shape=shape, part=shapes[key], point=at)


# Distance


def _distance(a: _Target, b: _Target) -> dict[str, Any]:
    plane_a, plane_b = _plane(a), _plane(b)
    if plane_a and plane_b and _parallel(plane_a[1], plane_b[1]):
        start = plane_a[0]
        end = _foot_on_plane(start, *plane_b)
        return _length("between planes", start, end)
    axis_a, axis_b = _axis(a), _axis(b)
    if axis_a and axis_b and _parallel(axis_a[1], axis_b[1]):
        start = axis_a[0]
        end = _foot_on_line(start, *axis_b)
        return _length("axis to axis", start, end)
    if a.kind == "point" and plane_b:
        return _length("point to plane", a.point, _foot_on_plane(a.point, *plane_b))
    if b.kind == "point" and plane_a:
        return _length("point to plane", _foot_on_plane(b.point, *plane_a), b.point)
    if a.kind == "point" and b.kind == "point":
        return _length("point to point", a.point, b.point)
    return _minimum(a, b)


def _length(how: str, start: np.ndarray, end: np.ndarray) -> dict[str, Any]:
    return {
        "value": float(np.linalg.norm(end - start)),
        "unit": "mm",
        "how": how,
        "points": [start, end],
        "exact": True,
    }


def _minimum(a: _Target, b: _Target) -> dict[str, Any]:
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    extrema = BRepExtrema_DistShapeShape(_topods(a), _topods(b))
    if not extrema.IsDone() or extrema.NbSolution() < 1:
        raise QueryError(
            "exception", f"no distance between {a.ref or 'a'} and {b.ref or 'b'} could be computed"
        )
    return {
        "value": float(extrema.Value()),
        "unit": "mm",
        "how": "minimum",
        "points": [_gp(extrema.PointOnShape1(1)), _gp(extrema.PointOnShape2(1))],
        "exact": True,
    }


def _topods(target: _Target) -> Any:
    if target.kind == "point":
        return _vertex(target.point)
    return getattr(target.shape, "wrapped", target.shape)


def _vertex(point: np.ndarray) -> Any:
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.gp import gp_Pnt

    return BRepBuilderAPI_MakeVertex(gp_Pnt(*map(float, point))).Vertex()


# Angle


def _angle(a: _Target, b: _Target) -> dict[str, Any]:
    plane_a, plane_b = _plane(a), _plane(b)
    line_a, line_b = _line(a), _line(b)
    if plane_a and plane_b:
        how, cosine = "between normals", float(plane_a[1] @ plane_b[1])
        degrees = math.degrees(math.acos(max(-1.0, min(1.0, cosine))))
    elif line_a and line_b:
        how, cosine = "between lines", abs(float(line_a[1] @ line_b[1]))
        degrees = math.degrees(math.acos(min(1.0, cosine)))
    elif (plane_a and line_b) or (line_a and plane_b):
        normal = (plane_a or plane_b)[1]
        direction = (line_a or line_b)[1]
        how = "line to plane"
        degrees = math.degrees(math.asin(min(1.0, abs(float(normal @ direction)))))
    else:
        # The first that is neither is the one to name.
        odd = a if not (plane_a or line_a) else b
        raise QueryError(
            "bad_request",
            "angle is measured between two planar faces, two straight edges, or a planar face "
            f"and a straight edge; {odd.what}",
        )
    return {
        "value": degrees,
        "unit": "deg",
        "how": how,
        "points": [(plane_a or line_a)[0], (plane_b or line_b)[0]],
        "exact": True,
    }


# Radius and diameter


def _radius(kind: str, target: _Target) -> dict[str, Any]:
    found = _round(target)
    if found is None:
        raise QueryError(
            "bad_request",
            f"{kind} is measured of a cylindrical, spherical or toroidal face or a circular "
            f"edge; {target.what}",
        )
    how, radius, centre, towards, _, more = found
    rim = centre + radius * towards
    if kind == "radius":
        value, points = radius, [centre, rim]
    else:
        value, points = 2 * radius, [centre - radius * towards, rim]
    return {"value": float(value), "unit": "mm", "how": how, "points": points, "exact": True, **more}


def _round(
    target: _Target,
) -> tuple[str, float, np.ndarray, np.ndarray, np.ndarray | None, dict[str, Any]] | None:
    """Of a round face or edge: what it is, its radius, the centre the radius is drawn
    from, the direction it is drawn in, its axis (a sphere has none), and what else the
    reply says of it."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface

    if target.kind not in ("face", "edge"):
        return None
    type = _type(target)
    if target.kind == "edge" and type == "circle":
        curve = BRepAdaptor_Curve(target.shape)
        circle = curve.Circle()
        origin, normal = _gp(circle.Location()), _gp(circle.Axis().Direction())
        at = target.point if target.point is not None else _gp(curve.Value(curve.FirstParameter()))
        return "circle", circle.Radius(), origin, _away(at, origin, normal), normal, {}
    if target.kind != "face" or type not in ("cylinder", "sphere", "torus"):
        return None
    surface = BRepAdaptor_Surface(target.shape)
    at = target.point if target.point is not None else _centre(target)
    if type == "cylinder":
        cylinder = surface.Cylinder()
        origin, along = _gp(cylinder.Axis().Location()), _gp(cylinder.Axis().Direction())
        centre = _foot_on_line(at, origin, along)
        return "cylinder", cylinder.Radius(), centre, _away(at, centre, along), along, {}
    if type == "sphere":
        sphere = surface.Sphere()
        centre = _gp(sphere.Location())
        towards = _unit(at - centre)
        if towards is None:
            towards = np.array([1.0, 0.0, 0.0])
        return "sphere", sphere.Radius(), centre, towards, None, {}
    torus = surface.Torus()
    origin, along = _gp(torus.Axis().Location()), _gp(torus.Axis().Direction())
    # The tube runs round the axis: its centre nearest the point is the one meant.
    centre = origin + torus.MajorRadius() * _away(at, origin, along)
    towards = _unit(at - centre)
    if towards is None:
        towards = along
    major = {"major": float(torus.MajorRadius())}
    return "torus, of the tube", torus.MinorRadius(), centre, towards, along, major


def _away(at: np.ndarray, centre: np.ndarray, axis: np.ndarray) -> np.ndarray:
    """The unit direction from ``centre`` towards ``at``, square to ``axis``; any such for a point on it."""
    out = at - centre
    towards = _unit(out - (out @ axis) * axis)
    if towards is None:
        least = np.eye(3)[int(np.argmin(np.abs(axis)))]
        towards = _unit(least - (least @ axis) * axis)
    return towards


# Thickness


def _thickness(target: _Target, kept: dict[Any, Any]) -> dict[str, Any]:
    from build123d import Face, Vector
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

    if target.kind != "face" or target.point is None:
        why = target.what if target.kind != "face" else f"{target.name} has no point"
        raise QueryError(
            "bad_request", f"thickness needs a.ref, a face, and a.point, a point on it; {why}"
        )
    # The point given is near the face; the wall is measured from the face itself.
    onto = BRepExtrema_DistShapeShape(_vertex(target.point), target.shape)
    if not onto.IsDone() or onto.NbSolution() < 1:
        raise QueryError(
            "exception", f"no point of {target.ref} near the one given could be computed"
        )
    start = onto.PointOnShape2(1)
    try:
        normal = Face(target.shape).normal_at(Vector(start.X(), start.Y(), start.Z()))
    except Exception as e:
        raise QueryError("bad_request", f"{target.ref} has no normal at the point") from e
    inward = gp_Dir(-normal.X, -normal.Y, -normal.Z)
    rays = _rays(target, kept)
    rays.Perform(gp_Lin(start, inward), _OWN_FACE, _REACH)
    hits = range(1, rays.NbPnt() + 1) if rays.IsDone() else ()
    first = min(hits, key=rays.WParameter, default=None)
    if first is None:
        raise QueryError("bad_request", "no opposite wall along the normal")
    return {
        "value": float(rays.WParameter(first)),
        "unit": "mm",
        "how": "wall, along the normal",
        "points": [_gp(start), _gp(rays.Pnt(first))],
        "exact": True,
    }


def _rays(target: _Target, kept: dict[Any, Any]) -> Any:
    """What a line is cut with to find where it meets the target's part: made once per part."""
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

    held = ("rays", target.key)
    if held not in kept:
        kept[held] = IntCurvesFace_ShapeIntersector()
        kept[held].Load(getattr(target.part, "wrapped", target.part), 1e-7)
    return kept[held]


# Bounding box, volume, area, mass


def _bbox(target: _Target) -> dict[str, Any]:
    from ocp_tessellate.ocp_utils import Bnd_Box, BRepBndLib

    if target.kind == "point":
        raise QueryError("bad_request", f"bbox is measured of a part, a face or an edge; {target.what}")
    box = Bnd_Box()
    # Of the geometry itself: not of a mesh, and not widened by the shape's tolerance.
    BRepBndLib.AddOptimal_s(_topods(target), box, False, False)
    low, high = _gp(box.CornerMin()), _gp(box.CornerMax())
    exact = _boxed_exactly(target)
    return {
        "min": _out(low),
        "max": _out(high),
        "size": _out(high - low),
        "unit": "mm",
        "how": "axis-aligned box"
        if exact
        else "axis-aligned box, approximate on faces that are neither flat nor cylinders",
        "exact": exact,
    }


def _boxed_exactly(target: _Target) -> bool:
    """Whether the box of the target is its own: OCC's is not, of a freeform face."""
    from build123d import Face

    if target.kind == "edge":
        return _type(target) in ("line", "circle")
    faces = [target.shape] if target.kind == "face" else topo.faces(target.shape)
    return all(Face(face).geom_type.name.lower() in ("plane", "cylinder") for face in faces)


def _extent(kind: str, target: _Target) -> dict[str, Any]:
    from build123d import Face

    if kind == "volume":
        if target.kind != "part":
            raise QueryError("bad_request", f"volume is measured of a part; {target.what}")
        return _exactly(target.shape.volume, "mm3", "of the solid")
    if target.kind == "part":
        return _exactly(target.shape.area, "mm2", "surface of the part")
    if target.kind == "face":
        return _exactly(Face(target.shape).area, "mm2", "of the face")
    raise QueryError("bad_request", f"area is measured of a part or a face; {target.what}")


def _exactly(value: float, unit: str, how: str) -> dict[str, Any]:
    return {"value": float(value), "unit": unit, "how": how, "exact": True}


def _mass(target: _Target, density: Any, default: bool) -> dict[str, Any]:
    if target.kind != "part":
        raise QueryError("bad_request", f"mass is measured of a part; {target.what}")
    if (
        not isinstance(density, (int, float))
        or isinstance(density, bool)
        or not math.isfinite(density)
        or density <= 0
    ):
        raise QueryError("bad_request", "density is a positive number, in g/cm³")
    volume = float(target.shape.volume)
    return {
        # mm³ to cm³.
        "value": volume / 1000 * density,
        "unit": "g",
        "how": f"PLA {number(PLA)} g/cm³ (default)" if default else f"at {number(density)} g/cm³",
        "density": float(density),
        "volume": volume,
        "exact": True,
    }


# What a target is


def _type(target: _Target) -> str:
    """The type of a face or an edge, as ``describe`` names it."""
    from build123d import Edge, Face

    return (Face if target.kind == "face" else Edge)(target.shape).geom_type.name.lower()


def _centre(target: _Target) -> np.ndarray:
    """A point of a face (on a curved one, the middle of its parameter range) or of an edge."""
    from build123d import Edge, Face

    return _vector((Face if target.kind == "face" else Edge)(target.shape).center())


def _plane(target: _Target) -> tuple[np.ndarray, np.ndarray] | None:
    """Of a planar face, a point of it (the target's, or its centre) and its outward normal."""
    from build123d import Face

    if target.kind != "face" or _type(target) != "plane":
        return None
    face = Face(target.shape)
    centre = face.center()
    normal = _vector(face.normal_at(centre))
    at = _vector(centre)
    if target.point is not None:
        at = _foot_on_plane(target.point, at, normal)
    return at, normal


def _axis(target: _Target) -> tuple[np.ndarray, np.ndarray] | None:
    """Of a cylindrical face or a circular edge, the point of its axis level with the
    target's point (or with its centre) and the axis' direction."""
    found = _round(target)
    if found is None or found[0] not in ("cylinder", "circle"):
        return None
    return found[2], found[4]


def _line(target: _Target) -> tuple[np.ndarray, np.ndarray] | None:
    """Of a straight edge, a point of it (the target's, or its middle) and its direction."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve

    if target.kind != "edge" or _type(target) != "line":
        return None
    direction = _gp(BRepAdaptor_Curve(target.shape).Line().Direction())
    middle = _centre(target)
    at = middle if target.point is None else _foot_on_line(target.point, middle, direction)
    return at, direction


# Vectors


def _parallel(u: np.ndarray, v: np.ndarray) -> bool:
    return float(np.linalg.norm(np.cross(u, v))) <= _PARALLEL


def _foot_on_plane(point: np.ndarray, on_plane: np.ndarray, normal: np.ndarray) -> np.ndarray:
    return point - ((point - on_plane) @ normal) * normal


def _foot_on_line(point: np.ndarray, on_line: np.ndarray, direction: np.ndarray) -> np.ndarray:
    return on_line + ((point - on_line) @ direction) * direction


def _unit(vector: np.ndarray) -> np.ndarray | None:
    length = float(np.linalg.norm(vector))
    return None if length < _ZERO else vector / length


def _gp(xyz: Any) -> np.ndarray:
    """A ``gp_Pnt`` or ``gp_Dir`` as an array."""
    return np.array([xyz.X(), xyz.Y(), xyz.Z()])


def _vector(vector: Any) -> np.ndarray:
    """A build123d ``Vector`` as an array."""
    return np.array([vector.X, vector.Y, vector.Z])


def _out(vector: np.ndarray) -> list[float]:
    # Adding 0.0 turns -0.0 into 0.0.
    return [float(c) + 0.0 for c in vector]
