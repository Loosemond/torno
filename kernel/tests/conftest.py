from pathlib import Path

import pytest


@pytest.fixture
def ws() -> Path:
    """The fixture workspace: one object folder per loading case."""
    return Path(__file__).parent / "fixtures" / "ws"


@pytest.fixture(scope="session")
def spline_prism():
    """A prism 5 mm high on a closed spline, the area of its outline and its length.

    Neither is the kernel's: they are those of a polygon of 20,000 points of
    the spline, which are within 1e-8 of the true ones.
    """
    import numpy as np
    from build123d import Edge, Face, Vector, Wire, extrude

    through = [(20, 0), (14, 9), (0, 12), (-12, 8), (-15, -2), (-6, -11), (8, -9)]
    outline = Edge.make_spline([Vector(*p) for p in through], periodic=True)
    points = np.array([tuple(outline.position_at(t))[:2] for t in np.linspace(0, 1, 20001)[:-1]])
    u, v = points[:, 0], points[:, 1]
    area = abs(float(u @ np.roll(v, -1) - v @ np.roll(u, -1))) / 2
    length = float(np.sum(np.linalg.norm(points - np.roll(points, -1, axis=0), axis=1)))
    return extrude(Face(Wire([outline])), 5), area, length
