"""The area and the volume of a shape: the one place either is measured.

Neither is taken from the quick forms OCC and build123d use by default, which
integrate at a fixed order: exact of planes, cylinders and spheres, but out in
the fourth digit on a face that ends in a spline, and still said as if exact.

- A volume is exact only of a shape all planes, cylinders, cones, spheres
  and tori that end in lines and circles: the quick form is exact of those.
  Of any other it is integrated by Gauss-Kronrod, never to a tolerance that
  costs minutes (to 1e-9 a part of 92 faces, lofts and fillets, took 41 s at
  every build, and four of them made a build of 178 s out of one of 13),
  and is told as approximate (``Volume``): at two tolerances at the least,
  and at finer ones for as long as that costs next to nothing, with about
  how many digits of it are good by what the last two agree to and by what
  the integral says of itself. Neither is a proof: on that part, integrals
  that agreed to 1e-13 were 2e-5 out, and one that claimed 3e-7 was 2e-6 out.
- An area is the sum of the areas of the faces, each taken as its surface
  allows, and says whether it is exact (``Area``). It is exact of a plane, a
  cylinder, a cone, a sphere and a torus, and of a curve extruded straight
  and not cut along its height. Of any other face it never is: no integral
  OCC offers converges on every freeform face, none says when it has not, and
  three of them have agreed to a millionth while all were further out than
  that. So such an area is told as approximate, with about how many digits
  of it are good, or, when its integrals are too far apart for two, with how
  far apart they are.
"""

import math
import re
import time
from typing import Any, NamedTuple

from . import topo

# How near its true value an area of a known kind is integrated, as a part of it.
EPSILON = 1e-9
# The tolerances a volume that is not exact is integrated to by Gauss-Kronrod,
# as parts of it, one after the other: the first two always, the finer ones
# for as long as all before them took less than _SPARE together. Measured on
# the half of a guitar stand (92 faces, lofts and fillets): 0.05 s, 0.9 s,
# then 2.7 s, 6.4 s, 12 s, 19 s, and 41 s to 1e-9; on a part of a few freeform
# faces every one of them takes milliseconds.
VOLUME_TOLERANCES = (1.0, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7)
# Seconds of this process: so little that the next integral, which costs two
# or three times the last, is not noticed in a build.
_SPARE = 0.05
# What tells how long an integral took: the processor's time on this thread,
# which neither a loaded machine nor another thread stretches.
_clock = time.thread_time
# The finer tolerance an area of no known kind is integrated to: the nearest
# of the three integrals wherever it was checked, but for the kinds below.
_FINEST = 1e-12
# Surfaces of which the integral at a fixed order was the nearest instead: on
# 28 of 29 extrusions cut along their height and 16 of 16 offsets, the worst
# 3.7e-3 out where the finest was 3.9e-2.
_FIXED_ORDER = ("EXTRUSION", "OFFSET")
# Lengths of a curve that agree this nearly, as a part of themselves, are one length.
AGREED = 1e-6
# Surfaces whose area the integral with a tolerance has right, to 1e-11 and better.
_ANALYTIC = ("PLANE", "CYLINDER", "CONE", "SPHERE", "TORUS")
_STRAIGHT_OR_ROUND = ("LINE", "CIRCLE")
# Heights along an extrusion closer than this, mm, are one height.
_LEVEL = 1e-7
# An area that is not exact is said to be good to about this many significant
# digits, no more, whatever its integrals say of each other; and to none at
# all when they vouch for fewer than FEWEST_DIGITS: of 51 faces said to be
# good to two because that was the least said, 4 were more than 1e-2 out.
FEWEST_DIGITS, MOST_DIGITS = 2, 6


class Area(NamedTuple):
    """An area in mm², whether it is exact, and if not how far it can be relied on.

    ``digits`` is about how many significant digits of it are good, None of
    an exact one and of one whose integrals lie too far apart to say: then
    ``spread``, mm², how far apart they lie, is what there is to tell.
    """

    value: float
    exact: bool
    digits: int | None = None
    spread: float = 0.0


def area(shape: Any) -> Area:
    """The area of a face, or of all the faces of a part.

    Exact only if every face's is; otherwise its spread is the sum of its
    faces', and it is good to about as many digits as that leaves of all its
    area: a small face in doubt takes little from a large part.
    """
    each = [_face_area(face) for face in topo.faces(shape)]
    doubted = [one for one in each if not one.exact]
    value = math.fsum(one.value for one in each)
    if not doubted:
        return Area(value, True)
    spread = math.fsum(one.spread for one in doubted)
    return Area(value, False, _digits(spread, value), spread)


class Volume(NamedTuple):
    """A volume in mm³, whether it is exact, and if not how far it can be relied on.

    As an ``Area``: ``digits`` is about how many significant digits of it are
    good, None of an exact one and of one too much in doubt to say; then
    ``spread``, mm³, how much of it is in doubt, is what there is to tell.
    """

    value: float
    exact: bool
    digits: int | None = None
    spread: float = 0.0


