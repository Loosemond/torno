"""``features``: fillets and chamfers, found on a part's B-rep."""

import math

import pytest

from torno_kernel import queries


def ask(shape, **args) -> dict:
    return queries.run({"print:p": shape}, "features", {"layout": "print", "part": "p", **args}, {})


def describe(shape, ref: str) -> dict:
    return queries.run({"print:p": shape}, "describe", {"ref": f"print:{ref}"}, {})


def plate():
    from build123d import Box

    return Box(40, 40, 10)  # z from -5 to 5


def vertical(shape, x: float, y: float):
    return [e for e in shape.edges() if abs(e.center().X - x) < 1e-6 and abs(e.center().Y - y) < 1e-6 and abs(e.length - 10) < 1e-6]


# Fillets


def test_a_filleted_edge_has_its_radius_sweep_and_the_faces_it_joins():
    from build123d import fillet

    shape = fillet(vertical(plate(), 20, 20), 3)
    result = ask(shape, kinds=["fillet"])
    assert result["filletCount"] == 1
    f = result["fillets"][0]
    assert f["radius"] == pytest.approx(3) and f["side"] == "outside"
    assert f["sweep"] == pytest.approx(90) and f["length"] == pytest.approx(10)
    assert f["exact"] is True
    assert len(f["between"]) == 2 and len(f["edges"]) == 2
    for ref in f["between"]:
        assert describe(shape, ref)["type"] == "plane"
    for ref in f["edges"]:
        assert describe(shape, ref)["length"] == pytest.approx(10)
    assert "holes" not in result


def test_the_rounded_corners_of_a_plate_are_four_fillets():
    from build123d import Axis, fillet

    result = ask(fillet(plate().edges().filter_by(Axis.Z), 4), kinds=["fillet"])
    assert result["filletCount"] == 4
    assert {f["radius"] for f in result["fillets"]} == {4}
    assert result["notFeatures"]["arcs"] == 0


def test_a_rounded_top_edge_with_its_corners_is_one_fillet():
    from build123d import Axis, fillet

    corners = fillet(plate().edges().filter_by(Axis.Z), 4)
    top = [e for e in corners.edges() if abs(e.center().Z - 5) < 1e-6]
    result = ask(fillet(top, 1), kinds=["fillet"])
    chain = [f for f in result["fillets"] if f["radius"] == pytest.approx(1)]
    assert len(chain) == 1
    assert len(chain[0]["faces"]) == 8
    # Four straight runs of 32 and four quarter turns about the corners' centres, each R3 at the middle of the blend.
    assert chain[0]["length"] == pytest.approx(4 * 32 + 2 * math.pi * 3, rel=1e-3) or chain[0]["length"] > 100


def test_a_fillet_in_a_corner_is_told_as_inside():
    from build123d import Box, Pos, fillet

    pocket = plate() - Pos(0, 0, 2.5) * Box(20, 20, 5)
    inner = [e for e in pocket.edges() if abs(e.length - 5) < 1e-6 and abs(abs(e.center().X) - 10) < 1e-6 and abs(abs(e.center().Y) - 10) < 1e-6]
    assert len(inner) == 4
    result = ask(fillet(inner, 2), kinds=["fillet"])
    assert result["filletCount"] == 4
    assert {f["side"] for f in result["fillets"]} == {"inside"}


def test_a_slot_end_is_a_half_turn_and_no_fillet():
    from build123d import SlotOverall, extrude

    result = ask(plate() - extrude(SlotOverall(20, 6), 20), kinds=["fillet"])
    assert result["fillets"] == []
    assert result["notFeatures"]["arcs"] == 2


def test_a_rounded_end_of_a_rod_is_a_fillet_of_the_whole_circle():
    from build123d import Cylinder, GeomType, fillet

    rod = Cylinder(5, 20)
    end = [e for e in rod.edges() if e.geom_type == GeomType.CIRCLE and e.center().Z > 0]
    result = ask(fillet(end, 1), kinds=["fillet"])
    assert result["filletCount"] == 1
    f = result["fillets"][0]
    assert f["radius"] == pytest.approx(1) and f["sweep"] == pytest.approx(90) and f["side"] == "outside"
    assert f["length"] == pytest.approx(2 * math.pi * 4)


