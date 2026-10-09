"""The import process: every format, units, the up axis, colours, the limit, what is refused."""

import json
import subprocess
import sys

import numpy as np
import pytest
import scanfix

from torno_kernel import scanfile, scans

BOX = scanfix.box((40, 30, 5))


def run(capsys, *argv) -> tuple[int, dict]:
    status = scans.main([str(a) for a in argv])
    return status, json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_an_stl_in_millimetres_is_kept_as_it_is(tmp_path, capsys):
    source = scanfix.write_stl(tmp_path / "box.stl", *BOX)
    status, said = run(capsys, "import", source, tmp_path / "mesh.bin")
    assert status == 0 and said["ok"] is True
    assert (said["unit"], said["up"], said["assumed"]) == ("mm", "z", {"unit": True, "up": True})
    assert (said["vertices"], said["triangles"], said["colours"], said["reduced"]) == (8, 12, "none", None)
    assert said["bbox"] == {"min": [-20, -15, -2.5], "max": [20, 15, 2.5]}
    assert said["area"] == pytest.approx(3100)
    assert said["source"]["bytes"] == source.stat().st_size and len(said["source"]["sha256"]) == 64
    vertices, triangles, colours = scanfile.read_bin(tmp_path / "mesh.bin")
    assert len(vertices) == 8 and len(triangles) == 12 and colours is None


def test_a_glb_is_metres_and_y_up_and_its_texture_becomes_colours(tmp_path, capsys):
    source = scanfix.write_glb(tmp_path / "box.glb", *BOX)
    status, said = run(capsys, "import", source, tmp_path / "mesh.bin")
    assert status == 0 and (said["unit"], said["up"], said["colours"]) == ("m", "y", "texture")
    assert said["bbox"]["min"] == pytest.approx([-20, -15, -2.5], abs=1e-4)
    assert said["bbox"]["max"] == pytest.approx([20, 15, 2.5], abs=1e-4)
    _, _, colours = scanfile.read_bin(tmp_path / "mesh.bin")
    # Every vertex has the uv of the bottom left pixel.
    assert {tuple(c) for c in colours.tolist()} == {(*scanfix.TEXTURE[1][0], 255)}


def test_a_ply_keeps_its_vertex_colours(tmp_path, capsys):
    vertices, triangles = scanfix.grid(4)
    paint = [[n * 10, 100, 200] for n in range(len(vertices))]
    source = scanfix.write_ply(tmp_path / "sheet.ply", vertices * 100, triangles, paint)
    status, said = run(capsys, "import", source, tmp_path / "mesh.bin")
    assert status == 0 and said["colours"] == "vertex" and said["unit"] == "mm"
    _, _, colours = scanfile.read_bin(tmp_path / "mesh.bin")
    assert colours[:, :3].tolist() == paint and set(colours[:, 3].tolist()) == {255}


def test_an_obj_is_y_up_and_a_small_one_is_metres(tmp_path, capsys):
    vertices, triangles = BOX
    in_obj = np.stack([vertices[:, 0], vertices[:, 2], -vertices[:, 1]], axis=1) / 1000
    status, said = run(capsys, "import", scanfix.write_obj(tmp_path / "box.obj", in_obj, triangles), tmp_path / "mesh.bin")
    assert status == 0 and (said["unit"], said["up"]) == ("m", "y")
    assert said["bbox"]["max"] == pytest.approx([20, 15, 2.5], abs=1e-4)


@pytest.mark.parametrize("suffix, diagonal, expected", [(".glb", 5000, ("m", "y")), (".gltf", 0.1, ("m", "y")), (".obj", 0.3, ("m", "y")), (".obj", 300, ("mm", "y")),
                                                       (".stl", 1300, ("mm", "z")), (".stl", 1.3, ("m", "z")), (".ply", 25, ("mm", "z")), (".ply", 19.9, ("m", "z"))])
def test_what_is_assumed_of_a_file(suffix, diagonal, expected):
    assert scans.guess(suffix, diagonal) == expected


def test_a_unit_and_an_up_axis_that_are_given_are_not_assumed(tmp_path, capsys):
    source = scanfix.write_stl(tmp_path / "box.stl", *BOX)
    status, said = run(capsys, "import", source, tmp_path / "mesh.bin", "--unit", "in", "--up", "y")
    assert status == 0 and said["assumed"] == {"unit": False, "up": False}
    # (x, y, z) → (x, −z, y), then inches to millimetres.
    assert said["bbox"]["max"] == pytest.approx([20 * 25.4, 2.5 * 25.4, 15 * 25.4], rel=1e-6)


