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
