"""``check``, in-process: overlap, clearance and whether a part's mesh is closed."""

import math
from pathlib import Path

import numpy as np
import pytest

from torno_kernel import checks, queries
from torno_kernel.loader import load_scene
from torno_kernel.tess import build_scene

WS = Path(__file__).parent / "fixtures" / "ws"


def boxes(at) -> dict:
    """A 20 × 20 × 10 box at the origin and another with its centre at ``at``."""
    from build123d import Box, Pos

    return {"assembly:a": Box(20, 20, 10), "assembly:b": Pos(*at) * Box(20, 20, 10)}


def check(shapes, kind: str, a: str, b: str | None = None, layout="assembly", kept=None) -> dict:
    args = {"kind": kind, "layout": layout, "a": a}
    if b is not None:
        args["b"] = b
    return queries.run(shapes, "check", args, {} if kept is None else kept)


def refused(shapes, args) -> tuple[str, str]:
    with pytest.raises(queries.QueryError) as e:
        queries.run(shapes, "check", args, {})
    return e.value.kind, e.value.message


# Overlap


def test_overlap_is_the_volume_the_two_share_and_where():
    result = check(boxes([10, 10, 5]), "overlap", "a", "b")
    assert result == {
        "volume": pytest.approx(500),
        "bbox": {"min": pytest.approx([0, 0, 0], abs=1e-9), "max": pytest.approx([10, 10, 5])},
    }


def test_parts_that_are_apart_or_only_touch_share_nothing():
    assert check(boxes([23, 0, 0]), "overlap", "a", "b") == {"volume": 0, "bbox": None}
    assert check(boxes([20, 0, 0]), "overlap", "a", "b") == {"volume": 0, "bbox": None}
    # Boxes around them overlap; they do not.
    from build123d import Box, Pos, Sphere

    near = {"assembly:a": Box(10, 10, 10), "assembly:b": Pos(9, 9, 9) * Sphere(5)}
    assert check(near, "overlap", "a", "b") == {"volume": 0, "bbox": None}


def test_a_part_inside_another_overlaps_by_its_whole_volume():
    from build123d import Box

    nested = {"assembly:a": Box(20, 20, 20), "assembly:b": Box(4, 4, 4)}
    result = check(nested, "overlap", "b", "a")
    assert result["volume"] == pytest.approx(64)
    assert result["bbox"] == {"min": pytest.approx([-2, -2, -2]), "max": pytest.approx([2, 2, 2])}


# Clearance


def test_clearance_between_parts_that_are_apart_is_the_gap_with_its_points():
    result = check(boxes([23, 0, 0]), "clearance", "a", "b")
    assert result == {
        "distance": pytest.approx(3),
        "points": [pytest.approx(result["points"][0]), pytest.approx(result["points"][1])],
        "overlapping": False,
        "how": "minimum",
    }
    on_a, on_b = result["points"]
    assert (on_a[0], on_b[0]) == (pytest.approx(10), pytest.approx(13))
    assert on_a[1:] == pytest.approx(on_b[1:])


def test_touching_parts_have_no_clearance_and_do_not_overlap():
    result = check(boxes([20, 0, 0]), "clearance", "a", "b")
    assert (result["distance"], result["overlapping"]) == (0, False)
    assert result["points"][0] == pytest.approx(result["points"][1])
    assert result["points"][0][0] == pytest.approx(10)


def test_overlapping_parts_have_no_clearance_and_say_so():
    result = check(boxes([10, 10, 5]), "clearance", "a", "b")
    assert (result["distance"], result["overlapping"]) == (0, True)
    from build123d import Box

    nested = {"assembly:a": Box(20, 20, 20), "assembly:b": Box(4, 4, 4)}
    inside = check(nested, "clearance", "a", "b")
    assert (inside["distance"], inside["overlapping"]) == (0, True)


def test_the_bracket_in_each_layout():
    _, _, bracket = build_scene(load_scene(WS / "bracket", "bracket.py"), "bracket.py")
    standing = check(bracket, "clearance", "post", "base")
    assert (standing["distance"], standing["overlapping"]) == (0, False)
    # For printing the post lies beside the base, its axis 1.5 mm above the base's top edge.
    lying = check(bracket, "clearance", "post", "base", layout="print")
    assert lying["distance"] == pytest.approx(math.hypot(60 - 20, 4 - 2.5) - 4)
    assert lying["overlapping"] is False


def test_what_the_two_share_is_worked_out_once_for_overlap_and_clearance():
    shapes = boxes([10, 10, 5])
    kept: dict = {}
    first = check(shapes, "overlap", "a", "b", kept=kept)
    held = dict(kept)
    assert len(held) == 1
    assert check(shapes, "overlap", "b", "a", kept=kept) == first
    assert check(shapes, "clearance", "a", "b", kept=kept)["overlapping"] is True
    assert kept == held and all(kept[k] is held[k] for k in held)


