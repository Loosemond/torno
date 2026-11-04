"""Why a boolean failed (``booleans``, reached through ``diagnose``), found by looking at its operands."""

import io
import time

import pytest
from build123d import Box, Cylinder, Face, Pos, Wire, extrude

from torno_kernel import booleans, diagnose


def failure(make):
    """The exception ``make()`` raises, which the test needs it to."""
    with pytest.raises(Exception) as caught:
        make()
    return caught.value


def operands(told):
    return {o["name"]: o for o in told["operands"]}


@pytest.fixture(scope="module")
def block():
    return Box(10, 10, 10)


@pytest.fixture(scope="module")
def bowtie():
    """A solid made of a face that crosses itself: OCC's check and the argument analyzer both find it invalid."""
    wire = Wire.make_polygon([(0, 0, 0), (10, 10, 0), (10, 0, 0), (0, 10, 0)], close=True)
    solid = extrude(Face(wire), 5)
    assert not solid.is_valid
    return solid


# Finding the call


def test_the_call_is_found_in_the_traceback_of_a_boolean(block):
    face = Face.make_rect(5, 5)
    call = booleans.find_boolean(failure(lambda: block.cut(face)))
    assert call is not None
    assert (call.operation, len(call.base), len(call.tools)) == ("cut", 1, 1)
    assert call.tools[0] is face


def test_each_boolean_is_named(block):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Splitter

    face = Face.make_rect(5, 5)
    assert booleans.find_boolean(failure(lambda: block.fuse(face))).operation == "fuse"
    named = [booleans._operation(c()) for c in (BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse, BRepAlgoAPI_Common, BRepAlgoAPI_Splitter)]
    assert named == ["cut", "fuse", "intersect", "split"]


def test_the_call_is_found_through_the_exception_a_loader_raised_from_it(block):
    try:
        try:
            block.cut(Face.make_rect(5, 5))
        except Exception as e:
            raise RuntimeError("the model did not load") from e
    except RuntimeError as wrapped:
        assert booleans.find_boolean(wrapped) is not None


def test_no_call_is_found_of_another_failure():
    assert booleans.find_boolean(failure(lambda: 1 / 0)) is None
    assert diagnose.find(failure(lambda: 1 / 0)) is None


def test_a_fillet_is_not_taken_for_a_boolean():
    plate = Box(20, 20, 5) - Box(12, 12, 5)
    from build123d import Axis

    error = failure(lambda: plate.fillet(6, plate.edges().filter_by(Axis.Z)))
    assert booleans.find_boolean(error) is None
    assert diagnose.from_exception(error)["operation"] == "fillet"


# The causes


def test_a_tool_that_is_not_a_solid_is_said_so(block):
    face = Face.make_rect(5, 5)
    told = diagnose.from_exception(failure(lambda: block.cut(face)))
    assert told["operation"] == "cut" and told["frame"] == "local" and told["complete"] is True
    assert operands(told)["base"]["type"] == "solid"
    assert operands(told)["tool"]["type"] == "face" and operands(told)["tool"]["solids"] == 0
    assert told["causes"] == ["not-solid"]
    assert told["pairs"] == []


def test_an_empty_operand_is_said_so(block):
    told = booleans.diagnose(booleans.BooleanCall("cut", [block], [Box(1, 1, 1) - Box(1, 1, 1)]))
    assert operands(told)["tool"]["type"] == "empty"
    assert told["causes"] == ["empty-operand"]


def test_an_invalid_operand_is_found_by_the_check_and_the_analyzer(block, bowtie):
    told = booleans.diagnose(booleans.BooleanCall("fuse", [block], [bowtie]))
    assert operands(told)["base"]["valid"] is True and "faults" not in operands(told)["base"]
    assert operands(told)["tool"]["valid"] is False
    assert operands(told)["tool"]["faults"] == ["crosses itself"]
    assert told["causes"] == ["invalid-operand"]


def test_a_tool_that_ends_flush_with_the_face_it_cuts_is_found(block):
    # The tool runs from the middle to the top face of the block and stops there instead of overshooting it.
    tool = Pos(0, 0, 2.5) * Box(4, 4, 5)
    told = booleans.diagnose(booleans.BooleanCall("cut", [block], [tool]))
    (pair,) = told["pairs"]
    (flush,) = pair["coincident"]
    assert (flush["kind"], flush["facing"], flush["gap"]) == ("plane", "same", 0.0)
    assert flush["normal"] == [0.0, 0.0, 1.0] and flush["center"][2] == pytest.approx(5)
    assert flush["area"] == pytest.approx(16) and flush["areaExact"] is True
    assert pair["inside"]["tool"] > 0
    assert told["causes"] == ["flush"]


def test_a_tool_that_overshoots_is_not_flush(block):
    told = booleans.diagnose(booleans.BooleanCall("cut", [block], [Pos(0, 0, 2.5) * Box(4, 4, 6)]))
    assert told["pairs"][0]["coincident"] == [] and told["causes"] == []


def test_a_plane_a_hair_off_is_found_with_its_gap(block):
    told = booleans.diagnose(booleans.BooleanCall("cut", [block], [Pos(0, 0, 2.5 - 5e-5) * Box(4, 4, 5)]))
    (flush,) = told["pairs"][0]["coincident"]
    assert flush["facing"] == "same" and flush["gap"] == pytest.approx(5e-5) and flush["area"] == pytest.approx(16)


