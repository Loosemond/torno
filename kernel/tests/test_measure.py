"""``measure``, in-process, on the shapes of the fixture models."""

import math
from pathlib import Path

import pytest

from torno_kernel import queries, topo
from torno_kernel.loader import load_scene
from torno_kernel.tess import build_scene

WS = Path(__file__).parent / "fixtures" / "ws"
PLATE = "assembly:plate"


@pytest.fixture(scope="module")
def shapes():
    """The measures plate and the bracket, as one build would hold them."""
    _, _, plate = build_scene(load_scene(WS / "measures", "measures.py"), "measures.py")
    _, _, bracket = build_scene(load_scene(WS / "bracket", "bracket.py"), "bracket.py")
    return {**plate, **bracket}


def refs(shapes, key: str, letter: str, descriptor: str) -> list[str]:
    """The faces (``F``) or edges (``E``) of a part whose descriptor starts so, in order."""
    items = topo.faces(shapes[key]) if letter == "F" else topo.edges(shapes[key])
    every = [f"{key}/{letter}{i}" for i in range(len(items))]
    return [r for r in every if queries.describe(shapes, r)["descriptor"].startswith(descriptor)]


def ref(shapes, key: str, letter: str, descriptor: str) -> str:
    [found] = refs(shapes, key, letter, descriptor)
    return found


def measure(shapes, kind: str, a=None, b=None, **more) -> dict:
    """``measure`` as it goes over the wire; a target given as a string is a ref."""
    args = {"kind": kind, **more}
    for name, target in (("a", a), ("b", b)):
        if target is not None:
            args[name] = {"ref": target} if isinstance(target, str) else target
    return queries.run(shapes, "measure", args, {})


def refused(shapes, kind: str, a=None, b=None, **more) -> tuple[str, str]:
    with pytest.raises(queries.QueryError) as e:
        measure(shapes, kind, a, b, **more)
    return e.value.kind, e.value.message


@pytest.fixture(scope="module")
def top(shapes):
    return ref(shapes, PLATE, "F", "plane, normal +Z, z = 3,")


@pytest.fixture(scope="module")
def bottom(shapes):
    return ref(shapes, PLATE, "F", "plane, normal -Z, z = -3,")


@pytest.fixture(scope="module")
def chamfer(shapes):
    return ref(shapes, PLATE, "F", "plane, normal (0.71, 0, 0.71)")


@pytest.fixture(scope="module")
def holes(shapes):
    return refs(shapes, PLATE, "F", "cylinder, radius 4, axis Z")


# Distance


def test_distance_between_parallel_planes_is_between_the_planes(shapes, top, bottom):
    result = measure(shapes, "distance", top, bottom)
    assert result == {
        "kind": "distance",
        "value": pytest.approx(6),
        "unit": "mm",
        "how": "between planes",
        "points": [pytest.approx(result["points"][0]), pytest.approx(result["points"][1])],
        "exact": True,
    }
    # From the centre of the first face, straight across to the plane of the second.
    centre = queries.describe(shapes, top)["center"]
    assert result["points"][0] == pytest.approx(centre)
    assert result["points"][1] == pytest.approx([centre[0], centre[1], -3])


def test_planes_facing_the_same_way_are_parallel_too(shapes, top):
    floor = ref(shapes, PLATE, "F", "plane, normal +Z, z = -1,")
    result = measure(shapes, "distance", top, floor)
    assert (result["value"], result["how"]) == (pytest.approx(4), "between planes")


def test_distance_between_planes_that_are_not_parallel_is_the_minimum(shapes, top, chamfer):
    result = measure(shapes, "distance", top, chamfer)
    # They meet along an edge.
    assert (result["value"], result["how"]) == (pytest.approx(0, abs=1e-9), "minimum")


def test_distance_between_two_holes_is_axis_to_axis(shapes, holes):
    result = measure(shapes, "distance", holes[0], holes[1])
    assert (result["value"], result["unit"], result["how"], result["exact"]) == (
        pytest.approx(20),
        "mm",
        "axis to axis",
        True,
    )
    on_a, on_b = result["points"]
    assert (on_a[0], on_a[1]) == pytest.approx((-10, 5))
    assert (on_b[0], on_b[1]) == pytest.approx((10, 5))
    assert on_a[2] == pytest.approx(on_b[2])