def test_unit_and_up_are_changed_afterwards_without_the_source(tmp_path, capsys):
    source = scanfix.write_stl(tmp_path / "box.stl", *BOX)
    run(capsys, "import", source, tmp_path / "mesh.bin")
    source.unlink()
    status, said = run(capsys, "convert", tmp_path / "mesh.bin", "--from-unit", "mm", "--to-unit", "cm", "--from-up", "z", "--to-up", "y")
    assert status == 0 and (said["unit"], said["up"], said["assumed"]) == ("cm", "y", {"unit": False, "up": False})
    assert said["bbox"]["max"] == pytest.approx([200, 25, 150], rel=1e-6) and "source" not in said
    status, back = run(capsys, "convert", tmp_path / "mesh.bin", "--from-unit", "cm", "--to-unit", "mm", "--from-up", "y", "--to-up", "z")
    assert back["bbox"]["max"] == pytest.approx([20, 15, 2.5], abs=1e-4) and back["triangles"] == 12


def test_above_the_limit_it_is_reduced_and_says_so(tmp_path, capsys):
    vertices, triangles = scanfix.grid(60)
    source = scanfix.write_stl(tmp_path / "sheet.stl", vertices * 10, triangles)
    status, said = run(capsys, "import", source, tmp_path / "mesh.bin", "--max-triangles", "2000")
    assert status == 0 and 0 < said["triangles"] <= 2000
    assert said["reduced"]["from"] == 6962 and said["reduced"]["cell"] > 0
    assert said["bbox"]["max"][0] == pytest.approx(295, abs=said["reduced"]["cell"])


def test_a_point_cloud_is_refused(tmp_path, capsys):
    vertices, _ = scanfix.grid(4)
    status, said = run(capsys, "import", scanfix.write_ply(tmp_path / "cloud.ply", vertices, []), tmp_path / "mesh.bin")
    assert status == 1 and said == {"ok": False, "error": {"kind": "no_triangles", "message": "cloud.ply has no triangles: a point cloud cannot be shown or checked against"}}
    assert not (tmp_path / "mesh.bin").exists()


def test_what_is_no_mesh_and_what_is_no_format_are_refused(tmp_path, capsys):
    (tmp_path / "junk.glb").write_bytes(b"not a glb at all")
    status, said = run(capsys, "import", tmp_path / "junk.glb", tmp_path / "mesh.bin")
    assert status == 1 and said["error"]["kind"] == "unreadable" and "junk.glb" in said["error"]["message"]
    (tmp_path / "part.3mf").write_bytes(b"")
    status, said = run(capsys, "import", tmp_path / "part.3mf", tmp_path / "mesh.bin")
    assert status == 1 and said["error"] == {"kind": "bad_request", "message": "part.3mf is not a scan torno reads: .glb, .gltf, .obj, .ply or .stl"}
    status, said = run(capsys, "import", tmp_path / "gone.stl", tmp_path / "mesh.bin")
    assert status == 1 and said["error"]["kind"] == "unreadable" and "gone.stl" in said["error"]["message"]


def test_the_source_is_only_read(tmp_path, capsys):
    folder = tmp_path / "downloads"
    folder.mkdir()
    source = scanfix.write_stl(folder / "box.stl", *BOX)
    before = (source.read_bytes(), source.stat().st_mtime_ns)
    run(capsys, "import", source, tmp_path / "mesh.bin")
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before
    assert [p.name for p in folder.iterdir()] == ["box.stl"]


def test_the_process_says_one_line_of_json_last_and_its_stages_on_stderr(tmp_path):
    source = scanfix.write_stl(tmp_path / "box.stl", *BOX)
    done = subprocess.run([sys.executable, "-m", "torno_kernel.scans", "import", str(source), str(tmp_path / "mesh.bin")], capture_output=True, text=True, timeout=120)
    assert done.returncode == 0
    assert json.loads(done.stdout.strip().splitlines()[-1])["triangles"] == 12
    assert "stage: reading" in done.stderr and "stage: writing" in done.stderr


def test_the_module_brings_neither_the_cad_kernel_nor_trimesh_until_it_reads():
    code = "import sys, torno_kernel.scans, torno_kernel.scanfile; bad = [m for m in ('build123d', 'OCP', 'trimesh', 'PIL') if m in sys.modules]; sys.exit(repr(bad) if bad else 0)"
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr
