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
BRACKET = WS / "bracket"


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
    assert reply["error"]["message"] == (
        "the build did not finish within 2 s and was stopped; "
        "set TORNO_BUILD_TIMEOUT to a number of seconds to allow more"
    )
    assert "starting slow work" in reply["error"]["output"]
    build_bracket(kernel, ws)


def test_default_timeout_is_ten_minutes():
    from torno_kernel import supervisor

    assert supervisor.DEFAULT_TIMEOUT == 600
    assert supervisor.MAX_TIMEOUT == 86400


@pytest.mark.parametrize("timeout", ["NaN", "Infinity", "-Infinity", "-1", "0", "true", '"60"'])
def test_timeout_that_is_not_a_positive_finite_number_is_a_bad_request(kernel, ws, timeout):
    # Written by hand: NaN and Infinity are what a careless client's JSON holds.
    dir = str(ws / "bracket")
    kernel.send_raw(f'{{"id":"t","op":"build","dir":"{dir}","model":"bracket.py","timeout":{timeout}}}')
    reply, _ = kernel.recv(5)
    assert reply == {
        "id": "t",
        "ok": False,
        "error": {
            "kind": "bad_request",
            "message": "build timeout must be a positive, finite number of seconds",
        },
    }


def test_enormous_timeout_is_capped_and_the_build_runs(kernel, ws):
    # 1e300 s from now is no time the event loop can wait until.
    id = kernel.send("build", dir=str(ws / "bracket"), model="bracket.py", timeout=1e300)
    assert kernel.recv(5)[0]["event"] == "build.started"
    reply, _ = kernel.recv(20)
    assert reply["id"] == id and reply["ok"], reply


def test_capped_timeout_is_a_day():
    from torno_kernel.supervisor import build_timeout

    assert build_timeout(None) == 600
    assert build_timeout(1e300) == 86400
    assert build_timeout(86401) == 86400
    assert build_timeout(90) == 90.0
    for bad in (float("nan"), float("inf"), -1, 0, True, "60"):
        assert build_timeout(bad) is None


GARBAGE_MODEL = """
import os, socket, stat, struct

# Stand in for a worker gone wrong: write a frame that is not JSON, or not a
# result, on the socket the worker answers the supervisor on.
PAYLOAD = {payload!r}
for fd in range(3, 64):
    try:
        if stat.S_ISSOCK(os.fstat(fd).st_mode):
            os.write(fd, struct.pack(">II", len(PAYLOAD), 0) + PAYLOAD)
    except OSError:
        pass
import time
time.sleep(30)
"""


@pytest.mark.parametrize("payload", [b"not json", b"null", b"[1]", b'{"ok":true}', b'{"ok":false}'])
def test_worker_frame_that_is_no_result_is_a_crash_of_that_build_only(fresh, ws, tmp_path, payload):
    (tmp_path / "garbage.py").write_text(GARBAGE_MODEL.format(payload=payload))
    id = fresh.send("build", dir=str(tmp_path), model="garbage.py")
    started, _ = fresh.recv(5)
    assert started["event"] == "build.started"
    reply, _ = fresh.recv(5)
    assert reply["id"] == id
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "crash"
    assert reply["error"]["message"] == "the build process sent a result that could not be read"
    assert gone(started["pid"])
    # The supervisor is still there.
    assert fresh.proc.poll() is None
    build_bracket(fresh, ws)


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
    reply = bracket_kernel.describe(BRACKET, "assembly:base")
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
    result = bracket_kernel.describe(BRACKET, "assembly:base/F0")["result"]
    assert result["kind"] == "face"
    assert result["ref"] == "assembly:base/F0"
    assert result["type"] == "plane"
    assert result["area"] == pytest.approx(150)
    assert math.hypot(*result["normal"]) == pytest.approx(1)
    assert result["center"] == pytest.approx([-20, 0, 0])
    assert result["normal"] == pytest.approx([-1, 0, 0])
    assert result["radius"] is None


