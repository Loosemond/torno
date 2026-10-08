"""Drives ``python -m torno_kernel`` as a subprocess through the frame codec."""

import io
import math
import os
import platform
import threading
import time
from pathlib import Path

import pytest
from kclient import Kernel

from torno_kernel.frames import write_frame

WS = Path(__file__).parent / "fixtures" / "ws"


@pytest.fixture(scope="module")
def kernel():
    """One kernel shared by the tests that only need it to be running."""
    k = Kernel()
    yield k
    k.close()


@pytest.fixture(scope="module")
def bracket_kernel():
    """A kernel whose live worker holds the bracket. Tests must not build on it."""
    k = Kernel()
    reply, _ = k.build(WS / "bracket", "bracket.py")
    assert reply["ok"], reply
    yield k
    k.close()


@pytest.fixture
def fresh():
    k = Kernel()
    yield k
    k.close()


def build_bracket(k: Kernel, ws) -> dict:
    reply, _ = k.build(ws / "bracket", "bracket.py")
    assert reply["ok"], reply
    return reply


def gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def test_ready_reports_versions(kernel):
    import build123d

    assert kernel.ready == {
        "event": "ready",
        "versions": {"build123d": build123d.__version__, "python": platform.python_version()},
    }


def test_build_bracket_replies_started_then_scene_and_blob(kernel, ws):
    reply, blob = kernel.build(ws / "bracket", "bracket.py")
    assert reply["ok"] is True
    scene = reply["scene"]
    assert scene["model"] == "bracket.py"
    assert scene["layouts"] == ["assembly", "print"]
    assert [p["key"] for p in scene["parts"]] == [
        "assembly:base",
        "assembly:post",
        "print:base",
        "print:post",
    ]
    assert scene["seconds"] > 0
    assert scene["output"] == ""
    bufs = [buf for p in scene["parts"] for buf in p["mesh"].values()]
    assert len(bufs) == 4 * 8
    assert all(buf["offset"] % 4 == 0 for buf in bufs)
    assert max(buf["offset"] + buf["length"] for buf in bufs) == len(blob)


def test_model_output_is_captured_and_does_not_corrupt_the_stream(kernel, ws):
    reply, _ = kernel.build(ws / "chatty", "chatty.py")
    assert reply["ok"] is True
    assert reply["scene"]["output"] == "report line\nreport line\n"
    # The next frames still parse: nothing the model printed reached the protocol stream.
    assert build_bracket(kernel, ws)["scene"]["output"] == ""


def test_model_exception_fails_the_build_and_the_kernel_survives(kernel, ws):
    reply, blob = kernel.build(ws / "broken", "broken.py")
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "exception"
    assert "wall too thin" in reply["error"]["message"]
    assert "broken.py" in reply["error"]["traceback"]
    assert blob == b""
    build_bracket(kernel, ws)


def test_model_that_exits_fails_the_build(kernel, ws):
    reply, _ = kernel.build(ws / "exits", "exits.py")
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "exception"
    assert "missing input file" in reply["error"]["message"]
    assert "exits.py" in reply["error"]["traceback"]
    build_bracket(kernel, ws)


def test_missing_model_fails_with_the_loader_kind(kernel, ws):
    reply, _ = kernel.build(ws / "noscene", "noscene.py")
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "no_scene"


def test_segfault_is_reported_as_crash_and_the_kernel_survives(kernel, ws):
    start = time.monotonic()
    reply, _ = kernel.build(ws / "crash", "crash.py", timeout=5)
    assert time.monotonic() - start < 5
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "crash"
    assert "SIGSEGV" in reply["error"]["message"]
    build_bracket(kernel, ws)


def test_hang_is_killed_at_the_deadline_and_the_kernel_survives(kernel, ws):
    id = kernel.send("build", dir=str(ws / "slow"), model="slow.py", timeout=2)
    start = time.monotonic()
    assert kernel.recv(5)[0]["event"] == "build.started"
    reply, _ = kernel.recv(4)
    assert 1.5 < time.monotonic() - start < 4
    assert reply["id"] == id
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "timeout"
    assert "starting slow work" in reply["error"]["output"]
    build_bracket(kernel, ws)


