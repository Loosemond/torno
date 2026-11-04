"""bd_warehouse is in torno's own kernel environment (the dev group, beside build123d), without a project."""

import build123d


def test_bd_warehouse_imports_beside_the_pinned_build123d():
    from bd_warehouse.bearing import SingleRowDeepGrooveBallBearing
    from bd_warehouse.fastener import ClearanceHole, Nut, SocketHeadCapScrew

    assert build123d.__version__ == "0.13.0"
    screw = SocketHeadCapScrew(size="M3-0.5", length=10, fastener_type="iso4762", simple=True)
    assert 100 < screw.volume < 130
    bearing = SingleRowDeepGrooveBallBearing(size="M8-22-7", bearing_type="SKT")
    assert tuple(round(x) for x in bearing.bounding_box().size) == (22, 22, 7)
    assert Nut and ClearanceHole