def test_describe_cylindrical_face_gives_its_radius_in_the_object_frame(bracket_kernel):
    count = bracket_kernel.describe(BRACKET, "assembly:post")["result"]["faceCount"]
    faces = [bracket_kernel.describe(BRACKET, f"assembly:post/F{i}")["result"] for i in range(count)]
    cylinders = [f for f in faces if f["type"] == "cylinder"]
    assert len(cylinders) == 1
    assert cylinders[0]["radius"] == pytest.approx(4)
    # The post stands 12.5 mm up in the assembly: positions are not part-local.
    assert cylinders[0]["center"][2] == pytest.approx(12.5)


def test_describe_edge(bracket_kernel):
    result = bracket_kernel.describe(BRACKET, "assembly:base/E1")["result"]
    assert result == {
        "kind": "edge",
        "ref": "assembly:base/E1",
        "type": "line",
        "length": pytest.approx(30),
        "center": pytest.approx([-20, 0, 2.5]),
        "descriptor": "line, 30 mm",
    }


def test_describe_replies_carry_a_descriptor(bracket_kernel):
    assert bracket_kernel.describe(BRACKET, "assembly:base")["result"]["descriptor"] == (
        "part, 40 × 30 × 5 mm, 6000 mm³, 6 faces"
    )
    assert bracket_kernel.describe(BRACKET, "assembly:base/F0")["result"]["descriptor"] == (
        "plane, normal -X, x = -20, 150 mm²"
    )


def test_nearest_over_the_protocol(bracket_kernel):
    anchors = [
        {"part": "base", "point": [5, 3, 5.5]},
        {"part": "gone", "point": [0, 0, 0]},
        {"part": "post", "point": [7, 0, 12]},
    ]
    reply = bracket_kernel.nearest(BRACKET, "assembly", anchors)
    assert reply["ok"] is True, reply
    above, gone_part, beside = reply["result"]["anchors"]
    assert above == {
        "part": "base",
        "found": True,
        "point": pytest.approx([5, 3, 2.5]),
        "normal": pytest.approx([0, 0, 1]),
        "ref": above["ref"],
        "distance": pytest.approx(3),
        "descriptor": "plane, normal +Z, z = 2.5, 1200 mm²",
    }
    # The ref is one describe takes once the layout is put in front of it.
    assert above["ref"].startswith("base/F")
    described = bracket_kernel.describe(BRACKET, f"assembly:{above['ref']}")["result"]
    assert described["descriptor"] == above["descriptor"]
    assert gone_part == {"part": "gone", "found": False}
    assert beside["descriptor"] == "cylinder, radius 4, axis Z, 502.7 mm²"
    assert beside["distance"] == pytest.approx(3)


def test_nearest_in_an_unknown_layout_is_bad_ref_naming_the_layouts(bracket_kernel):
    reply = bracket_kernel.nearest(BRACKET, "exploded", [])
    assert reply["ok"] is False
    assert reply["error"] == {
        "kind": "bad_ref",
        "message": "no layout 'exploded'; the layouts are assembly, print",
    }


def test_describe_unknown_part_lists_the_valid_keys(bracket_kernel):
    reply = bracket_kernel.describe(BRACKET, "assembly:nope")
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "bad_ref"
    for key in ("assembly:base", "assembly:post", "print:base", "print:post"):
        assert key in reply["error"]["message"]


def test_describe_face_index_out_of_range_is_bad_ref(bracket_kernel):
    reply = bracket_kernel.describe(BRACKET, "assembly:base/F6")
    assert reply["error"]["kind"] == "bad_ref"
    assert "6 faces" in reply["error"]["message"]


def test_unknown_query_and_unknown_op_are_bad_requests(bracket_kernel):
    id = bracket_kernel.send("query", dir=str(BRACKET), name="nope", args={})
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
    assert bracket_kernel.describe(BRACKET, "assembly:base")["ok"] is True


