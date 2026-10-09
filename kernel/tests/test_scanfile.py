"""``mesh.bin`` and ``.mask``, byte by byte."""

import struct

import numpy as np
import pytest
from scanfix import box

from torno_kernel import scanfile


def test_a_mesh_is_written_as_the_layout_says(tmp_path):
    vertices, triangles = box((40, 30, 5))
    said = scanfile.write_bin(tmp_path / "mesh.bin", vertices, triangles)
    raw = (tmp_path / "mesh.bin").read_bytes()
    assert raw[:8] == b"TORNOSCN"
    assert struct.unpack_from("<IIII", raw, 8) == (1, 0, 8, 12)
    assert struct.unpack_from("<6f", raw, 24) == (-20, -15, -2.5, 20, 15, 2.5)
    assert raw[48:64] == b"\0" * 16
    assert len(raw) == 64 + 12 * 8 + 12 * 12
    assert struct.unpack_from("<3f", raw, 64) == (-20, -15, -2.5)
    assert struct.unpack_from("<3I", raw, 64 + 12 * 8) == (0, 1, 3)
    assert said == {"vertices": 8, "triangles": 12, "bbox": {"min": [-20, -15, -2.5], "max": [20, 15, 2.5]}, "area": pytest.approx(3100)}


def test_colours_sit_between_the_vertices_and_the_triangles(tmp_path):
    vertices, triangles = box()
    colours = np.tile(np.array([[10, 20, 30, 255]], dtype=np.uint8), (8, 1))
    scanfile.write_bin(tmp_path / "mesh.bin", vertices, triangles, colours)
    raw = (tmp_path / "mesh.bin").read_bytes()
    assert struct.unpack_from("<I", raw, 12) == (1,)
    assert len(raw) == 64 + 12 * 8 + 4 * 8 + 12 * 12
    assert raw[64 + 96 : 64 + 100] == bytes([10, 20, 30, 255])
    assert struct.unpack_from("<3I", raw, 64 + 96 + 32) == (0, 1, 3)


def test_what_was_written_is_read_back(tmp_path):
    vertices, triangles = box()
    scanfile.write_bin(tmp_path / "mesh.bin", vertices, triangles)
    v, t, c = scanfile.read_bin(tmp_path / "mesh.bin")
    assert v.dtype == np.float32 and t.dtype == np.uint32 and c is None
    assert np.array_equal(v, vertices.astype(np.float32)) and np.array_equal(t, triangles)
    assert not list(tmp_path.glob("*.tmp"))


@pytest.mark.parametrize("damage, says", [(lambda raw: raw[:-4], "bytes"), (lambda raw: b"NOTASCAN" + raw[8:], "not a scan"), (lambda raw: raw[:8] + struct.pack("<I", 2) + raw[12:], "version")])
def test_a_file_that_is_not_one_is_refused(tmp_path, damage, says):
    scanfile.write_bin(tmp_path / "mesh.bin", *box())
    (tmp_path / "bad.bin").write_bytes(damage((tmp_path / "mesh.bin").read_bytes()))
    with pytest.raises(ValueError, match=says):
        scanfile.read_bin(tmp_path / "bad.bin")


@pytest.mark.parametrize("vertices, triangles, says", [(np.zeros((0, 3)), np.zeros((0, 3), int), "vertices and triangles"), (np.zeros((3, 3)), np.array([[0, 1, 3]]), "vertex 3"), (np.array([[0, 0, np.nan]] * 3), np.array([[0, 1, 2]]), "finite")])
def test_a_mesh_that_is_none_is_not_written(tmp_path, vertices, triangles, says):
    with pytest.raises(ValueError, match=says):
        scanfile.write_bin(tmp_path / "mesh.bin", vertices, triangles)
    assert not list(tmp_path.iterdir())


