import json
from itertools import pairwise
from pathlib import Path

import numpy as np
import pytest

from torno_kernel import topo
from torno_kernel.loader import load_scene
from torno_kernel.tess import build_scene

MESH_BUFFERS = {
    "vertices",
    "normals",
    "triangles",
    "edges",
    "trianglesPerFace",
    "segmentsPerEdge",
    "faceTypes",
    "edgeTypes",
}


@pytest.fixture(scope="module")
def bracket():
    ws = Path(__file__).parent / "fixtures" / "ws"
    return build_scene(load_scene(ws / "bracket", "bracket.py"), "bracket.py")


def read(blob: bytes, buf: dict, dtype: str) -> np.ndarray:
    return np.frombuffer(blob, dtype=dtype, count=buf["length"] // 4, offset=buf["offset"])


def part(scene: dict, key: str) -> dict:
    return next(p for p in scene["parts"] if p["key"] == key)


def assert_counts_agree(p: dict, blob: bytes, shape) -> None:
    mesh = p["mesh"]
    triangles_per_face = read(blob, mesh["trianglesPerFace"], "<u4")
    segments_per_edge = read(blob, mesh["segmentsPerEdge"], "<u4")
    triangles = read(blob, mesh["triangles"], "<u4")
    vertices = read(blob, mesh["vertices"], "<f4")

    assert p["triangleCount"] > 0
    assert triangles_per_face.sum() == p["triangleCount"] == len(triangles) / 3
    assert len(triangles_per_face) == p["faceCount"] == len(topo.faces(shape))
    assert len(segments_per_edge) == p["edgeCount"] == len(topo.edges(shape))

    assert len(read(blob, mesh["faceTypes"], "<u4")) == p["faceCount"]
    assert len(read(blob, mesh["edgeTypes"], "<u4")) == p["edgeCount"]
    assert len(read(blob, mesh["edges"], "<f4")) == 6 * segments_per_edge.sum()
    assert len(read(blob, mesh["normals"], "<f4")) == len(vertices)
    assert len(vertices) % 3 == 0
    assert triangles.max() < len(vertices) / 3


def to_object_frame(flat: np.ndarray, loc: dict) -> np.ndarray:
    """Apply a part's pose to flat xyz floats; returns an (n, 3) array."""
    v = flat.reshape(-1, 3).astype(np.float64)
    u, w = np.array(loc["q"][:3]), loc["q"][3]
    return v + 2 * w * np.cross(u, v) + 2 * np.cross(u, np.cross(u, v)) + np.array(loc["t"])


def assert_inside(points: np.ndarray, box, what: str) -> None:
    tol = 0.05
    assert (points >= np.array(list(box.min)) - tol).all(), what
    assert (points <= np.array(list(box.max)) + tol).all(), what


def assert_mesh_lies_on_topology(p: dict, blob: bytes, shape) -> None:
    """Face i's triangles lie on topo.faces(shape)[i]; likewise edge segments."""
    from build123d import Edge, Face

    mesh = p["mesh"]
    vertices = to_object_frame(read(blob, mesh["vertices"], "<f4"), p["loc"])
    triangles = read(blob, mesh["triangles"], "<u4").reshape(-1, 3)
    start = 0
    for i, count in enumerate(read(blob, mesh["trianglesPerFace"], "<u4")):
        box = Face(topo.faces(shape)[i]).bounding_box()
        assert_inside(vertices[triangles[start : start + count].ravel()], box, f"face {i}")
        start += count

    segments = to_object_frame(read(blob, mesh["edges"], "<f4"), p["loc"]).reshape(-1, 2, 3)
    start = 0
    for i, count in enumerate(read(blob, mesh["segmentsPerEdge"], "<u4")):
        if count:
            box = Edge(topo.edges(shape)[i]).bounding_box()
            assert_inside(segments[start : start + count].reshape(-1, 3), box, f"edge {i}")
        start += count


def test_bracket_scene_lists_model_layouts_and_part_keys(bracket):
    scene, _, shapes = bracket
    assert scene["model"] == "bracket.py"
    assert scene["layouts"] == ["assembly", "print"]
    keys = ["assembly:base", "assembly:post", "print:base", "print:post"]
    assert [p["key"] for p in scene["parts"]] == keys
    assert list(shapes) == keys
    assert [(p["layout"], p["name"]) for p in scene["parts"]] == [
        ("assembly", "base"),
        ("assembly", "post"),
        ("print", "base"),
        ("print", "post"),
    ]
    assert "seconds" not in scene
    assert "output" not in scene


def test_bracket_mesh_counts_agree_with_topology(bracket):
    scene, blob, shapes = bracket
    for p in scene["parts"]:
        assert_counts_agree(p, blob, shapes[p["key"]])


def test_bracket_buffers_are_aligned_and_inside_the_blob(bracket):
    scene, blob, _ = bracket
    spans = []
    for p in scene["parts"]:
        assert set(p["mesh"]) == MESH_BUFFERS
        for buf in p["mesh"].values():
            assert set(buf) == {"offset", "length"}
            assert buf["offset"] % 4 == 0
            assert buf["length"] % 4 == 0
            assert 0 <= buf["offset"] and buf["offset"] + buf["length"] <= len(blob)
            spans.append((buf["offset"], buf["offset"] + buf["length"]))
    spans.sort()
    for (_, end), (start, _) in pairwise(spans):
        assert end <= start


def test_bracket_base_bbox_and_volume(bracket):
    scene, _, _ = bracket
    base = part(scene, "assembly:base")
    assert base["bbox"]["min"] == pytest.approx([-20, -15, -2.5], abs=1e-3)
    assert base["bbox"]["max"] == pytest.approx([20, 15, 2.5], abs=1e-3)
    assert base["volume"] == pytest.approx(6000, abs=1e-6)
    assert base["valid"] is True
    assert base["faceCount"] == 6
    assert base["edgeCount"] == 12
    assert base["triangleCount"] == 12


def test_bracket_post_bbox_has_the_pose_applied(bracket):
    scene, _, _ = bracket
    post = part(scene, "assembly:post")
    assert post["bbox"]["min"][2] == pytest.approx(2.5, abs=1e-3)
    assert post["bbox"]["max"][2] == pytest.approx(22.5, abs=1e-3)


def test_bracket_rotated_post_bbox_is_in_the_object_frame(bracket):
    # print:post is Pos(60, 0, 4) * Rot(90, 0, 0) * Cylinder(4, 20): its axis lies along Y.
    scene, _, _ = bracket
    post = part(scene, "print:post")
    assert post["bbox"]["min"] == pytest.approx([56, -10, 0], abs=0.05)
    assert post["bbox"]["max"] == pytest.approx([64, 10, 8], abs=0.05)


def test_bracket_loc_takes_mesh_vertices_to_the_object_frame(bracket):
    scene, blob, shapes = bracket
    for p in scene["parts"]:
        points = to_object_frame(read(blob, p["mesh"]["vertices"], "<f4"), p["loc"])
        box = shapes[p["key"]].bounding_box()
        assert points.min(axis=0) == pytest.approx(list(box.min), abs=0.05)
        assert points.max(axis=0) == pytest.approx(list(box.max), abs=0.05)


def test_bracket_mesh_faces_and_edges_lie_on_their_topology(bracket):
    scene, blob, shapes = bracket
    for p in scene["parts"]:
        assert_mesh_lies_on_topology(p, blob, shapes[p["key"]])


def test_bracket_shapes_for_queries_are_in_the_object_frame(bracket):
    _, _, shapes = bracket
    assert shapes["assembly:post"].center().Z == pytest.approx(12.5)
    assert shapes["print:post"].center().X == pytest.approx(60)


def test_bracket_scene_is_json_serialisable(bracket):
    scene, _, _ = bracket
    assert json.loads(json.dumps(scene)) == scene


def test_bracket_hashes_are_strings_shared_by_equal_geometry_only(bracket):
    scene, _, _ = bracket
    hashes = {p["key"]: p["hash"] for p in scene["parts"]}
    assert all(isinstance(h, str) and h for h in hashes.values())
    assert hashes["assembly:base"] != hashes["assembly:post"]


def test_face_order_matches_build123d_faces(bracket):
    _, _, shapes = bracket
    for shape in shapes.values():
        ours = topo.faces(shape)
        theirs = [f.wrapped for f in shape.faces()]
        assert len(ours) == len(theirs)
        assert all(a.IsSame(b) for a, b in zip(ours, theirs))


def test_sphere_topped_part_counts_degenerate_edges():
    from build123d import Cylinder, Pos, Sphere

    shape = Cylinder(5, 10) + Pos(0, 0, 5) * Sphere(5)
    scene, blob, shapes = build_scene({"main": {"dome": shape}}, "dome.py")
    (p,) = scene["parts"]
    assert p["key"] == "main:dome"
    assert_counts_agree(p, blob, shapes["main:dome"])
    assert_mesh_lies_on_topology(p, blob, shapes["main:dome"])
    # The sphere's pole is a degenerate edge, which shape.edges() leaves out.
    assert p["edgeCount"] == 5
    assert len(shape.edges()) == 4
