"""Exact measurements of the built shapes: the ``measure`` query.

Every reply says ``how`` the value was taken and whether it is ``exact``.
Lengths are millimetres, angles degrees; points and directions are in the
frame of the layout the targets are in.
"""

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import extent, tess, topo
from .describe import number, reversed_text
from .queries import (
    QueryError,
    area_of,
    as_point,
    box_of,
    boxed_exactly_of,
    need_layout,
    need_solid,
    resolve,
    volume_of,
)

KINDS = ("distance", "angle", "radius", "diameter", "thickness", "bbox", "volume", "area", "mass")
# The kinds that are taken between two targets.
_BETWEEN = ("distance", "angle")
_TARGET = "a target: ref, a string, or layout, a string, with point, three finite numbers, or all three"
# Planes, axes and lines closer to parallel than this are parallel.
_PARALLEL = math.sin(math.radians(0.01))
# A wall thinner than this is the face the ray starts on.
_OWN_FACE = 1e-6
# A point this near a face, mm, is on it: further off, the wall asked about is not
# the one measured. A point picked on the mesh is as far off the face as the mesh
# is, which on a large curved part is more: then the band is this many times the
# part's deflection.
_ON_FACE = 0.05
_ON_MESH = 1.5
# Nor is it on the face when it is further from it than this part of the wall
# measured there: it is nearer the wall's other side. No less than half, or a
# thin round wall cannot be measured from its mesh at all: the triangles of a
# shell of 200 mm radius and 0.5 mm wall are 0.13 mm under its face.
_OF_THE_WALL = 0.5
# How far a ray is followed, mm.
_REACH = 1e7
PLA = 1.24  # g/cm³
# A face or an edge of another type than plane or line is taken for one, for an
# angle, when it is no further than this from one, mm.
_FLAT = 1e-6
_FLAT_SAID = "1e-6"
# Points an edge is sampled at to tell whether it is straight.
_SAMPLES = 129
# Types that are never flat or straight.
_CURVED = ("cylinder", "cone", "sphere", "torus", "circle", "ellipse", "hyperbola", "parabola")
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
        type = _type(self)
        return f"{self.ref} is {'an' if type[:1] in 'aeiou' else 'a'} {type} {self.kind}"


def measure(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any] | None) -> dict[str, Any]:
    """Answer ``measure``: ``args`` are ``kind``, the target ``a`` and, for some, ``b`` or ``density``.

    A target is ``{"ref": "assembly:lid/F12"}``, a point of a layout
    (``{"layout": "assembly", "point": [x, y, z]}``), or a ref with a point:
    then it is the feature the ref names, and the point says where on it the
    measurement is taken or drawn.

    - ``distance``: between two parallel planar faces, the distance between
      their planes; between two cylinders or circles of parallel axes, between
      the axes; from a point to a planar face, to its plane; between two
      points; of anything else the minimum. Where an end is a whole part
      that is ``minimum, between surfaces``: a part inside another, or a
      point inside a part, is as far from it as from its surface, not 0.
    - ``angle``: between the outward normals of two planar faces (0 for faces
      that look the same way, 180 for opposite ones), between two straight
      edges or between a straight edge and a planar face (both 0 to 90: a
      line has no sense). The axis of a cylindrical, conical or toroidal face
      or of a circular edge is taken as a line (``between axes``, ``axis to
      plane``, ``between lines, one an axis``), drawn from its point. A face of another type than a plane that is within
      1e-6 mm of one is taken for it, and an edge of another type than a line
      that is within 1e-6 mm of one (B-spline, extrusion): then ``exact`` is
      false and ``how`` says ``flat`` or ``straight within 1e-6 mm``.
    - ``radius``, ``diameter``: of a cylindrical, spherical or toroidal face
      (of a torus its tube, with ``major``) or of a circular edge.
    - ``thickness``: from a point of a face of a solid along its inward
      normal to where the same part ends. The point is on the face, or as
      near it as a pick on the mesh is: within 0.05 mm, or 1.5 times the
      deflection the part is drawn with where that is more, up to half the
      wall that is found there. It is laid on the face and ``moved``
      says how far, mm; one further off is refused.
    - ``bbox`` of a part, a face or an edge, exact when all its faces are
      planes or cylinders and all its edges lines or circles; ``volume`` and
      ``mass`` of a part that is a solid, exact of one all planes, cylinders,
      cones, spheres and tori that end in lines and circles, and of any
      other approximate (``extent``), with the digits of it that are good
      in ``how``; ``area`` of a part or a face,
      exact of planes, cylinders, cones, spheres, tori and curves extruded
      straight; of any other face it is approximate (``extent``), and ``how``
      says about how many significant digits of it are good, two to six, or
      by how much of it its integrals differ when they are too far apart for two.

    ``kept`` is the worker's (``queries.run``): what is measured of a whole
    part (its box, its volume, its area) is measured once.
    """
    kind = args.get("kind")
    if kind not in KINDS:
        raise QueryError(
            "bad_request",
            f"measure needs args.kind, one of {', '.join(KINDS[:-1])} and {KINDS[-1]}",
        )
    a = _target(shapes, kind, "a", args.get("a"), kept)
    if kind in _BETWEEN:
        b = _target(shapes, kind, "b", args.get("b"), kept)
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
        result = _bbox(a, kept)
    elif kind == "mass":
        result = _mass(a, args.get("density", PLA), "density" not in args, kept)
    else:
        result = _extent(kind, a, kept)
    points = result.pop("points", None)
    if points is not None:
        result["points"] = [_out(p) for p in points]
    return {"kind": kind, **result}


