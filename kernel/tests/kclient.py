"""Test client for the kernel: spawns it and exchanges frames over its pipes."""

import json
import os
import select
import struct
import subprocess
import sys
import time

from torno_kernel.frames import write_frame

_PREFIX = struct.Struct(">II")


class Kernel:
    """A running ``python -m torno_kernel``. ``ready`` is its first frame."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "torno_kernel"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            bufsize=0,
        )
        self._next_id = 0
        self.ready, _ = self.recv(60)

    def send(self, op: str, **fields) -> int:
        """Send a request and return its id."""
        self._next_id += 1
        write_frame(self.proc.stdin, {"id": self._next_id, "op": op, **fields})
        return self._next_id

    def recv(self, timeout: float) -> tuple[dict, bytes]:
        """The next frame. Raises TimeoutError, or EOFError if the kernel closed its end."""
        deadline = time.monotonic() + timeout
        header_len, blob_len = _PREFIX.unpack(self._read(_PREFIX.size, deadline))
        header = json.loads(self._read(header_len, deadline).decode("utf-8"))
        return header, self._read(blob_len, deadline)

    def build(self, dir, model: str, timeout: float = 20, **fields) -> tuple[dict, bytes]:
        """Run one build to its final reply, checking ``build.started`` came first."""
        id = self.send("build", dir=str(dir), model=model, **fields)
        started, _ = self.recv(5)
        assert started["id"] == id and started["event"] == "build.started", started
        reply, blob = self.recv(timeout)
        assert reply["id"] == id, reply
        return reply, blob

    def describe(self, ref: str) -> dict:
        id = self.send("query", name="describe", args={"ref": ref})
        reply, _ = self.recv(10)
        assert reply["id"] == id, reply
        return reply

    def close(self) -> None:
        """Close stdin and wait for the kernel to exit."""
        if self.proc.stdin and not self.proc.stdin.closed:
            self.proc.stdin.close()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.proc.stdout.close()

    def _read(self, n: int, deadline: float) -> bytes:
        fd = self.proc.stdout.fileno()
        data = bytearray()
        while len(data) < n:
            ready, _, _ = select.select([fd], [], [], max(0.0, deadline - time.monotonic()))
            if not ready:
                raise TimeoutError(f"no frame from the kernel: got {len(data)} of {n} bytes")
            chunk = os.read(fd, n - len(data))
            if not chunk:
                raise EOFError("the kernel closed its output")
            data += chunk
        return bytes(data)
