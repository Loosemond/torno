"""``measure``, in-process, on the shapes of the fixture models."""

import math
from pathlib import Path

import pytest

from torno_kernel import queries, topo
from torno_kernel.describe import number
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
    assert (result["value"], result["how"]) == (pytest.approx(16), "minimum, between surfaces")
    assert result["exact"] is True
    assert result["points"] == [pytest.approx([-4, 0, 2.5]), pytest.approx([-20, 0, 2.5])]
    touching = measure(shapes, "distance", "assembly:post", "assembly:base")
    assert (touching["value"], touching["how"]) == (
        pytest.approx(0, abs=1e-9),
        "minimum, between surfaces",
    )


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


def wedge(bulge: float):
    """A right triangle of 10 mm legs extruded 5 mm, its side along X a spline through
    (5, bulge): straight, and stored as a B-spline edge and an extrusion face, when bulge is 0."""
    from build123d import Face, Line, Spline, Wire, extrude

    side = Spline((0, 0), (5, bulge), (10, 0))
    profile = Wire([side, Line((10, 0), (10, 10)), Line((10, 10), (0, 0))])
    return {"assembly:wedge": extrude(Face(profile), 5)}


def test_angle_takes_a_flat_extrusion_face_as_a_plane_within_a_tolerance():
    made = wedge(0)
    assert queries.describe(made, "assembly:wedge/F0")["descriptor"].startswith("extrusion")
    result = measure(made, "angle", "assembly:wedge/F0", "assembly:wedge/F2")
    assert (result["value"], result["how"], result["exact"]) == (
        pytest.approx(135),
        "between normals, flat within 1e-6 mm",
        False,
    )
    top = measure(made, "angle", "assembly:wedge/F0", "assembly:wedge/F4")
    assert top["value"] == pytest.approx(90)
    # Its point is on it.
    assert result["points"][0][1] == pytest.approx(0, abs=1e-6)


def test_angle_takes_a_straight_bspline_edge_as_a_line_within_a_tolerance():
    made = wedge(0)
    assert queries.describe(made, "assembly:wedge/E2")["descriptor"].startswith("bspline")
    result = measure(made, "angle", "assembly:wedge/E2", "assembly:wedge/E7")
    assert (result["value"], result["how"], result["exact"]) == (
        pytest.approx(45),
        "between lines, straight within 1e-6 mm",
        False,
    )
    plane = measure(made, "angle", "assembly:wedge/E2", "assembly:wedge/F1")
    assert (plane["value"], plane["how"]) == (
        pytest.approx(90),
        "line to plane, straight within 1e-6 mm",
    )


def test_angle_refuses_a_curved_extrusion_face_saying_it_is_not_flat():
    made = wedge(3)
    message = refused(made, "angle", "assembly:wedge/F0", "assembly:wedge/F4")[1]
    assert message.endswith("assembly:wedge/F0 is curved: an extrusion face that is not flat")
    edge = refused(made, "angle", "assembly:wedge/E2", "assembly:wedge/F4")[1]
    assert edge.endswith("assembly:wedge/E2 is curved: a bspline edge that is not straight")


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
        "moved": pytest.approx(0, abs=1e-9),
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


def test_thickness_is_taken_from_the_face_when_the_point_is_a_hair_off_it(shapes, bottom):
    result = measure(shapes, "thickness", {"ref": bottom, "point": [15, -5, -3.04]})
    assert result["value"] == pytest.approx(6)
    assert result["points"] == [pytest.approx([15, -5, -3]), pytest.approx([15, -5, 3])]
    assert result["moved"] == pytest.approx(0.04)


def test_thickness_at_a_point_that_is_not_on_the_face_is_refused(shapes, bottom, top):
    assert refused(shapes, "thickness", {"ref": bottom, "point": [15, -5, -8]}) == (
        "bad_request",
        f"the point is 5 mm from {bottom}: give a point on the face",
    )
    # In the mouth of a hole the face is its rim, 4 mm away.
    assert refused(shapes, "thickness", {"ref": top, "point": [10, 5, 3]}) == (
        "bad_request",
        f"the point is 4 mm from {top}: give a point on the face",
    )
    assert refused(shapes, "thickness", {"ref": top, "point": [0, 60, 3.06]})[1].startswith(
        "the point is 45 mm from"
    )
    assert refused(shapes, "thickness", {"ref": top, "point": [15, 0, 3.06]})[1].startswith(
        "the point is 0.06 mm from"
    )


def test_thickness_from_inside_a_hole_goes_into_the_material(shapes, holes):
    # The wall of the hole at x = -14 faces +X; behind it are 6 mm of plate to x = -20.
    result = measure(shapes, "thickness", {"ref": holes[0], "point": [-14, 5, 0]})
    assert result["value"] == pytest.approx(6)
    assert result["points"][1] == pytest.approx([-20, 5, 0])


def test_thickness_with_nothing_behind_the_face_is_refused():
    from build123d import Box, Compound, Pos

    # A solid, and beside it a face that bounds nothing.
    loose = (Pos(50, 0, 0) * Box(10, 10, 10)).faces()[0]
    made = {"assembly:mixed": Compound([Box(10, 10, 10), loose])}
    centre = queries.describe(made, "assembly:mixed/F6")["center"]
    assert refused(made, "thickness", {"ref": "assembly:mixed/F6", "point": centre}) == (
        "bad_request",
        "no opposite wall along the normal",
    )


def not_solids() -> dict:
    from build123d import Axis, Box, Shell

    faces = Box(10, 10, 10).faces().sort_by(Axis.Z)
    return {"assembly:tub": Shell(faces[:-1]), "assembly:sheet": faces[0]}


def test_volume_mass_and_thickness_of_what_is_not_a_solid_are_refused():
    made = not_solids()
    assert refused(made, "volume", "assembly:tub") == (
        "bad_request",
        "assembly:tub is not a solid: it is a shell",
    )
    assert refused(made, "mass", "assembly:sheet") == (
        "bad_request",
        "assembly:sheet is not a solid: it is a face",
    )
    centre = queries.describe(made, "assembly:tub/F0")["center"]
    assert refused(made, "thickness", {"ref": "assembly:tub/F0", "point": centre}) == (
        "bad_request",
        "assembly:tub is not a solid: it is a shell",
    )
    # What it has, it is asked: five faces of 100 mm².
    assert measure(made, "area", "assembly:tub")["value"] == pytest.approx(500)
    assert measure(made, "area", "assembly:sheet/F0")["value"] == pytest.approx(100)
    assert measure(made, "bbox", "assembly:tub")["size"] == pytest.approx([10, 10, 10])


