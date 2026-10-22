"""``export`` and ``export_check``, in-process: the files of a build, and each read back before it is named.

Every shape is made here, in code; every file is written to a temporary folder by the test, as main writes the
bytes the worker answers with. No file is committed.
"""

import math
import struct
import zipfile
from pathlib import Path

import numpy as np
import pytest

from torno_kernel import export, queries


def hollow() -> dict:
    """The tub, its lid and a post on its own, in an assembly; the tub and the lid set apart for the bed."""
    from build123d import Box, Cylinder, Pos

    tub = Pos(0, 0, 19) * Box(40, 40, 38) - Pos(0, 0, 20) * Box(36, 36, 36)
    lid = Pos(0, 0, 39) * Box(40, 40, 2)
    post = Pos(60, 0, 10) * Cylinder(3, 20)
    return {
        "assembly:tub": tub,
        "assembly:lid": lid,
        "assembly:post": post,
        "print:tub": tub,
        "print:lid": Pos(60, 0, -38) * lid,
    }


def made(shapes, args, kept=None) -> tuple[dict, bytes]:
    reply = queries.run(shapes, "export", args, {} if kept is None else kept)
    assert isinstance(reply, queries.WithBlob)
    return reply.result, reply.blob


def checked(shapes, path: Path, args, kept=None) -> dict:
    return queries.run(shapes, "export_check", {**args, "path": str(path)}, {} if kept is None else kept)


def refused(shapes, name: str, args) -> tuple[str, str]:
    with pytest.raises(queries.QueryError) as caught:
        queries.run(shapes, name, args, {})
    return caught.value.kind, caught.value.message