def test_circular_edges_and_cylinders_have_axes_alike(shapes, holes):
    rims = refs(shapes, PLATE, "E", "circle, radius 4")
    assert len(rims) == 4
    xs = {r: queries.describe(shapes, r)["center"][0] for r in rims}
    left = [r for r in rims if xs[r] < 0]
    right = [r for r in rims if xs[r] > 0]
    between_rims = measure(shapes, "distance", left[0], right[0])
    assert (between_rims["value"], between_rims["how"]) == (pytest.approx(20), "axis to axis")
    rim_and_hole = measure(shapes, "distance", left[0], holes[1])
    assert (rim_and_hole["value"], rim_and_hole["how"]) == (pytest.approx(20), "axis to axis")
    # The two rims of one hole are on one axis.
    same = measure(shapes, "distance", left[0], left[1])
    assert (same["value"], same["how"]) == (pytest.approx(0, abs=1e-9), "axis to axis")


def test_distance_from_a_point_to_a_planar_face_is_point_to_plane(shapes, top):
    point = {"layout": "assembly", "point": [100, 100, 10]}
    result = measure(shapes, "distance", point, top)
    # To the plane, not to the nearest of the face: the point is far off to the side.
    assert (result["value"], result["how"]) == (pytest.approx(7), "point to plane")
    assert result["points"] == [pytest.approx([100, 100, 10]), pytest.approx([100, 100, 3])]
    other_way = measure(shapes, "distance", top, point)
    assert other_way["value"] == pytest.approx(7)
    assert other_way["points"] == [pytest.approx([100, 100, 3]), pytest.approx([100, 100, 10])]


def test_distance_between_two_points(shapes):
    a = {"layout": "assembly", "point": [0, 0, 0]}
    b = {"layout": "assembly", "point": [3, 4, 12]}
    result = measure(shapes, "distance", a, b)
    assert (result["value"], result["how"]) == (pytest.approx(13), "point to point")
    assert result["points"] == [[0, 0, 0], [3, 4, 12]]


def test_a_target_with_a_ref_and_a_point_is_the_feature_of_the_ref(shapes, top, bottom):
    a = {"ref": top, "point": [1, 2, 3]}
    assert measure(shapes, "distance", a, bottom)["how"] == "between planes"


def test_distance_between_two_parts_is_the_minimum_with_its_points(shapes):
    far = ref(shapes, "assembly:base", "F", "plane, normal -X, x = -20,")
    result = measure(shapes, "distance", "assembly:post", far)
    assert (result["value"], result["how"], result["exact"]) == (pytest.approx(16), "minimum", True)
    assert result["points"] == [pytest.approx([-4, 0, 2.5]), pytest.approx([-20, 0, 2.5])]
    touching = measure(shapes, "distance", "assembly:post", "assembly:base")
    assert (touching["value"], touching["how"]) == (pytest.approx(0, abs=1e-9), "minimum")


def test_a_point_and_a_curved_face_are_the_minimum_apart(shapes, holes):
    point = {"layout": "assembly", "point": [-10, 5, 0]}
    result = measure(shapes, "distance", point, holes[0])
    assert (result["value"], result["how"]) == (pytest.approx(4), "minimum")


def test_parts_are_measured_where_the_layout_shows_them(shapes):
    # The print layout sets the post beside the base: they do not touch there.
    result = measure(shapes, "distance", "print:post", "print:base")
    assert result["value"] > 1


# Angle


def test_angle_between_planar_faces_is_between_their_outward_normals(shapes, top, bottom, chamfer):
    result = measure(shapes, "angle", top, chamfer)
    assert (result["value"], result["unit"], result["how"], result["exact"]) == (
        pytest.approx(45),
        "deg",
        "between normals",
        True,
    )
    assert measure(shapes, "angle", top, bottom)["value"] == pytest.approx(180)
    floor = ref(shapes, PLATE, "F", "plane, normal +Z, z = -1,")
    assert measure(shapes, "angle", top, floor)["value"] == pytest.approx(0, abs=1e-6)
    side = ref(shapes, PLATE, "F", "plane, normal +X, x = 20,")
    assert measure(shapes, "angle", side, chamfer)["value"] == pytest.approx(45)


