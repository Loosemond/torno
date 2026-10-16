"""``check`` overhang, thin and bed: will a part print, in the ``print`` layout."""

from pathlib import Path

import pytest

from torno_kernel import queries
from torno_kernel.loader import load_scene
from torno_kernel.tess import build_scene

WS = Path(__file__).parent / "fixtures" / "ws"


def check(shapes, args) -> dict:
    return queries.run(shapes, "check", {"layout": "print", **args}, {})


def refused(shapes, args) -> tuple[str, str]:
    with pytest.raises(queries.QueryError) as e:
        queries.run(shapes, "check", {"layout": "print", **args}, {})
    return e.value.kind, e.value.message


def tee():
    """A post 10 × 10 × 20 on the bed with a bar 40 × 10 × 5 across its top: two undersides of 15 × 10 overhang."""
    from build123d import Box, Pos

    post = Pos(0, 0, 10) * Box(10, 10, 20)
    bar = Pos(0, 0, 22.5) * Box(40, 10, 5)
    return {"print:tee": post + bar}


# Overhang


def test_the_undersides_of_a_tee_overhang_and_the_face_on_the_bed_does_not():
    result = check(tee(), {"kind": "overhang", "a": "tee"})
    assert result["angle"] == 45
    assert result["exact"] is True
    assert len(result["faces"]) == 2
    assert all(f["ref"].startswith("tee/F") for f in result["faces"])
    assert [f["area"] for f in result["faces"]] == [pytest.approx(150), pytest.approx(150)]
    assert all(f["exact"] and f["areaExact"] and f["steepest"] == pytest.approx(90) for f in result["faces"])
    assert result["area"] == pytest.approx(300)
    shapes = tee()
    for f in result["faces"]:
        described = queries.run(shapes, "describe", {"ref": "print:" + f["ref"]})
        assert described["normal"] == pytest.approx([0, 0, -1])
        assert described["center"][2] == pytest.approx(20)


def test_a_face_sloped_less_than_the_angle_from_vertical_is_no_overhang():
    from build123d import Box, Pos, Rot

    # A slab turned 30° about x: its underside is 60° from vertical, its sides 30°.
    slab = Pos(0, 0, 30) * Rot(30, 0, 0) * Box(20, 20, 4)
    steep = check({"print:slab": slab}, {"kind": "overhang", "a": "slab", "angle": 45})
    assert [round(f["steepest"]) for f in steep["faces"]] == [60]
    shallow = check({"print:slab": slab}, {"kind": "overhang", "a": "slab", "angle": 70})
    assert shallow["faces"] == []
    assert shallow["area"] == 0


def test_a_curved_face_is_judged_by_sampled_normals_and_is_not_exact():
    from build123d import Cylinder, Pos, Rot

    lying = Pos(0, 0, 10) * Rot(90, 0, 0) * Cylinder(5, 20)
    result = check({"print:rod": lying}, {"kind": "overhang", "a": "rod"})
    curved = [f for f in result["faces"] if not f["exact"]]
    assert len(curved) == 1
    assert curved[0]["steepest"] > 80
    assert result["exact"] is False
    assert "sampled" in result["how"]


def test_overhang_refuses_an_angle_that_is_none():
    for angle in (0, 90, -5, "45", float("nan")):
        kind, message = refused(tee(), {"kind": "overhang", "a": "tee", "angle": angle})
        assert kind == "bad_request"
        assert "angle" in message


# Thin


def test_a_plate_thinner_than_the_least_wall_is_thin_on_both_faces():
    from build123d import Box, Pos

    plate = Pos(0, 0, 0.25) * Box(20, 20, 0.5)
    result = check({"print:plate": plate}, {"kind": "thin", "a": "plate", "min": 0.8})
    assert result["exact"] is False
    assert "approximate" in result["how"]
    assert len(result["faces"]) == 2
    assert all(f["thinnest"] == pytest.approx(0.5) for f in result["faces"])
    assert result["thinnest"]["value"] == pytest.approx(0.5)
    assert result["thinnest"]["ref"].startswith("plate/F")
    assert len(result["thinnest"]["points"]) == 2
    assert result["sampling"]["measured"] > 0


def test_a_box_thicker_than_the_least_wall_has_no_thin_face_and_says_its_thinnest():
    from build123d import Box

    result = check({"print:block": Box(20, 20, 5)}, {"kind": "thin", "a": "block", "min": 0.8})
    assert result["faces"] == []
    assert result["thinnest"]["value"] == pytest.approx(5)


def test_a_cup_with_a_thin_floor_is_thin_there_only():
    from build123d import Box, Pos

    # Walls of 2 mm, a floor of 0.6.
    cup = Pos(0, 0, 5) * Box(24, 24, 10) - Pos(0, 0, 5.6) * Box(20, 20, 10)
    result = check({"print:cup": cup}, {"kind": "thin", "a": "cup", "min": 1})
    assert len(result["faces"]) == 2  # the floor's underside and the inside of it
    assert result["thinnest"]["value"] == pytest.approx(0.6)


def test_thin_needs_a_least_wall():
    for least in (None, 0, -1, "1"):
        args = {"kind": "thin", "a": "tee"} | ({} if least is None else {"min": least})
        kind, message = refused(tee(), args)
        assert kind == "bad_request"
        assert "min" in message


# Bed


def test_the_bracket_fits_a_large_bed_and_says_by_how_much_it_does_not_fit_a_small_one():
    _, _, bracket = build_scene(load_scene(WS / "bracket", "bracket.py"), "bracket.py")
    roomy = check(bracket, {"kind": "bed", "size": [100, 100, 100]})
    assert roomy["fits"] is True
    assert roomy["exact"] is True
    assert roomy["size"] == pytest.approx([84, 30, 10.5])
    assert roomy["over"] == [0, 0, 0]
    assert roomy["bed"] == [100, 100, 100]
    assert roomy["parts"] == ["base", "post"]
    tight = check(bracket, {"kind": "bed", "size": [80, 20, 100]})
    assert tight["fits"] is False
    assert tight["over"] == pytest.approx([4, 10, 0])


def test_a_bed_is_exact_only_as_far_as_the_boxes_are(spline_prism):
    result = check({"print:prism": spline_prism[0]}, {"kind": "bed", "size": [256, 256, 256]})
    assert result["fits"] is True
    assert result["exact"] is False


def test_bed_needs_three_sizes():
    for size in (None, [1, 2], [1, 2, -3], "big", [1, 2, float("inf")]):
        args = {"kind": "bed"} | ({} if size is None else {"size": size})
        kind, message = refused(tee(), args)
        assert kind == "bad_request"
        assert "size" in message
