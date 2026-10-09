from pathlib import Path

import pytest


@pytest.fixture
def ws() -> Path:
    """The fixture workspace: one object folder per loading case."""
    return Path(__file__).parent / "fixtures" / "ws"


@pytest.fixture(scope="session")
def spline_prism():
    """A prism 5 mm high on a closed spline, and the area of its outline.

    The area is not the kernel's: it is that of a polygon of 200,000 points
    of the spline, which is within 1e-9 of the true one.
    """
    import numpy as np
    from build123d import Edge, Face, Vector, Wire, extrude

    through = [(20, 0), (14, 9), (0, 12), (-12, 8), (-15, -2), (-6, -11), (8, -9)]
    outline = Edge.make_spline([Vector(*p) for p in through], periodic=True)
    points = np.array([tuple(outline.position_at(t))[:2] for t in np.linspace(0, 1, 200001)[:-1]])
    u, v = points[:, 0], points[:, 1]
    area = abs(float(u @ np.roll(v, -1) - v @ np.roll(u, -1))) / 2
    return extrude(Face(Wire([outline])), 5), area