def test_angle_between_straight_edges_is_between_lines_and_at_most_90(shapes):
    long = refs(shapes, "assembly:base", "E", "line, 40 mm")
    short = refs(shapes, "assembly:base", "E", "line, 30 mm")
    result = measure(shapes, "angle", long[0], short[0])
    assert (result["value"], result["how"]) == (pytest.approx(90), "between lines")
    # A line has no sense: two parallel edges are at 0 whichever way each runs.
    for other in long[1:]:
        assert measure(shapes, "angle", long[0], other)["value"] == pytest.approx(0, abs=1e-6)
    slanted = refs(shapes, PLATE, "E", "line, 2.828 mm")[0]
    vertical = refs(shapes, PLATE, "E", "line, 6 mm")[0]
    assert queries.describe(shapes, vertical)["center"][2] == pytest.approx(0)
    assert measure(shapes, "angle", slanted, vertical)["value"] == pytest.approx(45)


def test_angle_between_a_face_and_an_edge_is_line_to_plane(shapes, top):
    slanted = refs(shapes, PLATE, "E", "line, 2.828 mm")[0]
    result = measure(shapes, "angle", top, slanted)
    assert (result["value"], result["how"]) == (pytest.approx(45), "line to plane")
    assert measure(shapes, "angle", slanted, top)["value"] == pytest.approx(45)
    lying = refs(shapes, PLATE, "E", "line, 40 mm")[0]
    assert measure(shapes, "angle", top, lying)["value"] == pytest.approx(0, abs=1e-6)


def test_angle_of_anything_else_names_what_can_be_measured(shapes, top, holes):
    assert refused(shapes, "angle", top, holes[0]) == (
        "bad_request",
        "angle is measured between two planar faces, two straight edges, or a planar face and "
        f"a straight edge; {holes[0]} is a cylinder face",
    )
    rim = refs(shapes, PLATE, "E", "circle")[0]
    assert refused(shapes, "angle", rim, top)[1].endswith(f"{rim} is a circle edge")
    assert refused(shapes, "angle", top, PLATE)[1].endswith(f"{PLATE} is a part")
    point = {"layout": "assembly", "point": [0, 0, 0]}
    assert refused(shapes, "angle", top, point)[1].endswith("b is a point")


# Radius and diameter


def test_radius_and_diameter_of_a_hole(shapes, holes):
    radius = measure(shapes, "radius", holes[0])
    assert (radius["value"], radius["unit"], radius["how"], radius["exact"]) == (
        pytest.approx(4),
        "mm",
        "cylinder",
        True,
    )
    on_axis, on_wall = radius["points"]
    assert (on_axis[0], on_axis[1]) == pytest.approx((-10, 5))
    assert math.dist(on_axis, on_wall) == pytest.approx(4)
    diameter = measure(shapes, "diameter", holes[0])
    assert (diameter["value"], diameter["how"]) == (pytest.approx(8), "cylinder")
    one_side, other_side = diameter["points"]
    assert math.dist(one_side, other_side) == pytest.approx(8)
    middle = [(p + q) / 2 for p, q in zip(one_side, other_side, strict=True)]
    assert (middle[0], middle[1]) == pytest.approx((-10, 5))


def test_radius_is_drawn_at_the_point_of_the_target(shapes, holes):
    result = measure(shapes, "radius", {"ref": holes[0], "point": [-10, 9, 1]})
    assert result["points"] == [pytest.approx([-10, 5, 1]), pytest.approx([-10, 9, 1])]


def test_radius_of_a_circular_edge(shapes):
    rim = refs(shapes, PLATE, "E", "circle, radius 4")[0]
    result = measure(shapes, "radius", rim)
    assert (result["value"], result["how"]) == (pytest.approx(4), "circle")
    assert measure(shapes, "diameter", rim)["value"] == pytest.approx(8)


