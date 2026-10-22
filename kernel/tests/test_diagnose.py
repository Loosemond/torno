"""Why a fillet or a chamfer failed, found by trying (``diagnose``), and the trial the agent asks for (``try_fillet``)."""

import json
import time

import pytest
from build123d import Axis, Box, BuildPart, Pos, fillet

from torno_kernel import diagnose, queries, topo
from torno_kernel.tess import build_scene

STEP = diagnose.STEP


def failure(make):
    """The exception ``make()`` raises, which the test needs it to."""
    with pytest.raises(Exception) as caught:
        make()
    return caught.value


@pytest.fixture(scope="module")
def pocket():
    """The probe of issue #49: a 20 mm square plate, 5 mm thick, with a 12 mm pocket through it (4 mm walls),
    and its eight vertical edges: the four outer corners first, then the four of the pocket."""
    plate = Box(20, 20, 5) - Box(12, 12, 5)
    edges = plate.edges().filter_by(Axis.Z)
    assert [round(abs(e.center().X)) for e in edges] == [10, 10, 10, 10, 6, 6, 6, 6]
    return plate, edges


@pytest.fixture(scope="module")
def rim():
    """A plate with a pocket 4 mm deep from the top, its walls 4 mm thick, and the eight edges round the top of
    the walls: the four outside first, then the four inside. Two R3 on one wall need 6 mm of its 4."""
    plate = Box(20, 20, 5) - Pos(0, 0, 1) * Box(12, 12, 4)
    top = plate.edges().filter_by(Axis.Z, reverse=True).group_by(Axis.Z)[-1]
    assert [round(e.length) for e in top] == [20, 20, 20, 20, 12, 12, 12, 12]
    return plate, top


# Finding the call


def test_the_call_is_found_in_the_traceback_of_a_method(pocket):
    plate, edges = pocket
    call = diagnose.find_call(failure(lambda: plate.fillet(6, edges)))
    assert call is not None
    assert (call.kind, call.size, call.size2, len(call.edges)) == ("fillet", 6, None, 8)


def test_the_call_is_found_through_the_operation_and_a_builder(pocket):
    plate, edges = pocket
    assert diagnose.find_call(failure(lambda: fillet(edges, 6))).kind == "fillet"

    def built():
        with BuildPart() as part:
            Box(20, 20, 5)
            Box(12, 12, 5, mode=__import__("build123d").Mode.SUBTRACT)
            fillet(part.edges().filter_by(Axis.Z), 6)

    call = diagnose.find_call(failure(built))
    assert call is not None and len(call.edges) == 8


def test_the_call_is_found_through_the_exception_a_loader_raised_from_it(pocket):
    plate, edges = pocket
    try:
        try:
            plate.fillet(6, edges)
        except Exception as e:
            raise RuntimeError("the model did not load") from e
    except RuntimeError as wrapped:
        assert diagnose.find_call(wrapped) is not None


def test_no_call_is_found_of_another_failure():
    assert diagnose.find_call(failure(lambda: 1 / 0)) is None
    assert diagnose.from_exception(failure(lambda: 1 / 0)) is None


# The probe


def test_the_probe_each_edge_works_alone_four_pairs_fail_and_the_radius_is_bisected(pocket):
    plate, edges = pocket
    started = time.monotonic()
    found = diagnose.from_exception(failure(lambda: plate.fillet(6, edges)))
    assert time.monotonic() - started < diagnose.BUDGET
    assert found["operation"] == "fillet" and found["size"] == 6 and "size2" not in found
    assert found["frame"] == "local" and found["edgeCount"] == 8 and found["complete"] is True
    assert found["alone"] == {"tried": 8, "failing": []}
    pairs = found["pairs"]
    assert [tuple(p["edges"]) for p in pairs["failing"]] == [(4, 5), (4, 6), (5, 7), (6, 7)]
    assert all(p["adjacent"] and p["apart"] == pytest.approx(12) and p["apartExact"] for p in pairs["failing"])
    # Two R6 need 12 mm, and the pocket's sides are 12: the eight work just under R6.
    together = found["together"]
    assert together["failsAt"] == 6
    assert 6 - STEP <= together["worksUpTo"] + 1e-9 < 6
    assert found["step"] == STEP
    # The edges told are those of the pairs that fail, in the frame of the plate as it was filleted.
    told = {edge["index"]: edge for edge in found["edges"]}
    assert sorted(told) == [4, 5, 6, 7]
    four = told[4]
    assert four["type"] == "line" and four["length"] == pytest.approx(5) and four["lengthExact"] is True
    assert four["along"] == "Z" and four["between"] == ["plane", "plane"]
    assert sorted([four["start"], four["end"]]) == [pytest.approx([-6, -6, -2.5]), pytest.approx([-6, -6, 2.5])]
    json.dumps(found, allow_nan=False)


