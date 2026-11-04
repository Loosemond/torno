"""``features``: the holes and bosses of a part, found on its B-rep."""

import math

import pytest

from torno_kernel import features, queries


def ask(shape, **args) -> dict:
    return queries.run({"print:p": shape}, "features", {"layout": "print", "part": "p", **args}, {})


def describe(shape, ref: str) -> dict:
    return queries.run({"print:p": shape}, "describe", {"ref": f"print:{ref}"}, {})


def plate():
    from build123d import Box

    return Box(40, 40, 10)  # z from -5 to 5


def through_hole():
    from build123d import Cylinder

    return plate() - Cylinder(1.7, 10)


def mouth(shape, radius: float):
    from build123d import GeomType

    return [
        e
        for e in shape.edges()
        if e.geom_type == GeomType.CIRCLE and abs(e.radius - radius) < 1e-6 and abs(e.center().Z - 5) < 1e-6
    ]


# Holes


def test_a_through_hole_has_its_diameter_axis_entry_and_depth():
    result = ask(through_hole())
    assert result["holeCount"] == 1 and result["bossCount"] == 0
    hole = result["holes"][0]
    assert hole["diameter"] == pytest.approx(3.4)
    assert hole["end"] == "through" and hole["shape"] == "plain"
    assert hole["axis"] == pytest.approx([0, 0, -1])
    assert hole["entry"] == pytest.approx([0, 0, 5])
    assert hole["depth"] == pytest.approx(10)
    assert hole["exact"] is True and "how" not in hole
    assert result["exact"] is True
    assert "bottom" not in hole


def test_the_refs_of_a_hole_are_the_faces_it_is_made_of_and_the_ones_it_opens_in():
    shape = through_hole()
    hole = ask(shape)["holes"][0]
    (wall,) = hole["faces"]
    wall_facts = describe(shape, wall)
    assert wall_facts["type"] == "cylinder" and wall_facts["radius"] == pytest.approx(1.7)
    entry, exit_ = describe(shape, hole["entryRef"]), describe(shape, hole["exitRef"])
    assert entry["normal"] == pytest.approx([0, 0, 1])
    assert exit_["normal"] == pytest.approx([0, 0, -1])


def test_a_blind_hole_says_where_it_ends():
    from build123d import Cylinder, Pos

    result = ask(plate() - Pos(0, 0, 2.5) * Cylinder(3, 5))
    hole = result["holes"][0]
    assert hole["end"] == "blind" and hole["bottom"] == "flat"
    assert hole["depth"] == pytest.approx(5)
    assert hole["diameter"] == pytest.approx(6)
    assert "exitRef" not in hole


def test_a_blind_hole_with_a_drill_point_has_a_cone_bottom_and_counts_the_point_in_its_depth():
    from build123d import Align, Cone, Cylinder, Pos

    tool = Pos(0, 0, -1) * Cylinder(2, 10, align=(Align.CENTER, Align.CENTER, Align.MIN)) + Pos(0, 0, -1) * Cone(
        0, 2, 1.2, align=(Align.CENTER, Align.CENTER, Align.MAX)
    )
    hole = ask(plate() - tool)["holes"][0]
    assert hole["end"] == "blind" and hole["bottom"] == "cone"
    assert hole["diameter"] == pytest.approx(4)
    assert hole["depth"] == pytest.approx(6 + 1.2)
    assert hole["exact"] is True
    kinds = [s["type"] for s in hole["steps"]]
    assert kinds == ["cylinder", "cone"] and hole["steps"][1]["tip"] is True


def test_a_counterbore_is_one_hole_with_the_bore_told():
    from build123d import Cylinder, Pos

    result = ask(through_hole() - Pos(0, 0, 3) * Cylinder(3.2, 4))
    assert result["holeCount"] == 1
    hole = result["holes"][0]
    assert hole["shape"] == "counterbore"
    assert hole["diameter"] == pytest.approx(3.4)
    assert hole["counterbore"] == pytest.approx({"diameter": 6.4, "depth": 4})
    assert hole["depth"] == pytest.approx(10) and hole["end"] == "through"
    assert [s["diameter"] for s in hole["steps"]] == pytest.approx([6.4, 3.4])
    assert hole["steps"][1]["from"] == pytest.approx(4)


def test_a_countersink_is_told_with_its_diameter_and_angle():
    from build123d import chamfer

    shape = chamfer(mouth(through_hole(), 1.7), 1.0)
    hole = ask(shape)["holes"][0]
    assert hole["shape"] == "countersink"
    assert hole["diameter"] == pytest.approx(3.4)
    assert hole["countersink"]["diameter"] == pytest.approx(5.4)
    assert hole["countersink"]["angle"] == pytest.approx(90)
    assert hole["countersink"]["depth"] == pytest.approx(1)
    assert hole["depth"] == pytest.approx(10)


