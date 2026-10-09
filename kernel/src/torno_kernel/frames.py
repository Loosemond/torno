"""Kernel frame codec.

A frame is ``u32 BE headerLen | u32 BE blobLen | header (UTF-8 JSON) | blob``.
``blobLen`` is 0 when there is no blob.
"""

import json
import struct
from typing import BinaryIO

_PREFIX = struct.Struct(">II")


def write_frame(fp: BinaryIO, header: dict, blob: bytes = b"") -> None:
    """Write one frame to ``fp`` and flush it.

    Raises ValueError, before anything is written, for a header that holds NaN
    or an infinity: Python would write them as bare words, which are not JSON.
    """
    encoded = json.dumps(
        header, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")
    fp.write(_PREFIX.pack(len(encoded), len(blob)))
    fp.write(encoded)
    if blob:
        fp.write(blob)
    fp.flush()


def read_frame(fp: BinaryIO) -> tuple[dict, bytes] | None:
    """Read one frame from ``fp``.

    Returns None when the stream ends cleanly between frames, and raises
    EOFError when it ends inside one.
    """
    prefix = _read_up_to(fp, _PREFIX.size)
    if not prefix:
        return None
    if len(prefix) < _PREFIX.size:
        raise EOFError("stream ended inside a frame prefix")
    header_len, blob_len = _PREFIX.unpack(prefix)
    header = _read_exactly(fp, header_len, "header")
    blob = _read_exactly(fp, blob_len, "blob")
    return json.loads(header.decode("utf-8")), blob


def _read_up_to(fp: BinaryIO, n: int) -> bytes:
    """Read ``n`` bytes, or fewer only if the stream ends first."""
    chunks = []
    remaining = n
    while remaining:
        chunk = fp.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _read_exactly(fp: BinaryIO, n: int, what: str) -> bytes:
    data = _read_up_to(fp, n)
    if len(data) < n:
        raise EOFError(f"stream ended inside a frame {what}: got {len(data)} of {n} bytes")
    return data