def test_shapes_that_meet_only_on_a_face_are_found(block):
    told = booleans.diagnose(booleans.BooleanCall("fuse", [block], [Pos(10, 0, 0) * Box(10, 10, 10)]))
    (pair,) = told["pairs"]
    assert pair["touching"] is True and pair["inside"]["tool"] == 0 and pair["inside"]["base"] == 0
    (face,) = pair["coincident"]
    assert (face["facing"], face["area"]) == ("opposite", pytest.approx(100))
    assert told["causes"] == ["coincident", "touching"]


def test_shapes_that_meet_only_on_an_edge_are_found(block):
    told = booleans.diagnose(booleans.BooleanCall("fuse", [block], [Pos(10, 10, 0) * Box(10, 10, 10)]))
    (pair,) = told["pairs"]
    assert pair["touching"] is True and pair["coincident"] == [] and pair["inside"]["tool"] == 0
    assert told["causes"] == ["touching"]


def test_shapes_that_do_not_meet_are_said_to_be_apart(block):
    told = booleans.diagnose(booleans.BooleanCall("cut", [block], [Pos(30, 0, 0) * Box(10, 10, 10)]))
    (pair,) = told["pairs"]
    assert pair["apart"] == pytest.approx(20) and pair["apartExact"] is False and pair["touching"] is False
    assert pair["inside"]["tool"] == 0 and "coincident" not in pair and told["causes"] == ["apart"]


def test_shapes_that_cross_are_not_touching(block):
    told = booleans.diagnose(booleans.BooleanCall("cut", [block], [Box(2, 2, 30)]))
    assert told["causes"] == [] and told["pairs"][0]["inside"]["tool"] > 0


def test_a_cylinder_in_a_hole_of_its_own_size_is_one_surface():
    told = booleans.diagnose(booleans.BooleanCall("cut", [Cylinder(5, 10)], [Cylinder(5, 4)]))
    kinds = {c["kind"] for c in told["pairs"][0]["coincident"]}
    assert "cylinder" in kinds
    cylinder = next(c for c in told["pairs"][0]["coincident"] if c["kind"] == "cylinder")
    assert cylinder["area"] == pytest.approx(2 * 3.141592653589793 * 5 * 4) and "coincident" in told["causes"]


def test_a_cylinder_of_another_radius_is_none():
    told = booleans.diagnose(booleans.BooleanCall("cut", [Cylinder(5, 10)], [Cylinder(4, 4)]))
    assert [c for c in told["pairs"][0]["coincident"] if c["kind"] == "cylinder"] == []


def test_the_operands_are_told_with_their_box_in_the_local_frame(block):
    told = booleans.diagnose(booleans.BooleanCall("cut", [block], [Pos(0, 0, 2.5) * Box(4, 4, 5)]))
    assert operands(told)["tool"]["box"] == {"min": [-2.0, -2.0, 0.0], "max": [2.0, 2.0, 5.0]}
    assert operands(told)["tool"]["faces"] == 6


def test_a_diagnosis_is_data_the_kernel_can_send(block):
    import json

    told = booleans.diagnose(booleans.BooleanCall("cut", [block], [Pos(0, 0, 2.5) * Box(4, 4, 5)]))
    assert json.loads(json.dumps(told, allow_nan=False)) == told


# The time it takes


def test_past_its_budget_the_diagnosis_says_it_was_cut_short(block):
    told = booleans.diagnose(booleans.BooleanCall("cut", [block], [Pos(0, 0, 2.5) * Box(4, 4, 5)]), budget=0)
    assert told["complete"] is False and told["causes"] == []
    assert all("valid" not in o for o in told["operands"])


def test_the_diagnosis_is_quick_enough_to_be_told_with_every_failed_build(block):
    started = time.monotonic()
    booleans.diagnose(booleans.BooleanCall("cut", [block], [Pos(0, 0, 2.5) * Box(4, 4, 5)]))
    assert time.monotonic() - started < 1.0


def test_operands_past_the_most_looked_at_are_said_to_be_left_out(block):
    tools = [Pos(30 + 20 * i, 0, 0) * Box(5, 5, 5) for i in range(booleans.MOST_OPERANDS + 2)]
    told = booleans.diagnose(booleans.BooleanCall("cut", [block], tools))
    assert told["complete"] is False and told["operandCount"] == {"base": 1, "tools": len(tools)}
    assert len(told["operands"]) == 1 + booleans.MOST_OPERANDS


# Through the worker


def _failing_cut(tmp_path):
    folder = tmp_path / "block"
    folder.mkdir()
    (folder / "block.py").write_text(
        "from build123d import *\nprint('making the block')\nblock = Box(10, 10, 10)\nblock = block.cut(Face.make_rect(5, 5))\n"
    )
    return folder


def test_a_build_that_fails_a_boolean_carries_the_diagnosis_and_prints_nothing_of_it(tmp_path):
    from kclient import Kernel

    kernel = Kernel()
    try:
        reply, _ = kernel.build(_failing_cut(tmp_path), "block.py", timeout=30)
    finally:
        kernel.close()
    assert reply["ok"] is False
    error = reply["error"]
    assert error["kind"] == "exception"
    assert error["diagnosis"]["operation"] == "cut" and error["diagnosis"]["causes"] == ["not-solid"]
    assert error["output"].strip() == "making the block"


def test_the_diagnosis_of_a_boolean_keeps_within_what_the_build_has_left(tmp_path):
    from torno_kernel import worker
    from torno_kernel.frames import read_frame

    channel = io.BytesIO()
    assert worker._build(channel, str(_failing_cut(tmp_path)), "block.py", deadline=time.monotonic()) is None
    channel.seek(0)
    found = read_frame(channel)[0]["error"]["diagnosis"]
    assert (found["budget"], found["complete"]) == (0, False)