def test_new_build_cancels_the_running_one(kernel, ws):
    slow = kernel.send("build", dir=str(ws / "slow"), model="slow.py")
    slow_started, _ = kernel.recv(5)
    time.sleep(0.5)
    quick = kernel.send("build", dir=str(ws / "bracket"), model="bracket.py")
    frames = [kernel.recv(20)[0] for _ in range(3)]
    finals = [f for f in frames if "ok" in f]
    assert [(f["id"], f["ok"]) for f in finals] == [(slow, False), (quick, True)]
    assert finals[0]["error"]["kind"] == "cancelled"
    assert [f for f in frames if "event" in f] == [
        {"id": quick, "event": "build.started", "pid": frames[1]["pid"]}
    ]
    assert gone(slow_started["pid"])
    # Nothing else follows: exactly two final replies.
    with pytest.raises(TimeoutError):
        kernel.recv(0.5)


def test_cancel_kills_the_running_build(kernel, ws):
    slow = kernel.send("build", dir=str(ws / "slow"), model="slow.py")
    started, _ = kernel.recv(5)
    kernel.send("cancel")
    reply, _ = kernel.recv(5)
    assert reply["id"] == slow
    assert reply["error"]["kind"] == "cancelled"
    assert gone(started["pid"])
    with pytest.raises(TimeoutError):
        kernel.recv(0.3)


def test_describe_part(bracket_kernel):
    reply = bracket_kernel.describe("assembly:base")
    assert reply["ok"] is True
    result = reply["result"]
    assert result["kind"] == "part"
    assert result["key"] == "assembly:base"
    assert result["volume"] == pytest.approx(6000)
    assert result["area"] == pytest.approx(2 * (40 * 30 + 40 * 5 + 30 * 5))
    assert result["bbox"]["min"] == pytest.approx([-20, -15, -2.5])
    assert result["bbox"]["max"] == pytest.approx([20, 15, 2.5])
    assert (result["faceCount"], result["edgeCount"], result["valid"]) == (6, 12, True)


def test_describe_planar_face(bracket_kernel):
    result = bracket_kernel.describe("assembly:base/F0")["result"]
    assert result["kind"] == "face"
    assert result["ref"] == "assembly:base/F0"
    assert result["type"] == "plane"
    assert result["area"] == pytest.approx(150)
    assert math.hypot(*result["normal"]) == pytest.approx(1)
    assert result["center"] == pytest.approx([-20, 0, 0])
    assert result["normal"] == pytest.approx([-1, 0, 0])
    assert result["radius"] is None


def test_describe_cylindrical_face_gives_its_radius_in_the_object_frame(bracket_kernel):
    count = bracket_kernel.describe("assembly:post")["result"]["faceCount"]
    faces = [bracket_kernel.describe(f"assembly:post/F{i}")["result"] for i in range(count)]
    cylinders = [f for f in faces if f["type"] == "cylinder"]
    assert len(cylinders) == 1
    assert cylinders[0]["radius"] == pytest.approx(4)
    # The post stands 12.5 mm up in the assembly: positions are not part-local.
    assert cylinders[0]["center"][2] == pytest.approx(12.5)


def test_describe_edge(bracket_kernel):
    result = bracket_kernel.describe("assembly:base/E1")["result"]
    assert result == {
        "kind": "edge",
        "ref": "assembly:base/E1",
        "type": "line",
        "length": pytest.approx(30),
        "center": pytest.approx([-20, 0, 2.5]),
    }


def test_describe_unknown_part_lists_the_valid_keys(bracket_kernel):
    reply = bracket_kernel.describe("assembly:nope")
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "bad_ref"
    for key in ("assembly:base", "assembly:post", "print:base", "print:post"):
        assert key in reply["error"]["message"]


def test_describe_face_index_out_of_range_is_bad_ref(bracket_kernel):
    reply = bracket_kernel.describe("assembly:base/F6")
    assert reply["error"]["kind"] == "bad_ref"
    assert "6 faces" in reply["error"]["message"]


def test_unknown_query_and_unknown_op_are_bad_requests(bracket_kernel):
    id = bracket_kernel.send("query", name="nope", args={})
    reply, _ = bracket_kernel.recv(5)
    assert (reply["id"], reply["error"]["kind"]) == (id, "bad_request")
    id = bracket_kernel.send("nope")
    reply, _ = bracket_kernel.recv(5)
    assert (reply["id"], reply["error"]["kind"]) == (id, "bad_request")