def test_radius_of_a_sphere_and_of_a_torus():
    from build123d import Sphere, Torus

    made = {"assembly:ball": Sphere(7), "assembly:ring": Torus(20, 3)}
    ball = measure(made, "radius", "assembly:ball/F0")
    assert (ball["value"], ball["how"]) == (pytest.approx(7), "sphere")
    assert math.dist(*ball["points"]) == pytest.approx(7)
    ring = measure(made, "diameter", "assembly:ring/F0")
    assert (ring["value"], ring["how"], ring["major"]) == (
        pytest.approx(6),
        "torus, of the tube",
        pytest.approx(20),
    )
    assert math.dist(*ring["points"]) == pytest.approx(6)


def test_radius_of_a_face_of_another_type_names_its_type(shapes, top):
    assert refused(shapes, "radius", top) == (
        "bad_request",
        "radius is measured of a cylindrical, spherical or toroidal face or a circular edge; "
        f"{top} is a plane face",
    )
    assert refused(shapes, "diameter", PLATE)[1] == (
        "diameter is measured of a cylindrical, spherical or toroidal face or a circular edge; "
        f"{PLATE} is a part"
    )
    line = refs(shapes, PLATE, "E", "line")[0]
    assert refused(shapes, "radius", line)[1].endswith(f"{line} is a line edge")


# Thickness


def test_thickness_of_the_wall_the_pocket_leaves(shapes):
    outside = ref(shapes, PLATE, "F", "plane, normal -Y, y = -15,")
    result = measure(shapes, "thickness", {"ref": outside, "point": [0, -15, 1]})
    assert result == {
        "kind": "thickness",
        "value": pytest.approx(2),
        "unit": "mm",
        "how": "wall, along the normal",
        "points": [pytest.approx([0, -15, 1]), pytest.approx([0, -13, 1])],
        "exact": True,
    }
    # Beside the pocket the same face has the whole plate behind it,
    beside = measure(shapes, "thickness", {"ref": outside, "point": [16, -15, 1]})
    assert beside["value"] == pytest.approx(30)
    # and in line with a hole, the plate as far as the hole.
    before_hole = measure(shapes, "thickness", {"ref": outside, "point": [10, -15, 1]})
    assert before_hole["value"] == pytest.approx(16)
    # Under the pocket, from below.
    bottom = ref(shapes, PLATE, "F", "plane, normal -Z, z = -3,")
    floor = measure(shapes, "thickness", {"ref": bottom, "point": [0, -10, -3]})
    assert floor["value"] == pytest.approx(2)


def test_thickness_is_taken_from_the_point_of_the_face_nearest_the_one_given(shapes, bottom):
    result = measure(shapes, "thickness", {"ref": bottom, "point": [15, -5, -8]})
    assert result["value"] == pytest.approx(6)
    assert result["points"] == [pytest.approx([15, -5, -3]), pytest.approx([15, -5, 3])]


def test_thickness_from_inside_a_hole_goes_into_the_material(shapes, holes):
    # The wall of the hole at x = -14 faces +X; behind it are 6 mm of plate to x = -20.
    result = measure(shapes, "thickness", {"ref": holes[0], "point": [-14, 5, 0]})
    assert result["value"] == pytest.approx(6)
    assert result["points"][1] == pytest.approx([-20, 5, 0])


def test_thickness_with_nothing_behind_the_face_is_refused():
    from build123d import Box, Shell

    lone = Shell([Box(10, 10, 10).faces()[0]])
    made = {"assembly:sheet": lone}
    centre = queries.describe(made, "assembly:sheet/F0")["center"]
    assert refused(made, "thickness", {"ref": "assembly:sheet/F0", "point": centre}) == (
        "bad_request",
        "no opposite wall along the normal",
    )