def test_a_hole_cut_by_a_fillet_at_its_mouth_is_still_one_hole_through_the_plate():
    from build123d import fillet

    shape = fillet(mouth(through_hole(), 1.7), 0.5)
    result = ask(shape)
    assert result["holeCount"] == 1
    hole = result["holes"][0]
    assert hole["shape"] == "rounded" and hole["rounded"]["radius"] == pytest.approx(0.5)
    assert hole["diameter"] == pytest.approx(3.4)
    assert hole["end"] == "through"
    assert hole["depth"] == pytest.approx(10)
    assert hole["entry"] == pytest.approx([0, 0, 5])
    assert hole["exact"] is True


def test_a_hole_in_a_part_that_is_turned_and_moved_is_told_where_it_is():
    from build123d import Pos, Rot

    shape = Pos(100, 50, 20) * Rot(0, 90, 0) * through_hole()
    hole = ask(shape)["holes"][0]
    # The hole ran along z through the middle of the plate; turned about y it runs along x, and the plate sits at (100, 50, 20).
    assert abs(hole["axis"][0]) == pytest.approx(1) and hole["axis"][1] == 0 and hole["axis"][2] == 0
    assert hole["entry"][1:] == pytest.approx([50, 20])
    assert hole["entry"][0] == pytest.approx(105)
    assert hole["depth"] == pytest.approx(10)


def test_a_hole_that_opens_on_a_slant_is_exact_between_the_planes_it_meets():
    from build123d import Cylinder, Pos, Rot

    shape = plate() - Pos(0, 0, 5) * Rot(30, 0, 0) * Cylinder(2, 30)
    hole = ask(shape)["holes"][0]
    assert hole["end"] == "through" and hole["exact"] is True
    # The axis meets the top face at (0, 0, 5) and the bottom face 10 / cos(30°) further along it.
    assert hole["entry"] == pytest.approx([0, 0, 5])
    assert hole["depth"] == pytest.approx(10 / math.cos(math.radians(30)))
    assert hole["steps"][0]["to"] == pytest.approx(hole["depth"])


def test_a_radial_hole_in_a_rod_is_exact_because_a_line_meets_a_cylinder_exactly():
    from build123d import Align, Cylinder, Pos, Rot

    rod = Cylinder(10, 40)
    through = ask(rod - Rot(0, 90, 0) * Cylinder(2, 30))["holes"][0]
    assert through["end"] == "through" and through["depth"] == pytest.approx(20) and through["exact"] is True
    blind = ask(rod - Pos(5, 0, 0) * Rot(0, 90, 0) * Cylinder(2, 10, align=(Align.CENTER, Align.CENTER, Align.MIN)))["holes"][0]
    assert blind["end"] == "blind" and blind["depth"] == pytest.approx(5)
    assert blind["axis"] == pytest.approx([-1, 0, 0]) and blind["entry"] == pytest.approx([10, 0, 0])


def test_a_hole_in_a_freeform_wall_is_told_not_exact_with_what_it_is_taken_from(spline_prism):
    from build123d import Cylinder, Pos, Rot

    shape = spline_prism[0] - Pos(0, 0, 2.5) * Rot(0, 90, 0) * Cylinder(1, 80)
    result = ask(shape)
    hole = result["holes"][0]
    assert hole["diameter"] == pytest.approx(2)
    assert hole["end"] == "through"
    assert hole["exact"] is False and "not exact" in hole["how"]
    assert result["exact"] is False
    # Its diameter is a radius of the B-rep all the same, and the wall of the prism is not mistaken for a feature.
    assert result["bossCount"] == 0
    assert result["notFeatures"]["freeformFaces"] >= 1


def test_a_hole_drilled_across_another_is_one_hole_through_the_part_that_crosses_it():
    from build123d import Cylinder, Rot

    shape = through_hole() - Rot(0, 90, 0) * Cylinder(1, 60)
    result = ask(shape)
    assert result["holeCount"] == 2
    across = next(h for h in result["holes"] if h["diameter"] == pytest.approx(2))
    vertical = next(h for h in result["holes"] if h["diameter"] == pytest.approx(3.4))
    assert across["end"] == "through" and across["depth"] == pytest.approx(40)
    assert across["crosses"] == vertical["faces"]
    assert vertical["depth"] == pytest.approx(10)


def test_a_void_inside_a_part_is_a_hole_that_is_enclosed():
    from build123d import Cylinder

    hole = ask(plate() - Cylinder(3, 4))["holes"][0]
    assert hole["end"] == "enclosed"
    assert "entryRef" not in hole
    assert hole["depth"] == pytest.approx(4)


def test_the_rounded_corners_of_a_plate_are_arcs_and_no_holes():
    from build123d import Axis, fillet

    shape = fillet(plate().edges().filter_by(Axis.Z), 4)
    result = ask(shape)
    assert result["holes"] == [] and result["bosses"] == []
    assert result["notFeatures"]["arcs"] == 4


def test_a_slot_end_does_not_go_all_the_way_round_and_is_no_hole():
    from build123d import Pos, SlotOverall, extrude

    slot = extrude(SlotOverall(20, 6), 20)
    result = ask(plate() - Pos(0, 0, 0) * slot)
    assert result["holes"] == []
    assert result["notFeatures"]["arcs"] == 2