def test_a_thousand_pipelined_queries_are_all_answered_in_order(bracket_kernel):
    stdin = bracket_kernel.proc.stdin
    pipelined = io.BytesIO()
    for i in range(1000):
        write_frame(
            pipelined,
            {
                "id": f"p{i}",
                "op": "query",
                "dir": str(BRACKET),
                "name": "describe",
                "args": {"ref": "assembly:base"},
            },
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
    reply = fresh.describe(BRACKET, "assembly:base")
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "no_build"
    fresh.send("shutdown")
    assert fresh.proc.wait(2) == 0


def test_query_without_a_folder_is_a_bad_request(bracket_kernel):
    id = bracket_kernel.send("query", name="describe", args={"ref": "assembly:base"})
    reply, _ = bracket_kernel.recv(5)
    assert reply == {
        "id": id,
        "ok": False,
        "error": {"kind": "bad_request", "message": "query needs dir, the object's folder, a string"},
    }


def test_each_object_is_answered_by_its_own_build_whichever_built_last(fresh, ws):
    bracket, plain = ws / "bracket", ws / "plain"
    build_bracket(fresh, ws)
    reply, _ = fresh.build(plain, "plain.py")
    assert reply["ok"], reply
    [plate] = [p["key"] for p in reply["scene"]["parts"]]
    # The plain plate built last; the bracket is still the bracket.
    assert fresh.describe(bracket, "assembly:base")["result"]["volume"] == pytest.approx(6000)
    assert fresh.describe(plain, plate)["result"]["volume"] == pytest.approx(800)
    # Neither knows the other's parts.
    assert fresh.describe(plain, "assembly:base")["error"]["kind"] == "bad_ref"
    assert fresh.describe(bracket, plate)["error"]["kind"] == "bad_ref"
    layout = plate.split(":")[0]
    near_plate = fresh.nearest(plain, layout, [{"part": "plate", "point": [0, 0, 4]}])
    assert near_plate["result"]["anchors"][0]["distance"] == pytest.approx(3)
    near_base = fresh.nearest(bracket, "assembly", [{"part": "plate", "point": [0, 0, 4]}])
    assert near_base["result"]["anchors"] == [{"part": "plate", "found": False}]
    # A folder that was never built has nothing to ask.
    never = fresh.describe(ws / "chatty", "assembly:plate")
    assert never["error"]["kind"] == "no_build"
    assert str(ws / "chatty") in never["error"]["message"]


def test_failed_build_of_one_object_leaves_every_live_worker(fresh, ws):
    build_bracket(fresh, ws)
    assert fresh.build(ws / "plain", "plain.py")[0]["ok"]
    assert fresh.build(ws / "broken", "broken.py")[0]["ok"] is False
    assert fresh.describe(ws / "bracket", "assembly:base")["ok"] is True
    assert fresh.describe(ws / "plain", "main:plate")["ok"] is True
    assert fresh.describe(ws / "broken", "assembly:base")["error"]["kind"] == "no_build"


def copies(ws, tmp_path, count: int) -> list[Path]:
    """Object folders that each hold the bracket."""
    folders = []
    for i in range(count):
        folder = tmp_path / f"object{i}"
        folder.mkdir()
        (folder / "bracket.py").write_text((ws / "bracket" / "bracket.py").read_text())
        folders.append(folder)
    return folders


def started_build(k: Kernel, folder) -> int:
    """Build the bracket in ``folder``; returns the worker's pid."""
    id = k.send("build", dir=str(folder), model="bracket.py")
    started, _ = k.recv(5)
    reply, _ = k.recv(20)
    assert (started["id"], reply["id"], reply["ok"]) == (id, id, True), reply
    return started["pid"]


def test_a_fifth_object_retires_the_least_recently_used(fresh, ws, tmp_path):
    folders = copies(ws, tmp_path, 5)
    pids = [started_build(fresh, folder) for folder in folders]
    first = fresh.describe(folders[0], "assembly:base")
    assert first["error"]["kind"] == "no_build"
    assert gone(pids[0])
    for folder, pid in zip(folders[1:], pids[1:], strict=True):
        assert not gone(pid)
        assert fresh.describe(folder, "assembly:base")["result"]["volume"] == pytest.approx(6000)


def test_a_query_counts_as_use_when_choosing_which_to_retire(fresh, ws, tmp_path):
    folders = copies(ws, tmp_path, 5)
    pids = [started_build(fresh, folder) for folder in folders[:4]]
    # The first was built longest ago, but it is the one just asked.
    assert fresh.describe(folders[0], "assembly:base")["ok"] is True
    pids.append(started_build(fresh, folders[4]))
    assert fresh.describe(folders[1], "assembly:base")["error"]["kind"] == "no_build"
    assert gone(pids[1])
    for index in (0, 2, 3, 4):
        assert fresh.describe(folders[index], "assembly:base")["ok"] is True
    # Building one of the four again does not retire any of them.
    pids.append(started_build(fresh, folders[2]))
    assert gone(pids[2])
    for index in (0, 2, 3, 4):
        assert fresh.describe(folders[index], "assembly:base")["ok"] is True


def test_cancelling_a_build_leaves_the_live_workers(fresh, ws):
    build_bracket(fresh, ws)
    assert fresh.build(ws / "plain", "plain.py")[0]["ok"]
    fresh.send("build", dir=str(ws / "bracket"), model="bracket.py")  # cancelled at once
    fresh.send("build", dir=str(ws / "slow"), model="slow.py")
    frames = [fresh.recv(5)[0] for _ in range(3)]
    assert sorted(f.get("event") or f["error"]["kind"] for f in frames) == [
        "build.started",
        "build.started",
        "cancelled",
    ]
    fresh.send("cancel")
    assert fresh.recv(5)[0]["error"]["kind"] == "cancelled"
    assert fresh.describe(ws / "bracket", "assembly:base")["ok"] is True
    assert fresh.describe(ws / "plain", "main:plate")["ok"] is True


def test_closing_stdin_leaves_no_live_worker_of_any_object(fresh, ws, tmp_path):
    pids = [started_build(fresh, folder) for folder in copies(ws, tmp_path, 3)]
    assert not any(gone(pid) for pid in pids)
    fresh.proc.stdin.close()
    assert fresh.proc.wait(2) == 0
    assert all(gone(pid) for pid in pids)


def test_failed_build_keeps_the_previous_worker_for_queries(kernel, ws):
    build_bracket(kernel, ws)
    reply, _ = kernel.build(ws / "broken", "broken.py")
    assert reply["ok"] is False
    assert kernel.describe(ws / "bracket", "assembly:base")["result"]["volume"] == pytest.approx(6000)


def test_queries_are_answered_while_another_build_runs(kernel, ws):
    build_bracket(kernel, ws)
    kernel.send("build", dir=str(ws / "slow"), model="slow.py")
    assert kernel.recv(5)[0]["event"] == "build.started"
    assert kernel.describe(ws / "bracket", "assembly:base")["result"]["volume"] == pytest.approx(6000)
    kernel.send("cancel")
    assert kernel.recv(5)[0]["error"]["kind"] == "cancelled"


def test_successful_build_replaces_and_stops_the_previous_worker(kernel, ws):
    id = kernel.send("build", dir=str(ws / "bracket"), model="bracket.py")
    first, _ = kernel.recv(5)
    assert kernel.recv(20)[0]["ok"] is True
    assert first["id"] == id
    # Another object's build leaves it alone.
    reply, _ = kernel.build(ws / "chatty", "chatty.py")
    assert reply["ok"] is True
    assert not gone(first["pid"])
    # The next build of the same object replaces it.
    build_bracket(kernel, ws)
    assert gone(first["pid"])
    assert kernel.describe(ws / "bracket", "assembly:base")["ok"] is True
    assert kernel.describe(ws / "chatty", "assembly:plate")["ok"] is True


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


def test_scene_that_cannot_be_serialised_is_an_exception_reply(monkeypatch):
    """The worker's one result frame: a NaN in the scene must not end it without one."""
    from torno_kernel import loader, tess, worker
    from torno_kernel.frames import read_frame

    monkeypatch.setattr(loader, "load_scene", lambda dir, model: {"main": {}})
    scene = {"model": "nan.py", "layouts": ["main"], "parts": [{"volume": float("nan")}]}
    monkeypatch.setattr(tess, "build_scene", lambda layouts, model: (scene, b"blob", {"k": 1}))
    channel = io.BytesIO()
    assert worker._build(channel, "/nowhere", "nan.py") is None
    channel.seek(0)
    reply, blob = read_frame(channel)
    assert blob == b""
    assert reply["ok"] is False
    assert reply["error"]["kind"] == "exception"
    assert "Out of range float values are not JSON compliant" in reply["error"]["message"]
    assert read_frame(channel) is None  # one frame, and nothing half written before it


class Routed:
    """A supervisor in this process, with stand-ins for its workers.

    For what cannot be arranged from outside: which of two frames it reads in
    one round, and a worker that takes too long over a query. Each stand-in is
    a real child, so that it can be signalled and reaped, and a socket whose
    other end the test holds.
    """

    def __init__(self) -> None:
        import socket
        import subprocess

        from torno_kernel import supervisor

        self._socket, self._subprocess, self._module = socket, subprocess, supervisor
        stdin, self.requests = os.pipe()
        self.replies, out = os.pipe()
        self._fds = [stdin, self.requests, self.replies]
        self._out = os.fdopen(out, "wb", buffering=0)
        self.supervisor = supervisor.Supervisor(stdin, self._out)
        self._decoder = supervisor._Decoder()
        self._children = []
        self._ends = []

    def worker(self, dir: str, request_id=None):
        """A stand-in worker and the test's end of its socket."""
        ours, theirs = self._socket.socketpair()
        ours.setblocking(False)
        child = self._subprocess.Popen(["sleep", "60"])
        self._children.append(child)
        self._ends += [ours, theirs]
        now = time.monotonic()
        outbox = self._module._Outbox(ours.send)
        worker = self._module._Worker(child.pid, dir, ours, request_id, now, now + 60, 60, None, outbox)
        return worker, theirs

    def request(self, **fields) -> None:
        frame = io.BytesIO()
        write_frame(frame, fields)
        os.write(self.requests, frame.getvalue())

    def sent(self) -> list[dict]:
        """The frames the supervisor has written to its client so far."""
        os.set_blocking(self.replies, False)
        frames = []
        try:
            while chunk := os.read(self.replies, 1 << 16):
                frames += [header for header, _ in self._decoder.feed(chunk)]
        except BlockingIOError:
            pass
        return frames

    def close(self) -> None:
        for child in self._children:
            child.kill()
            try:
                os.waitpid(child.pid, 0)
            except ChildProcessError:
                pass  # the supervisor reaped it
            child.returncode = -9
        for end in self._ends:
            end.close()
        self._out.close()
        for fd in self._fds:
            os.close(fd)


@pytest.fixture
def routed():
    r = Routed()
    yield r
    r.close()


def frame(header: dict) -> bytes:
    data = io.BytesIO()
    write_frame(data, header)
    return data.getvalue()


def test_reply_already_received_is_passed_on_when_a_build_replaces_its_worker(routed):
    sup = routed.supervisor
    live, live_end = routed.worker("/object")
    building, building_end = routed.worker("/object", request_id="build")
    sup._live["/object"] = live
    sup._building = building
    live.queries += [("answered", time.monotonic() + 30), ("unanswered", time.monotonic() + 30)]
    # Both are there to read in the same round: the answer, and the result that retires its worker.
    live_end.sendall(frame({"id": "answered", "ok": True, "result": {"volume": 1}}))
    building_end.sendall(frame({"ok": True, "scene": {"model": "m.py", "layouts": [], "parts": []}}))
    sup._step()
    sent = routed.sent()
    assert [(f["id"], f["ok"]) for f in sent] == [("answered", True), ("unanswered", False), ("build", True)]
    assert sent[0]["result"] == {"volume": 1}
    assert sent[1]["error"]["kind"] == "cancelled"
    assert sup._live == {"/object": building}
    assert gone(live.pid)


def test_query_not_answered_in_time_is_a_timeout_and_the_worker_is_left_alone(routed, monkeypatch):
    from torno_kernel import supervisor

    assert supervisor.QUERY_TIMEOUT == 30
    monkeypatch.setattr(supervisor, "QUERY_TIMEOUT", 0.3)
    sup = routed.supervisor
    live, live_end = routed.worker("/object")
    sup._live["/object"] = live
    routed.request(id="slow", op="query", dir="/object", name="describe", args={"ref": "a:b"})
    start = time.monotonic()
    sup._step()  # reads the request and sends the query on
    assert routed.sent() == []
    sup._step()  # wakes at the query's deadline, with nothing to read
    assert 0.25 < time.monotonic() - start < 2
    assert routed.sent() == [
        {
            "id": "slow",
            "ok": False,
            "error": {
                "kind": "timeout",
                "message": "the query was not answered within 0.3 s; "
                "the build it was sent to is still there",
            },
        }
    ]
    assert sup._live == {"/object": live}
    assert not gone(live.pid)

    # The answer, when it does come, is nobody's: it is dropped, and the next query is answered.
    live_end.sendall(frame({"id": "slow", "ok": True, "result": {}}))
    sup._step()
    assert routed.sent() == []
    routed.request(id="next", op="query", dir="/object", name="describe", args={"ref": "a:b"})
    sup._step()
    live_end.sendall(frame({"id": "next", "ok": True, "result": {"n": 1}}))
    sup._step()
    assert routed.sent() == [{"id": "next", "ok": True, "result": {"n": 1}}]
    assert sup._live == {"/object": live}


def test_after_a_timeout_later_queries_are_timeouts_at_once_until_the_worker_answers(routed, monkeypatch):
    from torno_kernel import supervisor

    monkeypatch.setattr(supervisor, "QUERY_TIMEOUT", 0.3)
    sup = routed.supervisor
    live, live_end = routed.worker("/object")
    other, other_end = routed.worker("/other")
    sup._live["/object"] = live
    sup._live["/other"] = other
    routed.request(id="slow", op="query", dir="/object", name="nearest", args={})
    sup._step()
    sup._step()  # the deadline passes
    assert [f["error"]["kind"] for f in routed.sent()] == ["timeout"]

    # The worker is still busy with that one: the next is not made to wait for it.
    routed.request(id="second", op="query", dir="/object", name="describe", args={"ref": "a:b"})
    routed.request(id="elsewhere", op="query", dir="/other", name="describe", args={"ref": "a:b"})
    start = time.monotonic()
    sup._step()
    assert time.monotonic() - start < 0.2
    assert routed.sent() == [
        {
            "id": "second",
            "ok": False,
            "error": {
                "kind": "timeout",
                "message": "the build of /object is still busy with a query it did not answer "
                "within 0.3 s; ask again when it has",
            },
        }
    ]
    # It was not sent on, so nothing waits for an answer; another object's worker is asked as ever.
    assert live.queries == []
    assert [id for id, _ in other.queries] == ["elsewhere"]
    other_end.sendall(frame({"id": "elsewhere", "ok": True, "result": {"n": 2}}))
    sup._step()
    assert routed.sent() == [{"id": "elsewhere", "ok": True, "result": {"n": 2}}]

    # Its late answer is dropped, and says it is free again.
    live_end.sendall(frame({"id": "slow", "ok": True, "result": {}}))
    sup._step()
    assert routed.sent() == []
    routed.request(id="third", op="query", dir="/object", name="describe", args={"ref": "a:b"})
    sup._step()
    assert [id for id, _ in live.queries] == ["third"]
    live_end.sendall(frame({"id": "third", "ok": True, "result": {"n": 3}}))
    sup._step()
    assert routed.sent() == [{"id": "third", "ok": True, "result": {"n": 3}}]
    assert sup._live == {"/other": other, "/object": live}
    assert not gone(live.pid)


def test_the_wait_ends_at_the_earlier_of_the_build_and_query_deadlines(routed, monkeypatch):
    from torno_kernel import supervisor

    monkeypatch.setattr(supervisor, "QUERY_TIMEOUT", 0.2)
    sup = routed.supervisor
    live, _ = routed.worker("/object")
    building, _ = routed.worker("/other", request_id="build")  # its deadline is a minute away
    sup._live["/object"] = live
    sup._building = building
    routed.request(id="q", op="query", dir="/object", name="describe", args={})
    sup._step()
    start = time.monotonic()
    sup._step()
    assert time.monotonic() - start < 2
    assert [f["error"]["kind"] for f in routed.sent()] == ["timeout"]
    assert sup._building is building and not gone(building.pid)