def test_the_diagnosis_is_quick_enough_to_be_told_with_every_failed_build(pocket):
    plate, edges = pocket
    found = diagnose.from_exception(failure(lambda: plate.fillet(6, edges)))
    assert found["seconds"] < 2


def test_an_edge_that_fails_alone_has_its_own_largest_radius_and_pairs_are_not_tried():
    thin = Box(20, 20, 2)
    top = thin.edges().group_by(Axis.Z)[-1]
    found = diagnose.from_exception(failure(lambda: thin.fillet(3, top)))
    assert found["alone"] == {"tried": 4, "failing": [0, 1, 2, 3]}
    assert "pairs" not in found
    for edge in found["edges"]:
        assert edge["failsAt"] <= 3 and edge["worksUpTo"] is not None
        # The plate is 2 thick: a fillet of its top edge fits within that.
        assert 1.9 < edge["worksUpTo"] < 2
    assert found["together"]["worksUpTo"] < 2


def test_r3_on_the_top_of_4_mm_walls_names_the_edges_of_each_wall_and_a_radius_that_works(rim):
    plate, top = rim
    found = diagnose.from_exception(failure(lambda: plate.fillet(3, top)))
    assert found["alone"]["failing"] == []
    failing = sorted(tuple(p["edges"]) for p in found["pairs"]["failing"])
    assert failing == [(0, 7), (1, 4), (2, 6), (3, 5)]
    assert all(p["apart"] == pytest.approx(4) for p in found["pairs"]["failing"])
    works = found["together"]["worksUpTo"]
    assert 1.99 <= works < 2
    plate.fillet(works, top)  # it does


def test_a_chamfer_that_fails_says_its_lengths_and_the_largest_that_works():
    thin = Box(20, 20, 2)
    top = thin.edges().group_by(Axis.Z)[-1]
    found = diagnose.from_exception(failure(lambda: thin.chamfer(3, None, top)))
    assert found["operation"] == "chamfer" and found["size"] == 3 and "size2" not in found
    assert found["alone"]["failing"] == [0, 1, 2, 3]
    works = found["together"]["worksUpTo"]
    assert 1.9 < works < 2
    thin.chamfer(works, None, top)


def test_an_uneven_chamfer_scales_both_lengths():
    thin = Box(20, 20, 2)
    top = thin.edges().group_by(Axis.Z)[-1]
    found = diagnose.from_exception(failure(lambda: thin.chamfer(4, 1, top)))
    assert found["operation"] == "chamfer" and (found["size"], found["size2"]) == (4, 1)
    works = found["together"]["worksUpTo"]
    assert works < 4
    thin.chamfer(works, works / 4, top)


# The budget


def test_past_its_budget_the_diagnosis_says_it_was_cut_short(pocket):
    plate, edges = pocket
    found = diagnose.from_exception(failure(lambda: plate.fillet(6, edges)), budget=0.02)
    assert found["complete"] is False
    assert found["budget"] == 0.02
    # What it had no time for is not told as a finding.
    assert "together" not in found or found["together"]["worksUpTo"] is None or found["together"].get("complete") is False


def test_with_no_time_at_all_it_still_names_the_call(pocket):
    plate, edges = pocket
    found = diagnose.from_exception(failure(lambda: plate.fillet(6, edges)), budget=0)
    assert (found["operation"], found["size"], found["edgeCount"], found["complete"]) == ("fillet", 6, 8, False)
    assert found["alone"] == {"tried": 0, "failing": []}


def test_the_budget_is_what_the_build_has_left_less_a_margin():
    assert diagnose.budget_left(None, now=0) == diagnose.BUDGET
    assert diagnose.budget_left(100, now=0) == diagnose.BUDGET
    assert diagnose.budget_left(3, now=0) == pytest.approx(3 - diagnose.MARGIN)
    assert diagnose.budget_left(0.5, now=0) == 0


# Through the kernel


def test_a_build_that_fails_a_fillet_carries_the_diagnosis_and_prints_nothing_of_it(tmp_path):
    from kclient import Kernel

    folder = tmp_path / "plate"
    folder.mkdir()
    (folder / "plate.py").write_text(
        "from build123d import *\n"
        "print('making the plate')\n"
        "plate = Box(20, 20, 5) - Box(12, 12, 5)\n"
        "plate = fillet(plate.edges().filter_by(Axis.Z), 6)\n"
    )
    kernel = Kernel()
    try:
        reply, _ = kernel.build(folder, "plate.py", timeout=30)
    finally:
        kernel.close()
    assert reply["ok"] is False
    error = reply["error"]
    assert error["kind"] == "exception" and "fillet" in error["message"]
    found = error["diagnosis"]
    assert found["operation"] == "fillet" and len(found["pairs"]["failing"]) == 4
    assert error["output"].strip() == "making the plate"


def test_a_build_that_fails_otherwise_has_no_diagnosis(tmp_path):
    from kclient import Kernel

    folder = tmp_path / "broken"
    folder.mkdir()
    (folder / "broken.py").write_text("from build123d import *\nbox = Box(1, 1, 1)\nraise ValueError('no')\n")
    kernel = Kernel()
    try:
        reply, _ = kernel.build(folder, "broken.py", timeout=30)
    finally:
        kernel.close()
    assert reply["ok"] is False and "diagnosis" not in reply["error"]


# The trial, on the last good build


@pytest.fixture(scope="module")
def built(rim):
    plate, _ = rim
    _, _, shapes = build_scene({"main": {"plate": plate}}, "plate.py")
    return shapes


def edge_refs(shapes, edges):
    """The refs of these edges in the built part, by where they are."""
    every = topo.edges(shapes["main:plate"])
    refs = []
    for edge in edges:
        index = next(i for i, e in enumerate(every) if e.IsSame(edge.wrapped))
        refs.append(f"plate/E{index}")
    return refs


def test_try_fillet_agrees_with_the_diagnosis(built, rim):
    plate, top = rim
    refs = edge_refs(built, top)
    told = queries.run(built, "try_fillet", {"part": "main:plate", "edges": refs, "radius": 3, "kind": "fillet"})
    assert told["works"] is False and told["frame"] == "object"
    assert told["alone"]["failing"] == []
    failing = sorted(tuple(sorted(p["edges"])) for p in told["pairs"]["failing"])
    assert len(failing) == 4 and all(a.startswith("plate/E") for pair in failing for a in pair)
    diagnosed = diagnose.from_exception(failure(lambda: plate.fillet(3, top)))
    assert told["together"]["worksUpTo"] == pytest.approx(diagnosed["together"]["worksUpTo"])
    # Each edge told is named by its ref, in the frame of the object.
    assert all(edge["ref"].startswith("plate/E") for edge in told["edges"])
    json.dumps(told, allow_nan=False)


def test_try_fillet_that_works_says_so_and_changes_nothing(built, rim):
    plate, top = rim
    refs = edge_refs(built, top)
    before = len(topo.faces(built["main:plate"]))
    told = queries.run(built, "try_fillet", {"part": "main:plate", "edges": refs, "radius": 1.5, "kind": "fillet"})
    assert told["works"] is True and "together" not in told and "alone" not in told
    assert len(topo.faces(built["main:plate"])) == before


def test_try_fillet_of_a_chamfer(built, rim):
    _, top = rim
    refs = edge_refs(built, top)
    told = queries.run(built, "try_fillet", {"part": "main:plate", "edges": refs, "radius": 1, "kind": "chamfer"})
    assert told["works"] is True and told["operation"] == "chamfer"


@pytest.mark.parametrize(
    ("args", "words"),
    [
        ({"part": "main:plate", "edges": [], "radius": 1}, "at least one edge"),
        ({"part": "main:plate", "edges": ["plate/F1"], "radius": 1}, "edges of plate"),
        ({"part": "main:plate", "edges": ["lid/E1"], "radius": 1}, "edges of plate"),
        ({"part": "main:plate", "edges": ["plate/E999"], "radius": 1}, "there is no E999"),
        ({"part": "main:plate", "edges": ["plate/E1"], "radius": 0}, "above 0"),
        ({"part": "main:plate", "edges": ["plate/E1"], "radius": 1, "kind": "round"}, "fillet or chamfer"),
        ({"part": "main:lid", "edges": ["lid/E1"], "radius": 1}, "no part 'main:lid'"),
    ],
)
def test_try_fillet_refuses_what_it_cannot_try_and_says_how(built, args, words):
    with pytest.raises(queries.QueryError) as refused:
        queries.run(built, "try_fillet", args)
    assert words in refused.value.message


# Edges of the last good build that are, exactly, edges of the failed build


def test_an_edge_of_the_failed_build_is_matched_to_the_last_good_build_only_where_it_is_the_same(built, rim):
    plate, top = rim
    found = diagnose.from_exception(failure(lambda: plate.fillet(3, top)))
    matched = queries.run(built, "match_edges", {"edges": found["edges"]})["matches"]
    assert len(matched) == len(found["edges"])
    assert all(len(refs) == 1 and refs[0].startswith("main:plate/E") for refs in matched)
    # The same plate moved by a hair is no longer the same edges.
    moved = Pos(0, 0, 0.001) * plate
    elsewhere = diagnose.from_exception(failure(lambda: moved.fillet(3, moved.edges().group_by(Axis.Z)[-1])))
    assert queries.run(built, "match_edges", {"edges": elsewhere["edges"]})["matches"] == [[]] * len(elsewhere["edges"])