def _target(shapes: dict[str, Any], kind: str, name: str, value: Any, kept: dict[Any, Any] | None = None) -> _Target:
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
    key, what, shape = resolve(shapes, ref, kept)
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
        # Said of a whole part, so that 8 mm to a part it is inside of is not read as apart.
        "how": "minimum, between surfaces" if "part" in (a.kind, b.kind) else "minimum",
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
    plane_a, plane_b = _flat(a), _flat(b)
    line_a, line_b = _straight(a), _straight(b)
    # A round face or edge is taken by its axis, as a line.
    axis_a = None if plane_a or line_a else _round_axis(a)
    axis_b = None if plane_b or line_b else _round_axis(b)
    along_a, along_b = line_a or axis_a, line_b or axis_b
    if plane_a and plane_b:
        how, cosine = "between normals", float(plane_a[1] @ plane_b[1])
        degrees = math.degrees(math.acos(max(-1.0, min(1.0, cosine))))
    elif along_a and along_b:
        if axis_a and axis_b:
            how = "between axes"
        else:
            how = "between lines, one an axis" if axis_a or axis_b else "between lines"
        cosine = abs(float(along_a[1] @ along_b[1]))
        degrees = math.degrees(math.acos(min(1.0, cosine)))
    elif (plane_a and along_b) or (along_a and plane_b):
        normal = (plane_a or plane_b)[1]
        direction = (along_a or along_b)[1]
        how = "axis to plane" if axis_a or axis_b else "line to plane"
        degrees = math.degrees(math.asin(min(1.0, abs(float(normal @ direction)))))
    else:
        # The first that is none of them is the one to name.
        odd = a if not (plane_a or along_a) else b
        raise QueryError(
            "bad_request",
            "angle is measured between planar faces, straight edges and the axes of cylinders, "
            f"cones, tori and circles; {_not_flat(odd)}",
        )
    ends = [(plane_a or along_a), (plane_b or along_b)]
    # Flat or straight only within the tolerance: said, and not exact.
    within = []
    if any(plane is not None and not plane[2] for plane in (plane_a, plane_b)):
        within.append("flat")
    if any(line is not None and not line[2] for line in (line_a, line_b)):
        within.append("straight")
    if within:
        how += f", {' and '.join(within)} within {_FLAT_SAID} mm"
    return {
        "value": degrees,
        "unit": "deg",
        "how": how,
        "points": [ends[0][0], ends[1][0]],
        "exact": not within,
    }


def _not_flat(target: _Target) -> str:
    """What a face or an edge an angle cannot be taken of is, to end a refusal with: one
    whose type may be flat or straight is said to be curved."""
    if target.kind not in ("face", "edge") or _type(target) in _CURVED:
        return target.what
    type = _type(target)
    article = "an" if type[:1] in "aeiou" else "a"
    shape = "flat" if target.kind == "face" else "straight"
    return f"{target.ref} is curved: {article} {type} {target.kind} that is not {shape}"


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
    """The unit direction from ``centre`` towards ``at``, square to ``axis``.

    Any such direction, for a point on the axis.
    """
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
    from OCP.gp import gp_Dir, gp_Lin

    if target.kind != "face" or target.point is None:
        why = target.what if target.kind != "face" else f"{target.name} has no point"
        raise QueryError(
            "bad_request", f"thickness needs a.ref, a face, and a.point, a point on it; {why}"
        )
    need_solid(target.part, target.key)
    # The wall is measured from the face itself: the point given is on it, to within rounding.
    onto = BRepExtrema_DistShapeShape(_vertex(target.point), target.shape)
    if not onto.IsDone() or onto.NbSolution() < 1:
        raise QueryError(
            "exception", f"no point of {target.ref} near the one given could be computed"
        )
    moved = float(onto.Value())
    refusal = QueryError(
        "bad_request", f"the point is {number(moved)} mm from {target.ref}: give a point on the face"
    )
    band = _band(target, kept)
    if moved > band:
        raise refusal
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
    wall = float(rays.WParameter(first))
    # A point as far off as the mesh is coarse may be on the other side of a
    # thin wall: one further from the face than half the wall found is not
    # taken for a point of it, unless it is a hair off.
    if moved > max(_ON_FACE, wall * _OF_THE_WALL):
        raise refusal
    return {
        "value": wall,
        "unit": "mm",
        "how": "wall, along the normal",
        "points": [_gp(start), _gp(rays.Pnt(first))],
        "moved": moved,
        "exact": True,
    }


