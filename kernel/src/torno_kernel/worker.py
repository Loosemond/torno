"""The forked build process: load, tessellate, reply once, then answer queries.

Everything here runs in a child of the supervisor and leaves through
``os._exit``, so the supervisor's own cleanup never runs twice.
"""

import ctypes
import os
import signal
import socket
import sys
import traceback
from pathlib import Path
from typing import Any, NoReturn

from . import loader, queries, tess
from .frames import read_frame, write_frame

_PR_SET_PDEATHSIG = 1
_PR_SET_DUMPABLE = 4


def run(sock: socket.socket, capture_fd: int, dir: str, model: str) -> NoReturn:
    """Build ``dir/model`` and serve queries on ``sock``. Never returns.

    The caller has already closed the supervisor's other descriptors.
    ``capture_fd`` receives everything the model writes to stdout and stderr.
    """
    try:
        _isolate(capture_fd)
        channel = sock.makefile("rwb")
        shapes = _build(channel, dir, model)
        if shapes is not None:
            _serve(channel, shapes)
    except BaseException:
        # Nothing may propagate into the supervisor's stack, which this
        # process inherited. A broken socket means the supervisor is gone.
        pass
    finally:
        os._exit(0)


def _isolate(capture_fd: int) -> None:
    libc = ctypes.CDLL(None)
    # No core dump: with systemd-coredump a crashed worker takes seconds to reap.
    libc.prctl(_PR_SET_DUMPABLE, 0)
    # Die with the supervisor even if it is killed before it can clean up.
    libc.prctl(_PR_SET_PDEATHSIG, int(signal.SIGKILL))
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)  # a model that reads stdin must not eat protocol frames
    os.close(devnull)
    os.dup2(capture_fd, 1)
    os.dup2(capture_fd, 2)
    # Line buffered, so the output survives a crash or a kill.
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)


def _build(channel: Any, dir: str, model: str) -> dict[str, Any] | None:
    """Send the build's one result frame. Returns the shapes, or None on failure."""
    try:
        layouts = loader.load_scene(Path(dir), model)
        scene, blob, shapes = tess.build_scene(layouts, model)
    except loader.LoadError as e:
        error = {"kind": e.kind, "message": e.message, "traceback": e.traceback}
    except SystemExit as e:
        error = _exception(f"{model} exited instead of defining a scene: sys.exit({e.code!r})")
    except BaseException as e:
        error = _exception(str(e) or type(e).__name__)
    else:
        _flush_output()
        write_frame(channel, {"ok": True, "scene": scene}, blob)
        return shapes
    _flush_output()
    write_frame(channel, {"ok": False, "error": error})
    return None


def _serve(channel: Any, shapes: dict[str, Any]) -> None:
    """Answer query frames until the supervisor closes the socket."""
    while (frame := read_frame(channel)) is not None:
        request, _ = frame
        try:
            result = queries.run(shapes, request.get("name"), request.get("args"))
        except queries.QueryError as e:
            reply = {"ok": False, "error": {"kind": e.kind, "message": e.message}}
        except Exception as e:
            reply = {"ok": False, "error": _exception(str(e) or type(e).__name__)}
        else:
            reply = {"ok": True, "result": result}
        write_frame(channel, {"id": request.get("id"), **reply})


def _exception(message: str) -> dict[str, str]:
    return {"kind": "exception", "message": message, "traceback": traceback.format_exc()}


def _flush_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
