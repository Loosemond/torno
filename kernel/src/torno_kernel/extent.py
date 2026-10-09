"""The area and the volume of a shape: the one place either is measured.

Neither is taken from the quick forms OCC and build123d use by default, which
integrate at a fixed order: exact of planes, cylinders and spheres, but out in
the fourth digit on a face that ends in a spline, and still said as if exact.

- A volume is integrated by Gauss-Kronrod until it has converged to EPSILON
  of itself. That is right wherever it was checked, to 1e-9.
- An area is the sum of the areas of the faces, each taken as its surface
  allows, and says whether it is exact (``Area``). No integral OCC offers
  converges on every freeform face, and none says when it has not: so of such
  a face three are taken, and the area is exact only when they agree.
"""

import math
from typing import Any, NamedTuple

from . import topo

# How near its true value an area or a volume is integrated, as a part of it.
EPSILON = 1e-9
# Areas that agree this nearly, as a part of themselves, are one area.
AGREED = 1e-6
# Surfaces whose area the integral with a tolerance has right, to 1e-11 and better.
_ANALYTIC = ("PLANE", "CYLINDER", "CONE", "SPHERE", "TORUS")
# Heights along an extrusion closer than this, mm, are one height.
_LEVEL = 1e-7


class Area(NamedTuple):
    """An area in mm², whether it is exact, and if not how far out it may be, mm²."""

    value: float
    exact: bool
    doubt: float = 0.0

    @property
    def digits(self) -> int:
        """How many digits of an area that is not exact can be relied on."""
        if self.doubt <= 0 or self.value <= 0:
            return 15
        return max(0, min(15, math.floor(-math.log10(self.doubt / self.value))))


def area(shape: Any) -> Area:
    """The area of a face, or of all the faces of a part: exact only if every face's is."""
    each = [_face_area(face) for face in topo.faces(shape)]
    return Area(
        sum(one.value for one in each),
        all(one.exact for one in each),
        sum(one.doubt for one in each),
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
    # Gauss-Kronrod: the form of VolumeProperties that takes an epsilon does not
    # converge on a prism with a spline for its outline (0.7 % out at 1e-9).
    BRepGProp.VolumePropertiesGK_s(wrapped, measured, EPSILON, False, False, centre)
    return abs(float(measured.Mass())), measured.CentreOfMass() if centre else None


def _face_area(face: Any) -> Area:
    from build123d import Face

    type = Face(face).geom_type.name
    if type in _ANALYTIC:
        return Area(_integrated(face, EPSILON), True)
    if type == "EXTRUSION":
        swept = _swept(face)
        if swept is not None:
            return swept
    # Three integrals, none to be trusted alone: on a spline extruded, the two
    # with a tolerance are out by up to 2 %, and on a sphere scaled to an
    # ellipsoid the one without by 0.4 %. The middle one is told, and is exact
    # only if the other two are where it is.
    low, middle, high = sorted(_integrated(face, tolerance) for tolerance in (None, 1e-9, 1e-12))
    if high - low <= AGREED * middle:
        return Area(middle, True)
    return Area(middle, False, min(high - middle, middle - low))


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