def test_a_part_inside_another_is_apart_from_its_surface_and_says_so():
    from build123d import Box

    nested = {"assembly:a": Box(20, 20, 20), "assembly:b": Box(4, 4, 4)}
    result = measure(nested, "distance", "assembly:a", "assembly:b")
    assert (result["value"], result["how"]) == (pytest.approx(8), "minimum, between surfaces")
    inside = measure(nested, "distance", {"layout": "assembly", "point": [0, 0, 0]}, "assembly:a")
    assert (inside["value"], inside["how"]) == (pytest.approx(10), "minimum, between surfaces")
    # Between a face and a point there is no inside to be in.
    face = measure(nested, "distance", {"layout": "assembly", "point": [0, 0, 0]}, "assembly:a/F0")
    assert face["how"] == "point to plane"


def test_bbox_is_exact_only_when_every_edge_is_a_line_or_a_circle():
    from build123d import Box, Cylinder, Ellipse, Pos, Rot, extrude

    # A cylinder cut on the slant: flat and cylindrical faces, and an ellipse between them.
    slanted = Cylinder(4, 20) - Pos(0, 0, 12) * Rot(0, 30, 0) * Box(40, 40, 10)
    assert measure({"assembly:it": Cylinder(4, 20)}, "bbox", "assembly:it")["exact"] is True
    assert measure({"assembly:it": slanted}, "bbox", "assembly:it")["exact"] is False
    made = {"assembly:it": extrude(Ellipse(10, 5), 2)}
    flat = [r for r in refs(made, "assembly:it", "F", "plane")]
    assert flat and all(measure(made, "bbox", r)["exact"] is False for r in flat)
    rim = refs(made, "assembly:it", "E", "ellipse")[0]
    assert measure(made, "bbox", rim)["exact"] is False


def test_what_a_target_is_reads_as_a_sentence():
    from build123d import Ellipse, extrude

    made = {"assembly:it": extrude(Ellipse(10, 5), 2)}
    rim = refs(made, "assembly:it", "E", "ellipse")[0]
    assert refused(made, "radius", rim)[1].endswith(f"{rim} is an ellipse edge")
    side = refs(made, "assembly:it", "F", "extrusion")[0]
    assert refused(made, "radius", side)[1].endswith(f"{side} is an extrusion face")


@pytest.mark.parametrize("huge", [1e308, -1e308, 1.1e9])
def test_coordinates_beyond_a_million_kilometres_are_refused(shapes, top, huge):
    far = {"layout": "assembly", "point": [0, 0, huge]}
    assert refused(shapes, "distance", far, top)[0] == "bad_request"
    assert refused(shapes, "distance", far, {"layout": "assembly", "point": [0, 0, 0]})[0] == (
        "bad_request"
    )
    near = {"layout": "assembly", "point": [0, 0, 1e9]}
    assert measure(shapes, "distance", near, top)["value"] == pytest.approx(1e9 - 3)


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
    assert result["how"] == (
        "axis-aligned box, approximate: exact only of planes and cylinders with straight and "
        "circular edges"
    )
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
    # What a line is cut with, and how coarsely the part is drawn.
    assert set(held) == {("rays", PLATE), ("deflection", PLATE)}
    assert queries.run(shapes, "measure", args, kept) == first
    assert all(kept[k] is held[k] for k in held) and len(kept) == 2


# Areas and volumes of what is not flat or round: exact to 1e-6 of themselves


def test_area_and_volume_of_a_spline_prism_are_exact_to_a_millionth(spline_prism):
    prism, true_area, true_length = spline_prism
    made = {"assembly:prism": prism}
    [top] = refs(made, "assembly:prism", "F", "plane, normal +Z")
    assert measure(made, "area", top)["value"] == pytest.approx(true_area, rel=1e-6)
    assert measure(made, "volume", "assembly:prism")["value"] == pytest.approx(true_area * 5, rel=1e-6)
    assert measure(made, "mass", "assembly:prism", density=1)["value"] == pytest.approx(
        true_area * 5 / 1000, rel=1e-6
    )
    # describe says the same numbers.
    assert queries.describe(made, top)["area"] == pytest.approx(true_area, rel=1e-6)
    described = queries.describe(made, "assembly:prism")
    assert described["volume"] == pytest.approx(true_area * 5, rel=1e-6)
    # Two ends, and a side as long as the outline and 5 mm high.
    whole = 2 * true_area + true_length * 5
    assert (described["area"], described["areaExact"]) == (pytest.approx(whole, rel=1e-6), True)
    area = measure(made, "area", "assembly:prism")
    assert (area["value"], area["exact"], area["how"]) == (
        pytest.approx(whole, rel=1e-6),
        True,
        "surface of the part",
    )
    [side] = refs(made, "assembly:prism", "F", "extrusion")
    alone = measure(made, "area", side)
    assert (alone["value"], alone["exact"]) == (pytest.approx(true_length * 5, rel=1e-6), True)
    face = queries.describe(made, side)
    assert (face["area"], face["areaExact"]) == (pytest.approx(true_length * 5, rel=1e-6), True)
    assert face["descriptor"] == f"extrusion, {number(true_length * 5)} mm²"


def test_volumes_of_an_ellipsoid_and_a_torus_and_the_area_of_the_torus_are_right_to_a_millionth():
    from build123d import Sphere, Torus, scale

    made = {"assembly:egg": scale(Sphere(5), by=(1, 2, 3)), "assembly:ring": Torus(20, 3)}
    assert measure(made, "volume", "assembly:egg")["value"] == pytest.approx(
        4 / 3 * math.pi * 5 * 10 * 15, rel=1e-6
    )
    assert measure(made, "volume", "assembly:ring")["value"] == pytest.approx(
        2 * math.pi**2 * 20 * 9, rel=1e-6
    )
    assert measure(made, "area", "assembly:ring")["value"] == pytest.approx(
        4 * math.pi**2 * 20 * 3, rel=1e-6
    )


