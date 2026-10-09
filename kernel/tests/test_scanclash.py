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
    assert said["points"] == {"scan": 900, "candidates": 900, "checked": 900, "ignored": 0}
    assert said["inside"]["count"] == 400 and said["inside"]["clustersOmitted"] == 0
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
    assert said["sampling"] == {"every": 1, "cell": 5.0, "surface": 1.0, "deflection": 0.1, "retaken": said["sampling"]["retaken"], "partial": False, "seconds": said["sampling"]["seconds"]}
    assert 1 <= said["sampling"]["retaken"] <= scanclash.MAX_RETAKEN


def test_the_scan_is_where_its_transform_puts_it(tmp_path):
    above = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, transform={"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}))
    assert above["inside"] == {"count": 0, "crossing": 0, "clusters": [], "clustersOmitted": 0} and above["deepest"] is None
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
    assert thinned["points"] == {"scan": 900, "candidates": 900, "checked": 100, "ignored": 0}
    assert thinned["sampling"]["every"] == 9 and 30 <= thinned["inside"]["count"] <= 60
    monkeypatch.setattr(scanclash, "BUDGET", -1.0)
    late = ask(box_part(), "scan_clash", scan=scan_of(tmp_path))
    assert late["sampling"]["partial"] is True and late["points"]["checked"] == 0 and late["inside"]["count"] == 0


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
