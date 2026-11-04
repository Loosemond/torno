"""``features``: patterns of holes and bosses."""

import math

import pytest

from torno_kernel import queries


def ask(shape, **args) -> dict:
    kinds = args.pop("kinds", ["pattern"])
    return queries.run({"print:p": shape}, "features", {"layout": "print", "part": "p", "kinds": kinds, **args}, {})


def plate():
    from build123d import Box

    return Box(80, 80, 10)


def drilled(points, radius=1.7):
    from build123d import Cylinder, Pos

    shape = plate()
    for x, y in points:
        shape = shape - Pos(x, y, 0) * Cylinder(radius, 10)
    return shape


def test_four_holes_at_the_corners_of_a_square_are_a_grid_of_two_by_two():
    result = ask(drilled([(-20, -20), (20, -20), (-20, 20), (20, 20)]))
    assert result["patternCount"] == 1
    p = result["patterns"][0]
    assert p["of"] == "hole" and p["count"] == 4 and p["arrangement"] == "grid"
    assert p["counts"] == [2, 2] and p["steps"] == pytest.approx([40, 40]) and p["size"] == pytest.approx([40, 40])
    assert p["diameter"] == pytest.approx(3.4) and p["end"] == "through" and p["depth"] == pytest.approx(10)
    assert p["axis"] == pytest.approx([0, 0, 1])
    assert len(p["entries"]) == 4 and p["exact"] is True


def test_holes_in_a_row_at_equal_steps_are_a_line_with_its_step():
    result = ask(drilled([(-30 + 15 * i, 5) for i in range(5)]))
    p = result["patterns"][0]
    assert p["arrangement"] == "line" and p["count"] == 5
    assert p["step"] == pytest.approx(15) and p["length"] == pytest.approx(60)
    assert abs(p["direction"][0]) == pytest.approx(1)


def test_holes_in_a_row_at_uneven_steps_are_no_pattern():
    result = ask(drilled([(-30, 0), (-10, 0), (20, 0)]))
    assert result["patterns"] == [] and result["patternCount"] == 0


def test_a_bolt_circle_is_a_circle_with_its_radius_centre_and_step():
    points = [(12 + 20 * math.cos(math.radians(60 * k)), -7 + 20 * math.sin(math.radians(60 * k))) for k in range(6)]
    p = ask(drilled(points))["patterns"][0]
    assert p["arrangement"] == "circle" and p["count"] == 6 and p["full"] is True
    assert p["radius"] == pytest.approx(20) and p["step"] == pytest.approx(60) and p["sweep"] == pytest.approx(360)
    assert p["centre"][:2] == pytest.approx([12, -7])


def test_an_arc_of_holes_at_equal_angles_is_a_circle_that_is_not_full():
    points = [(25 * math.cos(math.radians(30 * k)), 25 * math.sin(math.radians(30 * k))) for k in range(4)]
    p = ask(drilled(points))["patterns"][0]
    assert p["arrangement"] == "circle" and p["full"] is False
    assert p["step"] == pytest.approx(30) and p["sweep"] == pytest.approx(90)


def test_a_grid_of_three_by_two_that_is_turned_in_the_plane_is_still_a_grid():
    c, s = math.cos(math.radians(25)), math.sin(math.radians(25))
    points = [(c * a - s * b, s * a + c * b) for a in (-20, 0, 20) for b in (-10, 10)]
    p = ask(drilled(points))["patterns"][0]
    assert p["arrangement"] == "grid" and sorted(p["counts"]) == [2, 3]
    assert sorted(p["steps"]) == pytest.approx([20, 20])


def test_a_pair_of_alike_holes_is_a_line_of_two_and_a_different_third_is_left_out():
    from build123d import Cylinder, Pos

    shape = drilled([(-20, 0), (20, 0)]) - Pos(0, 25, 0) * Cylinder(3, 10)
    result = ask(shape)
    assert result["patternCount"] == 1
    assert result["patterns"][0]["count"] == 2 and result["patterns"][0]["step"] == pytest.approx(40)


def test_holes_that_differ_are_not_one_pattern():
    from build123d import Cylinder, Pos

    shape = drilled([(-20, 0), (20, 0)]) - Pos(0, 25, 0) * Cylinder(1.7, 10)
    # Three alike, at the corners of an isosceles triangle: neither a row nor a circle.
    assert ask(shape)["patterns"] == []
    blind = plate() - Pos(-20, 0, 2.5) * Cylinder(1.7, 5) - Pos(20, 0, 0) * Cylinder(1.7, 10)
    assert ask(blind)["patterns"] == []


def test_bosses_in_a_pattern_are_told_with_their_bases():
    from build123d import Cylinder, Pos

    shape = plate()
    for x in (-20, 0, 20):
        shape = shape + Pos(x, 0, 10) * Cylinder(3, 10)
    p = ask(shape)["patterns"][0]
    assert p["of"] == "boss" and p["count"] == 3 and p["arrangement"] == "line"
    assert p["height"] == pytest.approx(10) and p["diameter"] == pytest.approx(6) and p["step"] == pytest.approx(20)
    assert len(p["bases"]) == 3


def test_holes_with_a_counterbore_are_a_pattern_of_counterbored_holes():
    from build123d import Cylinder, Pos

    shape = plate()
    for x in (-20, 20):
        shape = shape - Pos(x, 0, 0) * Cylinder(1.7, 10) - Pos(x, 0, 3) * Cylinder(3.2, 4)
    p = ask(shape)["patterns"][0]
    assert p["shape"] == "counterbore" and p["count"] == 2


def test_a_pattern_in_a_part_that_is_turned_and_moved_is_found_all_the_same():
    from build123d import Pos, Rot

    shape = Pos(100, 50, 20) * Rot(30, 40, 50) * drilled([(-20, -20), (20, -20), (-20, 20), (20, 20)])
    p = ask(shape)["patterns"][0]
    assert p["arrangement"] == "grid" and p["counts"] == [2, 2] and p["steps"] == pytest.approx([40, 40])


def test_a_hole_on_its_own_is_no_pattern_and_nothing_is_told_of_holes_unasked():
    result = ask(drilled([(0, 0)]))
    assert result["patterns"] == [] and "holes" not in result and "bosses" not in result


def test_a_pattern_of_holes_in_a_freeform_wall_is_told_not_exact(spline_prism):
    from build123d import Cylinder, Pos, Rot

    shape = spline_prism[0]
    for z in (1.5, 3.5):
        shape = shape - Pos(0, 0, z) * Rot(0, 90, 0) * Cylinder(0.5, 80)
    p = ask(shape)["patterns"][0]
    assert p["count"] == 2 and p["step"] == pytest.approx(2) and p["exact"] is False