def test_thickness_needs_a_face_and_a_point(shapes, top):
    message = "thickness needs a.ref, a face, and a.point, a point on it"
    assert refused(shapes, "thickness", top) == ("bad_request", f"{message}; a has no point")
    assert refused(shapes, "thickness", {"ref": PLATE, "point": [0, 0, 3]}) == (
        "bad_request",
        f"{message}; {PLATE} is a part",
    )
    assert refused(shapes, "thickness", {"layout": "assembly", "point": [0, 0, 3]}) == (
        "bad_request",
        f"{message}; a is a point",
    )


# Bounding box, volume, area, mass


def test_bbox_of_the_plate_is_exact(shapes):
    assert measure(shapes, "bbox", PLATE) == {
        "kind": "bbox",
        "min": pytest.approx([-20, -15, -3], abs=1e-9),
        "max": pytest.approx([20, 15, 3], abs=1e-9),
        "size": pytest.approx([40, 30, 6], abs=1e-9),
        "unit": "mm",
        "how": "axis-aligned box",
        "exact": True,
    }


def test_bbox_of_a_face_and_of_an_edge(shapes, holes, chamfer):
    hole = measure(shapes, "bbox", holes[0])
    assert hole["exact"] is True
    assert hole["min"] == pytest.approx([-14, 1, -3], abs=1e-9)
    assert hole["max"] == pytest.approx([-6, 9, 3], abs=1e-9)
    slope = measure(shapes, "bbox", chamfer)
    assert (slope["min"], slope["max"]) == (
        pytest.approx([18, -15, 1], abs=1e-9),
        pytest.approx([20, 15, 3], abs=1e-9),
    )
    rim = refs(shapes, PLATE, "E", "circle, radius 4")[0]
    edge = measure(shapes, "bbox", rim)
    assert edge["exact"] is True
    assert edge["size"] == pytest.approx([8, 8, 0], abs=1e-9)


def test_bbox_of_a_part_with_a_face_that_is_neither_flat_nor_a_cylinder_is_not_exact():
    from build123d import Sphere

    result = measure({"assembly:ball": Sphere(7)}, "bbox", "assembly:ball")
    assert result["exact"] is False
    assert result["how"] == "axis-aligned box, approximate on faces that are neither flat nor cylinders"
    assert result["size"] == pytest.approx([14, 14, 14], abs=0.01)


def test_volume_and_area(shapes, top):
    # 40 × 30 × 6, less the chamfer's prism, the two holes and the pocket.
    solid = 7200 - 0.5 * 2 * 2 * 30 - 2 * math.pi * 16 * 6 - 10 * 6 * 4
    assert measure(shapes, "volume", PLATE) == {
        "kind": "volume",
        "value": pytest.approx(solid),
        "unit": "mm3",
        "how": "of the solid",
        "exact": True,
    }
    whole = measure(shapes, "area", PLATE)
    assert (whole["value"], whole["unit"], whole["how"], whole["exact"]) == (
        pytest.approx(queries.describe(shapes, PLATE)["area"]),
        "mm2",
        "surface of the part",
        True,
    )
    face = measure(shapes, "area", top)
    # 38 × 30, less the two holes and the mouth of the pocket.
    assert (face["value"], face["how"]) == (
        pytest.approx(38 * 30 - 2 * math.pi * 16 - 60),
        "of the face",
    )


def test_volume_area_and_mass_say_what_they_are_measured_of(shapes, top):
    assert refused(shapes, "volume", top) == (
        "bad_request",
        f"volume is measured of a part; {top} is a plane face",
    )
    edge = refs(shapes, PLATE, "E", "line")[0]
    assert refused(shapes, "area", edge) == (
        "bad_request",
        f"area is measured of a part or a face; {edge} is a line edge",
    )
    assert refused(shapes, "mass", top) == (
        "bad_request",
        f"mass is measured of a part; {top} is a plane face",
    )
    point = {"layout": "assembly", "point": [0, 0, 0]}
    assert refused(shapes, "bbox", point) == (
        "bad_request",
        "bbox is measured of a part, a face or an edge; a is a point",
    )


def test_mass_defaults_to_pla_and_says_so(shapes):
    volume = measure(shapes, "volume", PLATE)["value"]
    assert measure(shapes, "mass", PLATE) == {
        "kind": "mass",
        "value": pytest.approx(volume / 1000 * 1.24),
        "unit": "g",
        "how": "PLA 1.24 g/cm³ (default)",
        "density": 1.24,
        "volume": pytest.approx(volume),
        "exact": True,
    }