def _band(target: _Target, kept: dict[Any, Any]) -> float:
    """How far off a face of the target's part a point may be given at most, mm.

    As far as the mesh the part is drawn with is off it, and half as far
    again, and never less than _ON_FACE. The deflection is the one the build
    drew the part with, when it kept it (``tess.build_scene``): worked out
    again of a part that now carries its mesh, it is another.
    """
    held = ("deflection", target.key)
    if held not in kept:
        kept[held] = tess.deflection(target.part)
    return max(_ON_FACE, _ON_MESH * kept[held])


def _rays(target: _Target, kept: dict[Any, Any]) -> Any:
    """What a line is cut with to find where it meets the target's part: made once per part."""
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

    held = ("rays", target.key)
    if held not in kept:
        kept[held] = IntCurvesFace_ShapeIntersector()
        kept[held].Load(getattr(target.part, "wrapped", target.part), 1e-7)
    return kept[held]


# Bounding box, volume, area, mass


def _bbox(target: _Target, kept: dict[Any, Any] | None) -> dict[str, Any]:
    if target.kind == "point":
        raise QueryError("bad_request", f"bbox is measured of a part, a face or an edge; {target.what}")
    # Of a whole part it is kept, and is the box the scene tells: a face or an edge is boxed in no time.
    if target.kind == "part":
        low, high = box_of(target.shape, target.key, kept)
        exact = boxed_exactly_of(target.shape, target.key, kept)
    else:
        low, high = box_of(target.shape, None, kept)
        exact = extent.boxed_exactly(target.shape)
    return {
        "min": list(low),
        "max": list(high),
        "size": [b - a + 0.0 for a, b in zip(low, high, strict=True)],
        "unit": "mm",
        "how": "axis-aligned box"
        if exact
        else "axis-aligned box, approximate: exact only of planes and cylinders with "
        "straight and circular edges",
        "exact": exact,
    }


def _extent(kind: str, target: _Target, kept: dict[Any, Any] | None) -> dict[str, Any]:
    if kind == "volume":
        if target.kind != "part":
            raise QueryError("bad_request", f"volume is measured of a part; {target.what}")
        need_solid(target.shape, target.key)
        volume = volume_of(target.shape, target.key, kept)
        how = "of the solid" + volume_doubt(volume) + volume_reversed(volume)
        return {
            "value": volume.value,
            "unit": "mm3",
            "how": how,
            "exact": volume.exact,
            **({"reversed": list(volume.reversed)} if volume.reversed else {}),
        }
    if target.kind not in ("part", "face"):
        raise QueryError("bad_request", f"area is measured of a part or a face; {target.what}")
    if target.kind == "part":
        area = area_of(target.shape, target.key, kept)
    else:
        area = extent.area(target.shape)
    how = "surface of the part" if target.kind == "part" else "of the face"
    if not area.exact:
        # Of a freeform face OCC has no integral that is a proof: see extent.
        how += f", approximate{_doubt(area)}"
    return {"value": area.value, "unit": "mm2", "how": how, "exact": area.exact}


def _doubt(area: extent.Area) -> str:
    """How far an area that is not exact can be relied on, to follow "approximate" with."""
    if area.digits is not None:
        return f", good to about {area.digits} significant digits"
    if not (math.isfinite(area.value) and math.isfinite(area.spread)) or area.value <= 0:
        return ""
    # Too far apart to vouch for two digits: how far, as a part of the area, to two digits.
    percent = float(f"{100 * area.spread / area.value:.2g}")
    return f": its integrals differ by {number(percent)} %"


def volume_doubt(volume: extent.Volume) -> str:
    """What follows ``how`` of a volume: nothing of an exact one, else how far it can be relied on."""
    if volume.exact:
        return ""
    if volume.digits is not None:
        return f", approximate, good to about {volume.digits} significant digits"
    if not (math.isfinite(volume.value) and math.isfinite(volume.spread)) or volume.value <= 0:
        return ", approximate"
    # Too much in doubt to vouch for two digits: how much, as a part of the volume, to two digits.
    percent = float(f"{100 * volume.spread / volume.value:.2g}")
    return f", approximate: in doubt by {number(percent)} %"


