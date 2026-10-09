"""The area and the volume of a shape: the one place either is measured.

Both are integrated until they have converged to EPSILON of themselves. The
quicker forms OCC and build123d use by default integrate at a fixed order:
exact of planes, cylinders and spheres, but out in the fourth digit on a face
that ends in a spline, and still said as if exact.
"""

from typing import Any

from . import topo

# How near its true value an area or a volume is integrated, as a part of it.
EPSILON = 1e-9


def area(shape: Any) -> float:
    """The area of a face, or of all the faces of a part, mm²."""
    # OCP comes from the user's workspace, so it is imported only when used.
    from ocp_tessellate.ocp_utils import BRepGProp, GProp_GProps

    measured = GProp_GProps()
    BRepGProp.SurfaceProperties_s(_topods(shape), measured, EPSILON)
    return abs(float(measured.Mass()))


def volume(shape: Any) -> float:
    """The volume of the solids of a shape, mm³: 0 of one that has none."""
    return volume_and_centre(shape, centre=False)[0]


def volume_and_centre(shape: Any, centre: bool = True) -> tuple[float, Any]:
    """The volume of the solids of a shape and, if wanted, their centre of mass as a ``gp_Pnt``.

    Taken of the shape itself, however its solids are nested in compounds. A
    shape with no solid has no volume: what the integral gives of an open
    shell is not one.
    """
    from ocp_tessellate.ocp_utils import BRepGProp, GProp_GProps

    wrapped = _topods(shape)
    if not topo.solids(wrapped):
        return 0.0, None
    measured = GProp_GProps()
    # Gauss-Kronrod: the form of VolumeProperties that takes an epsilon does not
    # converge on a prism with a spline for its outline (0.7 % out at 1e-9).
    BRepGProp.VolumePropertiesGK_s(wrapped, measured, EPSILON, False, False, centre)
    return abs(float(measured.Mass())), measured.CentreOfMass() if centre else None


def _topods(shape: Any) -> Any:
    return getattr(shape, "wrapped", shape)