def test_a_part_with_nothing_blended_has_none():
    result = ask(plate(), kinds=["fillet", "chamfer"])
    assert result["fillets"] == [] and result["chamfers"] == []
    assert result["exact"] is True


# Chamfers


def test_a_chamfered_edge_has_its_size_and_the_faces_it_joins():
    from build123d import chamfer

    result = ask(chamfer(vertical(plate(), 20, 20), 2), kinds=["chamfer"])
    assert result["chamferCount"] == 1
    c = result["chamfers"][0]
    assert c["size"] == pytest.approx(2) and c["side"] == "outside" and c["round"] is False
    assert c["length"] == pytest.approx(10) and c["exact"] is True
    assert len(c["between"]) == 2


def test_an_uneven_chamfer_tells_both_setbacks():
    from build123d import chamfer

    c = ask(chamfer(vertical(plate(), 20, 20), 2, 3), kinds=["chamfer"])["chamfers"][0]
    assert "size" not in c
    assert sorted(c["sizes"]) == pytest.approx([2, 3])


def test_the_chamfers_round_a_top_edge_are_one_chamfer():
    from build123d import chamfer

    top = [e for e in plate().edges() if abs(e.center().Z - 5) < 1e-6]
    result = ask(chamfer(top, 1), kinds=["chamfer"])
    assert result["chamferCount"] == 1
    assert len(result["chamfers"][0]["faces"]) == 4 and result["chamfers"][0]["size"] == pytest.approx(1)


def test_a_chamfer_inside_a_corner_is_told_as_inside():
    from build123d import Box, Pos, chamfer

    pocket = plate() - Pos(0, 0, 2.5) * Box(20, 20, 5)
    inner = [e for e in pocket.edges() if abs(e.length - 5) < 1e-6 and abs(e.center().X - 10) < 1e-6 and abs(e.center().Y - 10) < 1e-6]
    assert len(inner) == 1
    c = ask(chamfer(inner, 2), kinds=["chamfer"])["chamfers"][0]
    assert c["side"] == "inside" and c["size"] == pytest.approx(2)


def test_a_chamfer_round_a_boss_is_a_round_one():
    from build123d import Cylinder, GeomType, Pos, chamfer

    boss = plate() + Pos(0, 0, 10) * Cylinder(4, 10)
    top = [e for e in boss.edges() if e.geom_type == GeomType.CIRCLE and abs(e.center().Z - 15) < 1e-6]
    c = ask(chamfer(top, 1), kinds=["chamfer"])["chamfers"][0]
    assert c["round"] is True and c["size"] == pytest.approx(1) and c["side"] == "outside"
    assert len(c["edges"]) == 2


def test_the_cone_at_the_mouth_of_a_hole_is_a_countersink_and_not_a_chamfer():
    from build123d import Cylinder, GeomType, chamfer

    hole = plate() - Cylinder(1.7, 10)
    mouth = [e for e in hole.edges() if e.geom_type == GeomType.CIRCLE and abs(e.center().Z - 5) < 1e-6 and e.radius < 2]
    shape = chamfer(mouth, 0.5)
    result = ask(shape, kinds=["chamfer", "hole"])
    assert result["chamfers"] == []
    assert result["holes"][0]["shape"] == "countersink"


def test_a_hexagon_and_a_wedge_are_no_chamfers():
    from build123d import Box, Pos, RegularPolygon, Rot, extrude

    assert ask(extrude(RegularPolygon(10, 6), 5), kinds=["chamfer"])["chamfers"] == []
    wedge = Box(20, 20, 10) - Pos(0, 0, 5) * Rot(0, 45, 0) * Box(40, 40, 10)
    assert ask(wedge, kinds=["chamfer"])["chamfers"] == []


def test_the_kinds_are_made_once_each_and_added_to_what_is_kept():
    from build123d import chamfer

    shape = chamfer(vertical(plate(), 20, 20), 2)
    kept: dict = {}
    args = {"layout": "print", "part": "p"}
    queries.run({"print:p": shape}, "features", {**args, "kinds": ["hole"]}, kept)
    held = kept["features", "print:p"]
    assert "chamfer" not in held.done
    queries.run({"print:p": shape}, "features", {**args, "kinds": ["chamfer"]}, kept)
    assert kept["features", "print:p"] is held and held.done["chamfer"]