def test_a_volume_is_exact_by_the_quick_integral_and_approximate_by_gauss_kronrod(spline_prism):
    from build123d import Align, Box, Cone, Cylinder, Pos, Rot, Sphere, Torus, fillet, scale

    from torno_kernel import extent

    prism, outline_area, _ = spline_prism
    half = Box(100, 100, 100, align=(Align.CENTER, Align.CENTER, Align.MIN))
    # Planes, cylinders, cones, spheres and tori that end in lines and circles: the quick
    # integral has those right, and takes a tenth of the time on a part full of fillets.
    quick = {
        Box(10, 20, 30): 6000,
        Cylinder(10, 20) - Cylinder(4, 20): math.pi * (100 - 16) * 20,
        Sphere(7): 4 / 3 * math.pi * 343,
        Cone(6, 2, 9): math.pi * 9 * (36 + 12 + 4) / 3,
        Torus(20, 3): 2 * math.pi**2 * 20 * 9,
        # A box of 6 × 16 × 26 grown by a ball of 2.
        fillet(Box(10, 20, 30).edges(), 2): 6 * 16 * 26
        + 2 * 2 * (6 * 16 + 16 * 26 + 6 * 26)
        + math.pi * 4 * (6 + 16 + 26)
        + 4 / 3 * math.pi * 8,
    }
    # Anything else is integrated by Gauss-Kronrod, as finely as costs next to nothing, and is
    # never told as exact.
    slow = {
        prism: outline_area * 5,
        scale(Sphere(5), by=(1, 2, 3)): 4 / 3 * math.pi * 5 * 10 * 15,
        # Cut through its middle on the slant, it ends in an ellipse: half of it is left.
        Cylinder(5, 20) - Rot(0, 30, 0) * half: math.pi * 25 * 20 / 2,
        Pos(1, 2, 3) * prism: outline_area * 5,
    }
    for shapes, plain, tolerance in ((quick, True, 1e-12), (slow, False, 1e-6)):
        for shape, volume in shapes.items():
            assert extent.round_and_straight(shape) is plain
            assert extent.volume(shape).value == pytest.approx(volume, rel=tolerance)
            # Only the quick integral of planes and round faces is told as exact.
            assert extent.volume(shape).exact is plain
            made = {"assembly:it": shape}
            result = measure(made, "volume", "assembly:it")
            assert (result["value"], result["exact"]) == (pytest.approx(volume, rel=tolerance), plain)
            scene, _, _ = build_scene({"assembly": {"it": shape}}, "it.py")
            assert scene["parts"][0]["volume"] == pytest.approx(volume, rel=tolerance)
            assert scene["parts"][0]["volumeExact"] is plain


def test_a_compound_inside_a_compound_has_the_volume_of_its_solid():
    from build123d import Box, Compound

    made = {"assembly:nest": Compound([Compound([Box(10, 10, 10)])])}
    assert measure(made, "volume", "assembly:nest")["value"] == pytest.approx(1000)
    assert measure(made, "mass", "assembly:nest", density=2)["value"] == pytest.approx(2)
    assert measure(made, "area", "assembly:nest")["value"] == pytest.approx(600)
    described = queries.describe(made, "assembly:nest")
    assert (described["volume"], described["area"]) == (pytest.approx(1000), pytest.approx(600))
    assert described["descriptor"] == "part, 10 × 10 × 10 mm, 1000 mm³, 6 faces"
    scene, _, _ = build_scene({"assembly": dict(nest=made["assembly:nest"])}, "nest.py")
    assert scene["parts"][0]["volume"] == pytest.approx(1000)


def said_volume_digits(how: str) -> int:
    """The digits a volume that is not exact says are good, from its ``how``."""
    import re

    [digits] = re.findall(r"approximate, good to about (\d) significant digits$", how)
    return int(digits)