def volume_reversed(volume: extent.Volume) -> str:
    """What follows ``how`` of a volume with solids inside out: nothing of a sound one."""
    if not volume.reversed:
        return ""
    return f"; {reversed_text(volume.reversed)} (faces point inward), counted as the material enclosed"


def _mass(
    target: _Target, density: Any, default: bool, kept: dict[Any, Any] | None
) -> dict[str, Any]:
    if target.kind != "part":
        raise QueryError("bad_request", f"mass is measured of a part; {target.what}")
    try:
        # An integer of hundreds of digits, which JSON may hold, is not finite to a float.
        usable = (
            isinstance(density, (int, float))
            and not isinstance(density, bool)
            and math.isfinite(density)
            and density > 0
        )
    except OverflowError:
        usable = False
    if not usable:
        raise QueryError("bad_request", "density is a positive number, in g/cm³")
    need_solid(target.shape, target.key)
    volume = volume_of(target.shape, target.key, kept)
    how = f"PLA {number(PLA)} g/cm³ (default)" if default else f"at {number(density)} g/cm³"
    if not volume.exact:
        # No more exact than the volume it is of.
        how += f"; volume{volume_doubt(volume)[1:]}"
    how += volume_reversed(volume)
    return {
        # mm³ to cm³.
        "value": volume.value / 1000 * density,
        "unit": "g",
        "how": how,
        "density": float(density),
        "volume": volume.value,
        "exact": volume.exact,
        **({"reversed": list(volume.reversed)} if volume.reversed else {}),
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


def _round_axis(target: _Target) -> tuple[np.ndarray, np.ndarray, bool] | None:
    """Of a cylindrical, conical or toroidal face or a circular edge, the point of its
    axis nearest the target's point (or its centre; of a circle, its centre) and the
    axis' direction, as ``_line`` says them of a line."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface

    if target.kind not in ("face", "edge"):
        return None
    type = _type(target)
    if target.kind == "edge":
        if type != "circle":
            return None
        circle = BRepAdaptor_Curve(target.shape).Circle()
        return _gp(circle.Location()), _gp(circle.Axis().Direction()), True
    surface = BRepAdaptor_Surface(target.shape)
    if type == "cylinder":
        axis = surface.Cylinder().Axis()
    elif type == "cone":
        axis = surface.Cone().Axis()
    elif type == "torus":
        axis = surface.Torus().Axis()
    else:
        return None
    origin, along = _gp(axis.Location()), _gp(axis.Direction())
    at = target.point if target.point is not None else _centre(target)
    return _foot_on_line(at, origin, along), along, True


def _flat(target: _Target) -> tuple[np.ndarray, np.ndarray, bool] | None:
    """Of a face that is flat, what ``_plane`` says of it and whether it is a plane
    exactly; one of another type is flat when it is within ``_FLAT`` of a plane."""
    exactly = _plane(target)
    if exactly is not None:
        return *exactly, True
    if target.kind != "face" or _type(target) in _CURVED:
        return None
    from build123d import Face
    from OCP.BRep import BRep_Tool
    from OCP.GeomLib import GeomLib_IsPlanarSurface

    planar = GeomLib_IsPlanarSurface(BRep_Tool.Surface_s(target.shape), _FLAT)
    if not planar.IsPlanar():
        return None
    plane = planar.Plan()
    normal = _gp(plane.Axis().Direction())
    face = Face(target.shape)
    centre = face.center()
    # The plane's normal faces either way: the face's own says which is out.
    if normal @ _vector(face.normal_at(centre)) < 0:
        normal = -normal
    near = _vector(centre) if target.point is None else target.point
    at = _foot_on_plane(near, _gp(plane.Location()), normal)
    return at, normal, False


def _straight(target: _Target) -> tuple[np.ndarray, np.ndarray, bool] | None:
    """Of an edge that is straight, what ``_line`` says of it and whether it is a line
    exactly; one of another type is straight when no point of it sampled is further
    than ``_FLAT`` from the line through its ends."""
    exactly = _line(target)
    if exactly is not None:
        return *exactly, True
    if target.kind != "edge" or _type(target) in _CURVED:
        return None
    from OCP.BRepAdaptor import BRepAdaptor_Curve

    curve = BRepAdaptor_Curve(target.shape)
    first, last = curve.FirstParameter(), curve.LastParameter()
    points = np.array([_gp(curve.Value(t)) for t in np.linspace(first, last, _SAMPLES)])
    start = points[0]
    direction = _unit(points[-1] - start)
    if direction is None:
        return None
    off = points - start
    if float(np.max(np.linalg.norm(off - np.outer(off @ direction, direction), axis=1))) > _FLAT:
        return None
    middle = (start + points[-1]) / 2
    at = middle if target.point is None else _foot_on_line(target.point, middle, direction)
    return at, direction, False


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