def written(tmp_path: Path, name: str, data: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def stl_triangles(data: bytes) -> np.ndarray:
    (count,) = struct.unpack_from("<I", data, 80)
    return np.frombuffer(data, dtype=export.STL_TRIANGLE, count=count, offset=84)


def stl_of(triangles: np.ndarray) -> bytes:
    return b"torno test".ljust(80, b" ") + struct.pack("<I", len(triangles)) + triangles.tobytes()


# STEP


def test_step_holds_each_part_by_name_and_colour_and_reads_back_as_the_model(tmp_path):
    shapes = hollow()
    args = {"format": "step", "layout": "assembly", "parts": ["tub", "lid", "post"], "colors": {"tub": "#3a7bd5", "lid": "#e0a030"}, "name": "hollow"}
    result, data = made(shapes, args)
    assert data.startswith(b"ISO-10303-21;")
    assert result["format"] == "step" and result["layout"] == "assembly" and result["bytes"] == len(data)
    assert [part["name"] for part in result["parts"]] == ["tub", "lid", "post"]
    assert "triangles" not in result
    path = written(tmp_path, "hollow.step", data)
    said = checked(shapes, path, args)
    assert said["passed"] is True, said["problems"]
    assert said["problems"] == []
    assert [one["name"] for one in said["objects"]] == ["tub", "lid", "post"]
    tub = said["objects"][0]
    assert tub["solids"] == 1 and tub["volume"] == pytest.approx(40 * 40 * 38 - 36**3, rel=1e-9)
    assert said["volumeDeviation"] < 1e-4  # percent
    # What a CAD program reads of it: the parts by name, in the colours given.
    from build123d import import_step

    read = import_step(str(path))
    assert [child.label for child in read.children] == ["tub", "lid", "post"]
    r, g, b, _ = read.children[0].color
    assert (round(r * 255), round(g * 255), round(b * 255)) == (0x3A, 0x7B, 0xD5)
    # Nothing of the machine it was made on.
    assert str(tmp_path).encode() not in data and str(Path.home()).encode() not in data


def test_step_of_some_parts_has_those_alone(tmp_path):
    shapes = hollow()
    args = {"format": "step", "layout": "print", "parts": ["lid"]}
    _, data = made(shapes, args)
    said = checked(shapes, written(tmp_path, "lid.step", data), args)
    assert said["passed"] is True, said["problems"]
    assert [one["name"] for one in said["objects"]] == ["lid"]
    # Checked against more parts than it holds, it fails, and says which is missing.
    more = checked(shapes, tmp_path / "lid.step", {**args, "parts": ["tub", "lid"]})
    assert more["passed"] is False
    assert any("tub" in problem for problem in more["problems"])


def test_step_cut_short_fails_its_check(tmp_path):
    shapes = hollow()
    args = {"format": "step", "layout": "assembly", "parts": ["tub", "lid"]}
    _, data = made(shapes, args)
    said = checked(shapes, written(tmp_path, "short.step", data[: len(data) // 2]), args)
    assert said["passed"] is False and said["problems"]


def test_step_of_another_shape_under_the_same_name_fails_its_check(tmp_path):
    from build123d import Box

    shapes = hollow()
    args = {"format": "step", "layout": "assembly", "parts": ["lid"]}
    _, data = made({**shapes, "assembly:lid": Box(40, 40, 2.5)}, args)
    said = checked(shapes, written(tmp_path, "other.step", data), args)
    assert said["passed"] is False
    assert any("volume" in problem for problem in said["problems"])


# STL


def test_stl_is_one_part_meshed_at_the_tolerance_asked(tmp_path):
    shapes = hollow()
    args = {"format": "stl", "layout": "assembly", "parts": ["post"], "tolerance": 0.01}
    result, data = made(shapes, args)
    triangles = stl_triangles(data)
    assert len(data) == 84 + 50 * len(triangles) and result["bytes"] == len(data)
    assert not data.startswith(b"solid")  # a reader would take it for text
    assert result["triangles"] == len(triangles) and result["parts"][0]["triangles"] == len(triangles)
    assert result["tolerance"] == 0.01 and result["angle"] == export.ANGLE
    # Every corner on the cylinder, in the object frame: the post stands at x = 60.
    corners = triangles["corners"].reshape(-1, 3).astype(np.float64)
    radial = np.hypot(corners[:, 0] - 60, corners[:, 1])
    assert np.all((np.abs(radial - 3) < 1e-4) | (radial < 3)) and corners[:, 2].min() == pytest.approx(0, abs=1e-5)
    said = checked(shapes, written(tmp_path, "post.stl", data), args)
    assert said["passed"] is True, said["problems"]
    post = said["objects"][0]
    assert post["triangles"] == len(triangles) and post["openEdges"] == 0 and post["degenerate"] == 0 and post["flipped"] == 0
    exact = math.pi * 9 * 20
    assert post["volume"] < exact and post["volumeDeviation"] == pytest.approx(abs(post["volume"] - exact) / exact * 100)
    assert post["volumeDeviation"] <= post["volumeAllowed"]
    # Finer, more triangles and nearer the model; coarser, fewer.
    finer, _ = made(shapes, {**args, "tolerance": 0.001, "angle": 1})
    coarser, _ = made(shapes, {**args, "tolerance": 0.5, "angle": 30})
    assert finer["triangles"] > result["triangles"] > coarser["triangles"]


def test_stl_cut_short_fails_its_check(tmp_path):
    shapes = hollow()
    args = {"format": "stl", "layout": "assembly", "parts": ["tub"]}
    _, data = made(shapes, args)
    said = checked(shapes, written(tmp_path, "short.stl", data[:-50]), args)
    assert said["passed"] is False
    assert any("cut short" in problem for problem in said["problems"])
    # With its count put right, a triangle is missing: the mesh is not closed.
    triangles = stl_triangles(data)[:-1]
    said = checked(shapes, written(tmp_path, "open.stl", stl_of(triangles)), args)
    assert said["passed"] is False and said["objects"][0]["openEdges"] > 0
    assert any("not closed" in problem for problem in said["problems"])


def test_stl_turned_inside_out_or_with_a_face_flipped_fails_its_check(tmp_path):
    shapes = hollow()
    args = {"format": "stl", "layout": "assembly", "parts": ["lid"]}
    _, data = made(shapes, args)
    triangles = stl_triangles(data).copy()
    inside_out = triangles.copy()
    inside_out["corners"] = inside_out["corners"][:, [0, 2, 1]]
    said = checked(shapes, written(tmp_path, "inside-out.stl", stl_of(inside_out)), args)
    assert said["passed"] is False
    assert any("inside out" in problem for problem in said["problems"])
    flipped = triangles.copy()
    flipped["corners"][0] = flipped["corners"][0][[0, 2, 1]]
    said = checked(shapes, written(tmp_path, "flipped.stl", stl_of(flipped)), args)
    assert said["passed"] is False and said["objects"][0]["flipped"] > 0


def test_stl_with_a_triangle_of_no_area_fails_its_check(tmp_path):
    shapes = hollow()
    args = {"format": "stl", "layout": "assembly", "parts": ["lid"]}
    _, data = made(shapes, args)
    triangles = stl_triangles(data).copy()
    extra = triangles[:1].copy()
    extra["corners"][0, 2] = extra["corners"][0, 1]
    said = checked(shapes, written(tmp_path, "degenerate.stl", stl_of(np.concatenate([triangles, extra]))), args)
    assert said["passed"] is False and said["objects"][0]["degenerate"] == 1


def test_stl_of_another_part_fails_on_its_volume(tmp_path):
    shapes = hollow()
    _, data = made(shapes, {"format": "stl", "layout": "assembly", "parts": ["lid"]})
    said = checked(shapes, written(tmp_path, "lid.stl", data), {"format": "stl", "layout": "assembly", "parts": ["post"]})
    assert said["passed"] is False
    assert any("volume" in problem for problem in said["problems"])


def test_a_part_with_a_void_is_meshed_as_its_two_shells(tmp_path):
    from build123d import Box, Pos

    void = {"assembly:block": Box(20, 20, 20) - Pos(0, 0, 0) * Box(10, 10, 10)}
    args = {"format": "stl", "layout": "assembly", "parts": ["block"]}
    _, data = made(void, args)
    said = checked(void, written(tmp_path, "block.stl", data), args)
    assert said["passed"] is True, said["problems"]
    assert said["objects"][0]["pieces"] == 2 == said["objects"][0]["shells"]
    assert said["objects"][0]["volume"] == pytest.approx(20**3 - 10**3, rel=1e-6)


def test_a_part_in_two_pieces_where_the_model_has_one_fails(tmp_path):
    from build123d import Box, Pos

    shapes = {"assembly:a": Box(10, 10, 10), "assembly:b": Box(10, 10, 10) + Pos(30, 0, 0) * Box(10, 10, 10)}
    _, data = made(shapes, {"format": "stl", "layout": "assembly", "parts": ["b"]})
    said = checked({**shapes, "assembly:b": Box(10, 10, 10) + Pos(10, 0, 0) * Box(10, 10, 10)}, written(tmp_path, "b.stl", data), {"format": "stl", "layout": "assembly", "parts": ["b"]})
    assert said["passed"] is False
    assert any("pieces" in problem for problem in said["problems"])


# 3MF


def test_3mf_is_the_plate_each_part_a_named_object_in_millimetres_where_the_layout_has_it(tmp_path):
    shapes = hollow()
    args = {"format": "3mf", "layout": "print", "parts": ["tub", "lid"], "colors": {"tub": "#3a7bd5", "lid": "#e0a030"}}
    result, data = made(shapes, args)
    assert data.startswith(b"PK")
    assert [part["name"] for part in result["parts"]] == ["tub", "lid"]
    assert result["triangles"] == sum(part["triangles"] for part in result["parts"])
    with zipfile.ZipFile(written(tmp_path, "plate.3mf", data)) as zipped:
        model = zipped.read("3D/3dmodel.model").decode()
    assert 'unit="millimeter"' in model and 'name="tub"' in model and 'name="lid"' in model
    assert "#3A7BD5" in model.upper()
    said = checked(shapes, tmp_path / "plate.3mf", args)
    assert said["passed"] is True, said["problems"]
    assert [one["name"] for one in said["objects"]] == ["tub", "lid"]
    assert said["triangles"] == result["triangles"]
    assert all(one["volumeDeviation"] <= one["volumeAllowed"] for one in said["objects"])
    # The lid is where the layout put it, 60 mm along and on the bed.
    lid = said["objects"][1]
    assert lid["box"]["min"] == pytest.approx([40, -20, 0], abs=1e-4)
    assert lid["box"]["max"] == pytest.approx([80, 20, 2], abs=1e-4)


def test_3mf_cut_short_or_of_other_parts_fails_its_check(tmp_path):
    shapes = hollow()
    args = {"format": "3mf", "layout": "print", "parts": ["tub", "lid"]}
    _, data = made(shapes, args)
    said = checked(shapes, written(tmp_path, "short.3mf", data[: len(data) - 200]), args)
    assert said["passed"] is False and said["problems"]
    _, lid = made(shapes, {**args, "parts": ["lid"]})
    said = checked(shapes, written(tmp_path, "lid.3mf", lid), args)
    assert said["passed"] is False
    assert any("tub" in problem for problem in said["problems"])
    # A part moved from where the layout has it is not the plate asked for.
    from build123d import Pos

    _, moved = made({**shapes, "print:lid": Pos(5, 0, 0) * shapes["print:lid"]}, args)
    said = checked(shapes, written(tmp_path, "moved.3mf", moved), args)
    assert said["passed"] is False
    assert any("box" in problem for problem in said["problems"])


def test_a_round_part_is_meshed_closed_and_within_the_chord_loss_of_its_volume(tmp_path):
    from build123d import Cylinder, Pos, Sphere

    shapes = {"print:ball": Pos(0, 0, 10) * Sphere(10), "print:peg": Pos(30, 0, 5) * Cylinder(4, 10) - Pos(30, 0, 5) * Cylinder(1, 10)}
    args = {"format": "3mf", "layout": "print", "parts": ["ball", "peg"], "tolerance": 0.05}
    _, data = made(shapes, args)
    said = checked(shapes, written(tmp_path, "round.3mf", data), args)
    assert said["passed"] is True, said["problems"]
    ball = said["objects"][0]
    assert ball["openEdges"] == 0 and ball["degenerate"] == 0 and ball["pieces"] == 1
    assert 0 < ball["volumeDeviation"] < 0.5 and ball["volumeDeviation"] <= ball["volumeAllowed"]


# Requests


def test_what_an_export_is_refused_for():
    from build123d import Box

    shapes = {**hollow(), "assembly:sheet": Box(1, 1, 1).faces()[0]}
    base = {"format": "stl", "layout": "assembly", "parts": ["tub"]}
    assert refused(shapes, "export", {**base, "format": "obj"})[0] == "bad_request"
    assert refused(shapes, "export", {**base, "layout": "nowhere"})[0] == "bad_ref"
    assert refused(shapes, "export", {**base, "parts": []})[0] == "bad_request"
    assert refused(shapes, "export", {**base, "parts": ["tub", "tub"]})[0] == "bad_request"
    assert refused(shapes, "export", {**base, "parts": ["nothing"]})[0] == "bad_ref"
    kind, message = refused(shapes, "export", {**base, "parts": ["tub", "lid"]})
    assert kind == "bad_request" and "one part" in message
    kind, message = refused(shapes, "export", {**base, "parts": ["sheet"]})
    assert kind == "bad_request" and "not a solid" in message
    for tolerance in (0, -1, 0.0001, 2, float("nan"), "0.01", True):
        assert refused(shapes, "export", {**base, "tolerance": tolerance})[0] == "bad_request"
    for angle in (0, 0.1, 60, None):
        assert refused(shapes, "export", {**base, "angle": angle})[0] == "bad_request"
    assert refused(shapes, "export", {**base, "colors": {"tub": "blue"}})[0] == "bad_request"
    assert refused(shapes, "export_check", base)[0] == "bad_request"  # no path
    assert refused(shapes, "export_check", {**base, "path": "relative.stl"})[0] == "bad_request"


def test_a_check_of_a_file_that_is_not_there_fails_and_says_so(tmp_path):
    said = checked(hollow(), tmp_path / "gone.stl", {"format": "stl", "layout": "assembly", "parts": ["tub"]})
    assert said["passed"] is False and said["problems"]


# Names, sizes and solids that touch (review of Task 17)


@pytest.mark.parametrize("name", ["lid top", "Lid.2", "tampa ção", "a(b)", "it's"])
def test_step_keeps_a_name_with_a_space_a_dot_an_accent_or_a_bracket(tmp_path, name):
    from build123d import Box

    shapes = {f"assembly:{name}": Box(10, 10, 10), "assembly:other": Box(5, 5, 5)}
    args = {"format": "step", "layout": "assembly", "parts": [name, "other"], "name": "caixa ção"}
    _, data = made(shapes, args)
    said = checked(shapes, written(tmp_path, "named.step", data), args)
    assert said["passed"] is True, said["problems"]
    assert [one["name"] for one in said["objects"]] == [name, "other"]
    # Written as UTF-8, as OCC reads it.
    assert f"PRODUCT('{name.replace(chr(39), chr(39) * 2)}'".encode() in data


def test_3mf_keeps_such_names_too(tmp_path):
    from build123d import Box, Pos

    shapes = {"print:tampa ção": Box(10, 10, 10), "print:Lid.2": Pos(20, 0, 0) * Box(10, 10, 10)}
    args = {"format": "3mf", "layout": "print", "parts": ["tampa ção", "Lid.2"]}
    _, data = made(shapes, args)
    said = checked(shapes, written(tmp_path, "named.3mf", data), args)
    assert said["passed"] is True, said["problems"]


def test_a_tolerance_that_would_make_too_many_triangles_is_refused_before_anything_is_meshed():
    import time

    from build123d import Sphere

    shapes = {"assembly:ball": Sphere(150)}
    start = time.monotonic()
    kind, message = refused(shapes, "export", {"format": "3mf", "layout": "assembly", "parts": ["ball"], "tolerance": 0.001, "angle": 0.5})
    # Meshed as asked it took 164 s; the refusal comes from a rough mesh.
    assert time.monotonic() - start < 5
    assert kind == "bad_request"
    assert "ball would be about" in message and "500,000" in message and "take a coarser tolerance or angle" in message
    # The estimate is never under what OCC makes, on a sphere, a block with holes and a torus.
    from build123d import Box, Cylinder, Pos, Torus

    for shape in (Sphere(50), Box(200, 100, 50) - Cylinder(3, 60) - Pos(50, 0, 0) * Cylinder(20, 60), Torus(30, 5)):
        _, triangles = export.mesh(shape, 0.01, 5)
        assert len(triangles) <= export.estimate(shape, 0.01, 5) <= 4 * len(triangles)


def two_touching():
    from build123d import Box, Compound, Pos

    return Compound([Box(10, 10, 10), Pos(10, 0, 0) * Box(10, 10, 10)])


def test_a_mesh_of_a_part_with_a_face_of_no_solid_is_refused():
    from build123d import Box, Compound, Pos

    shapes = {"assembly:flap": Compound([Box(10, 10, 10), Pos(30, 0, 0) * Box(10, 10, 10).faces()[0]])}
    kind, message = refused(shapes, "export", {"format": "3mf", "layout": "assembly", "parts": ["flap"]})
    assert (kind, message) == ("bad_request", "flap has 1 face of no solid: an STL or a 3MF is of solids")


def test_an_stl_of_solids_that_touch_is_refused_saying_what_to_do():
    kind, message = refused({"assembly:lid": two_touching()}, "export", {"format": "stl", "layout": "assembly", "parts": ["lid"]})
    assert (kind, message) == ("bad_request", "lid is 2 solids that touch: fuse them in the model, or export 3MF")


def test_a_3mf_has_a_mesh_of_each_solid_of_a_part_and_checks_each(tmp_path):
    from build123d import Box, Pos

    shapes = {"print:lid": two_touching(), "print:base": Pos(40, 0, 0) * Box(10, 10, 10)}
    args = {"format": "3mf", "layout": "print", "parts": ["lid", "base"], "colors": {"lid": "#3a7bd5"}}
    result, data = made(shapes, args)
    assert result["parts"][0]["solids"] == 2
    with zipfile.ZipFile(written(tmp_path, "touching.3mf", data)) as zipped:
        model = zipped.read("3D/3dmodel.model").decode()
    # The part is an object of its name made of its two solids, each a mesh of its own.
    assert 'name="lid 1"' in model and 'name="lid 2"' in model and "<components>" in model
    said = checked(shapes, tmp_path / "touching.3mf", args)
    assert said["passed"] is True, said["problems"]
    assert [one["name"] for one in said["objects"]] == ["lid, solid 1", "lid, solid 2", "base"]
    assert all(one["volume"] == pytest.approx(1000, rel=1e-6) for one in said["objects"])
    # Solids apart are one mesh in an STL, in as many pieces.
    from build123d import Compound

    apart = {"assembly:pair": Compound([Box(10, 10, 10), Pos(30, 0, 0) * Box(10, 10, 10)])}
    stl = {"format": "stl", "layout": "assembly", "parts": ["pair"]}
    _, data = made(apart, stl)
    said = checked(apart, written(tmp_path, "pair.stl", data), stl)
    assert said["passed"] is True and said["objects"][0]["pieces"] == 2