def reference_volume(shape) -> float:
    """The volume by Gauss-Kronrod to 1e-10 of itself: affordable of a part of a few faces only."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    measured = GProp_GProps()
    BRepGProp.VolumePropertiesGK_s(shape.wrapped, measured, 1e-10, False, False, False)
    return abs(measured.Mass())


def test_the_volume_of_a_freeform_part_is_approximate_and_as_near_as_it_says(spline_prism):
    from build123d import Cylinder, Pos, Rot

    prism, outline_area, _ = spline_prism
    horn = tuned_loft()
    bored = horn - Pos(0, 0, 10) * Rot(90, 0, 0) * Cylinder(2, 60)
    references = {"prism": (prism, outline_area * 5), "horn": (horn, None), "bored": (bored, None)}
    for name, (shape, true) in references.items():
        true = reference_volume(shape) if true is None else true
        made = {f"assembly:{name}": shape}
        result = measure(made, "volume", f"assembly:{name}")
        assert (result["unit"], result["exact"]) == ("mm3", False), name
        digits = said_volume_digits(result["how"])
        assert result["how"] == f"of the solid, approximate, good to about {digits} significant digits"
        assert 2 <= digits <= 6
        assert result["value"] == pytest.approx(true, rel=10**-digits), name
        # A part of a few faces costs nothing to integrate finely: it is good to five digits at least.
        assert digits >= 5, name
        # The mass is of that volume, and no more exact; describe says the same number.
        mass = measure(made, "mass", f"assembly:{name}", density=2)
        assert (mass["value"], mass["volume"], mass["exact"]) == (result["value"] / 500, result["value"], False)
        assert mass["how"] == f"at 2 g/cm³; volume approximate, good to about {digits} significant digits"
        described = queries.describe(made, f"assembly:{name}")
        assert (described["volume"], described["volumeExact"]) == (result["value"], False)
        assert f", ≈ {number(result['value'])} mm³, " in described["descriptor"]


def test_the_volume_and_the_mass_of_planes_and_round_faces_stay_exact(shapes):
    result = measure(shapes, "volume", PLATE)
    assert (result["how"], result["exact"]) == ("of the solid", True)
    mass = measure(shapes, "mass", PLATE)
    assert (mass["how"], mass["exact"]) == ("PLA 1.24 g/cm³ (default)", True)
    described = queries.describe(shapes, PLATE)
    assert described["volumeExact"] is True and "≈" not in described["descriptor"]


def gauss_kronrod_asked(monkeypatch, seconds: float = 0.0) -> list[float]:
    """The tolerances Gauss-Kronrod is asked for from here on, each integral taking ``seconds`` by the clock."""
    from torno_kernel import extent

    asked: list[float] = []
    clock = [0.0]
    monkeypatch.undo()
    integrate = extent._gauss_kronrod

    def counted(wrapped, tolerance, centre):
        asked.append(tolerance)
        clock[0] += seconds
        return integrate(wrapped, tolerance, centre)

    monkeypatch.setattr(extent, "_gauss_kronrod", counted)
    monkeypatch.setattr(extent, "_clock", lambda: clock[0])
    return asked


def test_no_volume_is_integrated_to_a_billionth_and_none_past_what_the_looser_ones_left(monkeypatch):
    from torno_kernel import extent

    horn = tuned_loft()
    asked = gauss_kronrod_asked(monkeypatch)
    cheap = extent.volume(horn)
    # Each integral took no time: every rung is climbed, and none is finer than the last.
    assert asked == list(extent.VOLUME_TOLERANCES) and min(asked) >= 1e-7
    asked = gauss_kronrod_asked(monkeypatch, seconds=0.04)
    extent.volume(horn)
    # 0.04 s each: a third is begun with 0.08 s spent, a fourth with 0.12 s is not.
    assert asked == list(extent.VOLUME_TOLERANCES[:3])
    asked = gauss_kronrod_asked(monkeypatch, seconds=0.5)
    costly = extent.volume(horn)
    # The first took all a volume has: no second, whose cost nothing would bound.
    assert asked == [extent.VOLUME_TOLERANCES[0]]
    assert not costly.exact and costly.value == pytest.approx(cheap.value, rel=1e-3)
    # It is held against the integral at a fixed order, and says no more digits than that bears out.
    assert costly.digits is None or 2 <= costly.digits <= cheap.digits


@pytest.mark.parametrize(
    "integrals, fixed, digits, percent",
    [
        ((100.0, 100.00000001), None, 6, None),  # 1e-10 apart: never more than six
        ((100.0, 100.0001), None, 5, None),  # 1e-6 apart: one fewer than they agree to
        ((100.0, 100.05), None, 2, None),
        ((100.0, 100.2), None, None, "0.2"),  # 2e-3 apart: no count of digits
        # The last is held against the last that differs from it: one that is the same number did not refine.
        ((100.005, 100.0, 100.0), None, 3, None),
        ((100.0, 111.0, 111.0), None, None, "9.9"),
        # All the same number: that is no agreement. Held against another kind of integral.
        ((100.0, 100.0, 100.0), 100.00005, 5, None),
        ((100.0, 100.0), 100.6, None, "0.6"),
        ((100.0, 100.0), 100.0, 6, None),
    ],
)
def test_the_digits_said_of_a_volume_are_one_fewer_than_two_integrals_that_differ_agree_to(
    monkeypatch, integrals, fixed, digits, percent
):
    from torno_kernel import extent

    def fake():
        left = list(integrals)
        clock = [0.0]

        def integrate(wrapped, tolerance, centre):
            # The last of them takes what a volume has: no other is begun.
            clock[0] += 1.0 if len(left) == 1 else 0.0
            return left.pop(0), None

        monkeypatch.setattr(extent, "_gauss_kronrod", integrate)
        monkeypatch.setattr(extent, "_clock", lambda: clock[0])

    def fixed_order(wrapped):
        assert fixed is not None, "integrals that differ need no other"
        return fixed

    monkeypatch.setattr(extent, "_fixed_order", fixed_order)
    fake()
    volume = extent.volume(tuned_loft())
    assert (volume.value, volume.exact, volume.digits) == (integrals[-1], False, digits)
    fake()
    how = measure({"assembly:horn": tuned_loft()}, "volume", "assembly:horn")["how"]
    if digits is None:
        assert how == f"of the solid, approximate: in doubt by {percent} %"
    else:
        assert how == f"of the solid, approximate, good to about {digits} significant digits"


def campaign() -> dict:
    """Freeform solids of the kinds the review of the volumes went over, its two lofts among them."""
    from build123d import (
        Align, Axis, Box, Cylinder, Edge, Ellipse, Face, Pos, Rectangle, Rot, Sphere, Vector, Wire,
        extrude, fillet, loft, scale,
    )

    through = [(20, 0), (14, 9), (0, 12), (-12, 8), (-15, -2), (-6, -11), (8, -9)]
    prism = extrude(Face(Wire([Edge.make_spline([Vector(*p) for p in through], periodic=True)])), 5)
    body = loft(
        [
            Pos(math.sin(i) * 4, 0, i * 12) * Rot(0, 0, i * 17) * Ellipse(20 - 2 * i + 3 * math.cos(i), 9 + i).face()
            for i in range(6)
        ]
    )
    bored = body
    for k in range(6):
        bored -= Pos(0, 0, 8 + k * 8) * Rot(0, 90, k * 25) * Cylinder(2.5, 90)
    half = Box(100, 100, 100, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return {
        "loft": body,
        "loft with six bores": bored,
        "loft, tuned": tuned_loft(),
        "loft, twisted": loft([Pos(0, 0, i * 10) * Rot(0, 0, i * 25) * Rectangle(20, 8).face() for i in range(5)]),
        "spline prism": prism,
        "spline prism, filleted": fillet(prism.edges().group_by(Axis.Z)[-1], 1),
        "ellipsoid": scale(Sphere(5), by=(1, 2, 3)),
        "cylinder cut on the slant": Cylinder(5, 20) - Rot(0, 30, 0) * half,
    }


def test_no_freeform_volume_says_more_digits_than_a_slow_reference_bears_out_nor_calls_a_good_one_rough():
    for name, shape in campaign().items():
        true = reference_volume(shape)
        made = {"assembly:it": shape}
        result = measure(made, "volume", "assembly:it")
        assert result["exact"] is False, name
        # Digits, not a percentage: each of these is right to a millionth and better.
        digits = said_volume_digits(result["how"])
        assert result["value"] == pytest.approx(true, rel=1e-6), name
        assert result["value"] == pytest.approx(true, rel=10**-digits), name
        if name.startswith("loft"):
            # A loft right to 1e-15 was told as good to 2 digits, and one with six bores as in doubt by 11 %.
            assert digits >= 5, name
        mass = measure(made, "mass", "assembly:it")
        assert mass["how"] == f"PLA 1.24 g/cm³ (default); volume approximate, good to about {digits} significant digits"


def test_a_volume_whose_first_integral_took_all_it_has_is_held_against_the_fixed_order_one(monkeypatch):
    from torno_kernel import extent

    asked = gauss_kronrod_asked(monkeypatch, seconds=0.5)
    for name, shape in campaign().items():
        del asked[:]
        true = reference_volume(shape)
        volume = extent.volume(shape)
        assert asked == [extent.VOLUME_TOLERANCES[0]], name
        # Rough, and says so: a percentage or few digits, and never more than are true.
        assert volume.exact is False and volume.spread > 0, name
        if volume.digits is not None:
            assert volume.value == pytest.approx(true, rel=10**-volume.digits), name


def test_a_part_that_is_not_a_solid_is_described_with_no_volume():
    made = not_solids()
    assert queries.describe(made, "assembly:tub")["volume"] == 0
    assert queries.describe(made, "assembly:tub")["area"] == pytest.approx(500)


# A pick on a large curved face is as far off it as the mesh it was made on


def test_thickness_takes_a_point_as_far_off_a_face_as_the_mesh_is_and_says_how_far_it_moved():
    from build123d import Cylinder

    made = {"assembly:drum": Cylinder(200, 50)}
    [side] = refs(made, "assembly:drum", "F", "cylinder")
    # The drum is drawn with chords up to (400 + 400 + 50) / 300 × 0.1 = 0.283 mm off it.
    result = measure(made, "thickness", {"ref": side, "point": [199.88, 0, 0]})
    assert (result["value"], result["moved"]) == (pytest.approx(400), pytest.approx(0.12))
    assert result["points"] == [pytest.approx([200, 0, 0]), pytest.approx([-200, 0, 0])]
    assert refused(made, "thickness", {"ref": side, "point": [199, 0, 0]}) == (
        "bad_request",
        f"the point is 1 mm from {side}: give a point on the face",
    )
    # A small part is drawn finer: there the band is 0.05 mm, as before.
    small = {"assembly:pin": Cylinder(2, 50)}
    [side] = refs(small, "assembly:pin", "F", "cylinder")
    assert refused(small, "thickness", {"ref": side, "point": [2.12, 0, 0]})[0] == "bad_request"


def test_an_integer_too_large_for_a_float_is_no_coordinate(shapes, top):
    far = {"layout": "assembly", "point": [0, 0, 10**400]}
    assert refused(shapes, "distance", far, top)[0] == "bad_request"
    with pytest.raises(queries.QueryError) as e:
        queries.run(shapes, "nearest", {"layout": "assembly", "anchors": [{"part": "plate", "point": [10**400, 0, 0]}]})
    assert e.value.kind == "bad_request"


# Areas of faces no integral of which can be trusted alone


def said_digits(how: str) -> int:
    """About how many significant digits an approximate area says are good."""
    import re

    found = re.search(r", approximate, good to about (\d) significant digits$", how)
    assert found, how
    return int(found[1])


def said_percent(how: str) -> float:
    """By how much of itself an approximate area says its integrals differ, when it says no digits."""
    import re

    found = re.search(r", approximate: its integrals differ by (\d+(?:\.\d+)?) %$", how)
    assert found, how
    return float(found[1])


def whole_surface_area(face, panels: int = 48) -> float:
    """The area of a face that is the whole of its surface, by Gauss-Legendre, without the kernel.

    The surface's u and v ranges are cut into panels, and |dS/du × dS/dv| is
    summed at six points a side in each: nothing of OCC's integrals is used.
    """
    import numpy as np
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.gp import gp_Pnt, gp_Vec

    surface = BRepAdaptor_Surface(face)
    u0, u1 = surface.FirstUParameter(), surface.LastUParameter()
    v0, v1 = surface.FirstVParameter(), surface.LastVParameter()
    nodes, weights = np.polynomial.legendre.leggauss(6)
    at, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
    hu, hv = (u1 - u0) / panels / 2, (v1 - v0) / panels / 2
    total = 0.0
    for i in range(panels):
        for j in range(panels):
            for x, wx in zip(nodes, weights, strict=True):
                for y, wy in zip(nodes, weights, strict=True):
                    surface.D1(u0 + hu * (2 * i + 1 + x), v0 + hv * (2 * j + 1 + y), at, du, dv)
                    total += wx * wy * du.Crossed(dv).Magnitude()
    return total * hu * hv


def ellipsoid_area(a: float, b: float, c: float) -> float:
    """The area of an ellipsoid, by Gauss-Legendre quadrature, without the kernel.

    The point at colatitude t and longitude p is (a sin t cos p, b sin t sin p,
    c cos t); the area element there is
    sin t · sqrt((bc sin t cos p)² + (ac sin t sin p)² + (ab cos t)²) dt dp.
    For 5, 10, 15 it is 1222.0536575644…
    """
    import numpy as np

    nodes, weights = np.polynomial.legendre.leggauss(300)
    t, wt = (nodes + 1) * math.pi / 2, weights * math.pi / 2
    p, wp = (nodes + 1) * math.pi, weights * math.pi
    tt, pp = np.meshgrid(t, p, indexing="ij")
    element = np.sin(tt) * np.sqrt(
        (b * c * np.sin(tt) * np.cos(pp)) ** 2
        + (a * c * np.sin(tt) * np.sin(pp)) ** 2
        + (a * b * np.cos(tt)) ** 2
    )
    return float(wt @ element @ wp)


def test_the_reference_for_the_ellipsoid_is_right_of_a_sphere():
    assert ellipsoid_area(7, 7, 7) == pytest.approx(4 * math.pi * 49, rel=1e-12)
    assert ellipsoid_area(5, 10, 15) == pytest.approx(1222.0536575644, rel=1e-12)


def test_the_area_of_an_ellipsoid_is_never_said_to_be_exact_and_is_as_near_as_it_says():
    from build123d import Sphere, scale

    made = {"assembly:egg": scale(Sphere(5), by=(1, 2, 3))}
    true_area = ellipsoid_area(5, 10, 15)
    for target, how in (("assembly:egg", "surface of the part"), ("assembly:egg/F0", "of the face")):
        result = measure(made, "area", target)
        assert result["exact"] is False
        # Its integrals are 0.36 % apart: too far for any digit to be vouched for.
        assert result["how"] == f"{how}, approximate: its integrals differ by 0.36 %"
        # The integral told is the one that was nearest wherever it was checked: 3.3e-6 here.
        assert result["value"] == pytest.approx(true_area, rel=1e-5)
    for ref in ("assembly:egg", "assembly:egg/F0"):
        assert queries.describe(made, ref)["areaExact"] is False
    assert queries.describe(made, "assembly:egg/F0")["descriptor"].startswith("bspline, ≈ ")


def tuned_loft():
    """A loft whose side OCC integrates three ways that agree to 9.6e-7, all further than that out."""
    from build123d import Circle, Ellipse, Pos, loft

    return loft(
        [Circle(10).face(), Pos(0, 0, 15) * Ellipse(13.5, 5).face(), Pos(3, 0, 30) * Circle(4).face()]
    )


def test_integrals_that_agree_are_no_proof_the_side_of_a_loft_is_approximate():
    made = {"assembly:horn": tuned_loft()}
    [side] = refs(made, "assembly:horn", "F", "bspline")
    face = topo.faces(made["assembly:horn"])[int(side.rsplit("F", 1)[1])]
    true_area = whole_surface_area(face)
    # The reference has settled, and is what two other integrators gave for the re-review.
    assert true_area == pytest.approx(whole_surface_area(face, 24), rel=1e-10)
    assert true_area == pytest.approx(1718.8083762046, rel=1e-10)
    result = measure(made, "area", side)
    assert result["exact"] is False
    assert result["value"] == pytest.approx(true_area, rel=1e-5)
    assert 2 <= said_digits(result["how"]) <= 5
    assert result["value"] == pytest.approx(true_area, rel=10 ** -said_digits(result["how"]))
    # What describe says of the face is for its descriptor: one integral, near enough for the
    # four digits shown after the ≈, and never exact. measure is what is asked for the area.
    described = queries.describe(made, side)
    assert (described["area"], described["areaExact"]) == (pytest.approx(true_area, rel=1e-5), False)
    assert described["descriptor"] == f"bspline, ≈ {number(result['value'])} mm²"
    # The part is two discs and that side: no more exact than its side, and to its digits.
    whole = measure(made, "area", "assembly:horn")
    assert whole["exact"] is False
    assert whole["value"] == pytest.approx(true_area + math.pi * 100 + math.pi * 16, rel=1e-5)
    assert whole["how"] == (
        f"surface of the part, approximate, good to about {said_digits(result['how'])} significant digits"
    )
    assert queries.describe(made, "assembly:horn")["areaExact"] is False


def test_integrals_that_coincide_are_still_approximate_and_good_to_six_digits_at_most(monkeypatch):
    from torno_kernel import extent

    made = {"assembly:horn": tuned_loft()}
    [side] = refs(made, "assembly:horn", "F", "bspline")
    # No doubt between them at all: which is not to say that they are right.
    monkeypatch.setattr(extent, "_integrated", lambda face, tolerance: 1718.81)
    result = measure(made, "area", side)
    assert (result["value"], result["exact"]) == (1718.81, False)
    assert result["how"] == "of the face, approximate, good to about 6 significant digits"
    assert queries.describe(made, side)["areaExact"] is False


@pytest.mark.parametrize(
    "integrals, digits",
    [
        ((100.0, 100.0, 100.0), 6),
        ((100.0, 100.0, 100.00000001), 6),  # 1e-10 apart: never more than six
        ((100.0, 100.0, 100.0001), 5),  # 1e-6 apart: one digit fewer than they agree to
        ((100.0, 100.00011, 100.0), 4),
        ((100.0, 100.05, 100.0), 2),  # 5e-4 apart
    ],
)
def test_the_digits_said_of_an_area_are_one_fewer_than_all_its_integrals_agree_to(
    monkeypatch, integrals, digits
):
    from torno_kernel import extent

    made = {"assembly:horn": tuned_loft()}
    [side] = refs(made, "assembly:horn", "F", "bspline")
    by_tolerance = dict(zip((None, 1e-9, 1e-12), integrals, strict=True))
    monkeypatch.setattr(extent, "_integrated", lambda face, tolerance: by_tolerance[tolerance])
    result = measure(made, "area", side)
    # The value is that of the finest tolerance, wherever it lies among them.
    assert (result["value"], result["exact"]) == (integrals[2], False)
    assert said_digits(result["how"]) == digits


@pytest.mark.parametrize(
    "integrals, percent",
    [
        ((100.0, 100.0, 100.2), "0.2"),  # 2e-3 apart: two digits agree, and one fewer is no count
        ((100.0, 102.13, 100.0), "2.1"),
        ((100.0, 150.0, 100.0), "50"),
        ((117.4, 100.0, 100.0), "17"),
    ],
)
def test_an_area_whose_integrals_are_too_far_apart_says_by_how_much_and_no_digits(
    monkeypatch, integrals, percent
):
    from torno_kernel import extent

    made = {"assembly:horn": tuned_loft()}
    [side] = refs(made, "assembly:horn", "F", "bspline")
    by_tolerance = dict(zip((None, 1e-9, 1e-12), integrals, strict=True))
    monkeypatch.setattr(extent, "_integrated", lambda face, tolerance: by_tolerance[tolerance])
    assert extent.area(topo.faces(made["assembly:horn"])[int(side.rsplit("F", 1)[1])]).digits is None
    result = measure(made, "area", side)
    assert (result["value"], result["exact"]) == (integrals[2], False)
    assert result["how"] == f"of the face, approximate: its integrals differ by {percent} %"


def test_a_spline_prism_with_a_cross_hole_says_no_digits_of_its_side_but_a_percentage():
    from build123d import Cylinder, Edge, Face, Pos, Rot, Vector, Wire, extrude

    from torno_kernel import extent

    through = [(20, 0), (14, 9), (0, 12), (-12, 8), (-15, -2), (-6, -11), (8, -9)]
    outline = Edge.make_spline([Vector(*p) for p in through], periodic=True)
    made = {"assembly:bored": extrude(Face(Wire([outline])), 30) - Pos(7, 0, 15) * Rot(0, 90, 20) * Cylinder(3, 60)}
    [side] = refs(made, "assembly:bored", "F", "extrusion")
    face = topo.faces(made["assembly:bored"])[int(side.rsplit("F", 1)[1])]
    integrals = [extent._integrated(face, tolerance) for tolerance in (None, 1e-9, 1e-12)]
    result = measure(made, "area", side)
    # A face of this kind was 3.9e-2 out in the review, its integrals 17 % apart: here
    # they are 0.71 % apart, and "about 2 significant digits" would be a promise.
    assert extent.area(face).digits is None
    assert result["exact"] is False
    assert said_percent(result["how"]) == pytest.approx(100 * (max(integrals) - min(integrals)) / result["value"], rel=0.05)
    assert 0.1 < said_percent(result["how"]) < 5
    # The part's doubt is its faces', as a part of all its area.
    whole = measure(made, "area", "assembly:bored")
    assert whole["exact"] is False
    assert said_percent(whole["how"]) == pytest.approx(100 * (max(integrals) - min(integrals)) / whole["value"], rel=0.05)
    assert said_percent(whole["how"]) < said_percent(result["how"])
    assert whole["how"].startswith("surface of the part, approximate: its integrals differ by ")


def test_a_part_says_no_digits_when_one_of_its_faces_says_none(monkeypatch):
    from torno_kernel import extent

    doubted = iter([extent.Area(100.0, False, 5, 1e-4), extent.Area(50.0, False, None, 2.0), extent.Area(50.0, True)])
    monkeypatch.setattr(extent, "_face_area", lambda face: next(doubted))
    monkeypatch.setattr(extent.topo, "faces", lambda shape: [1, 2, 3])
    # (1e-4 + 2) / 200: every face's spread, as a part of the whole.
    assert extent.area(object()) == extent.Area(200.0, False, None, pytest.approx(2.0001))
    counted = iter([extent.Area(100.0, False, 5, 1e-4), extent.Area(50.0, False, 3, 0.01), extent.Area(50.0, True)])
    monkeypatch.setattr(extent, "_face_area", lambda face: next(counted))
    assert extent.area(object())[:3] == (200.0, False, 3)


def test_the_area_of_a_freeform_face_cut_on_the_slant_is_not_said_to_be_exact(spline_prism):
    import numpy as np
    from build123d import Align, Box, Edge, Face, Pos, Rot, Vector, Wire, extrude

    through = [(20, 0), (14, 9), (0, 12), (-12, 8), (-15, -2), (-6, -11), (8, -9)]
    outline = Edge.make_spline([Vector(*p) for p in through], periodic=True)
    block = Box(200, 200, 40, align=(Align.CENTER, Align.CENTER, Align.MIN))
    # Cut by a plane through (0, 0, 8) tilted 15°: the side is as high as the plane is there.
    made = {"assembly:wedge": extrude(Face(Wire([outline])), 20) - Pos(0, 0, 8) * Rot(0, 15, 0) * block}
    points = np.array([tuple(outline.position_at(t))[:2] for t in np.linspace(0, 1, 20001)])
    steps = np.linalg.norm(np.diff(points, axis=0), axis=1)
    middles = (points[1:] + points[:-1]) / 2
    true_area = float(np.sum(steps * (8 - middles[:, 0] * math.tan(math.radians(15)))))
    [side] = refs(made, "assembly:wedge", "F", "extrusion")
    result = measure(made, "area", side)
    # It is cut along its height, so it is not its curve's length times a height: not claimed.
    assert result["exact"] is False
    # Of an extrusion that is cut, the integral at a fixed order is told: 5e-7 out here,
    # where the one to 1e-12 is 1.9e-3 out. The three are 0.28 % apart, and that is said.
    assert result["value"] == pytest.approx(true_area, rel=1e-4)
    assert result["how"] == "of the face, approximate: its integrals differ by 0.28 %"
    whole = measure(made, "area", "assembly:wedge")
    assert whole["exact"] is False
    # Of all the part's area that doubt is less: it leaves about two digits.
    assert whole["how"] == "surface of the part, approximate, good to about 2 significant digits"
    described = queries.describe(made, side)
    assert described["areaExact"] is False
    assert described["descriptor"] == f"extrusion, ≈ {number(result['value'])} mm²"
    assert queries.describe(made, "assembly:wedge")["areaExact"] is False


def test_areas_of_flat_and_round_faces_are_exact_and_of_a_turned_spline_approximate():
    import numpy as np
    from build123d import Axis, Box, Cone, Cylinder, Edge, Face, Sphere, Torus, Vector, Wire, revolve

    profile = Edge.make_spline([Vector(5, 0, 0), Vector(9, 0, 6), Vector(4, 0, 12), Vector(7, 0, 20)])
    closing = [
        Edge.make_line(profile @ 1, (0, 0, 20)),
        Edge.make_line((0, 0, 20), (0, 0, 0)),
        Edge.make_line((0, 0, 0), profile @ 0),
    ]
    made = {
        "assembly:box": Box(10, 20, 30),
        "assembly:ball": Sphere(7),
        "assembly:bush": Cylinder(10, 20) - Cylinder(4, 20),
        "assembly:vase": revolve(Face(Wire([profile, *closing])), Axis.Z),
        "assembly:cone": Cone(6, 2, 9),
        "assembly:ring": Torus(20, 3),
    }
    # Pappus: a curve turned about an axis sweeps its length times the way its centre goes.
    points = np.array([tuple(profile.position_at(t)) for t in np.linspace(0, 1, 20001)])
    steps = np.linalg.norm(np.diff(points, axis=0), axis=1)
    swept = float(2 * math.pi * np.sum(steps * (points[1:, 0] + points[:-1, 0]) / 2))
    expected = {
        "assembly:box": 2 * (200 + 300 + 600),
        "assembly:ball": 4 * math.pi * 49,
        "assembly:bush": 2 * math.pi * (100 - 16) + 2 * math.pi * 14 * 20,
        "assembly:cone": math.pi * (36 + 4) + math.pi * (6 + 2) * math.hypot(9, 4),
        "assembly:ring": 4 * math.pi**2 * 20 * 3,
    }
    for key, area in expected.items():
        result = measure(made, "area", key)
        assert (result["value"], result["exact"]) == (pytest.approx(area, rel=1e-9), True), key
        assert result["how"] == "surface of the part"
    # A spline turned about an axis is none of those: right to a millionth here, and not claimed.
    [turned] = refs(made, "assembly:vase", "F", "revolution")
    for target, area in ((turned, swept), ("assembly:vase", swept + math.pi * 25 + math.pi * 49)):
        result = measure(made, "area", target)
        assert (result["value"], result["exact"]) == (pytest.approx(area, rel=1e-6), False)
        assert 2 <= said_digits(result["how"]) <= 6


def test_a_density_too_large_for_a_float_is_refused(shapes):
    assert refused(shapes, "mass", PLATE, density=10**400) == (
        "bad_request",
        "density is a positive number, in g/cm³",
    )


@pytest.mark.parametrize("turned", [(0, 0, 0), (45, 0, 0), (30, 40, 50)])
def test_a_point_is_never_taken_further_off_a_face_than_half_the_wall_found(turned):
    import numpy as np
    from build123d import Box, Pos, Rot

    sheet = Rot(*turned) * Box(2000, 2000, 1)
    made = {"assembly:sheet": sheet}
    # Drawn 1.3 mm coarse, but 1 mm thick, however it is turned: a point on one side is
    # not on the other.
    up = np.array(tuple((Rot(*turned) * Pos(0, 0, 1)).position))
    [top] = [r for r in refs(made, "assembly:sheet", "F", "plane") if _at(made, r, up * 0.5)]
    [bottom] = [r for r in refs(made, "assembly:sheet", "F", "plane") if _at(made, r, up * -0.5)]
    assert refused(made, "thickness", {"ref": top, "point": list(up * -0.5)}) == (
        "bad_request",
        f"the point is 1 mm from {top}: give a point on the face",
    )
    # Half the wall is the most (it was a quarter, and 0.3 mm off was refused): 0.6 mm
    # off is nearer the other side, 0.3 mm is not.
    assert refused(made, "thickness", {"ref": top, "point": list(up * -0.1)}) == (
        "bad_request",
        f"the point is 0.6 mm from {top}: give a point on the face",
    )
    inside = measure(made, "thickness", {"ref": top, "point": list(up * 0.2)})
    assert (inside["value"], inside["moved"]) == (pytest.approx(1), pytest.approx(0.3))
    near = measure(made, "thickness", {"ref": bottom, "point": list(up * -0.7)})
    assert (near["value"], near["moved"]) == (pytest.approx(1), pytest.approx(0.2))
    # Further than the mesh is off the part, a point is refused whatever the wall.
    thick = {"assembly:slab": Box(2000, 2000, 400)}
    [top] = refs(thick, "assembly:slab", "F", "plane, normal +Z")
    assert measure(thick, "thickness", {"ref": top, "point": [0, 0, 202]})["moved"] == pytest.approx(2)
    assert refused(thick, "thickness", {"ref": top, "point": [0, 0, 203]})[0] == "bad_request"


@pytest.mark.parametrize("radius, wall", [(200, 0.5), (300, 0.6)])
def test_a_thin_round_wall_is_measured_from_any_point_picked_on_its_mesh(radius, wall):
    import numpy as np
    from build123d import Cylinder

    from torno_kernel import tess

    kept: dict = {}
    _, _, made = build_scene(
        {"assembly": {"shell": Cylinder(radius, 100) - Cylinder(radius - wall, 100)}}, "shell.py", kept
    )
    [outer] = refs(made, "assembly:shell", "F", f"cylinder, radius {radius},")
    vertices, triangles = tess.mesh_of(made["assembly:shell"])
    centres = vertices[triangles].mean(axis=1)
    off_axis = np.hypot(centres[:, 0], centres[:, 1])
    # The middles of the triangles of the outer face: where a click on the mesh lands,
    # up to 0.13 mm under the face of the 200 mm one, a quarter of its wall and more.
    picks = centres[(off_axis > radius - wall / 2) & (np.abs(centres[:, 2]) < 49)]
    assert len(picks) > 50
    sag = radius - np.hypot(picks[:, 0], picks[:, 1])
    assert wall / 4 < sag.max() < wall / 2
    deepest = picks[np.argsort(sag)[-5:]]
    for pick in [*picks[:: len(picks) // 40], *deepest]:
        args = {"kind": "thickness", "a": {"ref": outer, "point": pick.tolist()}}
        result = queries.run(made, "measure", args, kept)
        assert result["value"] == pytest.approx(wall, abs=1e-9)
        assert result["moved"] == pytest.approx(radius - math.hypot(pick[0], pick[1]), abs=1e-9)
    # A point on the other side of the wall has moved all of it, and is not on this face.
    across = {"kind": "thickness", "a": {"ref": outer, "point": [radius - wall, 0, 0]}}
    with pytest.raises(queries.QueryError) as e:
        queries.run(made, "measure", across, kept)
    assert (e.value.kind, e.value.message) == (
        "bad_request",
        f"the point is {number(wall)} mm from {outer}: give a point on the face",
    )


def _at(made, ref: str, point) -> bool:
    """Whether the centre of the face ``ref`` names is at ``point``."""
    return queries.describe(made, ref)["center"] == pytest.approx(list(point), abs=1e-6)


def test_a_wall_thinner_than_the_band_is_still_measured_from_a_point_a_hair_off_it():
    from build123d import Box

    made = {"assembly:foil": Box(20, 20, 0.1)}
    [top] = refs(made, "assembly:foil", "F", "plane, normal +Z")
    result = measure(made, "thickness", {"ref": top, "point": [0, 0, 0.09]})
    assert (result["value"], result["moved"]) == (pytest.approx(0.1), pytest.approx(0.04))


def test_the_band_is_of_the_mesh_the_build_drew_not_of_one_worked_out_after_it():
    from build123d import Torus

    from torno_kernel import tess

    ring = Torus(200, 30)
    kept: dict = {}
    build_scene({"assembly": {"ring": ring}}, "ring.py", kept)
    # (460 + 460 + 60) / 300 × 0.1, of the box the part was meshed by: once it carries a
    # mesh, that box is another, and the deflection worked out of it too.
    assert kept[("deflection", "assembly:ring")] == pytest.approx(0.327, abs=0.03)
    drawn = kept[("deflection", "assembly:ring")]
    made = {"assembly:ring": ring}
    off = 1.5 * drawn - 0.005
    result = queries.run(
        made, "measure", {"kind": "thickness", "a": {"ref": "assembly:ring/F0", "point": [230 + off, 0, 0]}}, kept
    )
    assert (result["value"], result["moved"]) == (pytest.approx(60), pytest.approx(off))
    assert kept[("deflection", "assembly:ring")] == drawn
    # Without what the build kept, the band is worked out of the part as it is now.
    assert tess.deflection(ring) == pytest.approx(drawn, abs=0.05)


def test_a_build_keeps_the_volume_of_each_part_and_no_query_measures_it_again(monkeypatch):
    from torno_kernel import extent

    kept: dict = {}
    scene, _, made = build_scene(load_scene(WS / "measures", "measures.py"), "measures.py", kept)
    [plate] = [part for part in scene["parts"] if part["key"] == PLATE]
    assert kept[("volume", PLATE)] == extent.Volume(plate["volume"], True)
    assert plate["volumeExact"] is True
    assert kept[("valid", PLATE)] is True
    monkeypatch.setattr(extent, "volume_and_centre", lambda *args, **more: pytest.fail("measured again"))
    args = {"kind": "volume", "a": {"ref": PLATE}}
    assert queries.run(made, "measure", args, kept)["value"] == plate["volume"]
    mass = queries.run(made, "measure", {"kind": "mass", "a": {"ref": PLATE}, "density": 1}, kept)
    assert mass["volume"] == plate["volume"]
    assert queries.run(made, "describe", {"ref": PLATE}, kept)["volume"] == plate["volume"]


def test_what_is_measured_of_a_whole_part_is_measured_once_for_all_its_queries(shapes, monkeypatch):
    from torno_kernel import extent

    counted = {"area": 0, "volume": 0, "box": 0}
    area, volume, box = extent.area, extent.volume, extent.box

    def counting(what, work):
        def count(*args):
            counted[what] += 1
            return work(*args)

        return count

    monkeypatch.setattr(extent, "area", counting("area", area))
    # `describe` takes the area of a part from one integral a face, which of a part of exact faces is its area.
    monkeypatch.setattr(extent, "area_of_all_at_a_glance", counting("area", extent.area_of_all_at_a_glance))
    monkeypatch.setattr(extent, "volume", counting("volume", volume))
    monkeypatch.setattr(extent, "box", counting("box", box))
    kept: dict = {}
    asked = [
        ("describe", {"ref": PLATE}),
        ("measure", {"kind": "bbox", "a": {"ref": PLATE}}),
        ("measure", {"kind": "volume", "a": {"ref": PLATE}}),
        ("measure", {"kind": "area", "a": {"ref": PLATE}}),
        ("measure", {"kind": "mass", "a": {"ref": PLATE}}),
    ]
    first = [queries.run(shapes, name, args, kept) for name, args in asked]
    assert counted == {"area": 1, "volume": 1, "box": 1}
    assert [queries.run(shapes, name, args, kept) for name, args in asked] == first
    assert counted == {"area": 1, "volume": 1, "box": 1}
    # They are one part's numbers, whichever query says them.
    described, bbox, volume, area, mass = first
    assert described["bbox"] == {"min": bbox["min"], "max": bbox["max"]}
    assert described["bboxExact"] is bbox["exact"] is True
    assert (described["volume"], described["area"]) == (volume["value"], area["value"])
    assert mass["volume"] == volume["value"]
    # With nowhere to keep them, as before: each is worked out when asked.
    assert [queries.run(shapes, name, args) for name, args in asked] == first
    assert counted == {"area": 3, "volume": 4, "box": 3}
    # A face is measured each time: it is quick, and a part has thousands.
    face = {"kind": "area", "a": {"ref": f"{PLATE}/F0"}}
    queries.run(shapes, "measure", face, kept)
    queries.run(shapes, "measure", face, kept)
    assert counted["area"] == 5


def test_the_band_follows_the_mesh_the_part_is_drawn_with():
    from build123d import Box, Rot

    from torno_kernel import tess

    # ocp-tessellate rounds each side of the box to three digits, and the sum again.
    assert tess.deflection(Box(100.4, 100.4, 100.4)) == pytest.approx(0.1)
    # Turned, the rod is drawn as finely as it is lying straight: its box is its own.
    straight = tess.deflection(Box(3000, 10, 10))
    assert tess.deflection(Rot(0, 0, 45) * Box(3000, 10, 10)) == pytest.approx(straight)
    assert straight == pytest.approx(1.01, abs=0.01)
