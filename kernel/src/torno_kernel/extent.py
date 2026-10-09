"""The area and the volume of a shape: the one place either is measured.

Neither is taken from the quick forms OCC and build123d use by default, which
integrate at a fixed order: exact of planes, cylinders and spheres, but out in
the fourth digit on a face that ends in a spline, and still said as if exact.

- A volume is integrated by Gauss-Kronrod until it has converged to EPSILON
  of itself. That is right wherever it was checked, to 1e-9. Of a shape all
  planes, cylinders, cones, spheres and tori that end in lines and circles,
  the quick form is exact and is taken instead: it costs a tenth.
- An area is the sum of the areas of the faces, each taken as its surface
  allows, and says whether it is exact (``Area``). It is exact of a plane, a
  cylinder, a cone, a sphere and a torus, and of a curve extruded straight
  and not cut along its height. Of any other face it never is: no integral
  OCC offers converges on every freeform face, none says when it has not, and
  three of them have agreed to a millionth while all were further out than
  that. So such an area is told as approximate, with about how many digits
  of it are good.
"""

import math
import re
from typing import Any, NamedTuple

from . import topo

# How near its true value an area or a volume is integrated, as a part of it.
EPSILON = 1e-9
# The finer tolerance an area of no known kind is integrated to: the nearest
# of the three integrals wherever it was checked.
_FINEST = 1e-12
# Lengths of a curve that agree this nearly, as a part of themselves, are one length.
AGREED = 1e-6
# Surfaces whose area the integral with a tolerance has right, to 1e-11 and better.
_ANALYTIC = ("PLANE", "CYLINDER", "CONE", "SPHERE", "TORUS")
_STRAIGHT_OR_ROUND = ("LINE", "CIRCLE")
# Heights along an extrusion closer than this, mm, are one height.
_LEVEL = 1e-7
# An area that is not exact is said to be good to about this many significant
# digits, no fewer and no more, whatever its integrals say of each other.
FEWEST_DIGITS, MOST_DIGITS = 2, 6


class Area(NamedTuple):
    """An area in mm², whether it is exact, and if not about how many significant digits of it are good."""

    value: float
    exact: bool
    digits: int | None = None


def area(shape: Any) -> Area:
    """The area of a face, or of all the faces of a part.

    Exact only if every face's is; otherwise good to about as many digits as
    the face of which the fewest are.
    """
    each = [_face_area(face) for face in topo.faces(shape)]
    doubted = [one.digits for one in each if one.digits is not None]
    return Area(
        math.fsum(one.value for one in each),
        all(one.exact for one in each),
        min(doubted, default=None),
    )


def volume(shape: Any) -> float:
    """The volume of the solids of a shape, mm³: 0 of one that has none."""
    return volume_and_centre(shape, centre=False)[0]


def volume_and_centre(shape: Any, centre: bool = True) -> tuple[float, Any]:
    """The volume of the solids of a shape and, if wanted, their centre of mass as a ``gp_Pnt``.

    Taken of the shape itself, however its solids are nested in compounds. A
    shape with no solid has no volume: what the integral gives of an open
    shell is not one.
    """
    # OCP comes from the user's workspace, so it is imported only when used.
    from ocp_tessellate.ocp_utils import BRepGProp, GProp_GProps

    wrapped = _topods(shape)
    if not topo.solids(wrapped):
        return 0.0, None
    measured = GProp_GProps()
    if round_and_straight(wrapped):
        # The quick integral is exact of these (1e-15 wherever it was checked),
        # and Gauss-Kronrod takes 2 ms more of every torus: 0.9 s against
        # 0.07 s on a block with 289 filleted holes, at every build.
        BRepGProp.VolumeProperties_s(wrapped, measured)
    else:
        # Gauss-Kronrod: the quick integral is 0.02 % out on a prism with a
        # spline for its outline, and the form of it that takes an epsilon
        # does not converge there (0.7 % out at 1e-9).
        BRepGProp.VolumePropertiesGK_s(wrapped, measured, EPSILON, False, False, centre)
    return abs(float(measured.Mass())), measured.CentreOfMass() if centre else None


def round_and_straight(shape: Any) -> bool:
    """Whether every face is a plane, a cylinder, a cone, a sphere or a torus, and every
    edge a line or a circle."""
    from ocp_tessellate.ocp_utils import BRep_Tool, BRepAdaptor_Curve, BRepAdaptor_Surface

    wrapped = _topods(shape)
    try:
        if not all(_kind(BRepAdaptor_Surface(face)) in _ANALYTIC for face in topo.faces(wrapped)):
            return False
        return all(
            _kind(BRepAdaptor_Curve(edge)) in _STRAIGHT_OR_ROUND
            for edge in topo.edges(wrapped)
            # A sphere's pole is an edge with no curve, and no extent.
            if not BRep_Tool.Degenerated_s(edge)
        )
    except Exception:
        # An edge with no curve to name the type of.
        return False


def _kind(adaptor: Any) -> str:
    """The type of a surface or a curve, in capitals: GeomAbs_Plane is PLANE."""
    return re.split(r"[_.]", str(adaptor.GetType()))[-1].upper()


def _face_area(face: Any) -> Area:
    from build123d import Face

    type = Face(face).geom_type.name
    if type in _ANALYTIC:
        return Area(_integrated(face, EPSILON), True)
    if type == "EXTRUSION":
        swept = _swept(face)
        if swept is not None:
            return swept
    # Three integrals, none of them a proof, nor their agreement: on a spline
    # extruded and cut on the slant the two with a tolerance are out by up to
    # 2 %, on a sphere scaled to an ellipsoid the one without by 0.4 %, and on
    # a loft all three were 1e-6 out while 1e-6 apart. The finest is told,
    # which was the nearest wherever it was checked, and never as exact.
    fixed, loose, finest = (_integrated(face, tolerance) for tolerance in (None, EPSILON, _FINEST))
    return Area(finest, False, _digits(max(fixed, loose, finest) - min(fixed, loose, finest), finest))


def _digits(spread: float, value: float) -> int:
    """About how many significant digits are good of an area whose integrals lie ``spread`` apart.

    One fewer than they all agree to, since they may all be out on one side;
    and between FEWEST_DIGITS and MOST_DIGITS whatever they say: integrals
    that coincide have been out in the seventh digit.
    """
    if not (math.isfinite(spread) and math.isfinite(value)) or value <= 0:
        return FEWEST_DIGITS
    if spread <= 0:
        return MOST_DIGITS
    agreed = math.floor(-math.log10(spread / value))
    return max(FEWEST_DIGITS, min(MOST_DIGITS, agreed - 1))


def _integrated(face: Any, tolerance: float | None) -> float:
    """The area OCC integrates of a face: at a fixed order, or until it says it is within a tolerance."""
    from ocp_tessellate.ocp_utils import BRepGProp, GProp_GProps

    measured = GProp_GProps()
    if tolerance is None:
        BRepGProp.SurfaceProperties_s(face, measured)
    else:
        BRepGProp.SurfaceProperties_s(face, measured, tolerance)
    return abs(float(measured.Mass()))


def _swept(face: Any) -> Area | None:
    """The area of a curve extruded straight and not cut along its height: its length times the height.

    Such a face is bounded by the curve at one height, the same curve at
    another, and straight edges along the extrusion between them. None for a
    face that is anything else, or whose length does not settle.
    """
    from ocp_tessellate.ocp_utils import BRep_Tool, BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.GCPnts import GCPnts_AbscissaPoint

    if len(topo.wires(face)) != 1:
        return None
    along = BRepAdaptor_Surface(face).Direction()
    levels: list[tuple[float, float, float]] = []  # height, and the edge's length at two tolerances
    for edge in topo.edges(face):
        if BRep_Tool.Degenerated_s(edge):
            continue
        curve = BRepAdaptor_Curve(edge)
        first, last = curve.FirstParameter(), curve.LastParameter()
        points = [curve.Value(first + (last - first) * i / 8) for i in range(9)]
        heights = [p.X() * along.X() + p.Y() * along.Y() + p.Z() * along.Z() for p in points]
        if max(heights) - min(heights) <= _LEVEL:
            lengths = [GCPnts_AbscissaPoint.Length_s(curve, tolerance) for tolerance in (1e-7, 1e-10)]
            levels.append((heights[0], *lengths))
            continue
        # Anything else is a straight edge along the extrusion: every point of
        # it is over the first.
        feet = [
            (
                p.X() - h * along.X() - (points[0].X() - heights[0] * along.X()),
                p.Y() - h * along.Y() - (points[0].Y() - heights[0] * along.Y()),
                p.Z() - h * along.Z() - (points[0].Z() - heights[0] * along.Z()),
            )
            for p, h in zip(points, heights, strict=True)
        ]
        if any(math.hypot(*foot) > _LEVEL for foot in feet):
            return None
    if not levels:
        return None
    bottom, top = min(level[0] for level in levels), max(level[0] for level in levels)
    below = [level for level in levels if level[0] - bottom <= _LEVEL]
    above = [level for level in levels if top - level[0] <= _LEVEL]
    if top - bottom <= _LEVEL or len(below) + len(above) != len(levels):
        return None
    # The curve at the bottom at one tolerance and another, and the curve at the top.
    lengths = [sum(level[1] for level in below), sum(level[2] for level in below), sum(level[2] for level in above)]
    if max(lengths) - min(lengths) > AGREED * lengths[1]:
        return None
    return Area(lengths[1] * (top - bottom), True)


def _topods(shape: Any) -> Any:
    return getattr(shape, "wrapped", shape)