def test_a_mask_is_one_bit_a_triangle_lowest_first(tmp_path):
    bits = np.zeros(12, dtype=bool)
    bits[[0, 9]] = True
    scanfile.write_mask(tmp_path / "M7.mask", bits)
    raw = (tmp_path / "M7.mask").read_bytes()
    assert raw[:8] == b"TORNOMSK" and struct.unpack_from("<II", raw, 8) == (1, 12)
    assert raw[16:] == bytes([0b00000001, 0b00000010])
    assert np.array_equal(scanfile.read_mask(tmp_path / "M7.mask", 12), bits)
    with pytest.raises(ValueError, match="12 triangles, not 13"):
        scanfile.read_mask(tmp_path / "M7.mask", 13)


def test_a_mesh_whose_triangles_name_no_vertex_or_whose_vertices_are_no_numbers_is_not_read(tmp_path):
    scanfile.write_bin(tmp_path / "mesh.bin", *box())
    raw = (tmp_path / "mesh.bin").read_bytes()
    lost = bytearray(raw)
    struct.pack_into("<I", lost, 64 + 12 * 8, 4_000_000_000)
    (tmp_path / "lost.bin").write_bytes(lost)
    with pytest.raises(ValueError, match="a triangle names vertex 4000000000, and there are 8"):
        scanfile.read_bin(tmp_path / "lost.bin")
    nowhere = bytearray(raw)
    struct.pack_into("<f", nowhere, 64, float("nan"))
    (tmp_path / "nowhere.bin").write_bytes(nowhere)
    with pytest.raises(ValueError, match="a vertex is not finite"):
        scanfile.read_bin(tmp_path / "nowhere.bin")
    empty = raw[:16] + struct.pack("<II", 0, 0) + raw[24:64]
    (tmp_path / "empty.bin").write_bytes(empty)
    with pytest.raises(ValueError, match="no vertices or no triangles"):
        scanfile.read_bin(tmp_path / "empty.bin")


def test_a_mesh_with_no_area_is_not_written(tmp_path):
    with pytest.raises(ValueError, match="no area"):
        scanfile.write_bin(tmp_path / "mesh.bin", np.zeros((3, 3)) + 5, np.array([[0, 1, 2]] * 4))
    with pytest.raises(ValueError, match="no area"):
        scanfile.write_bin(tmp_path / "mesh.bin", np.array([[0.0, 0, 0], [1, 0, 0], [2, 0, 0]]), np.array([[0, 1, 2]]))
    assert not list(tmp_path.iterdir())


def test_a_mask_cut_short_says_so(tmp_path):
    scanfile.write_mask(tmp_path / "M7.mask", np.ones(20, dtype=bool))
    raw = (tmp_path / "M7.mask").read_bytes()
    (tmp_path / "short.mask").write_bytes(raw[:-1])
    with pytest.raises(ValueError, match="is truncated: 18 bytes, and its header says 19"):
        scanfile.read_mask(tmp_path / "short.mask", 20)
    (tmp_path / "head.mask").write_bytes(raw[:10])
    with pytest.raises(ValueError, match="is truncated"):
        scanfile.read_mask(tmp_path / "head.mask", 20)


def test_a_mask_is_written_whole_or_not_at_all(tmp_path, monkeypatch):
    first = np.zeros(12, dtype=bool)
    scanfile.write_mask(tmp_path / "M7.mask", first)
    assert [p.name for p in tmp_path.iterdir()] == ["M7.mask"]

    def fails(*_):
        raise OSError("no room")

    monkeypatch.setattr(scanfile.os, "replace", fails)
    with pytest.raises(OSError, match="no room"):
        scanfile.write_mask(tmp_path / "M7.mask", np.ones(12, dtype=bool))
    # A reader sees the old mask, and nothing is left beside it.
    assert np.array_equal(scanfile.read_mask(tmp_path / "M7.mask", 12), first)
    assert [p.name for p in tmp_path.iterdir()] == ["M7.mask"]