# Mesh


def test_the_mesh_of_a_closed_box_is_watertight():
    from build123d import Box

    assert check({"assembly:a": Box(10, 10, 10)}, "mesh", "a") == {
        "watertight": True,
        "openEdges": 0,
        "where": [],
        "triangles": 12,
    }


def test_faces_that_share_no_vertex_of_the_mesh_are_welded():
    _, _, shapes = build_scene(load_scene(WS / "measures", "measures.py"), "measures.py")
    result = check(shapes, "mesh", "plate")
    assert (result["watertight"], result["openEdges"], result["where"]) == (True, 0, [])
    assert result["triangles"] > 100


def test_the_mesh_of_a_box_without_its_top_has_four_open_edges_and_says_where():
    from build123d import Axis, Box, Pos, Shell

    faces = (Pos(30, 0, 0) * Box(10, 10, 10)).faces().sort_by(Axis.Z)
    result = check({"assembly:tub": Shell(faces[:-1])}, "mesh", "tub")
    assert (result["watertight"], result["openEdges"], result["triangles"]) == (False, 4, 10)
    # The middles of the four edges round the missing top, in the object frame.
    assert sorted(map(tuple, result["where"])) == [
        pytest.approx((25, 0, 5)),
        pytest.approx((30, -5, 5)),
        pytest.approx((30, 5, 5)),
        pytest.approx((35, 0, 5)),
    ]


def test_at_most_twenty_open_edges_are_located():
    from build123d import Cylinder, Shell

    # A tube without its ends: both rims are open, each of many segments.
    tube = Cylinder(10, 20).faces().filter_by(lambda f: f.geom_type.name == "CYLINDER")
    result = check({"assembly:tube": Shell(tube)}, "mesh", "tube")
    assert result["watertight"] is False
    assert result["openEdges"] > 20
    assert len(result["where"]) == 20
    assert all(math.hypot(x, y) == pytest.approx(10, abs=0.11) for x, y, _ in result["where"])
    assert all(abs(z) == pytest.approx(10) for _, _, z in result["where"])


def tetrahedron(apex_again) -> tuple[np.ndarray, np.ndarray]:
    """Four triangles round four corners, one of them using a fifth vertex for the apex."""
    vertices = np.array([[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10], apex_again], dtype=np.float64)
    triangles = np.array([[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 4]])
    return vertices, triangles


def test_vertices_within_a_tenth_of_a_micron_are_one():
    # What a slicer welds is closed; what it does not is open, however near.
    count, where = checks.open_edges(*tetrahedron([0, 0, 10.00002]))
    assert (count, len(where)) == (0, 0)
    count, where = checks.open_edges(*tetrahedron([0, 0, 10.002]))
    assert count == 4
    assert sorted(map(tuple, where.tolist())) == [
        pytest.approx((0, 0, 5)),
        pytest.approx((0, 0, 5.001)),
        pytest.approx((0, 5, 5)),
        pytest.approx((0, 5, 5.001)),
    ]


def test_a_triangle_that_welding_leaves_without_area_opens_nothing():
    vertices, triangles = tetrahedron([0, 0, 10])
    sliver = np.array([[0, 0, 0], [0, 0, 0.00001], [10, 0, 0]], dtype=np.float64)
    vertices = np.vstack([vertices, sliver])
    triangles = np.vstack([triangles, [[5, 6, 7]]])
    count, _ = checks.open_edges(vertices, triangles)
    assert count == 0


# What is asked


def test_unknown_kind_names_the_kinds():
    assert refused(boxes([0, 0, 0]), {"kind": "collide", "layout": "assembly", "a": "a"}) == (
        "bad_request",
        "check needs args.kind, one of overlap, clearance and mesh",
    )


@pytest.mark.parametrize(
    "args",
    [
        {"kind": "mesh"},
        {"kind": "mesh", "layout": "assembly"},
        {"kind": "mesh", "layout": 1, "a": "a"},
        {"kind": "mesh", "layout": "assembly", "a": ["a"]},
    ],
)
def test_a_check_names_its_layout_and_its_part(args):
    assert refused(boxes([0, 0, 0]), args) == (
        "bad_request",
        "check needs args.layout and args.a, the name of a part of it, both strings",
    )


@pytest.mark.parametrize("kind", ["overlap", "clearance"])
def test_overlap_and_clearance_need_another_part(kind):
    shapes = boxes([0, 0, 0])
    assert refused(shapes, {"kind": kind, "layout": "assembly", "a": "a"}) == (
        "bad_request",
        f"check {kind} needs args.b, the name of the other part",
    )
    assert refused(shapes, {"kind": kind, "layout": "assembly", "a": "a", "b": "a"}) == (
        "bad_request",
        f"check {kind} is of two parts: a and b are both 'a'",
    )


