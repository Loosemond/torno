import io

import pytest

from torno_kernel.frames import read_frame, write_frame


def test_round_trips_header_and_blob():
    fp = io.BytesIO()
    write_frame(fp, {"id": 1, "ok": True, "name": "peça"}, b"\x00\x01\x02\xff")
    fp.seek(0)
    assert read_frame(fp) == ({"id": 1, "ok": True, "name": "peça"}, b"\x00\x01\x02\xff")


def test_layout_is_two_big_endian_lengths_then_json_then_blob():
    fp = io.BytesIO()
    write_frame(fp, {"id": 7}, b"abc")
    raw = fp.getvalue()
    header_len = int.from_bytes(raw[0:4], "big")
    assert int.from_bytes(raw[4:8], "big") == 3
    assert raw[8 : 8 + header_len].decode("utf-8") == '{"id":7}'
    assert raw[8 + header_len :] == b"abc"


def test_blob_defaults_to_empty():
    fp = io.BytesIO()
    write_frame(fp, {"op": "cancel"})
    assert fp.getvalue()[4:8] == b"\x00\x00\x00\x00"
    fp.seek(0)
    assert read_frame(fp) == ({"op": "cancel"}, b"")


def test_reads_two_frames_back_to_back():
    fp = io.BytesIO()
    write_frame(fp, {"id": 1}, b"first")
    write_frame(fp, {"id": 2})
    fp.seek(0)
    assert read_frame(fp) == ({"id": 1}, b"first")
    assert read_frame(fp) == ({"id": 2}, b"")
    assert read_frame(fp) is None


def test_returns_none_at_eof():
    assert read_frame(io.BytesIO()) is None


def test_raises_on_frame_cut_mid_blob():
    fp = io.BytesIO()
    write_frame(fp, {"id": 1}, b"0123456789")
    cut = io.BytesIO(fp.getvalue()[:-4])
    with pytest.raises(EOFError):
        read_frame(cut)


def test_raises_on_frame_cut_mid_prefix():
    with pytest.raises(EOFError):
        read_frame(io.BytesIO(b"\x00\x00\x00"))


def test_three_megabyte_blob_survives():
    blob = bytes(range(256)) * (3 * 1024 * 1024 // 256)
    fp = io.BytesIO()
    write_frame(fp, {"id": 1}, blob)
    fp.seek(0)
    header, got = read_frame(fp)
    assert header == {"id": 1}
    assert got == blob


def test_reads_whole_frame_from_a_stream_that_returns_short_reads():
    class Trickle(io.RawIOBase):
        def __init__(self, data):
            self.data = io.BytesIO(data)

        def readable(self):
            return True

        def readinto(self, b):
            return self.data.readinto(memoryview(b)[:3])

    fp = io.BytesIO()
    write_frame(fp, {"id": 9}, b"payload")
    assert read_frame(Trickle(fp.getvalue())) == ({"id": 9}, b"payload")


def test_refuses_a_header_that_is_not_json():
    # Python would write NaN and Infinity as bare words, which no JSON parser reads.
    for value in (float("nan"), float("inf")):
        stream = io.BytesIO()
        with pytest.raises(ValueError):
            write_frame(stream, {"volume": value})
        assert stream.getvalue() == b""