def volume(shape: Any, known: list[tuple[Any, "Volume"]] | None = None) -> Volume:
    """The volume of the solids of a shape, mm³: 0 of one that has none.

    ``known`` holds the shapes whose volume was taken with it before, and
    gets this one: a solid placed again, in another layout or twice in one,
    is the same solid (one ``TShape``) wherever it is put, and is integrated
    once.
    """
    wrapped = _topods(shape)
    if known is not None:
        for placed, measured in known:
            if _same_solid(wrapped, placed):
                return measured
    measured, _ = volume_and_centre(shape, centre=False)
    if known is not None:
        known.append((wrapped, measured))
    return measured


def _same_solid(one: Any, other: Any) -> bool:
    """Whether two shapes are one, placed twice: a placement that scaled it would change its volume."""
    if not one.IsPartner(other):
        return False
    scales = [abs(shape.Location().Transformation().ScaleFactor()) for shape in (one, other)]
    return abs(scales[0] - scales[1]) <= 1e-12


def volume_and_centre(shape: Any, centre: bool = True) -> tuple[Volume, Any]:
    """The volume of the solids of a shape and, if wanted, their centre of mass as a ``gp_Pnt``.

    Taken of the shape itself, however its solids are nested in compounds. A
    shape with no solid has no volume: what the integral gives of an open
    shell is not one.
    """
    # OCP comes from the user's workspace, so it is imported only when used.
    from ocp_tessellate.ocp_utils import BRepGProp, GProp_GProps

    wrapped = _topods(shape)
    if not topo.solids(wrapped):
        return Volume(0.0, True), None
    if round_and_straight(wrapped):
        # The quick integral is exact of these (1e-15 wherever it was checked),
        # and Gauss-Kronrod takes 2 ms more of every torus: 0.9 s against
        # 0.07 s on a block with 289 filleted holes, at every build.
        measured = GProp_GProps()
        BRepGProp.VolumeProperties_s(wrapped, measured)
        return Volume(abs(float(measured.Mass())), True), measured.CentreOfMass() if centre else None
    # Gauss-Kronrod: the quick integral is 0.02 % out on a prism with a spline
    # for its outline and 0.6 % on a loft, and the form of it that takes an
    # epsilon does not converge there (0.7 % out at 1e-9).
    spent, taken = 0.0, []
    for tolerance in VOLUME_TOLERANCES:
        started = _clock()
        taken.append(_gauss_kronrod(wrapped, tolerance, centre))
        spent += _clock() - started
        # It cannot be interrupted: what bounds its cost is the tolerance it is
        # asked for, and that is chosen by what the looser ones took.
        if len(taken) >= 2 and spent >= _SPARE:
            break
    (before, _, _), (value, claimed, at) = taken[-2:]
    spread = abs(value - before)
    if math.isfinite(claimed) and claimed > 0:
        # No nearer than the integral says it is of itself.
        spread = max(spread, claimed * value)
    return Volume(value, False, _volume_digits(abs(value - before), claimed, value), spread), at


def _gauss_kronrod(wrapped: Any, tolerance: float, centre: bool) -> tuple[float, float, Any]:
    """A volume integrated by Gauss-Kronrod to a tolerance, as a part of it: the volume,
    the error the integral says it has left, as a part of it too, and the centre of
    mass if wanted."""
    from ocp_tessellate.ocp_utils import BRepGProp, GProp_GProps

    measured = GProp_GProps()
    claimed = BRepGProp.VolumePropertiesGK_s(wrapped, measured, tolerance, False, False, centre)
    return abs(float(measured.Mass())), float(claimed), measured.CentreOfMass() if centre else None


def _volume_digits(apart: float, claimed: float, value: float) -> int | None:
    """About how many significant digits are good of a volume whose last two integrals lie
    ``apart`` and whose last says it is within ``claimed`` of itself.

    The fewer of the two: one fewer than the integrals agree to, as of an
    area (``_digits``), and as many as the integral claims.
    """
    digits = _digits(apart, value)
    if digits is None or not (math.isfinite(claimed) and claimed > 0):
        return digits
    digits = min(digits, math.floor(-math.log10(claimed)))
    return digits if digits >= FEWEST_DIGITS else None


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
    # a loft all three were 1e-6 out while 1e-6 apart. The one told is the one
    # that was the nearest of its kind of face wherever it was checked, and
    # never as exact.
    fixed, loose, finest = (_integrated(face, tolerance) for tolerance in (None, EPSILON, _FINEST))
    told = fixed if type in _FIXED_ORDER else finest
    spread = max(fixed, loose, finest) - min(fixed, loose, finest)
    return Area(told, False, _digits(spread, told), spread)


def _digits(spread: float, value: float) -> int | None:
    """About how many significant digits are good of an area whose integrals lie ``spread`` apart.

    One fewer than they all agree to, since they may all be out on one side,
    and no more than MOST_DIGITS: integrals that coincide have been out in
    the seventh digit. None when that is fewer than FEWEST_DIGITS: integrals
    17 % apart have been 4 % out, and no count of digits says that.
    """
    if not (math.isfinite(spread) and math.isfinite(value)) or value <= 0:
        return None
    if spread <= 0:
        return MOST_DIGITS
    digits = min(MOST_DIGITS, math.floor(-math.log10(spread / value)) - 1)
    return digits if digits >= FEWEST_DIGITS else None


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
