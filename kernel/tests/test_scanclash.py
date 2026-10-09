"""The scan queries, in-process: what is inside a part, how far a part is from a scan, where a plane cuts one."""

import math
import re
from pathlib import Path

import numpy as np
import pytest
import scanfix

from torno_kernel import queries, scanclash, scanfile
from torno_kernel.loader import load_scene
from torno_kernel.tess import build_scene, mesh_of

WS = Path(__file__).parent / "fixtures" / "ws"
IDENTITY = {"t": [0, 0, 0], "q": [0, 0, 0, 1], "s": 1}
# A sheet of 30 × 30 vertices a millimetre apart, at -14.5 to 14.5: none on a whole number.
SHEET = scanfix.grid(30)


def scan_of(tmp_path, mesh=SHEET, name="S1", transform=IDENTITY, **more) -> dict:
    path = tmp_path / f"{name}.bin"
    scanfile.write_bin(path, *mesh)
    return {"id": name, "path": str(path), "transform": transform, **more}


def box_part() -> dict:
    """A 20 × 20 × 10 box round the origin."""
    from build123d import Box

    return {"assembly:a": Box(20, 20, 10)}


def ask(shapes, name: str, kept=None, **args) -> dict:
    return queries.run(shapes, name, {"layout": "assembly", "part": "a", **args}, {} if kept is None else kept)


def refused(shapes, name: str, **args) -> tuple[str, str]:
    with pytest.raises(queries.QueryError) as e:
        ask(shapes, name, **args)
    return e.value.kind, e.value.message


def face_at(shapes, point) -> str:
    return queries.run(shapes, "nearest", {"layout": "assembly", "anchors": [{"part": "a", "point": point}]}, {})["anchors"][0]["ref"]


# Inside or outside


def test_a_point_is_inside_when_its_ray_crosses_the_mesh_an_odd_number_of_times():
    vertices, triangles = scanfix.box((20, 20, 10))
    points = [[0.3, 0.2, 0], [11, 0, 0], [0.3, 0.2, 6], [0.3, 0.2, -6], [9.9, 9.9, 4.9], [-30, 0.2, 0.1]]
    assert scanclash.inside(points, vertices, triangles).tolist() == [True, False, False, False, True, False]


def test_a_ray_through_an_edge_or_a_corner_is_asked_again_another_way():
    vertices, triangles = scanfix.box((20, 20, 10))
    # Straight up from each of these the ray meets the diagonal the top is split by, or a corner of the box.
    # From the very middle the rays along X and along Y meet the diagonals of the sides too.
    points = [[0, 0, 0], [0, 0, -20], [0, 0, 20], [5, 5, 0], [10, 10, -20], [-5, -5, 4]]
    assert scanclash.inside(points, vertices, triangles).tolist() == [True, False, False, True, False, True]


def test_it_agrees_with_the_solid_itself_but_within_the_mesh_of_its_surface():
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN

    _, _, shapes = build_scene(load_scene(WS / "hollow", "hollow.py"), "hollow.py")
    tub = shapes["assembly:tub"]
    vertices, triangles = mesh_of(tub)
    rng = np.random.default_rng(7)
    anywhere = rng.uniform(vertices.min(axis=0) - 2, vertices.max(axis=0) + 2, size=(300, 3))
    near = vertices[rng.integers(0, len(vertices), 300)] + rng.normal(0, 0.3, size=(300, 3))
    points = np.concatenate([anywhere, near])
    mine = scanclash.inside(points, vertices, triangles)
    classifier = BRepClass3d_SolidClassifier(tub.wrapped)
    theirs = []
    for point in points:
        classifier.Perform(gp_Pnt(*map(float, point)), 1e-7)
        theirs.append(classifier.State() == TopAbs_IN)
    wrong = np.flatnonzero(mine != np.array(theirs))
    assert 20 < mine.sum() < 580
    # The post is round and its mesh is not: a point between the two is on one side of each.
    held = {}
    for point in points[wrong]:
        [found] = queries.nearest(shapes, "assembly", [{"part": "tub", "point": [float(c) for c in point]}], held)
        assert found["distance"] < 0.02


def test_points_are_clustered_by_the_cells_that_touch_the_largest_first():
    few = [[100, 100, 100], [102, 101, 100]]
    many = [[x, 0, 0] for x in range(0, 40, 3)]
    alone = [[0, 60, 0]]
    labels = scanclash.clusters(np.array(few + many + alone, dtype=float))
    assert labels.tolist() == [1, 1, *[0] * 14, 2]
    assert scanclash.clusters(np.zeros((0, 3))).tolist() == []


def test_how_far_a_point_is_from_a_triangle_over_it_beside_it_and_past_a_corner():
    a, b, c = np.array([[0.0, 0, 0]] * 4), np.array([[10.0, 0, 0]] * 4), np.array([[0.0, 10, 0]] * 4)
    points = np.array([[2.0, 2, 3], [5, -4, 0], [-3, -4, 0], [8, 8, 0]])
    distance, nearest = scanclash.to_triangles(points, a, b, c)
    assert distance == pytest.approx([3, 4, 5, math.sqrt(18)])
    assert nearest == pytest.approx(np.array([[2, 2, 0], [5, 0, 0], [0, 0, 0], [5, 5, 0]]))
    # A triangle with no area is a point.
    flat = scanclash.to_triangles(np.array([[1.0, 0, 0]]), np.zeros((1, 3)), np.zeros((1, 3)), np.zeros((1, 3)))
    assert flat[0] == pytest.approx([1])


def test_a_mesh_is_sampled_no_more_than_the_spacing_apart():
    vertices = np.array([[0.0, 0, 0], [40, 0, 0], [0, 0.5, 0], [0, 30, 7]])
    triangles = np.array([[0, 1, 2], [0, 1, 3]])
    points, owner = scanclash.sampled(vertices, triangles, 1.0)
    assert set(owner.tolist()) == {0, 1}
    # The sliver has a row or two of points along it, not as many as a triangle 40 mm a side.
    assert (owner == 0).sum() < 130 and (owner == 1).sum() > 500
    rng = np.random.default_rng(3)
    s, t = rng.uniform(0, 1, 500), rng.uniform(0, 1, 500)
    over = s + t > 1
    s[over], t[over] = 1 - s[over], 1 - t[over]
    anywhere = vertices[0] * (1 - s - t)[:, None] + vertices[1] * s[:, None] + vertices[3] * t[:, None]
    gap = np.linalg.norm(anywhere[:, None, :] - points[None, owner == 1, :], axis=2).min(axis=1)
    assert gap.max() <= 1.0


# scan_clash