def test_a_layout_or_a_part_that_is_not_there_is_a_bad_ref_naming_those_that_are():
    shapes = boxes([0, 0, 0])
    assert refused(shapes, {"kind": "mesh", "layout": "print", "a": "a"}) == (
        "bad_ref",
        "no layout 'print'; the layouts are assembly",
    )
    assert refused(shapes, {"kind": "overlap", "layout": "assembly", "a": "a", "b": "lid"}) == (
        "bad_ref",
        "no part 'lid' in assembly; its parts are a, b",
    )


# Parts of several solids, and parts that are not solids


@pytest.mark.parametrize("far_first", [True, False])
def test_clearance_agrees_with_overlap_when_a_part_has_several_solids(far_first):
    from build123d import Box, Compound, Pos

    pieces = [Pos(40, 0, 0) * Box(4, 4, 4), Box(2, 2, 2)]  # one far off, one at the centre of a
    several = Compound(pieces if far_first else pieces[::-1])
    shapes = {"assembly:a": Box(20, 20, 20), "assembly:b": several}
    for one, other in (("a", "b"), ("b", "a")):
        assert check(shapes, "overlap", one, other)["volume"] == pytest.approx(8)
        result = check(shapes, "clearance", one, other)
        assert (result["distance"], result["overlapping"], result["how"]) == (
            0,
            True,
            "the parts overlap",
        )
        # Somewhere in what they share.
        assert result["points"][0] == result["points"][1]
        assert all(abs(c) <= 1 for c in result["points"][0])


def tub_and_box() -> dict:
    from build123d import Axis, Box, Pos, Shell

    tub = Shell(Box(10, 10, 10).faces().sort_by(Axis.Z)[:-1])
    return {
        "assembly:tub": tub,
        "assembly:box": Pos(2, 0, 0) * Box(10, 10, 10),
        "assembly:far": Pos(20, 0, 0) * Box(10, 10, 10),
    }


def test_overlap_of_a_part_that_is_not_a_solid_is_refused():
    shapes = tub_and_box()
    for a, b in (("tub", "box"), ("box", "tub")):
        assert refused(shapes, {"kind": "overlap", "layout": "assembly", "a": a, "b": b}) == (
            "bad_request",
            "tub is not a solid: it is a shell",
        )


def test_clearance_of_a_part_that_is_not_a_solid_is_its_distance_and_no_verdict():
    shapes = tub_and_box()
    apart = check(shapes, "clearance", "tub", "far")
    assert (apart["distance"], apart["overlapping"]) == (pytest.approx(10), None)
    assert apart["how"] == "minimum; tub is not a solid, so whether the parts overlap is not told"
    crossing = check(shapes, "clearance", "box", "tub")
    assert (crossing["distance"], crossing["overlapping"]) == (0, None)


def test_the_mesh_of_a_part_of_several_solids_is_checked_whole():
    from build123d import Box, Compound, Pos

    two = {"assembly:two": Compound([Box(10, 10, 10), Pos(30, 0, 0) * Box(10, 10, 10)])}
    result = check(two, "mesh", "two")
    assert (result["watertight"], result["triangles"]) == (True, 24)


# Welding across the lines of a grid


@pytest.mark.parametrize("line", [0.0, 0.00005, 0.0001, 0.00015, 0.0002, 0.0003, 7.00005])
@pytest.mark.parametrize("axis", [0, 1, 2])
def test_vertices_a_millionth_apart_are_one_wherever_they_lie(line, axis):
    # Two triangles side by side; the second has its own vertices for the edge they
    # share, a millionth of a millimetre off, on the other side of ``line``.
    def at(u, v, w):
        point = [u, v, w]
        return point[-axis:] + point[:-axis] if axis else point

    low, high = line - 5e-7, line + 5e-7
    vertices = np.array(
        [at(low, 0, 0), at(low, 10, 0), at(-10, 5, 0), at(high, 0, 0), at(high, 10, 0), at(10, 5, 0)]
    )
    triangles = np.array([[0, 1, 2], [3, 5, 4]])
    count, _ = checks.open_edges(vertices, triangles)
    assert count == 4


def test_vertices_are_one_within_a_tenth_of_a_micron_in_any_direction():
    rng = np.random.default_rng(1)
    for _ in range(200):
        base = rng.uniform(-1, 1, 3)
        step = rng.normal(size=3)
        near = base + step / np.linalg.norm(step) * 0.99e-4
        vertices = np.array(
            [base, base + [0, 10, 0], base + [-10, 5, 0], near, near + [0, 10, 0], near + [10, 5, 0]]
        )
        count, _ = checks.open_edges(vertices, np.array([[0, 1, 2], [3, 5, 4]]))
        assert count == 4