# Bosses


def test_a_boss_has_its_diameter_height_and_the_face_it_stands_on():
    from build123d import Cylinder, Pos

    shape = plate() + Pos(0, 0, 10) * Cylinder(4, 10)
    result = ask(shape)
    assert result["bossCount"] == 1 and result["holeCount"] == 0
    boss = result["bosses"][0]
    assert boss["diameter"] == pytest.approx(8) and boss["height"] == pytest.approx(10)
    assert boss["axis"] == pytest.approx([0, 0, 1])
    assert boss["base"] == pytest.approx([0, 0, 5]) and boss["top"] == pytest.approx([0, 0, 15])
    assert describe(shape, boss["baseRef"])["normal"] == pytest.approx([0, 0, 1])
    assert describe(shape, boss["topRef"])["normal"] == pytest.approx([0, 0, 1])
    assert boss["exact"] is True


def test_a_boss_with_a_chamfered_top_and_a_filleted_foot_is_one_boss():
    from build123d import Cylinder, GeomType, Pos, chamfer, fillet

    shape = plate() + Pos(0, 0, 10) * Cylinder(4, 10)
    foot = [e for e in shape.edges() if e.geom_type == GeomType.CIRCLE and abs(e.center().Z - 5) < 1e-6]
    shape = fillet(foot, 1)
    top = [e for e in shape.edges() if e.geom_type == GeomType.CIRCLE and abs(e.center().Z - 15) < 1e-6]
    shape = chamfer(top, 1)
    result = ask(shape)
    assert result["bossCount"] == 1
    boss = result["bosses"][0]
    assert boss["diameter"] == pytest.approx(8)
    assert boss["height"] == pytest.approx(10)
    assert [s["type"] for s in boss["steps"]] == ["round", "cylinder", "cone"]


def test_a_boss_on_the_side_of_a_rod_is_exact_to_the_cylinder_it_stands_on():
    from build123d import Cylinder, Pos, Rot

    shape = Cylinder(10, 40) + Rot(0, 90, 0) * Pos(0, 0, 10) * Cylinder(3, 6)
    boss = ask(shape)["bosses"][0]
    assert boss["diameter"] == pytest.approx(6) and boss["height"] == pytest.approx(3)
    assert boss["base"] == pytest.approx([10, 0, 0])
    assert boss["exact"] is True


def test_a_pin_that_stands_on_nothing_is_no_boss():
    from build123d import Cylinder

    result = ask(Cylinder(5, 5))
    assert result["bosses"] == [] and result["holes"] == []
    assert result["notFeatures"]["freeCylinders"] == 1


# The query


def test_kinds_choose_what_is_told_and_nothing_else_is():
    shape = through_hole()
    holes = ask(shape, kinds=["hole"])
    assert "holes" in holes and "bosses" not in holes and holes["kinds"] == ["hole"]
    bosses = ask(shape, kinds=["boss"])
    assert "bosses" in bosses and "holes" not in bosses and bosses["bosses"] == []


def test_it_is_bounded_and_says_how_many_it_left_out(monkeypatch):
    from build123d import Cylinder, Pos

    shape = plate()
    for x in (-15, -5, 5, 15):
        shape = shape - Pos(x, 0, 0) * Cylinder(1, 10)
    monkeypatch.setattr(features, "MAX_FEATURES", 3)
    result = ask(shape)
    assert result["holeCount"] == 4 and len(result["holes"]) == 3 and result["left"]["holes"] == 1


def test_a_part_is_analysed_once_for_as_long_as_the_worker_keeps_it():
    shape = through_hole()
    kept: dict = {}
    first = queries.run({"print:p": shape}, "features", {"layout": "print", "part": "p"}, kept)
    assert ("features", "print:p") in kept
    again = queries.run({"print:p": shape}, "features", {"layout": "print", "part": "p"}, kept)
    assert again["holes"] == first["holes"]
    assert kept["features", "print:p"]["holes"] is kept["features", "print:p"]["holes"]


@pytest.mark.parametrize(
    "args, kind",
    [
        ({"part": "p"}, "bad_request"),
        ({"layout": "print"}, "bad_request"),
        ({"layout": "print", "part": "p", "kinds": []}, "bad_request"),
        ({"layout": "print", "part": "p", "kinds": ["hole", "gear"]}, "bad_request"),
        ({"layout": "print", "part": "q"}, "bad_ref"),
        ({"layout": "assembly", "part": "p"}, "bad_ref"),
    ],
)
def test_what_cannot_be_answered_is_refused_by_kind(args, kind):
    with pytest.raises(queries.QueryError) as e:
        queries.run({"print:p": through_hole()}, "features", args, {})
    assert e.value.kind == kind


def test_a_part_that_is_not_a_solid_is_refused():
    shape = through_hole()
    face = shape.faces()[0]
    with pytest.raises(queries.QueryError) as e:
        queries.run({"print:p": face}, "features", {"layout": "print", "part": "p"}, {})
    assert e.value.kind == "bad_request" and "not a solid" in e.value.message