def test_a_sheet_through_a_box_has_its_points_inside_counted_and_the_deepest_taken_on_the_solid(tmp_path):
    said = ask(box_part(), "scan_clash", scan=scan_of(tmp_path))
    assert said["part"] == "a" and said["scan"] == "S1" and said["exact"] is False
    assert said["points"] == {"scan": 900, "candidates": 900, "checked": 900, "ignored": 0, "touching": 0}
    assert said["inside"]["count"] == 400 and said["inside"]["clustersOmitted"] == 0 and said["inside"]["crossingAtLeast"] is False
    # Round the 400, the triangles with a corner at 9.5 and one at 10.5: two in each of the 19 cells along a
    # side, and at the four corners two, two, one and one, by which way the cell is split.
    assert said["inside"]["crossing"] == 4 * 19 * 2 + 6
    [cluster] = said["inside"]["clusters"]
    assert cluster["count"] == 400 and cluster["centre"] == pytest.approx([0, 0, 0], abs=1e-9)
    assert cluster["bbox"] == {"min": [-9.5, -9.5, 0], "max": [9.5, 9.5, 0]}
    # In the middle of a box 10 thick every point is 5 from its top and its bottom: exactly, by the B-rep.
    assert said["deepest"]["depth"] == pytest.approx(5, abs=1e-9) and cluster["depth"] == pytest.approx(5, abs=1e-9)
    assert re.fullmatch(r"a/F\d", said["deepest"]["under"]) and said["deepest"]["at"][2] == 0
    assert said["nearest"]["distance"] == pytest.approx(0.5, abs=1e-9)
    assert max(abs(c) for c in said["nearest"]["at"]) == 10.5 and max(abs(c) for c in said["nearest"]["on"]) == pytest.approx(10)
    assert said["sampling"] == {"every": 1, "cell": 5.0, "surface": 1.0, "deflection": 0.1, "retaken": said["sampling"]["retaken"], "retakesFailed": 0, "partial": False, "seconds": said["sampling"]["seconds"]}
    assert 1 <= said["sampling"]["retaken"] <= scanclash.MAX_RETAKEN
    # Where the sheet goes through the box: round its four sides, in one ring.
    # Of its 1,682 triangles, the 21 × 21 cells whose boxes meet the box's: no other can go through it.
    assert said["crossings"]["triangles"] == {"candidates": 882, "checked": 882, "every": 1}
    [ring] = said["crossings"]["clusters"]
    assert ring["count"] == said["inside"]["crossing"] and said["crossings"]["clustersOmitted"] == 0
    assert ring["centre"] == pytest.approx([0, 0, 0], abs=0.2) and ring["bbox"]["max"][0] == pytest.approx(10, abs=0.5)


def test_the_scan_is_where_its_transform_puts_it(tmp_path):
    above = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, transform={"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}))
    assert above["inside"] == {"count": 0, "crossing": 0, "crossingAtLeast": False, "clusters": [], "clustersOmitted": 0} and above["deepest"] is None
    assert above["nearest"]["distance"] == pytest.approx(2, abs=1e-9) and above["nearest"]["at"][2] == 7
    # Stood on edge through the middle: 20 across, and the ten rows from -4.5 to 4.5 high.
    upright = {"t": [0, 0, 0], "q": [math.sin(math.pi / 4), 0, 0, math.cos(math.pi / 4)], "s": 1}
    assert ask(box_part(), "scan_clash", scan=scan_of(tmp_path, transform=upright))["inside"]["count"] == 200
    # At half its size every vertex is within the box.
    half = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, transform={"t": [0, 0, 0], "q": [0, 0, 0, 2], "s": 0.5}))
    assert half["inside"]["count"] == 900 and half["nearest"] is None


def test_a_region_is_left_out_or_is_all_that_is_asked(tmp_path):
    vertices, triangles = SHEET
    # The triangles whose first corner is left of the middle.
    left = vertices[triangles[:, 0], 0] < 0
    scanfile.write_mask(tmp_path / "M7.mask", left)
    without = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, ignore=[str(tmp_path / "M7.mask")]))
    only = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, only=str(tmp_path / "M7.mask")))
    # The column of vertices at 0.5 is a corner of triangles on both sides.
    assert without["inside"]["count"] == 9 * 20 and without["points"]["ignored"] == 16 * 30
    assert only["inside"]["count"] == 11 * 20 and only["points"]["ignored"] == 14 * 30
    scanfile.write_mask(tmp_path / "M8.mask", np.ones(5, dtype=bool))
    kind, message = refused(box_part(), "scan_clash", scan=scan_of(tmp_path, ignore=[str(tmp_path / "M8.mask")]))
    assert kind == "bad_request" and "a region of S1 could not be read" in message and "5 triangles, not 1682" in message


def test_more_points_than_it_can_test_are_thinned_and_a_query_out_of_time_says_what_it_did(tmp_path, monkeypatch):
    monkeypatch.setattr(scanclash, "MAX_CANDIDATES", 100)
    thinned = ask(box_part(), "scan_clash", scan=scan_of(tmp_path))
    assert thinned["points"] == {"scan": 900, "candidates": 900, "checked": 100, "ignored": 0, "touching": 0}
    assert thinned["sampling"]["every"] == 9 and 30 <= thinned["inside"]["count"] <= 60
    # Of the 882 triangles that could, every 9th had its edges tried: what crosses is no fewer than was found, and is said so.
    assert thinned["crossings"]["triangles"] == {"candidates": 882, "checked": 98, "every": 9}
    assert thinned["inside"]["crossingAtLeast"] is True and 1 <= thinned["inside"]["crossing"] < 158
    assert "at least" in thinned["how"] and "every 9th" in thinned["how"]
    monkeypatch.setattr(scanclash, "BUDGET", -1.0)
    late = ask(box_part(), "scan_clash", scan=scan_of(tmp_path))
    assert late["sampling"]["partial"] is True and late["points"]["checked"] == 0 and late["inside"]["count"] == 0
    assert late["inside"]["crossingAtLeast"] is True and late["crossings"]["triangles"]["checked"] == 0 and late["sampling"]["retaken"] == 0
    assert "the time ran out" in late["how"]


def test_what_has_no_inside_and_what_is_no_scan_are_refused(tmp_path):
    from build123d import Axis, Box

    shell = {"assembly:a": Box(20, 20, 10).faces().sort_by(Axis.Z)[-1]}
    assert refused(shell, "scan_clash", scan=scan_of(tmp_path)) == ("bad_request", "a is not a solid: nothing is inside it; scan_deviation says how far it is from the scan")
    kind, message = refused(box_part(), "scan_clash", scan={"id": "S1", "path": str(tmp_path / "gone.bin"), "transform": IDENTITY})
    assert kind == "bad_request" and message.startswith("the mesh of S1 could not be read: ")
    kind, message = refused(box_part(), "scan_clash", scan=scan_of(tmp_path, transform={"t": [0, 0, 0], "q": [0, 0, 0, 0], "s": 1}))
    assert (kind, message) == ("bad_request", "the transform of S1 is not one: t is three numbers, q four that are not all zero, s more than zero")
    assert refused(box_part(), "scan_clash", scan=scan_of(tmp_path), margin=500) == ("bad_request", "margin is a number from 0 to 50")
    assert refused(box_part(), "scan_clash")[1] == "a scan query needs args.scan, with id and path, both strings, and transform"
    assert refused(box_part(), "scan_clash", part="b", scan=scan_of(tmp_path))[0] == "bad_ref"


def test_what_was_worked_out_of_a_part_and_of_a_scan_is_kept_for_the_next_query(tmp_path):
    shapes, kept = box_part(), {}
    first = ask(shapes, "scan_clash", kept, scan=scan_of(tmp_path))
    read = kept["scan"][1]
    again = ask(shapes, "scan_clash", kept, scan=scan_of(tmp_path, name="S1"))
    assert again["inside"] == first["inside"]
    assert ("scan surface", "assembly:a") in kept and ("scan grids", "assembly:a") in kept
    # The same file asked of with another transform is read again: it stands elsewhere.
    ask(shapes, "scan_clash", kept, scan={**scan_of(tmp_path), "transform": {"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}})
    assert kept["scan"][1] is not read


# scan_deviation


def test_a_face_of_a_part_is_so_far_from_the_scan_and_on_which_side(tmp_path):
    shapes = box_part()
    top = face_at(shapes, [0, 0, 5])
    above = {"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}
    said = ask(shapes, "scan_deviation", scan=scan_of(tmp_path, transform=above), faces=[int(top.split("F")[1])])
    assert said["from"] == "part" and said["exact"] is False and said["beyond"] == 0 and said["compared"] == said["samples"] > 400
    assert {k: round(v, 6) for k, v in said["distance"].items()} == {"min": 2, "mean": 2, "max": 2, "rms": 2, "p50": 2, "p90": 2, "p95": 2}
    assert said["signed"] == {"min": pytest.approx(2), "mean": pytest.approx(2), "max": pytest.approx(2), "inside": 0}
    assert said["worst"]["face"] == top and said["worst"]["at"][2] == pytest.approx(5) and said["worst"]["on"][2] == pytest.approx(7)
    # The sheet at six tenths of its size, a millimetre under the top: all of it is inside the box.
    within = {"t": [0, 0, 4], "q": [0, 0, 0, 1], "s": 0.6}
    inside = ask(shapes, "scan_deviation", scan=scan_of(tmp_path, transform=within), faces=[int(top.split("F")[1])])
    assert inside["distance"]["min"] == pytest.approx(1) and inside["distance"]["max"] == pytest.approx(math.sqrt(1 + 2 * 1.3**2))
    assert inside["signed"]["max"] == pytest.approx(-1) and inside["signed"]["inside"] == inside["compared"]


def test_the_scan_is_so_far_from_the_part_and_the_furthest_point_is_taken_on_the_solid(tmp_path):
    above = {"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}
    said = ask(box_part(), "scan_deviation", scan=scan_of(tmp_path, transform=above), **{"from": "scan"})
    assert said["samples"] == 900 and said["compared"] == 900
    # Over the top the scan is 2 away; the mesh is sampled every millimetre, so the least found is that or a little more.
    assert 2 <= said["distance"]["min"] <= 2.13
    # The corner of the sheet, from the corner of the box: by the B-rep.
    assert said["worst"]["distance"] == pytest.approx(math.sqrt(4 + 4.5**2 + 4.5**2), abs=1e-9)
    assert [abs(c) for c in said["worst"]["at"]] == [14.5, 14.5, 7] and [abs(c) for c in said["worst"]["on"]] == pytest.approx([10, 10, 5])
    assert said["signed"]["inside"] == 0


def test_nothing_within_reach_is_said_as_that_and_a_part_that_is_no_solid_has_no_sides(tmp_path):
    from build123d import Axis, Box

    far = ask(box_part(), "scan_deviation", scan=scan_of(tmp_path, transform={"t": [0, 0, 100], "q": [0, 0, 0, 1], "s": 1}))
    assert far["compared"] == 0 and far["beyond"] == far["samples"] and far["distance"] is None and far["worst"] is None
    assert far["how"].endswith("nothing of the scan is within 50 mm")
    face = {"assembly:a": Box(20, 20, 10).faces().sort_by(Axis.Z)[-1]}
    said = ask(face, "scan_deviation", scan=scan_of(tmp_path, transform={"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}))
    assert said["signed"] is None and said["distance"]["max"] == pytest.approx(2)
    assert refused(box_part(), "scan_deviation", scan=scan_of(tmp_path), faces=[6]) == ("bad_ref", "faces are numbers of faces of a, which has 6: F0 to F5")
    assert refused(box_part(), "scan_deviation", scan=scan_of(tmp_path), **{"from": "both"})[0] == "bad_request"


# scan_section


def test_a_plane_cuts_a_sheet_in_one_line_told_in_the_planes_own_axes(tmp_path):
    said = queries.run(box_part(), "scan_section", {"layout": "assembly", "plane": {"origin": [0.25, 0, 0], "normal": [1, 0, 0]}, "scan": scan_of(tmp_path)}, {})
    assert said["scan"] == "S1" and said["exact"] is False and said["segments"] == 58 and said["omitted"] == 0
    # As `section` has them for this normal: x along +Y, y along +Z.
    assert said["plane"] == {"origin": [0.25, 0, 0], "normal": [1, 0, 0], "x": [0, 1, 0], "y": [0, 0, 1]}
    [line] = said["polylines"]
    assert line["closed"] is False and len(line["points"]) == 59
    along = [u for u, _ in line["points"]]
    assert sorted(along) in (along, along[::-1]) and {v for _, v in line["points"]} == {0}
    assert said["bounds"] == {"min": [-14.5, 0], "max": [14.5, 0]}


def test_a_plane_through_a_closed_scan_cuts_a_closed_line_and_one_that_misses_cuts_none(tmp_path):
    scan = scan_of(tmp_path, scanfix.box((40, 30, 5)))
    said = queries.run(box_part(), "scan_section", {"layout": "assembly", "plane": {"origin": [0, 0, 1], "normal": [0, 0, 2]}, "scan": scan}, {})
    [loop] = said["polylines"]
    assert loop["closed"] is True and len(loop["points"]) == 8
    assert said["bounds"] == {"min": [-20, -15], "max": [20, 15]} and said["plane"]["normal"] == [0, 0, 1]
    missed = queries.run(box_part(), "scan_section", {"layout": "assembly", "plane": {"origin": [0, 0, 50], "normal": [0, 0, 1]}, "scan": scan}, {})
    assert missed["polylines"] == [] and missed["bounds"] is None and missed["segments"] == 0
    with pytest.raises(queries.QueryError, match="scan_section needs args.plane"):
        queries.run(box_part(), "scan_section", {"layout": "assembly", "plane": {"origin": [0, 0, 0], "normal": [0, 0, 0]}, "scan": scan}, {})


# What the review of the first cut found


def test_a_region_painted_again_is_read_again_by_the_same_worker(tmp_path):
    shapes, kept = box_part(), {}
    mask = tmp_path / "M7.mask"
    scanfile.write_mask(mask, np.zeros(len(SHEET[1]), dtype=bool))
    scan = scan_of(tmp_path, ignore=[str(mask)])
    assert ask(shapes, "scan_clash", kept, scan=scan)["inside"]["count"] == 400
    scanfile.write_mask(mask, np.ones(len(SHEET[1]), dtype=bool))
    again = ask(shapes, "scan_clash", kept, scan=scan)
    fresh = ask(shapes, "scan_clash", {}, scan=scan)
    assert again["inside"]["count"] == 0 and again["points"]["ignored"] == 900
    assert {k: again[k] for k in ("points", "inside", "deepest", "nearest")} == {k: fresh[k] for k in ("points", "inside", "deepest", "nearest")}
    # And the mesh itself, written again where it was, as changing its unit does.
    vertices, triangles = SHEET
    scanfile.write_bin(scan["path"], vertices + [0, 0, 7], triangles)
    assert ask(shapes, "scan_clash", kept, scan={**scan, "ignore": []})["inside"]["count"] == 0


def test_the_turn_of_a_transform_is_counter_clockwise_about_its_axis_and_comes_before_the_move(tmp_path):
    # One triangle with a corner at +X: a quarter turn about +Z takes it to +Y, and then it is moved.
    mesh = (np.array([[30.0, 0, 0], [31, 0, 0], [31, 1, 0]]), np.array([[0, 1, 2]]))
    turned = {"t": [1, 2, 3], "q": [0, 0, math.sin(math.pi / 4), math.cos(math.pi / 4)], "s": 1}
    said = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, mesh, transform=turned), margin=50)
    assert said["nearest"]["at"] == pytest.approx([1, 32, 3]) and said["nearest"]["distance"] == pytest.approx(22)
    # Scaled first, turned next, moved last.
    halved = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, mesh, transform={**turned, "s": 0.5}), margin=50)
    assert halved["nearest"]["at"] == pytest.approx([1, 17, 3])


@pytest.mark.parametrize("which", ["made", "picked", "moved"])
def test_a_part_that_is_a_bare_solid_has_its_depths_like_any_other(tmp_path, which):
    from build123d import Box, Pos, Solid

    solid = {"made": lambda: Pos(-10, -10, -5) * Solid.make_box(20, 20, 10), "picked": lambda: Box(20, 20, 10).solid(), "moved": lambda: Pos(40, 0, 0) * Box(20, 20, 10).solid()}[which]()
    assert type(solid).__name__ == "Solid"
    shapes = {"assembly:a": solid}
    aside = [40, 0, 0] if which == "moved" else [0, 0, 0]
    said = ask(shapes, "scan_clash", scan=scan_of(tmp_path, transform={"t": aside, "q": [0, 0, 0, 1], "s": 1}))
    assert said["inside"]["count"] == 400 and said["sampling"]["retakesFailed"] == 0
    assert said["deepest"]["depth"] == pytest.approx(5, abs=1e-9) and said["inside"]["clusters"][0]["depth"] == pytest.approx(5, abs=1e-9)
    assert re.fullmatch(r"a/F\d", said["deepest"]["under"])
    # A millimetre under the top, at six tenths of its size: the furthest point of the scan is that far, by the B-rep.
    under = {"t": [aside[0], 0, 4], "q": [0, 0, 0, 1], "s": 0.6}
    far = ask(shapes, "scan_deviation", scan=scan_of(tmp_path, transform=under), **{"from": "scan"})
    assert far["worst"]["distance"] == pytest.approx(1, abs=1e-6) and far["worst"]["on"][2] == pytest.approx(5) and far["sampling"]["retakesFailed"] == 0


def test_a_depth_that_could_not_be_taken_on_the_solid_is_counted_and_said(tmp_path, monkeypatch):
    def fails(self, part, key, point):
        raise queries.QueryError("exception", "no nearest point")

    monkeypatch.setattr(queries._Surface, "nearest", fails)
    said = ask(box_part(), "scan_clash", scan=scan_of(tmp_path))
    assert said["inside"]["count"] == 400 and said["deepest"] is None and "depth" not in said["inside"]["clusters"][0]
    assert said["sampling"]["retakesFailed"] == said["sampling"]["retaken"] > 0
    assert f"{said['sampling']['retakesFailed']} of the points" in said["how"] and "could not be taken" in said["how"]
    far = ask(box_part(), "scan_deviation", scan=scan_of(tmp_path, transform={"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}), **{"from": "scan"})
    assert far["sampling"]["retakesFailed"] == 1 and "could not be taken" in far["how"]
    assert far["worst"]["distance"] == pytest.approx(math.sqrt(4 + 4.5**2 + 4.5**2))


def test_taking_depths_again_stops_when_the_time_is_spent_and_says_how_many_were_taken(tmp_path, monkeypatch):
    late = [0.0]
    real, taken = scanclash.time.monotonic, queries._Surface.nearest

    class Clock:
        monotonic = staticmethod(lambda: real() + late[0])

    def slow(self, part, key, point):
        late[0] = 1000.0
        return taken(self, part, key, point)

    monkeypatch.setattr(scanclash, "time", Clock)
    monkeypatch.setattr(queries._Surface, "nearest", slow)
    said = ask(box_part(), "scan_clash", scan=scan_of(tmp_path))
    assert said["inside"]["count"] == 400 and said["sampling"]["retaken"] == 1 and said["sampling"]["partial"] is True
    assert said["deepest"]["depth"] == pytest.approx(5, abs=1e-9) and "the time ran out" in said["how"]


def test_a_scan_that_passes_clean_through_a_thin_wall_crosses_it(tmp_path):
    from build123d import Box

    plate = {"assembly:a": Box(20, 20, 0.6)}
    # Stood on edge: its rows of vertices are at z = ±0.5, ±1.5, …, none within the plate's 0.6.
    upright = {"t": [0, 0, 0], "q": [math.sin(math.pi / 4), 0, 0, math.cos(math.pi / 4)], "s": 1}
    said = ask(plate, "scan_clash", scan=scan_of(tmp_path, transform=upright))
    assert said["inside"]["count"] == 0 and said["deepest"] is None
    # The row of cells across the plate: two triangles in each of the 19 within it, and two at each end.
    assert said["inside"]["crossing"] == 19 * 2 + 4 and said["inside"]["crossingAtLeast"] is False
    [where] = said["crossings"]["clusters"]
    assert where["count"] == 42 and where["centre"] == pytest.approx([0, 0, 0], abs=0.3)
    assert abs(where["bbox"]["min"][2]) <= 0.3 and abs(where["bbox"]["max"][2]) <= 0.3 and where["bbox"]["max"][0] <= 10
    assert "whether or not a vertex is inside" in said["how"]
    # Its vertices four millimetres apart across the wall, as a phone's scan has them.
    coarse = (SHEET[0] * [1, 4, 1], SHEET[1])
    assert ask(plate, "scan_clash", scan=scan_of(tmp_path, coarse, transform=upright))["inside"]["crossing"] == 42
    # Lying a millimetre clear of it, it crosses nothing.
    clear = ask(plate, "scan_clash", scan=scan_of(tmp_path, transform={"t": [0, 0, 1.3], "q": [0, 0, 0, 1], "s": 1}))
    assert clear["inside"]["crossing"] == 0 and clear["crossings"]["clusters"] == [] and clear["nearest"]["distance"] == pytest.approx(1)


def test_a_scan_lying_on_a_face_touches_it_whichever_face_it_is(tmp_path):
    # 21 vertices a side, at whole numbers from -10 to 10: all of it on the face.
    sheet = scanfix.grid(21)
    for z in (5, -5):
        said = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, sheet, transform={"t": [0, 0, z], "q": [0, 0, 0, 1], "s": 1}))
        assert said["points"]["touching"] == 441 and said["inside"]["count"] == 0 and said["inside"]["crossing"] == 0 and said["deepest"] is None
        assert said["nearest"]["distance"] == pytest.approx(0, abs=1e-9)
    # Through the middle, with its rim on the four sides: the rim touches, the rest is inside.
    middle = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, sheet))
    assert middle["points"]["touching"] == 80 and middle["inside"]["count"] == 361 and middle["inside"]["crossing"] == 0


def test_how_far_a_point_is_from_a_mesh_is_to_its_triangles_not_to_the_points_that_stand_for_it():
    vertices, triangles = scanfix.box((20, 20, 10))
    mesh = scanclash._Sampled(vertices, triangles)
    assert mesh.spacing == 1.0
    points = np.array([[0.3, 0.2, 5.3], [9.7, 0.2, 0.1], [10.4, 10.3, 0], [0, 0, 100]])
    distance, at, on, _ = mesh.nearest(points, 50)
    assert distance[:3] == pytest.approx([0.3, 0.3, 0.5]) and np.isinf(distance[3]) and on[3] == -1
    assert at[:3] == pytest.approx(np.array([[0.3, 0.2, 5], [10, 0.2, 0.1], [10, 10, 0]]))
    # A triangle longer than 512 points a side is sampled further apart, and says how far.
    long = scanclash._Sampled(np.array([[0.0, 0, 0], [2048, 0, 0], [0, 4, 0]]), np.array([[0, 1, 2]]))
    assert long.spacing == pytest.approx(4)


def test_a_scan_of_large_triangles_is_seen_between_its_vertices(tmp_path):
    shapes = box_part()
    top = int(face_at(shapes, [0, 0, 5]).split("F")[1])
    # One quad 200 mm a side, 0.3 above the top: its vertices are 140 mm from the part.
    quad = np.array([[-100.0, -100, 5.3], [100, -100, 5.3], [100, 100, 5.3], [-100, 100, 5.3]])
    two = np.array([[0, 1, 2], [0, 2, 3]])
    said = ask(shapes, "scan_deviation", scan=scan_of(tmp_path, (quad, two)), faces=[top])
    assert said["compared"] == said["samples"] > 400 and said["beyond"] == 0
    assert {k: round(v, 5) for k, v in said["distance"].items()} == {"min": 0.3, "mean": 0.3, "max": 0.3, "rms": 0.3, "p50": 0.3, "p90": 0.3, "p95": 0.3}
    assert said["signed"]["inside"] == 0 and said["worst"]["on"][2] == pytest.approx(5.3)
    # A smaller quad, and a patch with vertices of its own 10 above: the quad is still the nearer.
    patch, of_patch = scanfix.grid(3)
    both = (np.vstack([quad * [0.3, 0.3, 1], patch + [0, 0, 15]]), np.vstack([two, of_patch + 4]))
    said = ask(shapes, "scan_deviation", scan=scan_of(tmp_path, both), faces=[top])
    assert said["distance"]["min"] == pytest.approx(0.3, abs=1e-5) and said["distance"]["max"] == pytest.approx(0.3, abs=1e-5)


def test_from_the_scan_each_point_is_measured_to_the_parts_mesh_itself(tmp_path):
    # 19 vertices a side, all over the box, 0.3 above its top: every one is 0.3 from it.
    sheet = scanfix.grid(19)
    said = ask(box_part(), "scan_deviation", scan=scan_of(tmp_path, sheet, transform={"t": [0, 0, 5.3], "q": [0, 0, 0, 1], "s": 1}), **{"from": "scan"})
    assert said["compared"] == 361
    assert said["distance"]["mean"] == pytest.approx(0.3, abs=1e-5) and said["distance"]["max"] == pytest.approx(0.3, abs=1e-5)
    assert said["worst"]["distance"] == pytest.approx(0.3, abs=1e-5)
    assert "to the triangles of the part's mesh" in said["how"]


TURN = {"t": [0, 0, 0], "q": [0, 0, 0, 1], "s": 1}


@pytest.mark.parametrize(
    "transform",
    [
        {"t": [0, 0, 0, 1], "q": [0, 0, 1], "s": 1},
        [1, 2, 3],
        [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
        None,
        {**TURN, "s": 1e300},
        {**TURN, "s": float("nan")},
        {**TURN, "s": True},
        {**TURN, "q": [1e-200, 1e-200, 0, 0]},
        {**TURN, "q": [1e200, 0, 0, 1e200]},
        {**TURN, "q": [0, 0, float("inf"), 1]},
        {**TURN, "q": [0, 0, "0", 1]},
        {**TURN, "t": [1e300, 0, 0]},
        {**TURN, "t": [10**400, 0, 0]},
        {**TURN, "t": [0, 0, None]},
    ],
)
def test_a_transform_that_is_none_is_refused_in_a_sentence(tmp_path, transform):
    for name, more in (("scan_clash", {}), ("scan_deviation", {}), ("scan_section", {"plane": {"origin": [0, 0, 0], "normal": [1, 0, 0]}})):
        assert refused(box_part(), name, scan=scan_of(tmp_path, transform=transform), **more) == (
            "bad_request",
            "the transform of S1 is not one: t is three numbers, q four that are not all zero, s more than zero",
        )


def test_what_names_the_regions_of_a_scan_wrongly_is_refused_in_a_sentence(tmp_path):
    for wrong in ({"ignore": 5}, {"ignore": "M7.mask"}, {"ignore": [5]}, {"only": 5}, {"only": ["M7.mask"]}):
        assert refused(box_part(), "scan_clash", scan=scan_of(tmp_path, **wrong)) == ("bad_request", "of a scan, ignore is a list of the paths of masks and only the path of one")


def test_a_mesh_that_is_not_one_is_refused_and_never_indexed(tmp_path):
    import struct

    scan = scan_of(tmp_path)
    raw = Path(scan["path"]).read_bytes()
    lost = bytearray(raw)
    struct.pack_into("<I", lost, 64 + 12 * 900, 4_000_000_000)
    nowhere = bytearray(raw)
    struct.pack_into("<f", nowhere, 64, float("nan"))
    for bad, says in ((lost, "a triangle names vertex 4000000000"), (nowhere, "a vertex is not finite")):
        Path(scan["path"]).write_bytes(bad)
        for name, more in (("scan_clash", {}), ("scan_deviation", {}), ("scan_section", {"plane": {"origin": [0, 0, 0], "normal": [1, 0, 0]}})):
            kind, message = refused(box_part(), name, scan=scan, **more)
            assert kind == "bad_request" and message.startswith("the mesh of S1 could not be read: ") and says in message


# scan_section, again


def cut(tmp_path, plane, mesh=SHEET, **more) -> dict:
    return queries.run(box_part(), "scan_section", {"layout": "assembly", "plane": plane, "scan": scan_of(tmp_path, mesh), **more}, {})


def test_a_normal_of_any_length_is_a_direction_and_one_of_none_is_refused(tmp_path):
    import json

    for normal in ([1e308, 0, 0], [1e-200, 0, 0], [3e-300, 0, 4e-300 * 0], [1e308, 1e308, 0]):
        said = cut(tmp_path, {"origin": [0.25, 0, 0], "normal": normal})
        json.dumps(said, allow_nan=False)
        assert said["plane"]["normal"] == pytest.approx([1, 0, 0] if normal[1] == 0 else [math.sqrt(0.5), math.sqrt(0.5), 0])
        assert said["segments"] == (58 if normal[1] == 0 else 114)
    for plane in ({"origin": [0, 0, 0], "normal": [0, 0, 0]}, {"origin": [0, 0, 0], "normal": [float("inf"), 0, 0]}, {"origin": [1e300, 0, 0], "normal": [1, 0, 0]},
                  {"origin": [0, 0, 0], "normal": [True, False, False]}, {"origin": [0, 0], "normal": [1, 0, 0]}, [1, 2], None, {"origin": [0, 0, 0], "normal": [10**400, 0, 0]}):
        with pytest.raises(queries.QueryError, match="scan_section needs args.plane") as e:
            cut(tmp_path, plane)
        assert e.value.kind == "bad_request"


def test_a_section_of_a_scan_is_of_a_layout_the_build_has(tmp_path):
    plane = {"origin": [0.25, 0, 0], "normal": [1, 0, 0]}
    with pytest.raises(queries.QueryError) as e:
        queries.run(box_part(), "scan_section", {"layout": "nope", "plane": plane, "scan": scan_of(tmp_path)}, {})
    assert (e.value.kind, e.value.message) == ("bad_ref", "no layout 'nope'; the layouts are assembly")
    with pytest.raises(queries.QueryError) as e:
        queries.run(box_part(), "scan_section", {"plane": plane, "scan": scan_of(tmp_path)}, {})
    assert (e.value.kind, e.value.message) == ("bad_request", "scan_section needs args.layout, a string")


def test_a_scan_whose_triangles_share_no_vertex_is_cut_in_whole_lines_all_the_same(tmp_path):
    # As a scan with colours is: a vertex of its own for every corner where two patches of its texture meet. Here, every corner.
    vertices, triangles = scanfix.box((40, 30, 5))
    apart = (vertices[triangles].reshape(-1, 3), np.arange(36).reshape(-1, 3))
    said = cut(tmp_path, {"origin": [0, 0, 1], "normal": [0, 0, 1]}, apart)
    [loop] = said["polylines"]
    assert loop["closed"] is True and len(loop["points"]) == 8 and said["segments"] == 8
    assert said["bounds"] == {"min": [-20, -15], "max": [20, 15]}
    sheet = (SHEET[0][SHEET[1]].reshape(-1, 3), np.arange(3 * len(SHEET[1])).reshape(-1, 3))
    [line] = cut(tmp_path, {"origin": [0.25, 0, 0], "normal": [1, 0, 0]}, sheet)["polylines"]
    assert line["closed"] is False and len(line["points"]) == 59


def test_no_more_points_are_told_of_a_section_than_fit_and_it_says_how_many_there_were(tmp_path, monkeypatch):
    whole = cut(tmp_path, {"origin": [0.25, 0, 0], "normal": [1, 0, 0]})
    assert (whole["pointsFound"], whole["pointsTold"], whole["thinned"], whole["omitted"]) == (59, 59, False, 0)
    monkeypatch.setattr(scanclash, "MAX_OUTLINE_POINTS", 20)
    said = cut(tmp_path, {"origin": [0.25, 0, 0], "normal": [1, 0, 0]})
    [line] = said["polylines"]
    assert (said["pointsFound"], said["pointsTold"], said["thinned"], said["omitted"]) == (59, len(line["points"]), True, 0)
    assert 2 <= len(line["points"]) <= 20 and line["points"][0] == whole["polylines"][0]["points"][0] and line["points"][-1] == whole["polylines"][0]["points"][-1]
    assert said["bounds"] == whole["bounds"]
    # Two lines, the longer told with more of the points; one too many for what is left is left out and counted.
    two = (np.vstack([SHEET[0], scanfix.grid(8)[0] + [0, 0, 20]]), np.vstack([SHEET[1], scanfix.grid(8)[1] + 900]))
    said = cut(tmp_path, {"origin": [0.25, 0, 0], "normal": [1, 0, 0]}, two)
    assert said["pointsFound"] == 59 + 15 and said["thinned"] is True and said["pointsTold"] <= 20
    assert [len(line["points"]) for line in said["polylines"]] == sorted((len(line["points"]) for line in said["polylines"]), reverse=True)
    monkeypatch.setattr(scanclash, "MAX_OUTLINE_POINTS", 3)
    assert cut(tmp_path, {"origin": [0.25, 0, 0], "normal": [1, 0, 0]}, two)["omitted"] == 1


def test_a_triangle_smaller_than_the_spacing_is_stood_for_by_its_middle_alone():
    # 1,682 triangles half a millimetre a side: a scan's are small, and there are a million of them.
    vertices, triangles = scanfix.grid(30, 0.5)
    points, owner = scanclash.sampled(vertices, triangles, 1.0)
    assert owner.tolist() == list(range(1682))
    assert points == pytest.approx(vertices[triangles].mean(axis=1))
    # However few points it may have, a mesh is not stood for more coarsely than its triangles are large.
    mesh = scanclash._Sampled(vertices, triangles, most=100)
    assert mesh.spacing == 1.0 and len(mesh.points) == 1682
    distance, at, on, _ = mesh.nearest(np.array([[0.1, 0.05, 0.3], [7.26, -7.26, 2]]))
    assert distance == pytest.approx([0.3, math.sqrt(4 + 2 * 0.01**2)]) and at == pytest.approx(np.array([[0.1, 0.05, 0], [7.25, -7.25, 0]]))
    # One large triangle among them is given fewer points before all are given fewer.
    large = (np.vstack([vertices, [[0, 0, 5], [300, 0, 5], [0, 300, 5]]]), np.vstack([triangles, [[900, 901, 902]]]))
    mixed = scanclash._Sampled(*large, most=3000)
    assert 1 < mixed.spacing < 16 and len(mixed.points) <= 3000 and (mixed.owner == 1682).sum() > 300


# What the second review found


def through_a_box(points: np.ndarray, triangles: np.ndarray, half: np.ndarray) -> int:
    """How many triangles have an edge with a piece inside a box round the origin and a piece outside it: one edge at a time."""

    def goes(p, q) -> bool:
        d = q - p
        enters, leaves = 0.0, 1.0
        for axis in range(3):
            if d[axis] == 0:
                if abs(p[axis]) >= half[axis]:
                    return False
            else:
                a, b = (-half[axis] - p[axis]) / d[axis], (half[axis] - p[axis]) / d[axis]
                enters, leaves = max(enters, min(a, b)), min(leaves, max(a, b))
        length = float(np.linalg.norm(d))
        return (leaves - enters) * length > 2e-6 and (enters * length > 2e-6 or (1 - leaves) * length > 2e-6)

    return sum(any(goes(points[t[i]], points[t[(i + 1) % 3]]) for i in range(3)) for t in triangles)


@pytest.mark.parametrize("count, expected", [(257, 80), (300, 82)])
def test_a_scan_of_more_vertices_than_a_small_number_holds_crosses_as_one_of_few_does(tmp_path, count, expected):
    from build123d import Box

    # Stood on edge, the plate at its last rows: there a vertex's number times the number of vertices is past 2 ** 32.
    vertices, triangles = scanfix.grid(count)
    stood = (vertices[:, [1, 2, 0]] - [0, 0, (count - 1) / 2 - 3]).astype(np.float32).astype(np.float64)
    half = np.array([10, 10, 0.3])
    near = np.flatnonzero((np.abs(stood[triangles]) <= half + 3).all(axis=(1, 2)))
    assert through_a_box(stood, triangles[near], half) == expected
    said = ask({"assembly:a": Box(20, 20, 0.6)}, "scan_clash", scan=scan_of(tmp_path, (stood, triangles)))
    assert said["inside"]["crossing"] == expected and said["inside"]["crossingAtLeast"] is False
    assert sum(c["count"] for c in said["crossings"]["clusters"]) == expected
    for cluster in said["crossings"]["clusters"]:
        assert abs(cluster["centre"][2]) <= 0.3 and abs(cluster["centre"][1]) <= 10.5 and abs(cluster["centre"][0]) <= 10.5


# 90,000 vertices: any of their numbers past 47,721 times that is more than 32 bits hold.
LARGE = scanfix.grid(300)


def test_a_large_scan_through_a_box_is_counted_as_a_small_one_is(tmp_path):
    said = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, LARGE))
    assert said["points"] == {"scan": 90000, "candidates": 900, "checked": 900, "ignored": 0, "touching": 0}
    assert said["inside"]["count"] == 400 and said["inside"]["crossing"] == 4 * 19 * 2 + 6
    [ring] = said["crossings"]["clusters"]
    assert ring["count"] == 158 and ring["centre"] == pytest.approx([0, 0, 0], abs=0.2)
    assert said["deepest"]["depth"] == pytest.approx(5, abs=1e-9) and said["nearest"]["distance"] == pytest.approx(0.5, abs=1e-9)


def test_a_large_scan_is_so_far_from_a_part_and_the_part_from_it(tmp_path):
    shapes = box_part()
    above = {"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}
    top = int(face_at(shapes, [0, 0, 5]).split("F")[1])
    said = ask(shapes, "scan_deviation", scan=scan_of(tmp_path, LARGE, transform=above), faces=[top])
    assert said["compared"] == said["samples"] > 400 and {round(v, 6) for v in said["distance"].values()} == {2}
    # Within 3 of the box: the 400 vertices over it, and those no more than √5 beside it.
    said = ask(shapes, "scan_deviation", scan=scan_of(tmp_path, LARGE, transform=above), within=3, **{"from": "scan"})
    assert said["compared"] == 400 + 80 + 80 + 4 + 8 + 4
    assert said["distance"]["min"] == pytest.approx(2) and said["distance"]["max"] == pytest.approx(math.sqrt(4 + 4.5))
    assert said["worst"]["distance"] == pytest.approx(math.sqrt(4 + 4.5), abs=1e-9) and said["sampling"]["unsure"] == 0


def test_a_large_scan_is_cut_in_one_line(tmp_path):
    said = cut(tmp_path, {"origin": [0.25, 0, 0], "normal": [1, 0, 0]}, LARGE)
    [line] = said["polylines"]
    assert said["segments"] == 598 and len(line["points"]) == 599 and line["closed"] is False
    assert said["bounds"] == {"min": [-149.5, 0], "max": [149.5, 0]}
    # And through its last column of cells, where the vertices' numbers are largest.
    [line] = cut(tmp_path, {"origin": [149.25, 0, 0], "normal": [1, 0, 0]}, LARGE)["polylines"]
    assert len(line["points"]) == 599


def test_a_part_through_the_middle_of_a_triangle_of_the_scan_crosses_it(tmp_path):
    from build123d import Cylinder

    rod = {"assembly:a": Cylinder(1.0, 40)}
    one = (np.array([[-50.0, -40, 0], [50, -40, 0], [0, 60, 0]]), np.array([[0, 1, 2]]))
    said = ask(rod, "scan_clash", scan=scan_of(tmp_path, one))
    # No vertex of the scan is in the rod, and no edge of the scan meets it: the rod's own edges go through the triangle.
    assert said["inside"]["count"] == 0 and said["inside"]["crossing"] == 1 and said["inside"]["crossingAtLeast"] is False
    [where] = said["crossings"]["clusters"]
    assert where["count"] == 1 and np.linalg.norm(where["centre"]) <= 1.0 + 1e-6
    assert "edges of the part's mesh" in said["how"]
    # A sheet of triangles 20 mm a side, the rod through one of them, clear of its edges.
    coarse = (scanfix.grid(8)[0] * 20 + [3.3, 0.1, 0], scanfix.grid(8)[1])
    said = ask(rod, "scan_clash", scan=scan_of(tmp_path, coarse))
    assert said["inside"]["count"] == 0 and said["inside"]["crossing"] == 1
    # Standing on the triangle, or ending a hair short of it, it goes through nothing.
    for lift in (20, 20.5):
        said = ask(rod, "scan_clash", scan=scan_of(tmp_path, one, transform={"t": [0, 0, lift], "q": [0, 0, 0, 1], "s": 1}), margin=50)
        assert said["inside"]["crossing"] == 0


def test_a_part_of_solids_that_are_not_one_is_refused_in_a_sentence(tmp_path):
    from build123d import Box, Compound, Pos

    two = {"assembly:a": Compound(children=[Box(20, 20, 10), Pos(5, 0, 0) * Box(20, 20, 10)])}
    for name in ("scan_clash", "scan_deviation"):
        kind, message = refused(two, name, scan=scan_of(tmp_path))
        assert kind == "bad_request" and message.startswith("a cannot be checked against a scan: ") and "2 solids" in message


def test_what_is_asked_of_a_deviation_has_limits_and_they_are_named(tmp_path):
    scan = scan_of(tmp_path)
    assert refused(box_part(), "scan_deviation", scan=scan, samples=20_001) == ("bad_request", "samples is a number from 100 to 20000")
    assert refused(box_part(), "scan_deviation", scan=scan, within=200.5) == ("bad_request", "within is a number from 0.1 to 200")
    most = ask(box_part(), "scan_deviation", scan=scan, samples=20_000, within=200)
    assert most["samples"] == 2808 and most["compared"] == 2808
    assert scanclash.BUDGET == 10.0


def test_what_stands_for_a_scan_is_kept_from_one_deviation_to_the_next(tmp_path):
    shapes, kept = box_part(), {}
    scan = scan_of(tmp_path, transform={"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1})
    first = ask(shapes, "scan_deviation", kept, scan=scan)
    stood = kept["scan"][1].stood
    again = ask(shapes, "scan_deviation", kept, scan=scan)
    assert kept["scan"][1].stood is stood and again["distance"] == first["distance"]
    # Other faces reach other triangles of the scan; and a scan written again is another scan.
    ask(shapes, "scan_deviation", kept, scan=scan, within=3)
    assert kept["scan"][1].stood is not stood
    stood = kept["scan"][1].stood
    scanfile.write_bin(scan["path"], *SHEET)
    ask(shapes, "scan_deviation", kept, scan=scan, within=3)
    assert kept["scan"][1].stood is not stood


def test_a_deviation_out_of_time_says_what_it_measured(tmp_path, monkeypatch):
    scan = scan_of(tmp_path, transform={"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1})
    monkeypatch.setattr(scanclash, "DEVIATION_BATCH", 200)
    late = [0.0]
    real = scanclash.time.monotonic

    class Clock:
        @staticmethod
        def monotonic():
            # Each look at the clock is three seconds later than the last.
            late[0] += 3.0
            return real() + late[0]

    monkeypatch.setattr(scanclash, "time", Clock)
    for source in ("part", "scan"):
        late[0] = 0.0
        said = ask(box_part(), "scan_deviation", scan=scan, **{"from": source})
        assert said["sampling"]["partial"] is True and 0 < said["samples"] < (2808 if source == "part" else 900)
        assert said["compared"] == said["samples"] and said["distance"]["min"] == pytest.approx(2)
        assert f"the time ran out after {said['samples']:,} of {2808 if source == 'part' else 900:,}" in said["how"]
    monkeypatch.setattr(scanclash, "BUDGET", -1.0)
    none = ask(box_part(), "scan_deviation", scan=scan)
    assert none["sampling"]["partial"] is True and none["samples"] == 0 and none["distance"] is None and "the time ran out" in none["how"]


def test_a_distance_is_to_the_nearest_triangle_however_many_small_ones_are_nearly_as_near():
    # One triangle 400 mm a side, and over a corner of it a patch of 3,200 triangles 0.05 mm a side, 0.6 above:
    # of a point on the large one, the 128 points nearest to it all stand for the patch.
    along = np.arange(-1, 1 + 1e-9, 0.05) + 0.5
    patch = np.array([[x, y, 0.6] for x in along for y in along])
    m = len(along)
    cells = [[i * m + j, (i + 1) * m + j, i * m + j + 1] for i in range(m - 1) for j in range(m - 1)]
    cells += [[(i + 1) * m + j, (i + 1) * m + j + 1, i * m + j + 1] for i in range(m - 1) for j in range(m - 1)]
    vertices = np.vstack([[[-100, -100, 0], [300, -100, 0], [-100, 300, 0]], patch])
    mesh = scanclash._Sampled(vertices, np.vstack([[[0, 1, 2]], np.array(cells) + 3]))
    rng = np.random.default_rng(1)
    points = np.column_stack([rng.uniform(0.2, 0.8, 400), rng.uniform(0.2, 0.8, 400), np.zeros(400)])
    distance, at, on, unsure = mesh.nearest(points, 50)
    assert distance.max() < 1e-9 and (on == 0).all() and not unsure.any()
    # With no time to try them all, what is told is of a triangle, and is said not to be sure.
    distance, _, on, unsure = mesh.nearest(points, 50, deadline=0.0)
    wrong = distance > 0.01
    assert wrong.any() and unsure[wrong].all() and distance.max() <= 0.6 + 1e-9 and (on[wrong] > 0).all()


def test_a_deviation_says_how_many_of_its_distances_it_is_not_sure_of(tmp_path, monkeypatch):
    shapes = box_part()
    top = int(face_at(shapes, [0, 0, 5]).split("F")[1])
    scan = scan_of(tmp_path, transform={"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1})
    sure = ask(shapes, "scan_deviation", scan=scan, faces=[top])
    assert sure["sampling"]["unsure"] == 0 and "may be told" not in sure["how"]
    # No more than so many points are tried round one: with none allowed, none is settled that way.
    monkeypatch.setattr(scanclash, "NEAREST", (1,))
    monkeypatch.setattr(scanclash, "BALL", 0)
    said = ask(shapes, "scan_deviation", scan=scan, faces=[top])
    assert said["sampling"]["unsure"] == said["compared"] > 0
    assert f"{said['compared']:,} of them may be told up to 1.1 mm too far" in said["how"]


def test_the_points_of_a_part_are_as_far_apart_as_the_answer_says(tmp_path, monkeypatch):
    monkeypatch.setattr(scanclash, "MAX_PART_SAMPLES", 400)
    said = ask(box_part(), "scan_deviation", scan=scan_of(tmp_path, transform={"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}))
    assert said["sampling"]["surface"] > 1 and said["samples"] <= 400


def test_what_a_deviation_says_of_a_point_is_of_that_point(tmp_path):
    # A sheet tilted over the box: every point of the top is another distance from it, and the furthest is a corner.
    tilt = math.radians(10)
    leaning = {"t": [0, 0, 9], "q": [0, math.sin(tilt / 2), 0, math.cos(tilt / 2)], "s": 1}
    shapes = box_part()
    top = int(face_at(shapes, [0, 0, 5]).split("F")[1])
    said = ask(shapes, "scan_deviation", scan=scan_of(tmp_path, transform=leaning), faces=[top])
    at, on = np.array(said["worst"]["at"]), np.array(said["worst"]["on"])
    assert abs(at[0]) == pytest.approx(10) and at[2] == pytest.approx(5)
    assert np.linalg.norm(at - on) == pytest.approx(said["worst"]["distance"]) == pytest.approx(said["distance"]["max"])
    # The plane of the sheet goes through (0, 0, 9) with the normal turned 10° about Y.
    normal = np.array([math.sin(tilt), 0, math.cos(tilt)])
    assert abs((on - [0, 0, 9]) @ normal) < 1e-6 and said["distance"]["max"] == pytest.approx(abs((at - [0, 0, 9]) @ normal), abs=1e-6)