def test_request_that_is_not_json_is_a_bad_request_and_the_stream_recovers(bracket_kernel):
    stdin = bracket_kernel.proc.stdin
    stdin.write(b"\x00\x00\x00\x05\x00\x00\x00\x00{oops")
    reply, _ = bracket_kernel.recv(5)
    assert (reply["id"], reply["error"]["kind"]) == (None, "bad_request")
    write_frame(stdin, [1, 2])
    reply, _ = bracket_kernel.recv(5)
    assert (reply["id"], reply["error"]["kind"]) == (None, "bad_request")
    assert bracket_kernel.describe("assembly:base")["ok"] is True


def test_a_thousand_pipelined_queries_are_all_answered_in_order(bracket_kernel):
    stdin = bracket_kernel.proc.stdin
    pipelined = io.BytesIO()
    for i in range(1000):
        write_frame(
            pipelined,
            {"id": f"p{i}", "op": "query", "name": "describe", "args": {"ref": "assembly:base"}},
        )
    stdin.write(pipelined.getvalue())
    replies = [bracket_kernel.recv(10)[0] for _ in range(1000)]
    assert [r["id"] for r in replies] == [f"p{i}" for i in range(1000)]
    assert all(r["ok"] for r in replies)


def test_client_that_writes_many_requests_before_reading_any_reply_is_not_blocked(kernel):
    # Requests and replies both exceed what the pipes hold, so a supervisor that
    # blocked on writing replies would never read the rest of the requests.
    pipelined = io.BytesIO()
    for i in range(20000):
        write_frame(pipelined, {"id": i, "op": "nope"})
    done = threading.Event()

    def write():
        kernel.proc.stdin.write(pipelined.getvalue())
        done.set()

    threading.Thread(target=write, daemon=True).start()
    assert done.wait(10), "the kernel stopped reading requests"
    replies = [kernel.recv(10)[0] for _ in range(20000)]
    assert [r["id"] for r in replies] == list(range(20000))
    assert {r["error"]["kind"] for r in replies} == {"bad_request"}


def test_query_before_any_build_is_no_build_and_shutdown_exits(fresh):
    reply = fresh.describe("assembly:base")
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "no_build"
    fresh.send("shutdown")
    assert fresh.proc.wait(2) == 0


def test_failed_build_keeps_the_previous_worker_for_queries(kernel, ws):
    build_bracket(kernel, ws)
    reply, _ = kernel.build(ws / "broken", "broken.py")
    assert reply["ok"] is False
    assert kernel.describe("assembly:base")["result"]["volume"] == pytest.approx(6000)


def test_queries_are_answered_while_another_build_runs(kernel, ws):
    build_bracket(kernel, ws)
    kernel.send("build", dir=str(ws / "slow"), model="slow.py")
    assert kernel.recv(5)[0]["event"] == "build.started"
    assert kernel.describe("assembly:base")["result"]["volume"] == pytest.approx(6000)
    kernel.send("cancel")
    assert kernel.recv(5)[0]["error"]["kind"] == "cancelled"


def test_successful_build_replaces_and_stops_the_previous_worker(kernel, ws):
    id = kernel.send("build", dir=str(ws / "bracket"), model="bracket.py")
    first, _ = kernel.recv(5)
    assert kernel.recv(20)[0]["ok"] is True
    reply, _ = kernel.build(ws / "chatty", "chatty.py")
    assert reply["ok"] is True
    assert first["id"] == id
    assert gone(first["pid"])
    assert kernel.describe("assembly:base")["error"]["kind"] == "bad_ref"
    assert kernel.describe("assembly:plate")["ok"] is True


def test_ten_builds_in_a_row_each_finish_quickly(kernel, ws):
    for _ in range(10):
        start = time.monotonic()
        build_bracket(kernel, ws)
        assert time.monotonic() - start < 5


def test_closing_stdin_exits_and_leaves_no_children(fresh, ws):
    id = fresh.send("build", dir=str(ws / "bracket"), model="bracket.py")
    live, _ = fresh.recv(5)
    assert fresh.recv(20)[0]["ok"] is True
    fresh.send("build", dir=str(ws / "slow"), model="slow.py")
    building, _ = fresh.recv(5)
    assert live["id"] == id and not gone(live["pid"]) and not gone(building["pid"])
    fresh.proc.stdin.close()
    assert fresh.proc.wait(2) == 0
    assert gone(live["pid"])
    assert gone(building["pid"])