def test_mass_at_a_given_density(shapes):
    volume = measure(shapes, "volume", PLATE)["value"]
    steel = measure(shapes, "mass", PLATE, density=7.85)
    assert (steel["value"], steel["how"], steel["density"]) == (
        pytest.approx(volume / 1000 * 7.85),
        "at 7.85 g/cm³",
        7.85,
    )


@pytest.mark.parametrize("density", [0, -1, "1.24", True, float("nan"), float("inf")])
def test_density_that_is_not_a_positive_number_is_refused(shapes, density):
    assert refused(shapes, "mass", PLATE, density=density) == (
        "bad_request",
        "density is a positive number, in g/cm³",
    )


# What is asked


def test_unknown_kind_names_the_kinds(shapes):
    message = (
        "measure needs args.kind, one of distance, angle, radius, diameter, thickness, bbox, "
        "volume, area and mass"
    )
    assert refused(shapes, "width", PLATE) == ("bad_request", message)
    with pytest.raises(queries.QueryError) as e:
        queries.run(shapes, "measure", None, {})
    assert (e.value.kind, e.value.message) == ("bad_request", message)


@pytest.mark.parametrize(
    "target",
    [None, "assembly:plate", [0, 0, 0], {}, {"ref": 3}, {"point": [0, 0, 0]}, {"layout": "assembly"},
     {"layout": "assembly", "point": [0, 0]}, {"layout": "assembly", "point": [0, 0, float("nan")]},
     {"ref": PLATE, "point": "here"}, {"layout": 3, "point": [0, 0, 0]}],
)  # fmt: skip
def test_a_target_that_is_not_one_is_refused(shapes, target):
    with pytest.raises(queries.QueryError) as e:
        queries.run(shapes, "measure", {"kind": "volume", "a": target}, {})
    assert (e.value.kind, e.value.message) == (
        "bad_request",
        "measure volume needs args.a, a target: ref, a string, or layout, a string, with point, "
        "three finite numbers, or all three",
    )


def test_distance_and_angle_need_a_second_target(shapes, top):
    for kind in ("distance", "angle"):
        assert refused(shapes, kind, top) == (
            "bad_request",
            f"measure {kind} needs args.b, a target: ref, a string, or layout, a string, with "
            "point, three finite numbers, or all three",
        )


def test_refs_that_name_nothing_are_bad_refs_naming_what_there_is(shapes, top):
    kind, message = refused(shapes, "volume", "assembly:nope")
    assert kind == "bad_ref"
    assert "no part 'assembly:nope'; the parts are assembly:plate" in message
    assert refused(shapes, "area", f"{PLATE}/F99") == (
        "bad_ref",
        f"{PLATE} has 14 faces, F0 to F13; there is no F99",
    )
    assert refused(shapes, "distance", top, {"layout": "exploded", "point": [0, 0, 0]}) == (
        "bad_ref",
        "no layout 'exploded'; the layouts are assembly, print",
    )


def test_targets_of_two_layouts_are_refused(shapes, top):
    assert refused(shapes, "distance", top, "print:base") == (
        "bad_request",
        "a is in assembly and b in print: both ends of a measurement are in one layout",
    )
    assert refused(shapes, "volume", {"ref": PLATE, "layout": "print"}) == (
        "bad_request",
        f"a names the layout print and a ref of another, {PLATE}",
    )


def test_what_was_worked_out_of_a_part_is_kept_for_the_next_thickness(shapes):
    outside = ref(shapes, PLATE, "F", "plane, normal -Y, y = -15,")
    kept: dict = {}
    args = {"kind": "thickness", "a": {"ref": outside, "point": [0, -15, 1]}}
    first = queries.run(shapes, "measure", args, kept)
    held = dict(kept)
    assert len(held) == 1
    assert queries.run(shapes, "measure", args, kept) == first
    assert all(kept[k] is held[k] for k in held) and len(kept) == 1
